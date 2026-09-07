import type { Prisma, PurchaseOrder, PurchaseOrderStatus, SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import type { ResolveResult, ResolvedSupplierLine } from "~/domain/mapping/types";
import type { ShippingAddress } from "~/domain/orders/address";
import { evaluateOrder as evaluatePipeline } from "~/domain/orders/pipeline";
import { AppError, errorMessage, isRetryable } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money, sum } from "~/lib/money";
import { logActivity } from "./activity.server";
import { notify } from "./notifications.server";
import { evaluateAndStoreOrder, lineResolution, orderIssues } from "./orders.server";
import { chooseShippingForShop } from "./shipping.server";
import type { ShopWithSettings } from "./shop.server";
import { offlineClient, type GraphqlClient } from "./shopify/graphql.server";
import { addOrderTags, createFulfillmentWithTracking } from "./shopify/orders.server";
import { touchSupplierAccount } from "./supplier-accounts.server";
import { getShippingOptions } from "./suppliers/catalog.server";
import { adapterForShop } from "./suppliers/index.server";
import type { PlaceOrderInput, SupplierOrderState } from "./suppliers/types";

// ---------------------------------------------------------------------------
// Place orders
// ---------------------------------------------------------------------------

export interface PlaceOrderOutcome {
  orderId: string;
  ok: boolean;
  purchaseOrderIds: string[];
  error?: string;
  issues?: string[];
}

interface Group {
  platform: SupplierPlatform;
  lines: Array<{ lineItemId: string; lineItemTitle: string; resolved: ResolvedSupplierLine; supplierProductId: string }>;
}

/**
 * Turn one Shopify order into supplier purchase orders and submit them.
 *
 * Lines are grouped per platform (one upstream order per supplier account),
 * shipping is chosen per group with the merchant's carrier preferences, and
 * each purchase order is idempotent on its own id so a retry after a network
 * blip cannot double-order.
 */
