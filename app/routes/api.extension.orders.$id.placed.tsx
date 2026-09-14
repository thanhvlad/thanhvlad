import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import {
  EXTENSION_BODY_LIMITS,
  ExtensionApiError,
  ExtensionPlacedBody,
  PURCHASE_ORDER_ID_SHAPE,
  authenticateExtensionRequest,
  describeZodError,
  markPlacedFromExtension,
  readJsonBody,
} from "~/services/fulfillment.server";

/**
 * The extension reports that the merchant placed a purchase order on the
 * supplier's site.
 *
 *   POST /api/extension/orders/:id/placed
 *   Authorization: Bearer <shop api token>
 *   { "externalOrderIds": ["8190000000000000"], "totalCost": "12.40", "currency": "USD" }
 *   → 200 { ok: true, status: "AWAITING_PAYMENT", paymentUrl }
 *   → 200 { ok: true, alreadyRecorded: true } when the same ids are reported again
 *   → 409 when the purchase order is already recorded with other ids
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

    const parsed = ExtensionPlacedBody.safeParse(await readJsonBody(request, EXTENSION_BODY_LIMITS.orders));
    if (!parsed.success) return json({ ok: false, error: describeZodError(parsed.error) }, 400);

    const answer = await markPlacedFromExtension(shop, id, parsed.data);
    return json(answer.body, answer.status);
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension placed report failed", { error, purchaseOrderId: params.id });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};
