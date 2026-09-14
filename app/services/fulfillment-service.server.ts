import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type FulfillmentRequest, type FulfillmentRequestStatus } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { env } from "~/lib/env.server";
import { blocksPlacement } from "~/domain/orders/pipeline";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { notify } from "./notifications.server";
import { cancelPurchaseOrder, placeSupplierOrders, quoteSupplierOrders, type SupplierQuote } from "./fulfillment.server";
import { evaluateAndStoreOrder, orderIssues, refreshOrderFromShopify } from "./orders.server";
import type { ShopWithSettings } from "./shop.server";
import { assertNoUserErrors, gid, gql, offlineClient, type GraphqlClient, type UserError } from "./shopify/graphql.server";
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
 * location shows a native **Request fulfillment** button. Pressing it reaches the
 * app two ways: the `fulfillment_orders/fulfillment_request_submitted` webhook
 * and a POST to `<callbackUrl>/fulfillment_order_notification`. Neither carries
 * the order, so both only prompt the app to read the fulfilment order from
 * Shopify and act on what Shopify says now.
 *
 * A request is answered in Shopify only once the app knows the answer. With the
 * approval gate on (the default) it is priced and left SUBMITTED while the
 * merchant decides: approving places the supplier order and then accepts,
 * declining rejects, and a request nobody approves is rejected before Shopify's
 * response window closes.
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
    // Both states are "the merchant still has to do something": SUBMITTED is
    // one we have not answered, AWAITING_APPROVAL is one waiting on them.
    prisma.fulfillmentRequest.count({ where: { order: { shopId: shop.id }, status: { in: ["SUBMITTED", "AWAITING_APPROVAL"] } } }),
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

  // Shopify routes a fulfilment order to the location holding the stock. Leaving
  // a variant stocked at the merchant's own location means their "Request
  // fulfillment" button goes there and this app is never asked, so the primary
  // location is released as part of assigning.
  const release = shop.primaryLocationId ? [shop.primaryLocationId] : [];

  let assigned = 0;
  const errors: string[] = [];
  const stillStocked: string[] = [];
  for (const variant of variants) {
    try {
      const outcome = await assignVariantToLocation(
        client,
        variant.inventoryItemId!,
        shop.fulfillmentLocationId,
        variant.inventoryQuantity,
        release,
      );
      await prisma.productVariant.update({ where: { id: variant.id }, data: { fulfillmentAssigned: true } });
      assigned += 1;
      for (const blocked of outcome.stillStocked) {
        stillStocked.push(`${variant.product.title}: still stocked at ${blocked.locationName} — ${blocked.reason}`);
      }
    } catch (error) {
      errors.push(`${variant.product.title}: ${errorMessage(error)}`);
    }
  }
  await logActivity(shop.id, {
    actor,
    action: "fulfillment_service.assigned",
    level: errors.length || stillStocked.length ? "warn" : "info",
    message:
      `${assigned} of ${variants.length} variant(s) stocked at the app's fulfilment location` +
      `${errors.length ? `; ${errors.length} failed` : ""}` +
      `${stillStocked.length ? `; ${stillStocked.length} still stocked elsewhere` : ""}.`,
  });
  // A variant left on both locations is assigned but will not route here, so the
  // caller is told about it in the same list as the outright failures.
  return { assigned, total: variants.length, errors: [...errors, ...stillStocked] };
}

