import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { requireShop } from "~/lib/auth.server";
import { logActivity } from "~/services/activity.server";

/**
 * Download the export attached to a customer data request notification.
 *
 * Scoped to the signed-in shop: a notification id from another store answers
 * 404 rather than someone else's customer data.
 *
 * Admins only. The file is a customer's complete record - name, email, phone,
 * address and every order - and a read-only or day-to-day staff member has no
 * part in answering a privacy request. Every download is written to the
 * activity log with who took it, because an access log to exactly this data
 * is what Shopify's protected customer data rules ask for.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, actor } = await requireShop(request, { minRole: "ADMIN" });
  const row = await prisma.notification.findFirst({ where: { id: params.id!, shopId: shop.id }, select: { id: true, title: true, meta: true, createdAt: true } });
  const dataRequest = (row?.meta as { dataRequest?: unknown } | null)?.dataRequest;
  if (!row || !dataRequest) return new Response("Not found", { status: 404 });
  await logActivity(shop.id, {
    actor,
    action: "gdpr.export_downloaded",
    entity: "Notification",
    entityId: row.id,
    message: `${row.title}: export downloaded.`,
  });
  const stamp = row.createdAt.toISOString().slice(0, 10);
  return new Response(JSON.stringify(dataRequest, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="customer-data-request-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
};