export async function placeSupplierOrders(shop: ShopWithSettings, orderId: string, options: { force?: boolean; actor?: string; supplierNote?: string | null } = {}): Promise<PlaceOrderOutcome> {
  const order = await evaluateAndStoreOrder(shop, orderId);
  const full = await prisma.order.findUnique({ where: { id: orderId }, include: { lineItems: true, purchaseOrders: true } });
  if (!full) return { orderId, ok: false, purchaseOrderIds: [], error: "Order not found" };

  const issues = orderIssues(order).filter((i) => i.severity === "error");
  if (issues.length > 0 && !options.force) {
    return { orderId, ok: false, purchaseOrderIds: [], error: "Order is not ready", issues: issues.map((i) => i.message) };
  }
  if (["AWAITING_PAYMENT", "AWAITING_SHIPMENT", "AWAITING_DELIVERY", "FULFILLED"].includes(order.stage) && !options.force) {
    return { orderId, ok: true, purchaseOrderIds: full.purchaseOrders.map((po) => po.id) };
  }

  // Lines already covered by a live purchase order are skipped.
  const covered = new Set(
    (await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { orderId, status: { notIn: ["FAILED", "CANCELED", "DRAFT"] } } },
      select: { orderLineItemId: true },
    })).map((i) => i.orderLineItemId),
  );

  const groups = new Map<string, Group>();
  for (const li of full.lineItems) {
    if (!li.productVariantId || li.isCanceled || li.isFulfilled || covered.has(li.id)) continue;
    const resolution = lineResolution(li);
    if (!resolution?.ok) continue;
    for (const resolved of resolution.lines) {
      const sv = await prisma.supplierVariant.findUnique({ where: { id: resolved.supplierVariantId }, select: { supplierProductId: true } });
      const key = resolved.platform;
      const group = groups.get(key) ?? { platform: resolved.platform as SupplierPlatform, lines: [] };
      group.lines.push({ lineItemId: li.id, lineItemTitle: li.title, resolved, supplierProductId: sv?.supplierProductId ?? "" });
      groups.set(key, group);
    }
  }

  if (groups.size === 0) {
    return { orderId, ok: false, purchaseOrderIds: [], error: "Nothing to order: every line is unmapped, fulfilled or already ordered." };
  }

  const address = full.shippingAddress as ShippingAddress;
  const country = (address.countryCode ?? full.countryCode ?? "US").toUpperCase();
  const purchaseOrderIds: string[] = [];
  const errors: string[] = [];

  for (const group of groups.values()) {
    const { adapter, account } = await adapterForShop(shop.id, group.platform);

    // Shipping: quote on the first line (suppliers price per parcel) and let
    // the selector apply preferences + guard rails.
    let carrierCode: string | null = null;
    let carrierName: string | null = null;
    let shipFrom: string | null = null;
    let estimatedDays: number | null = null;
    let shippingReason = "";
    try {
      const quotes = group.lines[0].supplierProductId
        ? await getShippingOptions(shop.id, group.lines[0].supplierProductId, {
            shipToCountry: country,
            externalSkuId: group.lines[0].resolved.externalSkuId,
            quantity: group.lines.reduce((n, l) => n + l.resolved.quantity, 0),
            maxAgeMinutes: 60,
          })
        : [];
      const choice = await chooseShippingForShop(shop.id, shop.parsedSettings.shipping, quotes, country);
      if (choice.ok && choice.option) {
        carrierCode = choice.option.carrierCode;
        carrierName = choice.option.carrierName;
        shipFrom = choice.option.shipFromCountry ?? null;
        estimatedDays = choice.option.maxDeliveryDays ?? null;
      }
      shippingReason = choice.reason;
      if (!choice.ok && shop.parsedSettings.shipping.fallback === "NONE") {
        throw new AppError("NO_SHIPPING", choice.reason);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "NO_SHIPPING") {
        errors.push(error.message);
        await recordFailedPurchaseOrder(shop, full.id, group, account?.id ?? null, "NO_SHIPPING", error.message);
        continue;
      }
      logger.warn("Shipping quote failed; continuing with supplier default", { orderId, error });
      shippingReason = `Shipping quote failed (${errorMessage(error)}); supplier default used.`;
    }

    const po = await prisma.purchaseOrder.create({
      data: {
        orderId: full.id,
        supplierAccountId: account?.id ?? null,
        platform: group.platform,
        status: "SUBMITTING",
        currency: group.lines[0].resolved.currency,
        itemsCost: money(sum(group.lines.map((l) => d(l.resolved.unitCost).times(l.resolved.quantity)))),
        carrierCode,
        carrierName,
        shipFromCountry: shipFrom,
        estimatedDeliveryDays: estimatedDays,
        supplierNote: options.supplierNote ?? shop.parsedSettings.orders.supplierNote,
        attempts: 1,
        lastAttemptAt: new Date(),
        raw: { shippingReason } as Prisma.InputJsonValue,
        items: {
          create: group.lines.map((l) => ({
            orderLineItemId: l.lineItemId,
            supplierVariantId: l.resolved.supplierVariantId,
            externalProductId: l.resolved.externalProductId,
            externalSkuId: l.resolved.externalSkuId,
            title: l.resolved.title,
            quantity: l.resolved.quantity,
            unitCost: l.resolved.unitCost,
            currency: l.resolved.currency,
          })),
        },
      },
    });
    purchaseOrderIds.push(po.id);

    const payload: PlaceOrderInput = {
      reference: po.id,
      items: group.lines.map((l) => ({
        externalProductId: l.resolved.externalProductId,
        externalSkuId: l.resolved.externalSkuId,
        quantity: l.resolved.quantity,
        carrierCode,
        shipFromCountry: shipFrom,
      })),
      address: {
        name: address.name ?? [address.firstName, address.lastName].filter(Boolean).join(" "),
        phone: address.phone ?? "",
        address1: address.address1 ?? "",
        address2: address.address2 ?? null,
        city: address.city ?? "",
        province: address.province ?? address.provinceCode ?? null,
        zip: address.zip ?? null,
        countryCode: country,
        taxNumber: address.taxNumber ?? null,
        email: full.customerEmail ?? null,
      },
      note: po.supplierNote,
      currency: shop.currency,
    };

    try {
      const result = await adapter.placeOrder(payload);
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: {
          status: toPurchaseOrderStatus(result.status),
          externalOrderId: result.externalOrderId,
          itemsCost: result.itemsCost,
          shippingCost: result.shippingCost,
          totalCost: result.totalCost,
          currency: result.currency,
          placedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          raw: { ...(po.raw as object), paymentUrl: result.paymentUrl ?? null, externalOrderIds: result.externalOrderIds ?? [result.externalOrderId], response: sanitize(result.raw) } as Prisma.InputJsonValue,
        },
      });
      if (account) await touchSupplierAccount(account.id);
      await logActivity(shop.id, {
        actor: options.actor,
        action: "order.placed",
        entity: "Order",
        entityId: full.id,
        message: `${full.name}: supplier order ${result.externalOrderId} placed on ${group.platform} (${money(result.totalCost)} ${result.currency}).`,
        meta: { purchaseOrderId: po.id },
      });
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`${group.platform}: ${message}`);
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: "FAILED", errorCode: error instanceof AppError ? error.code : "SUPPLIER_ERROR", errorMessage: message },
      });
      await logActivity(shop.id, { actor: options.actor, action: "order.place_failed", entity: "Order", entityId: full.id, level: "error", message: `${full.name}: ${group.platform} rejected the order — ${message}` });
      if (shop.parsedSettings.notifications.onOrderFailed) {
        await notify(shop.id, { type: "order.failed", severity: "critical", title: `Order ${full.name} failed at ${group.platform}`, body: message, link: `/app/orders/${full.id}`, dedupeKey: `order-failed:${po.id}`, dedupeMinutes: 30 });
      }
    }
  }

  await rollupOrderCosts(full.id);
  await evaluateAndStoreOrder(shop, full.id);

  const anyPlaced = purchaseOrderIds.length > 0 && errors.length < groups.size;
  if (anyPlaced && shop.parsedSettings.orders.tagOnPlaced) {
    try {
      const client = await offlineClient(shop.domain);
      await addOrderTags(client, full.shopifyOrderId, [shop.parsedSettings.orders.tagOnPlaced]);
    } catch (error) {
      logger.warn("Could not tag Shopify order", { orderId, error });
    }
  }

  return { orderId, ok: errors.length === 0, purchaseOrderIds, error: errors.length ? errors.join("; ") : undefined };
}

