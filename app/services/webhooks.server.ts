import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
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

/** Handle a stored webhook. Idempotent per event row. */
export async function processWebhookEvent(webhookEventId: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId }, include: { shop: true } });
  if (!event || event.processedAt) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  try {
    const shop = event.shop ? await getShopByDomain(event.shop.domain) : null;
    if (!shop) {
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: "shop not found" } });
      return;
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
      case "APP_SCOPES_UPDATE": {
        await logActivity(shop.id, { action: "shop.scopes_updated", message: `Access scopes updated: ${String((payload.current as string[] | undefined)?.join(", ") ?? "")}` });
        break;
      }
      case "CUSTOMERS_DATA_REQUEST": {
        await logActivity(shop.id, { action: "gdpr.data_request", message: "Customer data request received.", meta: { customerId: payload.customer } });
        break;
      }
      case "CUSTOMERS_REDACT": {
        const orderIds = ((payload.orders_to_redact as number[] | undefined) ?? []).map((id) => gid("Order", id));
        await prisma.order.updateMany({
          where: { shopId: shop.id, shopifyOrderId: { in: orderIds } },
          data: { customerName: null, customerEmail: null, phone: null, shippingAddress: {} },
        });
        await logActivity(shop.id, { action: "gdpr.customer_redact", message: `Redacted ${orderIds.length} order(s).` });
        break;
      }
      case "SHOP_REDACT": {
        await prisma.shop.delete({ where: { id: shop.id } }).catch(() => undefined);
        break;
      }
      default:
        logger.info("Unhandled webhook topic", { topic: event.topic });
    }

    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null } });
  } catch (error) {
    logger.error("Webhook processing failed", { topic: event.topic, id: event.id, error });
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { error: errorMessage(error) } });
    throw error;
  }
}
