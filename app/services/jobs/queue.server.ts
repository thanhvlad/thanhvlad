import { createHash } from "node:crypto";
import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import IORedis from "ioredis";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { EnqueueOptions, JobName, JobPayloads } from "./types";

/**
 * Queue abstraction.
 *
 * With REDIS_URL set, jobs go through BullMQ and are processed by the worker
 * process (`npm run worker`) or in-process when RUN_WORKER_IN_WEB=true. Without
 * Redis, jobs run inline on the next tick — fine for development and tiny
 * stores, but a restart loses whatever was queued.
 */

export type JobHandler<N extends JobName> = (payload: JobPayloads[N], meta: { jobId: string; attempt: number }) => Promise<unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __dropshipJobHandlers: Map<JobName, JobHandler<JobName>> | undefined;
}

// On globalThis, like the Prisma client: Vite re-evaluates server modules on
// every HMR update, and a module-scoped Map would be replaced by an empty one
// while the boot flag that guards registration survives — every job would then
// fail with "no handler registered" until the dev server is restarted.
const handlers: Map<JobName, JobHandler<JobName>> =
  globalThis.__dropshipJobHandlers ?? new Map<JobName, JobHandler<JobName>>();
globalThis.__dropshipJobHandlers = handlers;

const QUEUE_NAME = "dropship-hub";

let connection: IORedis | null = null;
let queue: Queue | null = null;
let worker: Worker | null = null;

export function registerHandler<N extends JobName>(name: N, handler: JobHandler<N>) {
  handlers.set(name, handler as JobHandler<JobName>);
}

export function hasRedis(): boolean {
  return Boolean(env().REDIS_URL);
}

function redis(): IORedis {
  if (!connection) {
    connection = new IORedis(env().REDIS_URL!, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: false });
    connection.on("error", (error) => logger.error("Redis error", { error }));
  }
  return connection;
}

export function getQueue(): Queue | null {
  if (!hasRedis()) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: redis(),
      prefix: env().QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

const inlineRunning = new Set<string>();

/** Enqueue a job (or run it inline without Redis). Returns the queue job id. */
/**
 * Per-job options for BullMQ.
 *
 * A key is set only when it carries a value. BullMQ merges these over
 * `defaultJobOptions`, and an explicit `undefined` overwrites the default — so
 * passing `attempts: undefined` discarded `attempts: 3` and reduced every job in
 * the app to a single attempt with no retry at all.
 *
 * Exported for the unit test; `now` is injectable so the dedupe bucket is
 * deterministic there.
 */
export function buildJobOptions(options: EnqueueOptions, now = Date.now()): JobsOptions {
  return {
    ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.dedupeKey ? { jobId: dedupeJobId(options.dedupeKey, dedupeWindow(options), now) } : {}),
  };
}

