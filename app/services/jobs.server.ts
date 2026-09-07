import type { JobRun, JobStatus, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";

/**
 * JobRun bookkeeping. Queue handlers wrap their work in `runJob` so the UI can
 * show a progress bar and a result summary for every bulk action.
 */

export async function createJobRun(input: {
  shopId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  total?: number;
  queueJobId?: string | null;
}): Promise<JobRun> {
  return prisma.jobRun.create({
    data: {
      shopId: input.shopId ?? null,
      type: input.type,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      total: input.total ?? 0,
      queueJobId: input.queueJobId ?? null,
    },
  });
}

export async function startJobRun(id: string) {
  return prisma.jobRun.update({ where: { id }, data: { status: "RUNNING", startedAt: new Date() } });
}

export async function progressJobRun(
  id: string,
  delta: { processed?: number; succeeded?: number; failed?: number; total?: number },
) {
  return prisma.jobRun.update({
    where: { id },
    data: {
      ...(delta.processed ? { processed: { increment: delta.processed } } : {}),
      ...(delta.succeeded ? { succeeded: { increment: delta.succeeded } } : {}),
      ...(delta.failed ? { failed: { increment: delta.failed } } : {}),
      ...(delta.total !== undefined ? { total: delta.total } : {}),
    },
  });
}

export async function finishJobRun(id: string, status: JobStatus, result: Record<string, unknown> = {}, error?: unknown) {
  return prisma.jobRun.update({
    where: { id },
    data: {
      status,
      result: result as Prisma.InputJsonValue,
      error: error ? errorMessage(error) : null,
      finishedAt: new Date(),
    },
  });
}

/** Run `fn` inside a JobRun, recording success or failure. */
export async function runJob<T extends Record<string, unknown>>(
  jobRunId: string,
  fn: (ctx: { progress: (delta: Parameters<typeof progressJobRun>[1]) => Promise<unknown> }) => Promise<T>,
): Promise<T> {
  await startJobRun(jobRunId);
  try {
    const result = await fn({ progress: (delta) => progressJobRun(jobRunId, delta) });
    await finishJobRun(jobRunId, "SUCCEEDED", result);
    return result;
  } catch (error) {
    await finishJobRun(jobRunId, "FAILED", {}, error);
    throw error;
  }
}

export async function listJobRuns(shopId: string, options: { type?: string; limit?: number; activeOnly?: boolean } = {}) {
  return prisma.jobRun.findMany({
    where: {
      shopId,
      ...(options.type ? { type: options.type } : {}),
      ...(options.activeOnly ? { status: { in: ["QUEUED", "RUNNING"] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 20,
  });
}

export async function getJobRun(shopId: string, id: string) {
  return prisma.jobRun.findFirst({ where: { id, shopId } });
}
