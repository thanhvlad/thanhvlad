import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { env } from "~/lib/env.server";
import { emailProvider } from "~/services/email.server";
import { queueStats } from "~/services/jobs/index.server";

/**
 * Liveness and readiness for the platform's health check.
 *
 * 200 when the database answers and, if Redis is configured, the queue does
 * too; 503 otherwise, with the failing component named. Public and unauthenticated
 * by design — it reveals nothing beyond which dependency is down — and cheap
 * enough to poll every few seconds.
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  const startedAt = Date.now();
  const config = env();
  const checks: Record<string, { ok: boolean; ms: number; error?: string }> = {};

  checks.database = await timed(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
  if (config.REDIS_URL) {
    checks.queue = await timed(async () => {
      const stats = await withTimeout(queueStats(), 3000);
      if (stats.mode !== "redis") throw new Error("queue not connected");
    });
  }

  const ok = Object.values(checks).every((c) => c.ok);
  const body = {
    ok,
    service: "dropship-hub",
    supplierDriver: config.SUPPLIER_DRIVER,
    queue: config.REDIS_URL ? "redis" : "inline",
    email: emailProvider(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
    tookMs: Date.now() - startedAt,
  };
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

async function timed(run: () => Promise<void>): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  try {
    await withTimeout(run(), 5000);
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
