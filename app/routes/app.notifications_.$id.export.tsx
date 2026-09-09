import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { requireShop } from "~/lib/auth.server";

/**
 * Download the export attached to a customer data request notification.
 *
 * Scoped to the signed-in shop: a notification id from another store answers
 * 404 rather than someone else's customer data.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const row = await prisma.notification.findFirst({ where: { id: params.id!, shopId: shop.id }, select: { meta: true, createdAt: true } });
  const dataRequest = (row?.meta as { dataRequest?: unknown } | null)?.dataRequest;
  if (!dataRequest) return new Response("Not found", { status: 404 });
  const stamp = row!.createdAt.toISOString().slice(0, 10);
  return new Response(JSON.stringify(dataRequest, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="customer-data-request-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
};
