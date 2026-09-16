import type { LoaderFunctionArgs } from "@remix-run/node";
import type { OrderStage } from "@prisma/client";
import { requireShop } from "~/lib/auth.server";
import { listOrders } from "~/services/orders.server";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows per `listOrders` call; the service clamps `pageSize` to this. */
const PAGE_SIZE = 250;
/** Hard ceiling for one export, so a huge store cannot exhaust the request. */
const MAX_ROWS = 5000;

/**
 * CSV export of the current orders view.
 *
 * Pages through `listOrders` rather than taking a single page: a single page was
 * 250 rows with nothing to say so, which quietly dropped everything else from a
 * merchant's accounting export.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const stage = (url.searchParams.get("stage") ?? "ALL") as OrderStage | "ALL";
  const search = url.searchParams.get("q") ?? "";

  const items: Awaited<ReturnType<typeof listOrders>>["items"] = [];
  let total = 0;
  for (let page = 1; items.length < MAX_ROWS; page += 1) {
    const result = await listOrders(shop.id, { stage, search, page, pageSize: PAGE_SIZE });
    total = result.total;
    items.push(...result.items);
    if (result.items.length < PAGE_SIZE || items.length >= result.total) break;
  }
  const truncated = total > items.length;

  const header = ["Order", "Created", "Customer", "Email", "Country", "Stage", "Financial status", "Total", "Supplier cost", "Supplier shipping", "Supplier orders", "Tracking numbers", "Issues"];
  const rows = items.map((o) => [
    o.name,
    o.shopifyCreatedAt?.toISOString() ?? "",
    o.customerName ?? "",
    o.customerEmail ?? "",
    o.countryCode ?? "",
    o.stage,
    o.financialStatus ?? "",
    o.totalPrice.toString(),
    o.supplierCost.toString(),
    o.supplierShipping.toString(),
    o.purchaseOrders.map((po) => `${po.platform}:${po.externalOrderId ?? po.status}`).join(" | "),
    o.purchaseOrders.flatMap((po) => po.trackings.map((t) => t.number)).join(" | "),
    ((o.issues as unknown as Array<{ message: string }>) ?? []).map((i) => i.message).join(" | "),
  ]);
  // A truncated export says so in the file itself, so nobody reconciles a month
  // against a silently short CSV.
  if (truncated) {
    rows.push([`Truncated: ${items.length} of ${total} orders exported. Narrow the filter or the date range for the rest.`]);
  }
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${stage.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Export-Rows": String(items.length),
      "X-Export-Total": String(total),
    },
  });
};
