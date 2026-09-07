/**
 * Enqueue a job by hand (useful for ops and smoke tests):
 *
 *   node --import tsx/esm scripts/enqueue.ts rollup-metrics '{"shopId":"…","days":7}'
 *   node --import tsx/esm scripts/enqueue.ts scheduler-tick '{"kind":"purchase-orders"}'
 *
 * Without REDIS_URL the job runs inline in this process.
 */
import { bootJobs, enqueue, queueStats, shutdownQueue } from "../app/services/jobs/index.server";
import type { JobName, JobPayloads } from "../app/services/jobs/types";

const [name, payloadJson] = process.argv.slice(2);
if (!name) {
  console.error("usage: enqueue.ts <job-name> '<json payload>'");
  process.exit(1);
}

bootJobs({ worker: false });
const payload = JSON.parse(payloadJson ?? "{}") as JobPayloads[JobName];
const id = await enqueue(name as JobName, payload);
console.info(`enqueued ${name} as ${id}`);
console.info(await queueStats());
// Give an inline job a moment to run before exiting.
await new Promise((resolve) => setTimeout(resolve, process.env.REDIS_URL ? 200 : 3000));
await shutdownQueue();
process.exit(0);
