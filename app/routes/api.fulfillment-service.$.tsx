import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { reconcileFulfillmentRequests, verifyShopifyHmac } from "~/services/fulfillment-service.server";
import { getShopByDomain } from "~/services/shop.server";

/**
 * Fulfilment-service callback endpoint.
 *
 * Shopify calls three paths under the registered callback URL:
 *
 * - `POST /fulfillment_order_notification` whenever a merchant requests
 *   fulfilment or asks to cancel one. The body only says which kind
 *   (`{"kind":"FULFILLMENT_REQUEST"}`), so the app verifies the signature and
 *   goes to read the assigned fulfilment orders itself. This path used to answer
 *   200 and do nothing, which left requests to the webhooks alone.
 * - `GET /fetch_tracking_numbers`, hourly, only while the service is registered
 *   with tracking support. Tracking is pushed to Shopify on the fulfilment when
 *   the supplier ships, so there is never a completed fulfilment waiting for a
 *   number here; the answer is an empty, successful set.
 * - `GET /fetch_stock`, only with inventory management on, which the app does
 *   not register with.
 *
 * Every answer Shopify expects is a success. A failing callback raises an alert
 * in the merchant's admin and counts against Built for Shopify 5.8.3.
 */

/** The notification body is a single small JSON object; anything larger is not Shopify. */
const MAX_NOTIFICATION_BYTES = 16 * 1024;

async function readCapped(request: Request): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_NOTIFICATION_BYTES) return null;
  const body = Buffer.from(await request.arrayBuffer());
  return body.length > MAX_NOTIFICATION_BYTES ? null : body;
}

async function notification(request: Request) {
  const body = await readCapped(request);
  if (!body) return json({ error: "Payload too large" }, { status: 413 });
  if (!verifyShopifyHmac(body, request.headers.get("x-shopify-hmac-sha256"), env().SHOPIFY_API_SECRET)) {
    return json({ error: "Invalid signature" }, { status: 401 });
  }

  const domain = request.headers.get("x-shopify-shop-domain") ?? new URL(request.url).searchParams.get("shop");
  const shop = domain ? await getShopByDomain(domain) : null;
  let kind: unknown = null;
  try {
    kind = (JSON.parse(body.toString("utf8")) as { kind?: unknown }).kind ?? null;
  } catch {
    // A signed body that is not JSON still means "something changed"; the
    // reconciliation below reads the real state either way.
  }

  if (!shop || !shop.isActive) {
    logger.warn("Fulfilment notification for a store the app does not serve", { domain, kind });
    return json({ ok: true });
  }

  // Answered at once, worked on afterwards: Shopify only needs to hear the
  // notification arrived, and reading and answering every request can take
  // longer than its callback timeout. The ten-minute sweep repeats this work,
  // so a restart mid-run loses nothing.
  void reconcileFulfillmentRequests(shop).catch((error) =>
    logger.error("Fulfilment notification reconciliation failed", { shopId: shop.id, kind, error }),
  );
  return json({ ok: true });
}

function respond(request: Request) {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  logger.debug("Fulfilment service callback", { path, method: request.method });
  if (path.endsWith("/fulfillment_order_notification")) {
    return request.method === "POST" ? notification(request) : json({ error: "Method not allowed" }, { status: 405 });
  }
  if (path.endsWith("/fetch_tracking_numbers")) {
    return json({ tracking_numbers: {}, message: "Tracking is sent to Shopify on each fulfilment when the supplier ships.", success: true });
  }
  if (path.endsWith("/fetch_stock")) return json({});
  // The bare callback URL answered 200 before, and nothing documents Shopify
  // never probing it, so it keeps doing so; only invented sub-paths are refused.
  if (path.endsWith("/api/fulfillment-service")) return json({ ok: true });
  return json({ error: "Not found" }, { status: 404 });
}

export const loader = ({ request }: LoaderFunctionArgs) => respond(request);
export const action = ({ request }: ActionFunctionArgs) => respond(request);
