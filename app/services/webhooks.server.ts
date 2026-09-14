import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { applySubscriptionWebhook } from "./billing.server";
import { handleCustomerDataRequest, redactCustomer, redactShop } from "./compliance.server";
import { cancelPurchaseOrder } from "./fulfillment.server";
import { handleFulfillmentRequest } from "./fulfillment-service.server";
import { refreshOrderFromShopify } from "./orders.server";
import { handleProductDeleted, syncProductFromShopify } from "./products.server";
import { getShopByDomain, markShopUninstalled } from "./shop.server";
import { gid, gql, offlineClient } from "./shopify/graphql.server";

/** The mandatory privacy topics: retried far longer than the rest. */
const COMPLIANCE_TOPICS = ["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"];

export interface WebhookDeliveryInput {
  shopDomain: string;
  topic: string;
  webhookId: string;
  eventId?: string | null;
  triggeredAt?: string | Date | null;
  payload: unknown;
}

/**
 * Store a webhook for asynchronous processing. Returns null when this delivery
 * was already stored.
 *
 * Two different things count as "already": the same delivery id (Shopify
 * retries at-least-once), and the same event id for the same store and topic.
 * The second is how a store holding both an app-level and a shop-level
 * subscription to a topic receives each event twice under two delivery ids;
 * with only the delivery id checked, a fulfilment request was accepted twice
 * and a cancelled order was cancelled upstream twice.
 */