export async function locationsForVariant(client: GraphqlClient, inventoryItemId: string) {
  return inventoryLevelsFor(client, inventoryItemId);
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * How long a request may wait for the merchant before the app declines it.
 *
 * Built for Shopify 5.8.6 counts a fulfilment request as answered only once it
 * is accepted or rejected, and wants that within 24 hours. The sweep that
 * enforces this runs every ten minutes and can itself be delayed by a restart,
 * so the app gives up well inside the window rather than at its edge.
 */
export const APPROVAL_WINDOW_MS = 20 * 60 * 60_000;

/** When the merchant is reminded that a request is still waiting. */
export const APPROVAL_REMINDER_MS = 12 * 60 * 60_000;

/**
 * A SUBMITTED row younger than this is taken to be in the hands of another run
 * (the webhook and the callback arrive together). An older one was left behind
 * by a crash and is picked up again.
 */
const IN_FLIGHT_MS = 5 * 60_000;

export function approvalDeadline(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + APPROVAL_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Reading fulfilment orders from Shopify
// ---------------------------------------------------------------------------

const LIVE_FULFILLMENT_ORDER_FIELDS = `
  id
  status
  requestStatus
  orderId
  assignedLocation { location { id } }
  lineItems(first: 100) { nodes { id totalQuantity lineItem { id } } }
  merchantRequests(first: 5, kind: FULFILLMENT_REQUEST) { nodes { message kind sentAt } }
`;

const FULFILLMENT_ORDER_QUERY = `#graphql
  query DropshipFulfillmentOrderForRequest($id: ID!) {
    fulfillmentOrder(id: $id) {
      ${LIVE_FULFILLMENT_ORDER_FIELDS}
    }
  }
`;

const ASSIGNED_FULFILLMENT_ORDERS_QUERY = `#graphql
  query DropshipAssignedFulfillmentOrders($status: FulfillmentOrderAssignmentStatus, $locationIds: [ID!], $after: String) {
    assignedFulfillmentOrders(first: 50, after: $after, assignmentStatus: $status, locationIds: $locationIds) {
      nodes {
        ${LIVE_FULFILLMENT_ORDER_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Kept beside the flow that needs it: the accept-first design never had a way
// to hand an accepted order back, which is why "Decline" called reject on an
// order Shopify no longer allowed to be rejected.
const CLOSE_FULFILLMENT_ORDER = `#graphql
  mutation DropshipCloseFulfillmentOrder($id: ID!, $message: String) {
    fulfillmentOrderClose(id: $id, message: $message) {
      fulfillmentOrder { id status requestStatus }
      userErrors { field message }
    }
  }
`;

interface RawLiveFulfillmentOrder {
  id: string;
  status: string;
  requestStatus: string;
  orderId: string;
  assignedLocation: { location: { id: string } | null } | null;
  lineItems: { nodes: Array<{ id: string; totalQuantity: number; lineItem: { id: string } }> };
  merchantRequests: { nodes: Array<{ message: string | null; kind: string; sentAt: string }> };
}

interface AssignedPage {
  assignedFulfillmentOrders: { nodes: RawLiveFulfillmentOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

/** A fulfilment order as Shopify holds it right now. */
export interface LiveFulfillmentOrder {
  id: string;
  /** FulfillmentOrderStatus: OPEN, IN_PROGRESS, CLOSED, INCOMPLETE, ... */
  status: string;
  /** FulfillmentOrderRequestStatus: SUBMITTED, ACCEPTED, CANCELLATION_REQUESTED, ... */
  requestStatus: string;
  orderId: string;
  locationId: string | null;
  lineItems: Array<{ fulfillmentOrderLineItemId: string; shopifyLineItemId: string; quantity: number }>;
  /** The note the merchant typed in the most recent request dialog. */
  requestMessage: string | null;
}

function toLive(raw: RawLiveFulfillmentOrder): LiveFulfillmentOrder {
  const latest = [...raw.merchantRequests.nodes].sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
  return {
    id: raw.id,
    status: raw.status,
    requestStatus: raw.requestStatus,
    orderId: raw.orderId,
    locationId: raw.assignedLocation?.location?.id ?? null,
    lineItems: raw.lineItems.nodes.map((li) => ({
      fulfillmentOrderLineItemId: li.id,
      shopifyLineItemId: li.lineItem.id,
      quantity: li.totalQuantity,
    })),
    requestMessage: latest?.message || null,
  };
}

export async function fetchLiveFulfillmentOrder(client: GraphqlClient, fulfillmentOrderId: string): Promise<LiveFulfillmentOrder | null> {
  const data = await gql<{ fulfillmentOrder: RawLiveFulfillmentOrder | null }>(client, FULFILLMENT_ORDER_QUERY, { id: fulfillmentOrderId });
  return data.fulfillmentOrder ? toLive(data.fulfillmentOrder) : null;
}

/**
 * Every fulfilment order at the app's location in the given assignment state.
 *
 * `complete` is false when the page cap was hit, so a caller never concludes
 * that a request has gone from Shopify only because it was on a page not read.
 */
export async function listAssignedFulfillmentOrders(
  client: GraphqlClient,
  status: "FULFILLMENT_REQUESTED" | "CANCELLATION_REQUESTED",
  locationId: string,
  maxPages = 5,
): Promise<{ orders: LiveFulfillmentOrder[]; complete: boolean }> {
  const orders: LiveFulfillmentOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data: AssignedPage = await gql<AssignedPage>(client, ASSIGNED_FULFILLMENT_ORDERS_QUERY, { status, locationIds: [locationId], after });
    orders.push(...data.assignedFulfillmentOrders.nodes.map(toLive));
    if (!data.assignedFulfillmentOrders.pageInfo.hasNextPage) return { orders, complete: true };
    after = data.assignedFulfillmentOrders.pageInfo.endCursor;
  }
  return { orders, complete: false };
}

export async function closeFulfillmentOrder(client: GraphqlClient, fulfillmentOrderId: string, message: string) {
  const data = await gql<{ fulfillmentOrderClose: { userErrors: UserError[] } }>(client, CLOSE_FULFILLMENT_ORDER, {
    id: fulfillmentOrderId,
    message,
  });
  assertNoUserErrors(data.fulfillmentOrderClose.userErrors, "fulfillmentOrderClose");
}

/**
 * The fulfilment order a webhook is about.
 *
 * `fulfillment_request_submitted` puts it under `submitted_fulfillment_order`,
 * `cancellation_request_submitted` under `fulfillment_order`. Neither carries
 * the order id or the line items: the old parser looked for both, found
 * neither, and every real webhook was dropped as "unknown order".
 */
export function fulfillmentOrderIdFromPayload(payload: Record<string, unknown>): string | null {
  const candidates = [payload.submitted_fulfillment_order, payload.fulfillment_order, payload.original_fulfillment_order];
  for (const candidate of candidates) {
    const id = (candidate as { id?: unknown } | null | undefined)?.id;
    if (id !== undefined && id !== null && String(id)) return gid("FulfillmentOrder", String(id));
  }
  const bare = payload.fulfillment_order_id ?? payload.id;
  return bare !== undefined && bare !== null && String(bare) ? gid("FulfillmentOrder", String(bare)) : null;
}

/**
 * Whether a callback request really came from Shopify.
 *
 * Shopify signs `fulfillment_order_notification` the way it signs webhooks: a
 * base64 HMAC-SHA256 of the raw body under the app's secret. Anything else
 * could make the app spend Admin API calls on demand for whoever asks.
 */
export function verifyShopifyHmac(rawBody: string | Buffer, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Acting on requests
// ---------------------------------------------------------------------------

/** Fulfilment orders being worked on in this process, so two triggers do not race. */
const inFlight = new Set<string>();

/**
 * Handle a fulfilment-order webhook: read the fulfilment order it names from
 * Shopify and act on its current state.
 */
export async function handleFulfillmentRequest(shop: ShopWithSettings, topic: string, payload: Record<string, unknown>) {
  const fulfillmentOrderId = fulfillmentOrderIdFromPayload(payload);
  if (!fulfillmentOrderId) {
    logger.warn("Unrecognised fulfilment-order webhook payload", { topic });
    return;
  }
  const client = await offlineClient(shop.domain);
  const live = await fetchLiveFulfillmentOrder(client, fulfillmentOrderId);
  if (!live) {
    logger.warn("Fulfilment order from a webhook no longer exists", { topic, fulfillmentOrderId });
    return;
  }
  await processFulfillmentOrder(shop, client, live);
}

/**
 * Act on one fulfilment order according to what Shopify says about it now.
 *
 * Reading the state rather than trusting the trigger makes the webhook, the
 * callback and the periodic sweep safe to deliver the same request twice.
 */
export async function processFulfillmentOrder(shop: ShopWithSettings, client: GraphqlClient, live: LiveFulfillmentOrder) {
  // Only requests routed to this app's own location are ours to answer.
  if (shop.fulfillmentLocationId && live.locationId && live.locationId !== shop.fulfillmentLocationId) return;
  if (live.requestStatus !== "SUBMITTED" && live.requestStatus !== "CANCELLATION_REQUESTED") return;
  if (inFlight.has(live.id)) return;
  inFlight.add(live.id);
  try {
    let order = await prisma.order.findUnique({ where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: live.orderId } } });
    if (!order) order = await refreshOrderFromShopify(shop, client, live.orderId);
    if (!order) {
      logger.warn("Fulfilment request for an unknown order", { fulfillmentOrderId: live.id });
      return;
    }
    if (live.requestStatus === "CANCELLATION_REQUESTED") {
      await handleCancellation(shop, client, order, live);
    } else {
      await handleSubmitted(shop, client, order, live);
    }
  } finally {
    inFlight.delete(live.id);
  }
}

async function handleCancellation(
  shop: ShopWithSettings,
  client: GraphqlClient,
  order: { id: string; name: string },
  live: LiveFulfillmentOrder,
) {
  await prisma.fulfillmentRequest.updateMany({
    where: { orderId: order.id, shopifyFulfillmentOrderId: live.id },
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
    await acceptCancellationRequest(client, live.id, "Cancelled before the supplier shipped.");

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
      where: { orderId: order.id, shopifyFulfillmentOrderId: live.id },
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
    await rejectCancellationRequest(client, live.id, message);
    await prisma.fulfillmentRequest.updateMany({
      where: { orderId: order.id, shopifyFulfillmentOrderId: live.id },
      data: { status: "ACCEPTED", responseMessage: message, respondedAt: new Date() },
    });
    await logActivity(shop.id, {
      action: "fulfillment_service.cancel_rejected",
      entity: "Order",
      entityId: order.id,
      level: "warn",
      message: `${order.name}: cancellation refused, the supplier already shipped.`,
    });
  }
}

async function handleSubmitted(
  shop: ShopWithSettings,
  client: GraphqlClient,
  order: { id: string; name: string },
  live: LiveFulfillmentOrder,
) {
  const key = { orderId_shopifyFulfillmentOrderId: { orderId: order.id, shopifyFulfillmentOrderId: live.id } };
  const existing = await prisma.fulfillmentRequest.findUnique({ where: key });
  // Already waiting on the merchant: the sweep owns its reminder and deadline,
  // and pricing it again would move the number they are looking at.
  if (existing?.status === "AWAITING_APPROVAL") return;
  if (existing?.status === "SUBMITTED" && Date.now() - existing.requestedAt.getTime() < IN_FLIGHT_MS) return;

  const lineItems = live.lineItems as unknown as Prisma.InputJsonValue;
  // A row in any other state is an earlier request that was answered; Shopify
  // saying SUBMITTED again means the merchant asked again, so it starts over
  // with a fresh clock.
  const request = await prisma.fulfillmentRequest.upsert({
    where: key,
    create: { orderId: order.id, shopifyFulfillmentOrderId: live.id, requestMessage: live.requestMessage, lineItems },
    update: {
      status: "SUBMITTED",
      requestMessage: live.requestMessage,
      lineItems,
      requestedAt: existing?.status === "SUBMITTED" ? undefined : new Date(),
      responseMessage: null,
      respondedAt: null,
      quote: Prisma.JsonNull,
      quotedAt: null,
      quoteError: null,
      approvedAt: null,
      approvedBy: null,
    },
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
    await rejectFulfillmentRequest(client, live.id, message, reasonFor(blocking));
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
      dedupeKey: `fo-reject:${request.id}:${request.requestedAt.getTime()}`,
    });
    return;
  }

  const deadline = approvalDeadline(request.requestedAt);

  // The merchant's own money is about to be spent on the strength of a button
  // pressed in a different product. Unless they have said otherwise, price the
  // order and stop here so the spend is a decision they take knowingly.
  //
  // Nothing is said to Shopify yet. Accepting first and asking afterwards left
  // "Decline" calling reject on an order Shopify had already seen accepted,
  // which it refuses, and the order sat accepted and unfulfilled.
  if (shop.parsedSettings.orders.requireApprovalOnFulfillmentRequest) {
    let quote: SupplierQuote | null = null;
    let quoteError: string | null = null;
    try {
      quote = await quoteSupplierOrders(shop, order.id, { shopifyLineItemIds: live.lineItems.map((li) => li.shopifyLineItemId) });
    } catch (error) {
      quoteError = errorMessage(error);
      logger.warn("Could not price a fulfilment request", { requestId: request.id, error });
    }

    await prisma.fulfillmentRequest.update({
      where: { id: request.id },
      data: {
        status: "AWAITING_APPROVAL",
        quote: (quote as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        quotedAt: new Date(),
        quoteError,
      },
    });

    await notify(shop.id, {
      type: "order.failed",
      severity: "info",
      title: `${order.name}: waiting for you to approve the supplier order`,
      body:
        (quote
          ? `${quote.totalCost} ${quote.currency} — ${quote.itemsCost} of items plus ${quote.shippingCost} shipping.`
          : `The cost could not be worked out: ${quoteError ?? "unknown reason"}.`) +
        ` Declined automatically at ${deadline.toISOString()} unless you approve it.`,
      link: `/app/orders/${order.id}`,
      dedupeKey: `fo-approve:${request.id}:${request.requestedAt.getTime()}`,
    });
    return;
  }

  const outcome = await commitRequest(shop, client, request, live, "fulfillment-request");
  if (outcome.ok) {
    await logActivity(shop.id, {
      action: "fulfillment_service.accepted",
      entity: "Order",
      entityId: order.id,
      message: `${order.name}: ${supplierSideSummary(outcome.awaitingPlacementIds)}; Shopify's fulfilment request accepted.`,
    });
  } else {
    // Held for the merchant rather than rejected: a supplier timeout is not a
    // reason to send the order back to Shopify, and the deadline still makes
    // sure Shopify gets an answer.
    await prisma.fulfillmentRequest.update({
      where: { id: request.id },
      data: { status: "AWAITING_APPROVAL", quoteError: outcome.error },
    });
    await notify(shop.id, {
      type: "order.failed",
      severity: "critical",
      title: `${order.name}: could not place the supplier order`,
      body: `${outcome.error} Fix it and approve the request, or decline it. It is declined automatically at ${deadline.toISOString()}.`,
      link: `/app/orders/${order.id}`,
      dedupeKey: `fo-place:${request.id}:${request.requestedAt.getTime()}`,
    });
  }
}

