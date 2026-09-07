import { env } from "~/lib/env.server";
import { registerAllHandlers } from "./handlers.server";
import { ensureSchedules, startWorker } from "./queue.server";

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
  }
}

export { enqueue, queueStats, shutdownQueue } from "./queue.server";
export type { JobName, JobPayloads } from "./types";
