import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import {
  EXTENSION_BODY_LIMITS,
  ExtensionApiError,
  ExtensionSyncOrdersBody,
  authenticateExtensionRequest,
  describeZodError,
  readJsonBody,
  syncOrdersFromExtension,
} from "~/services/fulfillment.server";

/**
 * The extension read the merchant's AliExpress orders list (or one order's
 * detail page) and reports the orders on it: AliExpress order id, product
 * ids, SKU text, status, total and date. Never the customer's data.
 *
 *   POST /api/extension/orders/sync
 *   Authorization: Bearer <shop api token>
 *   { "orders": [{ "orderId": "8190000000000001", "productIds": ["3256809840464144", "1005010026778896"],
 *                  "skuText": "Play blue light", "status": "Awaiting delivery", "total": "$93.62", "date": "Sep 15, 2026" }] }
 *   → 200 { ok: true, results: [{ orderId, result: "recorded" | "already" | "advanced" | "ambiguous" | "unmatched", purchaseOrderId?, orderName?, status? }] }
 *
 * A known AliExpress order advances its purchase order's status, never
 * backwards; an unknown one is matched to a purchase order waiting for the
 * extension by product (and SKU text) and recorded through the same path as
 * "Mark as placed". Safe to repeat. No CORS headers: only the extension's
 * own worker calls this.
 */

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

export const loader = async (_args: LoaderFunctionArgs) => json({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });
  try {
    const shop = await authenticateExtensionRequest(request, { scope: "orders-sync", limit: 30 });
    const parsed = ExtensionSyncOrdersBody.safeParse(await readJsonBody(request, EXTENSION_BODY_LIMITS.sync));
    if (!parsed.success) return json({ ok: false, error: describeZodError(parsed.error) }, 400);
    const results = await syncOrdersFromExtension(shop, parsed.data);
    return json({ ok: true, results });
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension order sync failed", { error });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};