/**
 * Place the supplier order for a request, then accept it in Shopify.
 *
 * Placement comes first so a failure leaves the request SUBMITTED, which the
 * merchant can still decline. Accepting is repeated safely: when the supplier
 * order already exists, placement is a no-op and only the acceptance runs.
 */
async function commitRequest(
  shop: ShopWithSettings,
  client: GraphqlClient,
  request: Pick<FulfillmentRequest, "id" | "orderId">,
  live: LiveFulfillmentOrder,
  actor: string,
): Promise<{ ok: true; purchaseOrderIds: string[]; awaitingPlacementIds: string[] } | { ok: false; error: string; issues?: string[] }> {
  const outcome = await placeSupplierOrders(shop, request.orderId, {
    actor,
    shopifyLineItemIds: live.lineItems.map((li) => li.shopifyLineItemId),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error ?? "Could not place the supplier order", issues: outcome.issues };
  const awaitingPlacementIds = outcome.awaitingPlacementIds ?? [];

  if (live.requestStatus === "SUBMITTED") {
    try {
      // Accepting is still right when the order only went to the extension
      // queue: the app has taken the fulfilment on. The message just must not
      // tell the merchant, in Shopify, that something was bought.
      const message = awaitingPlacementIds.length
        ? "Accepted by DropshipHub: the supplier order is waiting to be placed with the Chrome extension."
        : "Accepted by DropshipHub: the supplier order has been created.";
      await acceptFulfillmentRequest(client, live.id, message);
    } catch (error) {
      // Another run may have accepted it a moment earlier; only a request that
      // is still not accepted is a failure.
      const now = await fetchLiveFulfillmentOrder(client, live.id).catch(() => null);
      if (now?.requestStatus !== "ACCEPTED") {
        return {
          ok: false,
          error: `The supplier order was created, but Shopify did not accept the fulfilment request: ${errorMessage(error)}`,
        };
      }
    }
  }

  await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "ACCEPTED", approvedAt: new Date(), approvedBy: actor, quoteError: null, respondedAt: new Date() },
  });
  return { ok: true, purchaseOrderIds: outcome.purchaseOrderIds, awaitingPlacementIds };
}

