import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import { ExtensionApiError, authenticateExtensionRequest, listAwaitingPlacement, listAwaitingTracking } from "~/services/fulfillment.server";

/**
 * Supplier orders waiting to be placed from the merchant's browser.
 *
 *   GET /api/extension/orders
 *   Authorization: Bearer <shop api token>
 *   → { ok: true, orders: [{ id, orderName, shippingAddress, items: [...] }],
 *       awaitingTracking: [{ id, orderName, platform, status, externalOrderIds, placedAt }] }
 *
 * `awaitingTracking` lists placed supplier orders with no tracking number yet,
 * so the popup can offer "Add tracking" without the merchant hunting for the
 * purchase order id. It carries no address.
 *
 * The response carries customer names, phone numbers and addresses, so unlike
 * the capture endpoint it sends NO CORS headers: no web page may read it. The
 * extension calls it from its own popup, which the host permission the
 * merchant grants for the app's origin exempts from CORS.
 */

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  // no-store: an address list must not linger in a proxy or the browser cache.
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const shop = await authenticateExtensionRequest(request, { scope: "orders-read", limit: 60 });
    const [orders, awaitingTracking] = await Promise.all([listAwaitingPlacement(shop), listAwaitingTracking(shop)]);
    return json({ ok: true, orders, awaitingTracking });
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension order list failed", { error });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};

export const action = async (_args: ActionFunctionArgs) => json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET" });
