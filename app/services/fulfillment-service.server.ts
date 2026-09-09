import type { FulfillmentRequestStatus, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { env } from "~/lib/env.server";
import { blocksPlacement } from "~/domain/orders/pipeline";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { notify } from "./notifications.server";
import { cancelPurchaseOrder, placeSupplierOrders } from "./fulfillment.server";
import { evaluateAndStoreOrder, orderIssues, refreshOrderFromShopify } from "./orders.server";
import type { ShopWithSettings } from "./shop.server";
import { gid, offlineClient, type GraphqlClient } from "./shopify/graphql.server";
import {
  acceptCancellationRequest,
  acceptFulfillmentRequest,
  assignVariantToLocation,
  createFulfillmentService,
  deleteFulfillmentService,
  inventoryLevelsFor,
  listFulfillmentServices,
  rejectCancellationRequest,
  rejectFulfillmentRequest,
  updateFulfillmentServiceCallback,
  type RejectionReason,
} from "./shopify/fulfillment-service.server";

/**
 * The app as a Shopify fulfilment service.
 *
 * Once registered, every Shopify order containing a product stocked at the app's
 * location shows a native **Request fulfillment** button. Pressing it sends a
 * `fulfillment_orders/fulfillment_request_submitted` webhook; we accept it, place
 * the supplier order, and later fulfil with the tracking number.
 */

const SERVICE_NAME = "DropshipHub";

export function callbackUrl(): string {
  return `${env().SHOPIFY_APP_URL.replace(/\/$/, "")}/api/fulfillment-service`;
}

export interface FulfillmentServiceState {
  registered: boolean;
  serviceId: string | null;
  locationId: string | null;
  locationName: string | null;
  registeredAt: Date | null;
  /** Managed products whose inventory already sits at the app's location. */
  assignedVariants: number;
  totalVariants: number;
  pendingRequests: number;
}

export async function getFulfillmentServiceState(shop: ShopWithSettings, client?: GraphqlClient): Promise<FulfillmentServiceState> {
  const [totalVariants, pendingRequests] = await Promise.all([
    prisma.productVariant.count({ where: { product: { shopId: shop.id } } }),
    prisma.fulfillmentRequest.count({ where: { order: { shopId: shop.id }, status: "SUBMITTED" } }),
  ]);

  let locationName: string | null = null;
  if (shop.fulfillmentServiceId && client) {
    try {
      const services = await listFulfillmentServices(client);
      locationName = services.find((s) => s.id === shop.fulfillmentServiceId)?.locationName ?? null;
    } catch (error) {
      logger.warn("Could not read fulfilment services", { shopId: shop.id, error });
    }
  }

  return {
    registered: Boolean(shop.fulfillmentServiceId && shop.fulfillmentLocationId),
    serviceId: shop.fulfillmentServiceId,
    locationId: shop.fulfillmentLocationId,
    locationName,
    registeredAt: shop.fulfillmentServiceRegisteredAt,
    assignedVariants: await prisma.productVariant.count({
      where: { product: { shopId: shop.id }, fulfillmentAssigned: true },
    }),
    totalVariants,
    pendingRequests,
  };
}

/** Register (or re-attach to) the fulfilment service and store its location. */
export async function registerFulfillmentService(shop: ShopWithSettings, client: GraphqlClient, actor?: string) {
  const url = callbackUrl();

  // Re-attach if a previous install already created it — Shopify rejects a
  // duplicate service name, and merchants reinstall apps all the time.
  const existing = await listFulfillmentServices(client).catch(() => []);
  const mine = existing.find((s) => s.serviceName === SERVICE_NAME || s.callbackUrl?.includes("/api/fulfillment-service"));

  let service = mine;
  if (mine) {
    if (mine.callbackUrl !== url) {
      await updateFulfillmentServiceCallback(client, mine.id, url).catch((error) =>
        logger.warn("Could not update fulfilment service callback", { error }),
      );
    }
  } else {
    service = await createFulfillmentService(client, { name: SERVICE_NAME, callbackUrl: url });
  }
  if (!service?.locationId) {
    throw new Error("Shopify created the fulfilment service but returned no location.");
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      fulfillmentServiceId: service.id,
      fulfillmentLocationId: service.locationId,
      fulfillmentServiceRegisteredAt: new Date(),
    },
  });
  await logActivity(shop.id, {
    actor,
    action: "fulfillment_service.registered",
    message: `Registered as a Shopify fulfilment service; location "${service.locationName ?? service.locationId}" created.`,
  });
  return service;
}