/** How an accepted request's supplier side is described in logs and notices. */
function supplierSideSummary(awaitingPlacementIds: string[]): string {
  return awaitingPlacementIds.length
    ? "supplier order waiting to be placed with the extension (nothing ordered yet)"
    : "supplier order placed";
}

/** The request as Shopify holds it, or a reason to stop. */
async function liveRequestFor(client: GraphqlClient, request: Pick<FulfillmentRequest, "shopifyFulfillmentOrderId">) {
  const live = await fetchLiveFulfillmentOrder(client, request.shopifyFulfillmentOrderId);
  if (live?.requestStatus === "SUBMITTED") return { live, answerable: "reject" as const };
  // Accepted and still in progress: a request held under the old accept-first
  // flow. Only fulfillmentOrderClose can hand one of those back.
  if (live?.requestStatus === "ACCEPTED" && live.status === "IN_PROGRESS") return { live, answerable: "close" as const };
  return { live, answerable: null };
}

const WITHDRAWN_MESSAGE = "Shopify no longer asks for this fulfilment: it was withdrawn or already answered.";

async function markWithdrawn(request: Pick<FulfillmentRequest, "id">) {
  await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "CLOSED", responseMessage: WITHDRAWN_MESSAGE, respondedAt: new Date() },
  });
}

