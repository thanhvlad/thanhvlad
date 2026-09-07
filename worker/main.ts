/**
 * Standalone queue worker: `npm run worker`.
 *
 * Consumes the BullMQ queue and owns the repeatable schedules. Run at least
 * one instance in production; the web process only enqueues.
 */
import { bootJobs, shutdownQueue } from "../app/services/jobs/index.server";
import { logger } from "../app/lib/logger.server";
import prisma from "../app/db.server";

bootJobs({ worker: true });
logger.info("DropshipHub worker running");

async function shutdown(signal: string) {
  logger.info("Worker shutting down", { signal });
  await shutdownQueue();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
