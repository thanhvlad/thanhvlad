import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireShop } from "~/lib/auth.server";
import { getJobRun } from "~/services/jobs.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const job = await getJobRun(shop.id, params.id!);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    id: job.id,
    type: job.type,
    status: job.status,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    error: job.error,
    result: job.result,
  });
};