/**
 * Approve a held fulfilment request and send it to the supplier.
 *
 * This is the merchant pressing "pay" in the app. It cannot literally pay the
 * supplier — AliExpress will not take a payment from a third party on the
 * merchant's behalf — so what it does is commit the order upstream and hand
 * back the supplier's own payment link, which is the furthest a Shopify app can
 * carry this without holding the merchant's card.
 */
export async function approveFulfillmentRequest(shop: ShopWithSettings, requestId: string, actor?: string) {
  const request = await prisma.fulfillmentRequest.findFirst({
    where: { id: requestId, order: { shopId: shop.id } },
    include: { order: { select: { id: true, name: true } } },
  });
  if (!request) return { ok: false as const, error: "Fulfilment request not found" };
  if (request.status !== "AWAITING_APPROVAL") {
    return { ok: false as const, error: `This request is ${request.status.toLowerCase().replace(/_/g, " ")}, not waiting for approval.` };
  }

  const client = await offlineClient(shop.domain);
  // Checked before anything is ordered: a merchant who withdrew the request in
  // Shopify must not find a supplier order placed for it.
  const { live, answerable } = await liveRequestFor(client, request);
  if (!live || !answerable) {
    await markWithdrawn(request);
    return { ok: false as const, error: `${WITHDRAWN_MESSAGE} Nothing was ordered.` };
  }

  const outcome = await commitRequest(shop, client, request, live, actor ?? "approval");
  if (!outcome.ok) {
    // The request stays AWAITING_APPROVAL so the merchant can fix the reason
    // and press approve again, rather than losing the request entirely.
    await prisma.fulfillmentRequest.update({ where: { id: request.id }, data: { quoteError: outcome.error } });
    return { ok: false as const, error: outcome.error, issues: outcome.issues };
  }

  await logActivity(shop.id, {
    actor,
    action: "fulfillment_service.approved",
    entity: "Order",
    entityId: request.orderId,
    message: `${request.order.name}: approved, ${supplierSideSummary(outcome.awaitingPlacementIds)}; Shopify's fulfilment request accepted.`,
  });
  return { ok: true as const, purchaseOrderIds: outcome.purchaseOrderIds, awaitingPlacementIds: outcome.awaitingPlacementIds };
}

