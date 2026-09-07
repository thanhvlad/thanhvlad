import type { LoaderFunctionArgs } from "@remix-run/node";
import type { OrderStage } from "@prisma/client";
import { requireShop } from "~/lib/auth.server";
import { listOrders } from "~/services/orders.server";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV export of the current orders view (max 5000 rows). */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const stage = (url.searchParams.get("stage") ?? "ALL") as OrderStage | "ALL";
  const search = url.searchParams.get("q") ?? "";
  const { items } = await listOrders(shop.id, { stage, search, page: 1, pageSize: 250 });

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
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${stage.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