export async function recordWebhook(input: WebhookDeliveryInput) {
  const shop = await getShopByDomain(input.shopDomain);
  try {
    return await prisma.webhookEvent.create({
      data: {
        shopId: shop?.id ?? null,
        shopDomain: input.shopDomain,
        topic: input.topic,
        webhookId: input.webhookId,
        eventId: input.eventId || null,
        triggeredAt: parseTriggeredAt(input.triggeredAt),
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null;
    throw error;
  }
}

/** X-Shopify-Triggered-At as a Date; null when absent or unparseable. */
export function parseTriggeredAt(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** How long a webhook waits for its shop to appear before being given up on. */
const WEBHOOK_ORPHAN_TIMEOUT_MS = 60 * 60_000;

/**
 * How long one attempt holds an event. Long enough for the slowest handler (a
 * fulfilment request that prices a whole order upstream), short enough that a
 * process killed mid-attempt does not strand the event for long.
 */
const WEBHOOK_LEASE_MS = 10 * 60_000;

/** Attempts before the sweep stops retrying an event and leaves it for a human. */
export const WEBHOOK_MAX_ATTEMPTS = 25;

/**
 * Take the event for this attempt, atomically.
 *
 * The inline queue, a BullMQ job and the recovery sweep can all reach the same
 * row; without a claim two of them could process it at once. The attempt
 * counter rides along so the sweep knows when to stop.
 */
async function claimWebhookEvent(id: string, now: Date): Promise<boolean> {
  const { count } = await prisma.webhookEvent.updateMany({
    where: { id, processedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + WEBHOOK_LEASE_MS), lastAttemptAt: now, attempts: { increment: 1 } },
  });
  return count === 1;
}

/** Handle a stored webhook. Idempotent per event row. */
export async function processWebhookEvent(webhookEventId: string) {
  if (!(await claimWebhookEvent(webhookEventId, new Date()))) return;
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId }, include: { shop: true } });
  if (!event || event.processedAt) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  try {
    // By domain, not only through the relation: a row recorded before the Shop
    // row existed has no shopId and could never find its store on a retry.
    const domain = event.shopDomain ?? event.shop?.domain ?? null;
    const shop = domain ? await getShopByDomain(domain) : null;
    if (!shop) {
      // Not marked processed. A webhook can legitimately arrive before the
      // install finishes writing the Shop row, and permanently retiring it here
      // silently dropped the delivery — including GDPR topics, which must not
      // be lost. It is retried until the shop appears or the delivery ages out.
      const age = Date.now() - event.createdAt.getTime();
      const message = `shop not found (waiting ${Math.round(age / 60_000)} min)`;
      if (age > WEBHOOK_ORPHAN_TIMEOUT_MS) {
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date(), error: "shop not found; gave up", lockedUntil: null },
        });
        logger.warn("Dropping webhook for an unknown shop", { topic: event.topic, id: event.id });
        return;
      }
      throw new Error(message);
    }
    if (!event.shopId) {
      await prisma.webhookEvent.updateMany({ where: { id: event.id }, data: { shopId: shop.id } });
    }

    switch (event.topic) {
      case "ORDERS_CREATE":
      case "ORDERS_UPDATED":
      case "ORDERS_PAID":
      case "ORDERS_FULFILLED": {
        const client = await offlineClient(shop.domain);
        const shopifyOrderId = gid("Order", String(payload.admin_graphql_api_id ?? payload.id ?? ""));
        if (shopifyOrderId.endsWith("/")) break;
        await refreshOrderFromShopify(shop, client, shopifyOrderId);
        break;
      }
      case "ORDERS_CANCELLED": {
        const client = await offlineClient(shop.domain);
        const shopifyOrderId = gid("Order", String(payload.admin_graphql_api_id ?? payload.id ?? ""));
        // Same empty-id guard the other order topics have: without an id the
        // gid is a bare prefix and the Admin API lookup errors out.
        if (shopifyOrderId.endsWith("/")) break;
        const order = await refreshOrderFromShopify(shop, client, shopifyOrderId);
        if (order && shop.parsedSettings.orders.cancelSupplierOnCancel) {
          const pos = await prisma.purchaseOrder.findMany({ where: { orderId: order.id, status: { in: ["PLACED", "AWAITING_PAYMENT", "PAID"] } } });
          for (const po of pos) {
            await cancelPurchaseOrder(shop, po.id, "Shopify order cancelled", "webhook").catch((error) => logger.warn("Cancel upstream failed", { po: po.id, error }));
          }
        }
        break;
      }
      case "PRODUCTS_UPDATE": {
        const client = await offlineClient(shop.domain);
        await syncProductFromShopify(shop, client, gid("Product", String(payload.admin_graphql_api_id ?? payload.id ?? "")));
        break;
      }
      case "PRODUCTS_DELETE": {
        await handleProductDeleted(shop.id, gid("Product", String(payload.id ?? "")));
        break;
      }
      case "FULFILLMENTS_CREATE":
      case "FULFILLMENTS_UPDATE": {
        // Someone (or another app) fulfilled in Shopify: refresh so lines flip to fulfilled.
        const client = await offlineClient(shop.domain);
        const orderId = payload.order_id ? gid("Order", String(payload.order_id)) : null;
        if (orderId) await refreshOrderFromShopify(shop, client, orderId);
        break;
      }
      case "FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED":
      case "FULFILLMENT_ORDERS_CANCELLATION_REQUEST_SUBMITTED": {
        await handleFulfillmentRequest(shop, event.topic, payload);
        break;
      }
      case "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE": {
        // Routing finished; nothing to do until the merchant requests fulfilment.
        break;
      }
      case "APP_UNINSTALLED": {
        // The trigger time, not the time we got round to it: a delivery that
        // waited in a retry or the sweep must not uninstall a store that has
        // reinstalled since.
        await markShopUninstalled(shop.domain, { triggeredAt: event.triggeredAt ?? event.createdAt });
        break;
      }
      case "APP_SUBSCRIPTIONS_UPDATE": {
        await applySubscriptionWebhook(shop, payload);
        break;
      }
      case "APP_SCOPES_UPDATE": {
        await logActivity(shop.id, { action: "shop.scopes_updated", message: `Access scopes updated: ${String((payload.current as string[] | undefined)?.join(", ") ?? "")}` });
        break;
      }
      case "CUSTOMERS_DATA_REQUEST": {
        await handleCustomerDataRequest(shop, payload);
        break;
      }
      case "CUSTOMERS_REDACT": {
        await redactCustomer(shop, payload);
        break;
      }
      case "SHOP_REDACT": {
        // shop/redact arrives 48 hours after an uninstall, and a retry can come
        // later still. A store that reinstalled in between is a live customer:
        // erasing it deleted its sessions and data while the app was installed.
        // An inactive store is erased as before; an active one is checked with
        // Shopify first, and an unclear answer is retried rather than guessed.
        if (shop.isActive) {
          const state = await appInstallState(shop.domain);
          if (state === "unknown") throw new Error("Could not confirm with Shopify that the app is uninstalled; will retry");
          if (state === "installed") {
            await logActivity(shop.id, { action: "gdpr.shop_redact_skipped", level: "warn", message: `Store erase request ignored: ${shop.domain} has reinstalled the app.` });
            await prisma.webhookEvent.update({
              where: { id: event.id },
              data: { processedAt: new Date(), error: "skipped: store reinstalled", lockedUntil: null },
            });
            return;
          }
        }
        await logActivity(shop.id, { action: "gdpr.shop_redact", message: `Store ${shop.domain} redacted.` }).catch(() => undefined);
        await redactShop(shop, "shop/redact webhook");
        // The WebhookEvent row cascaded away with the Shop, so there is nothing
        // left to mark processed.
        return;
      }
      default:
        logger.info("Unhandled webhook topic", { topic: event.topic });
    }

    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null, lockedUntil: null } });
  } catch (error) {
    logger.error("Webhook processing failed", { topic: event.topic, id: event.id, attempt: event.attempts, error });
    // The row may be gone (a redaction cascaded it away, or the shop was
    // uninstalled mid-flight); updateMany makes that a no-op instead of a
    // second, uncaught P2025 that fails the job through every retry. The lease
    // is released so the queue's own retry can take the event straight back.
    await prisma.webhookEvent.updateMany({ where: { id: event.id }, data: { error: errorMessage(error), lockedUntil: null } });
    throw error;
  }
}

