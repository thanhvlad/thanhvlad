import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { registerAllHandlers } from "./handlers.server";
import { ensureSchedules, shutdownQueue, startWorker } from "./queue.server";

declare global {
  // eslint-disable-next-line no-var
  var __dropshipJobsBooted: boolean | undefined;
}

/**
 * Boot the job system once per process. The web process always registers
 * handlers (needed for inline mode); it only consumes the Redis queue when
 * RUN_WORKER_IN_WEB=true.
 */
export function bootJobs(options: { worker?: boolean } = {}) {
  if (globalThis.__dropshipJobsBooted) return;
  globalThis.__dropshipJobsBooted = true;
  registerAllHandlers();
  const runWorker = options.worker ?? env().RUN_WORKER_IN_WEB;
  if (runWorker) {
    startWorker();
    void ensureSchedules();
    // The standalone worker installs its own handlers; the web process needs
    // them too when it consumes the queue, or a deploy kills jobs mid-flight
    // and BullMQ has to wait for the stall timeout before retrying them.
    if (!options.worker) installShutdownHandlers();
  }
}

let shutdownInstalled = false;

function installShutdownHandlers() {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info("Web process shutting down; closing the queue worker", { signal });
      void shutdownQueue()
        .catch((error) => logger.warn("Queue shutdown failed", { error }))
        .finally(() => process.exit(0));
    });
  }
}

export { enqueue, queueStats, shutdownQueue } from "./queue.server";
export type { JobName, JobPayloads } from "./types";