export async function enqueue<N extends JobName>(name: N, payload: JobPayloads[N], options: EnqueueOptions = {}): Promise<string> {
  const q = getQueue();
  if (q) {
    const job = await q.add(name, payload, buildJobOptions(options));
    return job.id ?? name;
  }

  const id = options.dedupeKey
    ? dedupeJobId(options.dedupeKey, dedupeWindow(options))
    : `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (options.dedupeKey && inlineRunning.has(id)) return id;
  inlineRunning.add(id);
  const run = async () => {
    try {
      await runInline(name, payload, id);
    } finally {
      inlineRunning.delete(id);
    }
  };
  if (options.delayMs && options.delayMs > 0) setTimeout(run, options.delayMs);
  else setImmediate(run);
  return id;
}

/** Attempts an inline job gets, matching the queue's `defaultJobOptions`. */
const INLINE_ATTEMPTS = 3;

async function runInline<N extends JobName>(name: N, payload: JobPayloads[N], id: string) {
  const handler = handlers.get(name);
  if (!handler) {
    logger.warn("No handler registered for inline job", { name });
    return;
  }
  // Inline mode retries too. Without it a webhook that failed once was never
  // reprocessed: its WebhookEvent kept processedAt null forever and nothing in
  // the app went back for it.
  for (let attempt = 1; attempt <= INLINE_ATTEMPTS; attempt += 1) {
    try {
      await handler(payload, { jobId: id, attempt });
      return;
    } catch (error) {
      if (attempt === INLINE_ATTEMPTS) {
        logger.error("Inline job failed", { name, id, attempt, error });
        return;
      }
      logger.warn("Inline job failed; retrying", { name, id, attempt, error });
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt).unref?.());
    }
  }
}

/** Process jobs from Redis in this process. Call once from the worker (or web when RUN_WORKER_IN_WEB). */
export function startWorker(options: { concurrency?: number } = {}): Worker | null {
  if (!hasRedis()) {
    logger.info("Queue worker not started: no REDIS_URL (jobs run inline)");
    return null;
  }
  if (worker) return worker;
  const processor: Processor = async (job) => {
    const handler = handlers.get(job.name as JobName);
    if (!handler) throw new Error(`No handler for job ${job.name}`);
    return handler(job.data as JobPayloads[JobName], { jobId: String(job.id), attempt: job.attemptsMade + 1 });
  };
  worker = new Worker(QUEUE_NAME, processor, {
    connection: redis(),
    prefix: env().QUEUE_PREFIX,
    concurrency: options.concurrency ?? 5,
  });
  // Without an 'error' listener a Redis blip is an unhandled EventEmitter
  // 'error' event, which takes the whole worker process down.
  worker.on("error", (error) => logger.error("Queue worker error", { error }));
  worker.on("failed", (job, error) => logger.error("Job failed", { name: job?.name, id: job?.id, attempt: job?.attemptsMade, error }));
  worker.on("completed", (job) => logger.debug("Job completed", { name: job.name, id: job.id }));
  logger.info("Queue worker started", { concurrency: options.concurrency ?? 5 });
  return worker;
}

/** Register the repeatable scheduler ticks. Safe to call on every boot. */
export async function ensureSchedules() {
  const q = getQueue();
  if (!q) return;
  const ticks: Array<{ kind: JobPayloads["scheduler-tick"]["kind"]; every: number }> = [
    { kind: "purchase-orders", every: 30 * 60_000 },
    { kind: "tracking", every: 15 * 60_000 },
    { kind: "inventory", every: 60 * 60_000 },
    { kind: "auto-place", every: 10 * 60_000 },
    { kind: "metrics", every: 60 * 60_000 },
    { kind: "payments", every: 20 * 60_000 },
  ];
  for (const tick of ticks) {
    await q.upsertJobScheduler(`tick-${tick.kind}`, { every: tick.every }, { name: "scheduler-tick", data: { kind: tick.kind } });
  }
  await q.upsertJobScheduler("refresh-rates-usd", { every: 12 * 60 * 60_000 }, { name: "refresh-rates", data: { base: "USD" } });
  logger.info("Repeatable schedules registered");
}

export async function shutdownQueue() {
  await worker?.close();
  await queue?.close();
  connection?.disconnect();
  worker = null;
  queue = null;
  connection = null;
}

export interface QueueStats {
  mode: "inline" | "redis";
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export async function queueStats(): Promise<QueueStats> {
  const q = getQueue();
  if (!q) return { mode: "inline", waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  return {
    mode: "redis",
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}

/** Default window a dedupe key collapses duplicates over. */
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;

function dedupeWindow(options: EnqueueOptions): number {
  return options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
}

/**
 * Job id for a dedupe key, valid for one window.
 *
 * BullMQ refuses a job whose id it already holds, and completed jobs are kept
 * for a day. A bare dedupe key as the job id therefore did not collapse
 * duplicates — it made the job run at most once every 24 hours. Every periodic
 * sync silently degraded to daily, and a merchant's manual "sync orders" button
 * was a no-op until the next day. Bucketing by time makes the key mean what it
 * says: one run per window.
 */
export function dedupeJobId(key: string, windowMs: number, now = Date.now()): string {
  const bucket = Math.floor(now / Math.max(1_000, windowMs));
  return sanitizeJobId(`${key}-${bucket}`);
}

function sanitizeJobId(key: string) {
  // BullMQ job ids cannot contain ":". Hashing the overflow keeps two long keys
  // that share a prefix from collapsing onto one id.
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length <= 180) return safe;
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return `${safe.slice(0, 163)}-${digest}`;
}
