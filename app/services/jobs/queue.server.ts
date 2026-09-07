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

const handlers = new Map<JobName, JobHandler<JobName>>();
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
export async function enqueue<N extends JobName>(name: N, payload: JobPayloads[N], options: EnqueueOptions = {}): Promise<string> {
  const q = getQueue();
  if (q) {
    const opts: JobsOptions = {
      delay: options.delayMs,
      attempts: options.attempts,
      priority: options.priority,
      ...(options.dedupeKey ? { jobId: sanitizeJobId(options.dedupeKey) } : {}),
    };
    const job = await q.add(name, payload, opts);
    return job.id ?? name;
  }

  const id = options.dedupeKey ? sanitizeJobId(options.dedupeKey) : `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

async function runInline<N extends JobName>(name: N, payload: JobPayloads[N], id: string) {
  const handler = handlers.get(name);
  if (!handler) {
    logger.warn("No handler registered for inline job", { name });
    return;
  }
  try {
    await handler(payload, { jobId: id, attempt: 1 });
  } catch (error) {
    logger.error("Inline job failed", { name, id, error });
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

export async function queueStats() {
  const q = getQueue();
  if (!q) return { mode: "inline" as const };
  const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  return { mode: "redis" as const, ...counts };
}

function sanitizeJobId(key: string) {
  // BullMQ job ids cannot contain ":".
  return key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
}
