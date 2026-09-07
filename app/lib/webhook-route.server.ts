import type { ActionFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import { bootJobs, enqueue } from "~/services/jobs/index.server";
import { recordWebhook } from "~/services/webhooks.server";
import { authenticate } from "~/shopify.server";

/**
 * Shared webhook action: verify HMAC, persist, enqueue, respond 200 fast.
 * Shopify drops the subscription after repeated slow/failed responses, so the
 * actual work never runs in the request.
 */
export async function handleWebhookRequest({ request }: ActionFunctionArgs) {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);
  bootJobs();
  try {
    const event = await recordWebhook({ shopDomain: shop, topic, webhookId, payload });
    if (event) {
      await enqueue("process-webhook", { webhookEventId: event.id }, { dedupeKey: `webhook-${event.id}` });
    }
  } catch (error) {
    // Still 200: Shopify would otherwise retry and we already logged it.
    logger.error("Failed to record webhook", { shop, topic, error });
  }
  return new Response(null, { status: 200 });
}