async function recordFailedPurchaseOrder(shop: ShopWithSettings, orderId: string, group: Group, supplierAccountId: string | null, code: string, message: string) {
  await prisma.purchaseOrder.create({
    data: {
      orderId,
      supplierAccountId,
      platform: group.platform,
      status: "FAILED",
      errorCode: code,
      errorMessage: message,
      attempts: 1,
      lastAttemptAt: new Date(),
      items: {
        create: group.lines.map((l) => ({
          orderLineItemId: l.lineItemId,
          supplierVariantId: l.resolved.supplierVariantId,
          externalProductId: l.resolved.externalProductId,
          externalSkuId: l.resolved.externalSkuId,
          title: l.resolved.title,
          quantity: l.resolved.quantity,
          unitCost: l.resolved.unitCost,
          currency: l.resolved.currency,
        })),
      },
    },
  });
  await logActivity(shop.id, { action: "order.place_failed", entity: "Order", entityId: orderId, level: "error", message });
}

export async function placeSupplierOrdersBulk(shop: ShopWithSettings, orderIds: string[], options: { actor?: string; onProgress?: (outcome: PlaceOrderOutcome) => Promise<unknown> } = {}) {
  const outcomes: PlaceOrderOutcome[] = [];
  for (const id of orderIds) {
    let outcome: PlaceOrderOutcome;
    try {
      outcome = await placeSupplierOrders(shop, id, { actor: options.actor });
    } catch (error) {
      outcome = { orderId: id, ok: false, purchaseOrderIds: [], error: errorMessage(error) };
    }
    outcomes.push(outcome);
    if (options.onProgress) await options.onProgress(outcome);
  }
  return outcomes;
}

/** Retry a failed purchase order: drop it and re-run placement for its lines. */
export async function retryPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string, actor?: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po) throw new Error("Purchase order not found");
  if (po.status !== "FAILED" && po.status !== "CANCELED") throw new Error("Only failed or canceled purchase orders can be retried.");
  await prisma.purchaseOrder.delete({ where: { id: po.id } });
  return placeSupplierOrders(shop, po.orderId, { actor, force: true });
}

