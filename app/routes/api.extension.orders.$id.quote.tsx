import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import {
  EXTENSION_BODY_LIMITS,
  ExtensionApiError,
  ExtensionQuoteBody,
  PURCHASE_ORDER_ID_SHAPE,
  authenticateExtensionRequest,
  describeZodError,
  readJsonBody,
  recordSupplierQuote,
} from "~/services/fulfillment.server";

/**
 * The extension reports what AliExpress's checkout page shows the purchase
 * order costs, in the account's currency, so the app's cost and profit are
 * the price paid rather than the price captured from the product page.
 *
 *   POST /api/extension/orders/:id/quote
 *   Authorization: Bearer <shop api token>
 *   { "currency": "USD", "total": "93.62", "subtotal": "85.89", "shipping": "2.99", "charges": "4.74", "source": "confirm" }
 *   → 200 { ok: true, currency, totalCost, itemsCost, shippingCost }
 *   → 200 { ok: true, unchanged: true } when the same total is sent again
 *   → 409 once the purchase order is paid, shipped, cancelled or otherwise past a quote
 *
 * No CORS headers: only the extension's own worker calls this.
 */

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

export const loader = async (_args: LoaderFunctionArgs) => json({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "POST" });
  try {
    const shop = await authenticateExtensionRequest(request, { scope: "orders-write", limit: 60 });
    const id = params.id ?? "";
    if (!PURCHASE_ORDER_ID_SHAPE.test(id)) return json({ ok: false, error: "Purchase order not found" }, 404);

    const parsed = ExtensionQuoteBody.safeParse(await readJsonBody(request, EXTENSION_BODY_LIMITS.orders));
    if (!parsed.success) return json({ ok: false, error: describeZodError(parsed.error) }, 400);

    const answer = await recordSupplierQuote(shop, id, parsed.data);
    return json(answer.body, answer.status);
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension quote report failed", { error, purchaseOrderId: params.id });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};
