import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";

/**
 * Liveness and readiness for the platform's health check.
 *
 * 200 when the database answers, 503 when it does not. Public and
 * unauthenticated, so it says nothing beyond that: it used to name the supplier
 * driver, the queue mode, the email provider and the raw database error, which
 * told anyone on the internet that orders were not reaching a supplier API and
 * which parts of the stack were missing. Those details now live on the
 * authenticated Settings > Support screen, and a failure's message goes to the
 * server log. Cheap enough to poll every few seconds.
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  const database = await check("database", async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
  const body: HealthBody = {
    ok: database.ok,
    service: "dropship-hub",
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database },
  };
  return new Response(JSON.stringify(body), {
    status: body.ok ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

export interface HealthBody {
  ok: boolean;
  service: string;
  uptimeSeconds: number;
  checks: { database: { ok: boolean } };
}

async function check(name: string, run: () => Promise<void>): Promise<{ ok: boolean }> {
  try {
    await withTimeout(run(), 5000);
    return { ok: true };
  } catch (error) {
    // The reason is for the operator, not for whoever polls the endpoint.
    logger.error("Health check failed", { check: name, error });
    return { ok: false };
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