/** Merchant placed it by hand; link the upstream id so tracking can sync. */
export async function markPurchaseOrderManual(shop: ShopWithSettings, purchaseOrderId: string, externalOrderId: string, actor?: string) {
  const po = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { externalOrderId: externalOrderId.trim(), status: "PLACED", placedAt: new Date(), errorCode: null, errorMessage: null },
  });
  await logActivity(shop.id, { actor, action: "order.manual_link", entity: "Order", entityId: po.orderId, message: `Supplier order ${externalOrderId} linked manually.` });
  await evaluateAndStoreOrder(shop, po.orderId);
  return po;
}

export async function cancelPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string, reason?: string, actor?: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { order: true } });
  if (!po) throw new Error("Purchase order not found");
  let upstream = false;
  if (po.externalOrderId) {
    const { adapter } = await adapterForShop(shop.id, po.platform);
    if (adapter.cancelOrder) {
      upstream = await adapter.cancelOrder(po.externalOrderId, reason).catch(() => false);
    }
  }
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: "CANCELED", canceledAt: new Date(), errorMessage: reason ?? null } });
  await logActivity(shop.id, { actor, action: "order.supplier_canceled", entity: "Order", entityId: po.orderId, message: `Supplier order ${po.externalOrderId ?? po.id} canceled${upstream ? " at the supplier" : " locally (supplier could not cancel)"}.` });
  await rollupOrderCosts(po.orderId);
  await evaluateAndStoreOrder(shop, po.orderId);
  return { upstream };
}

// ---------------------------------------------------------------------------
// Sync status & tracking
// ---------------------------------------------------------------------------

function toPurchaseOrderStatus(state: SupplierOrderState): PurchaseOrderStatus {
  switch (state) {
    case "PLACED":
      return "PLACED";
    case "AWAITING_PAYMENT":
      return "AWAITING_PAYMENT";
    case "PAID":
      return "PAID";
    case "SHIPPED":
      return "SHIPPED";
    case "DELIVERED":
      return "DELIVERED";
    case "CANCELED":
      return "CANCELED";
    case "FAILED":
    default:
      return "FAILED";
  }
}

const ORDER_RANK: Record<PurchaseOrderStatus, number> = {
  DRAFT: 0, SUBMITTING: 1, FAILED: 1, PLACED: 2, AWAITING_PAYMENT: 2, PAID: 3, SHIPPED: 4, DELIVERED: 5, CANCELED: 5,
};