/**
 * Answer a request the app will not carry out, the only way Shopify allows for
 * its current state: reject one still SUBMITTED, close one already accepted.
 */
async function refuseRequest(
  client: GraphqlClient,
  request: Pick<FulfillmentRequest, "id" | "shopifyFulfillmentOrderId">,
  message: string,
): Promise<"rejected" | "closed" | "withdrawn"> {
  const { answerable } = await liveRequestFor(client, request);
  if (answerable === "reject") {
    await rejectFulfillmentRequest(client, request.shopifyFulfillmentOrderId, message, "OTHER");
    await prisma.fulfillmentRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", responseMessage: message, respondedAt: new Date() },
    });
    return "rejected";
  }
  if (answerable === "close") {
    await closeFulfillmentOrder(client, request.shopifyFulfillmentOrderId, message);
    await prisma.fulfillmentRequest.update({
      where: { id: request.id },
      data: { status: "CLOSED", responseMessage: message, respondedAt: new Date() },
    });
    return "closed";
  }
  await markWithdrawn(request);
  return "withdrawn";
}

/**
 * Refuse a held fulfilment request and tell Shopify why.
 *
 * Without this the only way out of the approval queue was to approve: a
 * merchant who changed their mind left Shopify believing the app still owned a
 * fulfilment it was never going to carry out.
 */