export async function unregisterFulfillmentService(shop: ShopWithSettings, client: GraphqlClient, actor?: string) {
  if (!shop.fulfillmentServiceId) return;
  try {
    await deleteFulfillmentService(client, shop.fulfillmentServiceId, shop.primaryLocationId);
  } catch (error) {
    // Shopify refuses to delete while inventory still sits there; surface it.
    throw new Error(`Shopify would not remove the fulfilment service: ${errorMessage(error)}`);
  }
  await prisma.shop.update({
    where: { id: shop.id },
    data: { fulfillmentServiceId: null, fulfillmentLocationId: null, fulfillmentServiceRegisteredAt: null },
  });
  await logActivity(shop.id, { actor, action: "fulfillment_service.removed", message: "Fulfilment service removed." });
}

/**
 * Stock the given managed products at the app's location so Shopify routes
 * their fulfilment orders here.
 */
export async function assignProductsToService(
  shop: ShopWithSettings,
  client: GraphqlClient,
  productIds: string[],
  actor?: string,
) {
  if (!shop.fulfillmentLocationId) throw new Error("Register the fulfilment service first.");
  const variants = await prisma.productVariant.findMany({
    where: { product: { shopId: shop.id, id: { in: productIds } }, inventoryItemId: { not: null } },
    select: { id: true, inventoryItemId: true, inventoryQuantity: true, product: { select: { title: true } } },
  });

  let assigned = 0;
  const errors: string[] = [];
  for (const variant of variants) {
    try {
      await assignVariantToLocation(client, variant.inventoryItemId!, shop.fulfillmentLocationId, variant.inventoryQuantity);
      await prisma.productVariant.update({ where: { id: variant.id }, data: { fulfillmentAssigned: true } });
      assigned += 1;
    } catch (error) {
      errors.push(`${variant.product.title}: ${errorMessage(error)}`);
    }
  }
  await logActivity(shop.id, {
    actor,
    action: "fulfillment_service.assigned",
    message: `${assigned} variant(s) stocked at the app's fulfilment location${errors.length ? `; ${errors.length} failed` : ""}.`,
  });
  return { assigned, total: variants.length, errors };
}

export async function locationsForVariant(client: GraphqlClient, inventoryItemId: string) {
  return inventoryLevelsFor(client, inventoryItemId);
}

// ---------------------------------------------------------------------------
// Webhook handling
// ---------------------------------------------------------------------------

interface RequestPayload {
  kind: "REQUEST" | "CANCELLATION";
  shopifyOrderId: string | null;
  fulfillmentOrderId: string;
  message: string | null;
  lineItems: Array<{ fulfillmentOrderLineItemId: string; shopifyLineItemId: string | null; quantity: number }>;
}

/**
 * Shopify's fulfilment-order webhooks carry the fulfilment order under a few
 * different shapes depending on topic and API version, so the payload is read
 * defensively and the parts we cannot find are simply left null.
 */
export function parseFulfillmentRequestPayload(topic: string, payload: Record<string, unknown>): RequestPayload | null {
  const fo = (payload.fulfillment_order ?? payload) as Record<string, unknown>;
  const rawId = fo.id ?? (payload as Record<string, unknown>).fulfillment_order_id;
  if (!rawId) return null;
  const fulfillmentOrderId = gid("FulfillmentOrder", String(rawId));
  const orderIdRaw = fo.order_id ?? (payload as Record<string, unknown>).order_id;
  const rawItems = (fo.line_items ?? (payload as Record<string, unknown>).fulfillment_order_line_items ?? []) as Array<
    Record<string, unknown>
  >;
  return {
    kind: topic.includes("CANCELLATION") ? "CANCELLATION" : "REQUEST",
    shopifyOrderId: orderIdRaw ? gid("Order", String(orderIdRaw)) : null,
    fulfillmentOrderId,
    message: (payload.message as string) ?? (fo.request_message as string) ?? null,
    lineItems: rawItems.map((li) => ({
      fulfillmentOrderLineItemId: gid("FulfillmentOrderLineItem", String(li.id ?? "")),
      shopifyLineItemId: li.line_item_id ? gid("LineItem", String(li.line_item_id)) : null,
      quantity: Number(li.quantity ?? 0),
    })),
  };
}