/** Poll one purchase order upstream; pull tracking when shipped. */
export async function syncPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string): Promise<{ changed: boolean; status: PurchaseOrderStatus; newTracking: number }> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { order: true, trackings: true } });
  if (!po || !po.externalOrderId) return { changed: false, status: po?.status ?? "DRAFT", newTracking: 0 };

  const { adapter } = await adapterForShop(shop.id, po.platform);
  const upstream = await adapter.getOrder(po.externalOrderId);
  if (!upstream) return { changed: false, status: po.status, newTracking: 0 };

  const next = toPurchaseOrderStatus(upstream.status);
  // Never regress (a transient "PLACED" read after "SHIPPED" would hide tracking).
  const status = ORDER_RANK[next] >= ORDER_RANK[po.status] ? next : po.status;
  const changed = status !== po.status;

  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: {
      status,
      itemsCost: upstream.itemsCost ?? undefined,
      shippingCost: upstream.shippingCost ?? undefined,
      totalCost: upstream.totalCost ?? undefined,
      currency: upstream.currency ?? undefined,
      paidAt: upstream.paidAt ?? (status === "PAID" && !po.paidAt ? new Date() : undefined),
      shippedAt: upstream.shippedAt ?? (status === "SHIPPED" && !po.shippedAt ? new Date() : undefined),
      raw: { ...(po.raw as object), lastStatus: sanitize(upstream.raw) } as Prisma.InputJsonValue,
    },
  });

  let newTracking = 0;
  if (["SHIPPED", "DELIVERED"].includes(status)) {
    const trackings = await adapter.getTracking(po.externalOrderId).catch((error) => {
      logger.warn("Tracking fetch failed", { purchaseOrderId, error });
      return [];
    });
    for (const t of trackings) {
      const existing = po.trackings.find((x) => x.number === t.number);
      if (!existing) newTracking += 1;
      await prisma.trackingNumber.upsert({
        where: { purchaseOrderId_number: { purchaseOrderId: po.id, number: t.number } },
        create: {
          purchaseOrderId: po.id,
          number: t.number,
          carrierCode: t.carrierCode ?? po.carrierCode,
          carrierName: t.carrierName ?? po.carrierName,
          trackingUrl: t.url ?? null,
          status: t.status ?? null,
          lastCheckedAt: new Date(),
          notifyCustomer: shop.parsedSettings.fulfillment.notifyCustomer,
        },
        update: { status: t.status ?? undefined, trackingUrl: t.url ?? undefined, carrierName: t.carrierName ?? undefined, lastCheckedAt: new Date() },
      });
    }
  }

  if (changed) {
    await logActivity(shop.id, { action: "order.supplier_status", entity: "Order", entityId: po.orderId, message: `${po.order.name}: supplier order ${po.externalOrderId} is now ${status}.` });
    if (status === "SHIPPED" && shop.parsedSettings.notifications.onTrackingSynced) {
      await notify(shop.id, { type: "order.shipped", title: `${po.order.name} shipped by supplier`, link: `/app/orders/${po.orderId}`, dedupeKey: `shipped:${po.id}`, dedupeMinutes: 1440 });
    }
  }

  await rollupOrderCosts(po.orderId);
  await evaluateAndStoreOrder(shop, po.orderId);

  if (newTracking > 0 && shop.parsedSettings.fulfillment.autoFulfill) {
    // Fulfilment needs an offline Shopify session; if it is missing the
    // tracking stays queued for the periodic sync-tracking job.
    await syncPendingTracking(shop, po.id).catch((error) => logger.warn("Tracking sync deferred", { purchaseOrderId, error }));
  }
  return { changed, status, newTracking };
}

/** Every open purchase order for a shop. */
export async function syncOpenPurchaseOrders(shop: ShopWithSettings, options: { onProgress?: () => Promise<unknown>; limit?: number } = {}) {
  const open = await prisma.purchaseOrder.findMany({
    where: { order: { shopId: shop.id }, status: { in: ["PLACED", "AWAITING_PAYMENT", "PAID", "SHIPPED"] }, externalOrderId: { not: null } },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 200,
    select: { id: true },
  });
  let changed = 0;
  for (const po of open) {
    try {
      const result = await syncPurchaseOrder(shop, po.id);
      if (result.changed || result.newTracking) changed += 1;
    } catch (error) {
      logger.warn("Purchase order sync failed", { purchaseOrderId: po.id, error, retryable: isRetryable(error) });
    }
    if (options.onProgress) await options.onProgress();
  }
  return { checked: open.length, changed };
}

/**
 * Push tracking numbers to Shopify as fulfilments. One fulfilment per tracking
 * number covering the line items of its purchase order.
 */