export async function declineFulfillmentRequest(shop: ShopWithSettings, requestId: string, reason: string, actor?: string) {
  const request = await prisma.fulfillmentRequest.findFirst({
    where: { id: requestId, order: { shopId: shop.id } },
    include: { order: { select: { id: true, name: true } } },
  });
  if (!request) return { ok: false as const, error: "Fulfilment request not found" };
  if (request.status !== "AWAITING_APPROVAL" && request.status !== "SUBMITTED") {
    return { ok: false as const, error: `This request is ${request.status.toLowerCase().replace(/_/g, " ")}; there is nothing to decline.` };
  }

  const message = reason.trim() || "The merchant declined this fulfilment.";
  const client = await offlineClient(shop.domain);
  const answer = await refuseRequest(client, request, message);
  if (answer === "withdrawn") {
    return { ok: false as const, error: WITHDRAWN_MESSAGE };
  }
  await logActivity(shop.id, {
    actor,
    action: "fulfillment_service.declined",
    entity: "Order",
    entityId: request.orderId,
    level: "warn",
    message: `${request.order.name}: fulfilment request declined — ${message}`,
  });
  return { ok: true as const };
}

export interface ReconcileResult {
  skipped?: "not registered";
  processed: number;
  failed: number;
  expired: number;
  withdrawn: number;
  reminded: number;
}

/**
 * Bring the app's requests in line with Shopify's, and answer what is overdue.
 *
 * Runs on the callback, on a schedule, and whenever the webhook path could have
 * missed something (webhooks are dropped on a restart of the inline queue). It
 * picks up every submitted and cancellation-requested fulfilment order at the
 * app's location, forgets requests the merchant withdrew, reminds about ones
 * waiting half a day, and declines ones no one approved in time.
 */
