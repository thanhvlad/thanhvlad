import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "@remix-run/node";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { bootJobs, enqueue } from "~/services/jobs/index.server";
import { processWebhookEvent, recordWebhook } from "~/services/webhooks.server";
import { authenticate } from "~/shopify.server";

/**
 * Shared webhook action: verify HMAC, persist, respond fast, process later.
 *
 * The one rule is that a 200 is only ever sent for a delivery that is safely
 * in the database. Shopify never retries a 2xx, and in production jobs run
 * in memory with no Redis behind them, so the row is the only durable copy:
 * the recovery sweep (see sweepPendingWebhooks) reprocesses whatever a restart
 * or a failed job left behind. When the row cannot be written the delivery is
 * refused with a 500 so Shopify sends it again — this used to answer 200 and
 * log, which silently dropped the event, GDPR requests included.
 */
export async function handleWebhookRequest({ request }: ActionFunctionArgs) {
  // Kept for the fallback below; authenticate.webhook consumes the body.
  const copy = request.clone();
  let delivery: VerifiedDelivery;
  try {
    const context = await authenticate.webhook(request);
    delivery = {
      shop: context.shop,
      topic: context.topic,
      webhookId: context.webhookId,
      eventId: context.eventId ?? null,
      triggeredAt: context.triggeredAt ?? null,
      payload: context.payload,
    };
  } catch (error) {
    const fallback = await verifyAfterSessionFailure(copy, error);
    if (!fallback) throw error;
    delivery = fallback;
  }

  bootJobs();

  let event: Awaited<ReturnType<typeof recordWebhook>>;
  try {
    event = await recordWebhook({
      shopDomain: delivery.shop,
      topic: delivery.topic,
      webhookId: delivery.webhookId,
      eventId: delivery.eventId,
      triggeredAt: delivery.triggeredAt,
      payload: delivery.payload,
    });
  } catch (error) {
    logger.error("Failed to record webhook; asking Shopify to redeliver", { shop: delivery.shop, topic: delivery.topic, error });
    return new Response(null, { status: 500 });
  }
  // A delivery or event already stored: acknowledge, the first copy owns the work.
  if (!event) return new Response(null, { status: 200 });

  if (delivery.topic === "APP_UNINSTALLED") {
    // Handled before answering, as Shopify's own template does: it is a few
    // database writes, and every second it waits in memory is a second in which
    // a restart loses it or a reinstall races it. A failure here is still
    // acknowledged, because the row is stored and the sweep retries it.
    try {
      await processWebhookEvent(event.id);
    } catch (error) {
      logger.warn("Inline uninstall processing failed; the recovery sweep will retry", { shop: delivery.shop, error });
    }
    return new Response(null, { status: 200 });
  }

  try {
    // A long window: Shopify re-delivers the same event for up to two days,
    // and each delivery must collapse onto the one job.
    await enqueue("process-webhook", { webhookEventId: event.id }, { dedupeKey: `webhook-${event.id}`, dedupeWindowMs: 24 * 60 * 60_000 });
  } catch (error) {
    // Stored, so not lost: the sweep enqueues it again once the queue is back.
    logger.error("Failed to enqueue webhook; the recovery sweep will pick it up", { shop: delivery.shop, topic: delivery.topic, error });
  }
  return new Response(null, { status: 200 });
}

export interface VerifiedDelivery {
  shop: string;
  topic: string;
  webhookId: string;
  eventId: string | null;
  triggeredAt: string | null;
  payload: unknown;
}

/**
 * authenticate.webhook validates the HMAC and then, before returning, refreshes
 * the store's expiring offline token. For a store that has just uninstalled,
 * that refresh is refused, so the library throws on a delivery it had already
 * verified — and app/uninstalled (and a later shop/redact, when sessions were
 * never cleaned up) failed every retry and was lost for good.
 *
 * A thrown 400/401/405 Response is the library rejecting the request itself
 * and is passed through. Anything else happened after validation, so the
 * delivery is verified here, independently, with the app secret; nothing is
 * accepted that the HMAC does not prove came from Shopify.
 */
async function verifyAfterSessionFailure(request: Request, error: unknown): Promise<VerifiedDelivery | null> {
  if (error instanceof Response && error.status < 500) return null;
  const secret = env().SHOPIFY_API_SECRET;
  if (!secret) return null;
  const rawBody = await request.text().catch(() => null);
  if (rawBody === null) return null;
  const delivery = verifyWebhookDelivery(rawBody, request.headers, secret);
  if (delivery) logger.warn("Webhook accepted after the offline session could not be refreshed", { shop: delivery.shop, topic: delivery.topic, error });
  return delivery;
}

/** Independent HMAC check of a classic webhook delivery. Exported for the test. */
export function verifyWebhookDelivery(rawBody: string, headers: Headers, secret: string): VerifiedDelivery | null {
  const hmac = headers.get("x-shopify-hmac-sha256");
  const topic = headers.get("x-shopify-topic");
  const shop = headers.get("x-shopify-shop-domain");
  const webhookId = headers.get("x-shopify-webhook-id");
  if (!hmac || !topic || !shop || !webhookId || !secret) return null;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmac, "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return null;
  }
  return {
    shop,
    // The library's storage form: "app/uninstalled" -> "APP_UNINSTALLED".
    topic: topic.toUpperCase().replace(/\/|\./g, "_"),
    webhookId,
    eventId: headers.get("x-shopify-event-id"),
    triggeredAt: headers.get("x-shopify-triggered-at"),
    payload,
  };
}