/**
 * Handle "Request fulfillment": record it, accept it in Shopify, then place the
 * supplier order when the merchant has auto-placement on (or the order is
 * otherwise ready).
 */
export async function handleFulfillmentRequest(shop: ShopWithSettings, topic: string, payload: Record<string, unknown>) {
  const parsed = parseFulfillmentRequestPayload(topic, payload);
  if (!parsed) {
    logger.warn("Unrecognised fulfilment-order webhook payload", { topic });
    return;
  }
  const client = await offlineClient(shop.domain);

  // Make sure we have the order before responding to Shopify.
  let order = parsed.shopifyOrderId
    ? await prisma.order.findUnique({ where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: parsed.shopifyOrderId } } })
    : null;
  if (!order && parsed.shopifyOrderId) {
    order = await refreshOrderFromShopify(shop, client, parsed.shopifyOrderId);
  }
  if (!order) {
    logger.warn("Fulfilment request for an unknown order", { fulfillmentOrderId: parsed.fulfillmentOrderId });
    return;
  }

  if (parsed.kind === "CANCELLATION") {
    await prisma.fulfillmentRequest.updateMany({
      where: { orderId: order.id, shopifyFulfillmentOrderId: parsed.fulfillmentOrderId },
      data: { status: "CANCELLATION_REQUESTED" },
    });
    // Only a live supplier order can block a cancellation. Counting tracking
    // across every purchase order on the Shopify order, cancelled ones
    // included, let old history veto a new cancellation.
    const livePurchaseOrders = await prisma.purchaseOrder.findMany({
      where: { orderId: order.id, status: { notIn: ["CANCELED", "FAILED"] } },
      select: { id: true },
    });
    const shipped = livePurchaseOrders.length
      ? await prisma.trackingNumber.count({ where: { purchaseOrderId: { in: livePurchaseOrders.map((p) => p.id) } } })
      : 0;

    if (shipped === 0) {
      await acceptCancellationRequest(client, parsed.fulfillmentOrderId, "Cancelled before the supplier shipped.");

      // Cancel upstream as well. Accepting in Shopify while leaving the supplier
      // order open kept it in the payment queue and in payment reminders, so the
      // merchant was chased to pay for an order Shopify had already abandoned.
      for (const po of livePurchaseOrders) {
        try {
          await cancelPurchaseOrder(shop, po.id, "Cancelled by the merchant in Shopify", "fulfillment-service");
        } catch (error) {
          logger.warn("Could not cancel the supplier order after a Shopify cancellation", {
            purchaseOrderId: po.id,
            error,
          });
        }
      }

      await prisma.fulfillmentRequest.updateMany({
        where: { orderId: order.id, shopifyFulfillmentOrderId: parsed.fulfillmentOrderId },
        data: { status: "CANCELLED", respondedAt: new Date() },
      });
      await logActivity(shop.id, {
        action: "fulfillment_service.cancelled",
        entity: "Order",
        entityId: order.id,
        message: `${order.name}: fulfilment cancelled at the merchant's request.`,
      });
    } else {
      // Shopify has to be told. Writing only a log line left the cancellation
      // request pending in the admin forever, with nothing on the other end.
      const message = `Already shipped: the supplier has ${shipped} tracking number(s) for this order.`;
      await rejectCancellationRequest(client, parsed.fulfillmentOrderId, message);
      await prisma.fulfillmentRequest.updateMany({
        where: { orderId: order.id, shopifyFulfillmentOrderId: parsed.fulfillmentOrderId },
        data: { status: "CLOSED", responseMessage: message, respondedAt: new Date() },
      });
      await logActivity(shop.id, {
        action: "fulfillment_service.cancel_rejected",
        entity: "Order",
        entityId: order.id,
        level: "warn",
        message: `${order.name}: cancellation refused, the supplier already shipped.`,
      });
    }
    return;
  }

  const request = await prisma.fulfillmentRequest.upsert({
    where: { orderId_shopifyFulfillmentOrderId: { orderId: order.id, shopifyFulfillmentOrderId: parsed.fulfillmentOrderId } },
    create: {
      orderId: order.id,
      shopifyFulfillmentOrderId: parsed.fulfillmentOrderId,
      requestMessage: parsed.message,
      lineItems: parsed.lineItems as unknown as Prisma.InputJsonValue,
    },
    update: { status: "SUBMITTED", requestMessage: parsed.message, respondedAt: null },
  });

  // Decide before answering Shopify: rejecting with a reason is far more useful
  // to the merchant than accepting and then failing silently.
  const evaluated = await evaluateAndStoreOrder(shop, order.id);
  // `blocksPlacement` rather than a bare severity check: a purchase order that
  // failed earlier is an error worth showing, but it is not a reason to refuse
  // to place the lines that are still outstanding.
  const blocking = orderIssues(evaluated).filter(blocksPlacement);

  // Reject on ANY blocking issue. Only the mapping codes were checked here
  // before, so OUT_OF_STOCK, NOT_PAID and HIGH_RISK fell through to accept:
  // Shopify then believed the app owned a fulfilment that was going nowhere,
  // with no rejection to prompt the merchant and no retry.
  if (blocking.length > 0) {
    const message = `Not fulfillable yet: ${blocking[0].message}`;
    await rejectFulfillmentRequest(client, parsed.fulfillmentOrderId, message, reasonFor(blocking));
    await prisma.fulfillmentRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", responseMessage: message, respondedAt: new Date() },
    });
    await notify(shop.id, {
      type: "order.failed",
      severity: "warning",
      title: `${order.name}: fulfilment request rejected`,
      body: message,
      link: `/app/orders/${order.id}`,
      dedupeKey: `fo-reject:${request.id}`,
    });
    return;
  }

  await acceptFulfillmentRequest(client, parsed.fulfillmentOrderId, "Sent to the supplier by DropshipHub.");
  await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "ACCEPTED", respondedAt: new Date() },
  });
  await logActivity(shop.id, {
    action: "fulfillment_service.accepted",
    entity: "Order",
    entityId: order.id,
    message: `${order.name}: fulfilment request accepted from Shopify.`,
  });

  // Place the supplier order right away when nothing blocks it; otherwise the
  // order sits in the pipeline with its reasons visible, as usual.
  if (blocking.length === 0) {
    const outcome = await placeSupplierOrders(shop, order.id, { actor: "fulfillment-request" });
    if (!outcome.ok) {
      await notify(shop.id, {
        type: "order.failed",
        severity: "critical",
        title: `${order.name}: could not place the supplier order`,
        body: outcome.error,
        link: `/app/orders/${order.id}`,
        dedupeKey: `fo-place:${request.id}`,
      });
    }
  } else {
    await notify(shop.id, {
      type: "order.failed",
      severity: "warning",
      title: `${order.name}: accepted but on hold`,
      body: blocking[0].message,
      link: `/app/orders/${order.id}`,
      dedupeKey: `fo-hold:${request.id}`,
    });
  }
}

function reasonFor(issues: Array<{ code: string }>): RejectionReason {
  if (issues.some((i) => i.code.startsWith("ADDRESS_"))) return "INCORRECT_ADDRESS";
  if (issues.some((i) => i.code === "OUT_OF_STOCK")) return "INVENTORY_OUT_OF_STOCK";
  if (issues.some((i) => i.code === "NO_COUNTRY_MATCH")) return "UNDELIVERABLE_DESTINATION";
  if (issues.some((i) => i.code.startsWith("NO_MAPPING") || i.code === "MAPPING_NOT_RESOLVED")) return "INELIGIBLE_PRODUCT";
  return "OTHER";
}

export async function listFulfillmentRequests(shopId: string, options: { status?: FulfillmentRequestStatus; limit?: number } = {}) {
  return prisma.fulfillmentRequest.findMany({
    where: { order: { shopId }, ...(options.status ? { status: options.status } : {}) },
    include: { order: { select: { id: true, name: true, stage: true } } },
    orderBy: { requestedAt: "desc" },
    take: options.limit ?? 50,
  });
}
