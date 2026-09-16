import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import {
  EXTENSION_BODY_LIMITS,
  ExtensionApiError,
  ExtensionSyncTrackingBody,
  authenticateExtensionRequest,
  describeZodError,
  readJsonBody,
  syncTrackingFromExtension,
} from "~/services/fulfillment.server";

/**
 * The extension read an AliExpress tracking page: the order id from its
 * address, the carrier and the tracking number, nothing else.
 *
 *   POST /api/extension/orders/sync-tracking
 *   Authorization: Bearer <shop api token>
 *   { "tradeOrderId": "8190000000000001", "trackingNumber": "SWX000000000000000001", "carrier": "AliExpress Selection Standard" }
 *   → 200 { ok: true, result: "added" | "known" | "unmatched", purchaseOrderId?, orderName?, number? }
 *
 * An added number goes through the same path as tracking typed on the order
 * page, so the Shopify fulfilment follows the shop's settings. No CORS
 * headers: only the extension's own worker calls this.
 */

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

export const loader = async (_args: LoaderFunctionArgs) => json({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });
  try {
    const shop = await authenticateExtensionRequest(request, { scope: "orders-write", limit: 60 });
    const parsed = ExtensionSyncTrackingBody.safeParse(await readJsonBody(request, EXTENSION_BODY_LIMITS.orders));
    if (!parsed.success) return json({ ok: false, error: describeZodError(parsed.error) }, 400);
    const answer = await syncTrackingFromExtension(shop, parsed.data);
    return json(answer.body, answer.status);
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension tracking sync failed", { error });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};