export async function syncPendingTracking(shop: ShopWithSettings, purchaseOrderId?: string, client?: GraphqlClient) {
  const pending = await prisma.trackingNumber.findMany({
    where: { syncedToShopify: false, purchaseOrder: { order: { shopId: shop.id }, ...(purchaseOrderId ? { id: purchaseOrderId } : {}) } },
    include: { purchaseOrder: { include: { order: true, items: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (pending.length === 0) return { synced: 0, failed: 0 };

  const graphql = client ?? (await offlineClient(shop.domain));
  const settings = shop.parsedSettings.fulfillment;
  let synced = 0;
  let failed = 0;

  for (const tracking of pending) {
    const po = tracking.purchaseOrder;
    const lineItemIds = po.items.map((i) => i.orderLineItemId).filter((id): id is string => Boolean(id));
    const lines = await prisma.orderLineItem.findMany({ where: { id: { in: lineItemIds } } });
    try {
      const result = await createFulfillmentWithTracking(graphql, {
        orderId: po.order.shopifyOrderId,
        items: lines.map((l) => ({ lineItemId: l.shopifyLineItemId, quantity: l.fulfillableQuantity || l.quantity })),
        tracking: {
          number: tracking.number,
          company: settings.carrierNameOverride || tracking.carrierName || tracking.carrierCode || undefined,
          url: settings.trackingUrlTemplate ? settings.trackingUrlTemplate.replace("{tracking}", tracking.number) : tracking.trackingUrl,
        },
        notifyCustomer: tracking.notifyCustomer && settings.notifyCustomer,
      });
      await prisma.trackingNumber.update({
        where: { id: tracking.id },
        data: { syncedToShopify: true, syncedAt: new Date(), shopifyFulfillmentId: result.id, syncError: result.skipped ? result.reason : null },
      });
      await prisma.orderLineItem.updateMany({ where: { id: { in: lineItemIds } }, data: { isFulfilled: true, fulfillableQuantity: 0 } });
      synced += 1;
      await logActivity(shop.id, { action: "tracking.synced", entity: "Order", entityId: po.orderId, message: `${po.order.name}: tracking ${tracking.number} synced to Shopify${result.skipped ? " (already fulfilled)" : ""}.` });
      if (shop.parsedSettings.orders.tagOnShipped) {
        await addOrderTags(graphql, po.order.shopifyOrderId, [shop.parsedSettings.orders.tagOnShipped]).catch(() => undefined);
      }
      if (shop.parsedSettings.notifications.onTrackingSynced) {
        await notify(shop.id, { type: "tracking.synced", title: `${po.order.name} fulfilled`, body: `Tracking ${tracking.number}`, link: `/app/orders/${po.orderId}`, dedupeKey: `tracking:${tracking.id}` });
      }
    } catch (error) {
      failed += 1;
      const message = errorMessage(error);
      await prisma.trackingNumber.update({ where: { id: tracking.id }, data: { syncError: message } });
      await logActivity(shop.id, { action: "tracking.sync_failed", entity: "Order", entityId: po.orderId, level: "error", message: `${po.order.name}: could not sync tracking ${tracking.number} — ${message}` });
    }
    await evaluateAndStoreOrder(shop, po.orderId);
  }
  return { synced, failed };
}

/** Manual tracking entry from the order page. */
export async function addManualTracking(shop: ShopWithSettings, purchaseOrderId: string, input: { number: string; carrierName?: string | null; url?: string | null; notifyCustomer?: boolean }, actor?: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po) throw new Error("Purchase order not found");
  const tracking = await prisma.trackingNumber.upsert({
    where: { purchaseOrderId_number: { purchaseOrderId, number: input.number.trim() } },
    create: { purchaseOrderId, number: input.number.trim(), carrierName: input.carrierName ?? null, trackingUrl: input.url ?? null, notifyCustomer: input.notifyCustomer ?? true },
    update: { carrierName: input.carrierName ?? undefined, trackingUrl: input.url ?? undefined },
  });
  if (ORDER_RANK[po.status] < ORDER_RANK.SHIPPED) {
    await prisma.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: "SHIPPED", shippedAt: new Date() } });
  }
  await logActivity(shop.id, { actor, action: "tracking.added", entity: "Order", entityId: po.orderId, message: `Tracking ${tracking.number} added manually.` });
  if (shop.parsedSettings.fulfillment.autoFulfill) await syncPendingTracking(shop, purchaseOrderId);
  await evaluateAndStoreOrder(shop, po.orderId);
  return tracking;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Recompute order-level supplier cost from live purchase orders. */
export async function rollupOrderCosts(orderId: string) {
  const pos = await prisma.purchaseOrder.findMany({ where: { orderId, status: { notIn: ["FAILED", "CANCELED", "DRAFT"] } } });
  await prisma.order.update({
    where: { id: orderId },
    data: {
      supplierCost: money(sum(pos.map((p) => p.itemsCost))),
      supplierShipping: money(sum(pos.map((p) => p.shippingCost))),
      placedAt: pos.length ? (pos.map((p) => p.placedAt).filter(Boolean).sort()[0] ?? new Date()) : null,
    },
  });
}

function sanitize(value: unknown): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return null as unknown as Prisma.InputJsonValue;
  }
}

export type { PurchaseOrder, ResolveResult };
export { evaluatePipeline };