export async function reconcileFulfillmentRequests(
  shop: ShopWithSettings,
  options: { client?: GraphqlClient; now?: Date } = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = { processed: 0, failed: 0, expired: 0, withdrawn: 0, reminded: 0 };
  if (!shop.fulfillmentLocationId) return { ...result, skipped: "not registered" };
  const client = options.client ?? (await offlineClient(shop.domain));
  const now = options.now ?? new Date();

  const submitted = await listAssignedFulfillmentOrders(client, "FULFILLMENT_REQUESTED", shop.fulfillmentLocationId);
  const cancellations = await listAssignedFulfillmentOrders(client, "CANCELLATION_REQUESTED", shop.fulfillmentLocationId);
  for (const live of [...submitted.orders, ...cancellations.orders]) {
    try {
      await processFulfillmentOrder(shop, client, live);
      result.processed += 1;
    } catch (error) {
      result.failed += 1;
      logger.error("Could not act on a fulfilment request", { shopId: shop.id, fulfillmentOrderId: live.id, error });
    }
  }

  const waiting = await prisma.fulfillmentRequest.findMany({
    where: { order: { shopId: shop.id }, status: { in: ["SUBMITTED", "AWAITING_APPROVAL"] } },
    include: { order: { select: { id: true, name: true } } },
    orderBy: { requestedAt: "asc" },
    take: 100,
  });
  const stillSubmitted = new Set(submitted.orders.map((fo) => fo.id));

  for (const request of waiting) {
    try {
      const age = now.getTime() - request.requestedAt.getTime();
      if (age >= APPROVAL_WINDOW_MS) {
        const message = "Not approved in DropshipHub in time. Request fulfilment again when you are ready to approve it.";
        const answer = await refuseRequest(client, request, message);
        if (answer === "withdrawn") {
          result.withdrawn += 1;
          continue;
        }
        result.expired += 1;
        await logActivity(shop.id, {
          action: "fulfillment_service.expired",
          entity: "Order",
          entityId: request.orderId,
          level: "warn",
          message: `${request.order.name}: fulfilment request declined automatically, nobody approved it within ${APPROVAL_WINDOW_MS / 3_600_000} hours.`,
        });
        await notify(shop.id, {
          type: "order.failed",
          severity: "warning",
          title: `${request.order.name}: fulfilment request declined automatically`,
          body: "Nobody approved it in time, so Shopify was told no. Request fulfilment again in Shopify when you are ready.",
          link: `/app/orders/${request.orderId}`,
          dedupeKey: `fo-expired:${request.id}:${request.requestedAt.getTime()}`,
        });
        continue;
      }

      // A merchant can withdraw a request Shopify has not seen answered. Only a
      // complete listing can prove it is gone; rows held by the old accept-first
      // flow are ACCEPTED in Shopify and never appear in it, so they are checked
      // one by one.
      if (submitted.complete && !stillSubmitted.has(request.shopifyFulfillmentOrderId)) {
        const { answerable } = await liveRequestFor(client, request);
        if (!answerable) {
          await markWithdrawn(request);
          result.withdrawn += 1;
          continue;
        }
      }

      if (request.status === "AWAITING_APPROVAL" && age >= APPROVAL_REMINDER_MS) {
        await notify(shop.id, {
          type: "order.failed",
          severity: "warning",
          title: `${request.order.name}: still waiting for your approval`,
          body: `Declined automatically at ${approvalDeadline(request.requestedAt).toISOString()} unless you approve it.`,
          link: `/app/orders/${request.orderId}`,
          dedupeKey: `fo-remind:${request.id}:${request.requestedAt.getTime()}`,
          dedupeMinutes: 24 * 60,
        });
        result.reminded += 1;
      }
    } catch (error) {
      result.failed += 1;
      logger.error("Could not settle a waiting fulfilment request", { shopId: shop.id, requestId: request.id, error });
    }
  }
  return result;
}

/** The request still waiting on the merchant for this order, if there is one. */
export async function pendingApproval(shopId: string, orderId: string) {
  const request = await prisma.fulfillmentRequest.findFirst({
    where: { orderId, order: { shopId }, status: "AWAITING_APPROVAL" },
    orderBy: { requestedAt: "desc" },
  });
  if (!request) return null;
  return {
    id: request.id,
    requestedAt: request.requestedAt,
    decideBy: approvalDeadline(request.requestedAt),
    requestMessage: request.requestMessage,
    quote: (request.quote as unknown as SupplierQuote | null) ?? null,
    quoteError: request.quoteError,
  };
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
