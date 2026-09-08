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
import { gid, offlineClient } from "./shopify/graphql.server";

/**
 * Store a webhook for asynchronous processing. Returns null when this
 * delivery id was already seen (Shopify retries at-least-once).
 */
export async function recordWebhook(input: { shopDomain: string; topic: string; webhookId: string; payload: unknown }) {
  const shop = await getShopByDomain(input.shopDomain);
  try {
    return await prisma.webhookEvent.create({
      data: {
        shopId: shop?.id ?? null,
        topic: input.topic,
        webhookId: input.webhookId,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null;
    throw error;
  }
}

/** How long a webhook waits for its shop to appear before being given up on. */
const WEBHOOK_ORPHAN_TIMEOUT_MS = 60 * 60_000;

/** Handle a stored webhook. Idempotent per event row. */
export async function processWebhookEvent(webhookEventId: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId }, include: { shop: true } });
  if (!event || event.processedAt) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  try {
    const shop = event.shop ? await getShopByDomain(event.shop.domain) : null;
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
          data: { processedAt: new Date(), error: "shop not found; gave up" },
        });
        logger.warn("Dropping webhook for an unknown shop", { topic: event.topic, id: event.id });
        return;
      }
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { error: message } });
      throw new Error(message);
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
        await markShopUninstalled(shop.domain);
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
        await logActivity(shop.id, { action: "gdpr.shop_redact", message: `Store ${shop.domain} redacted.` }).catch(() => undefined);
        await redactShop(shop, "shop/redact webhook");
        // The WebhookEvent row cascaded away with the Shop, so there is nothing
        // left to mark processed.
        return;
      }
      default:
        logger.info("Unhandled webhook topic", { topic: event.topic });
    }

    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null } });
  } catch (error) {
    logger.error("Webhook processing failed", { topic: event.topic, id: event.id, error });
    // The row may be gone (a redaction cascaded it away, or the shop was
    // uninstalled mid-flight); updateMany makes that a no-op instead of a
    // second, uncaught P2025 that fails the job through every retry.
    await prisma.webhookEvent.updateMany({ where: { id: event.id }, data: { error: errorMessage(error) } });
    throw error;
  }
}
