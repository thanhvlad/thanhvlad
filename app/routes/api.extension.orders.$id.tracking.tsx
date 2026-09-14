import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import {
  EXTENSION_BODY_LIMITS,
  ExtensionApiError,
  ExtensionTrackingBody,
  PURCHASE_ORDER_ID_SHAPE,
  addTrackingFromExtension,
  authenticateExtensionRequest,
  describeZodError,
  readJsonBody,
} from "~/services/fulfillment.server";

/**
 * The extension reports a tracking number for a placed purchase order. It goes
 * through the same path as tracking typed on the order page, so the Shopify
 * fulfilment and the customer notification follow the shop's own settings.
 *
 *   POST /api/extension/orders/:id/tracking
 *   Authorization: Bearer <shop api token>
 *   { "number": "LP00123456789CN", "carrier": "Cainiao" }
 *
 * No CORS headers: only the extension's own pages call this.
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

    const parsed = ExtensionTrackingBody.safeParse(await readJsonBody(request, EXTENSION_BODY_LIMITS.orders));
    if (!parsed.success) return json({ ok: false, error: describeZodError(parsed.error) }, 400);

    const answer = await addTrackingFromExtension(shop, id, parsed.data);
    return json(answer.body, answer.status);
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension tracking report failed", { error, purchaseOrderId: params.id });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};