const INSTALL_PROBE = `#graphql
  query DropshipInstallProbe {
    shop { id }
  }
`;

export type InstallState = "installed" | "uninstalled" | "unknown";

/**
 * Whether the app is installed on a store right now, according to Shopify.
 *
 * Shopify revokes the tokens on uninstall, so a trivial query with the offline
 * token answers the question. "unknown" is a network or Shopify failure, which
 * the caller must retry rather than read as either answer.
 */
export async function appInstallState(shopDomain: string): Promise<InstallState> {
  try {
    await gql(await offlineClient(shopDomain), INSTALL_PROBE);
    return "installed";
  } catch (error) {
    const state = classifyInstallProbeError(error);
    if (state === "unknown") logger.warn("Install probe failed", { shop: shopDomain, error });
    return state;
  }
}

/** What a failed install probe says about the installation. Exported for the test. */
export function classifyInstallProbeError(error: unknown): Exclude<InstallState, "installed"> {
  const e = error as { name?: string; response?: { code?: number; body?: { error?: string } } } | null;
  // No offline session at all: the uninstall already cleaned up.
  if (e?.name === "SessionNotFoundError") return "uninstalled";
  const code = e?.response?.code;
  if (code === 401) return "uninstalled";
  // The expiring offline token could not be refreshed because the grant is gone.
  if (code === 400 && (e?.response?.body?.error === "invalid_subject_token" || e?.response?.body?.error === "invalid_grant")) return "uninstalled";
  return "unknown";
}

/** Events younger than this are left alone: their first attempt may still be on its way. */
const SWEEP_GRACE_MS = 2 * 60_000;
/** Minimum gap between two sweep-driven attempts at one event. */
const SWEEP_RETRY_GAP_MS = 10 * 60_000;
/**
 * Ordinary topics stop being worth replaying after Shopify's own two-day
 * redelivery horizon: a fulfilment request replayed a week late does more harm
 * than good. Privacy requests must be honoured within 30 days.
 */
const SWEEP_MAX_AGE_MS = 2 * 24 * 60 * 60_000;
const SWEEP_COMPLIANCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const SWEEP_BATCH = 50;

/**
 * The rows the recovery sweep may hand back to the queue. Exported so the test
 * can pin the rules without a database.
 */
export function pendingWebhookFilter(now: Date): Prisma.WebhookEventWhereInput {
  const at = now.getTime();
  return {
    processedAt: null,
    attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
    createdAt: { lt: new Date(at - SWEEP_GRACE_MS), gt: new Date(at - SWEEP_COMPLIANCE_MAX_AGE_MS) },
    AND: [
      { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(at - SWEEP_RETRY_GAP_MS) } }] },
      { OR: [{ topic: { in: COMPLIANCE_TOPICS } }, { createdAt: { gt: new Date(at - SWEEP_MAX_AGE_MS) } }] },
    ],
  };
}

/**
 * Re-queue stored webhooks nobody finished.
 *
 * Production runs jobs in memory, so a deploy or crash between the 200 and the
 * job's end lost the event: the row kept processedAt null and nothing ever
 * looked at it again. This runs on boot and on a timer (see queue.server) and
 * hands each unfinished, unclaimed event back to the queue. The claim in
 * processWebhookEvent makes a double hand-off harmless.
 */
export async function sweepPendingWebhooks(enqueueWebhook: (webhookEventId: string) => Promise<unknown>, now: Date = new Date()): Promise<number> {
  const rows = await prisma.webhookEvent.findMany({
    where: pendingWebhookFilter(now),
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true, topic: true },
  });
  let queued = 0;
  for (const row of rows) {
    try {
      await enqueueWebhook(row.id);
      queued += 1;
    } catch (error) {
      logger.warn("Could not re-queue a pending webhook", { id: row.id, topic: row.topic, error });
    }
  }
  if (queued) logger.info("Re-queued unfinished webhooks", { queued });
  return queued;
}
