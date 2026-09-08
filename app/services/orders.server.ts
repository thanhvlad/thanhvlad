import type { Order, OrderLineItem, OrderStage, Prisma, PurchaseOrder } from "@prisma/client";
import prisma from "~/db.server";
import { applySuggestions, validateAddress, type ShippingAddress } from "~/domain/orders/address";
import { evaluateOrder as evaluatePipeline, type OrderIssue, type PurchaseOrderStatus } from "~/domain/orders/pipeline";
import type { ResolveResult } from "~/domain/mapping/types";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { resolveForVariant } from "./mapping.server";
import type { ShopWithSettings } from "./shop.server";
import type { GraphqlClient } from "./shopify/graphql.server";
import { fetchOrder, fetchOrdersPage, updateOrderShippingAddress, type ShopifyOrderSnapshot } from "./shopify/orders.server";

export type OrderWithItems = Order & { lineItems: OrderLineItem[]; purchaseOrders: PurchaseOrder[] };

// ---------------------------------------------------------------------------
// Ingest from Shopify
// ---------------------------------------------------------------------------

/** Mirror a Shopify order locally (idempotent) and re-evaluate its pipeline state. */
export async function upsertOrderFromSnapshot(shop: ShopWithSettings, snapshot: ShopifyOrderSnapshot): Promise<Order> {
  const address = snapshot.shippingAddress;
  const managedVariants = await prisma.productVariant.findMany({
    where: { product: { shopId: shop.id }, shopifyVariantId: { in: snapshot.lineItems.map((li) => li.variantId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, shopifyVariantId: true },
  });
  const variantByShopifyId = new Map(managedVariants.map((v) => [v.shopifyVariantId, v.id]));

  const order = await prisma.order.upsert({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: snapshot.id } },
    create: {
      shopId: shop.id,
      shopifyOrderId: snapshot.id,
      name: snapshot.name,
      orderNumber: snapshot.orderNumber,
      financialStatus: snapshot.displayFinancialStatus?.toLowerCase() ?? null,
      fulfillmentStatus: snapshot.displayFulfillmentStatus?.toLowerCase() ?? null,
      customerName: address?.name ?? [snapshot.customer?.firstName, snapshot.customer?.lastName].filter(Boolean).join(" ") ?? null,
      customerEmail: snapshot.email ?? snapshot.customer?.email ?? null,
      phone: address?.phone ?? snapshot.phone ?? snapshot.customer?.phone ?? null,
      shippingAddress: toAddressJson(address, snapshot),
      countryCode: address?.countryCodeV2 ?? null,
      currency: snapshot.currencyCode,
      totalPrice: snapshot.totalPrice,
      totalShipping: snapshot.totalShipping,
      totalTax: snapshot.totalTax,
      totalDiscount: snapshot.totalDiscounts,
      tags: snapshot.tags,
      note: snapshot.note,
      riskLevel: snapshot.riskLevel,
      isTest: snapshot.test,
      canceledAt: snapshot.cancelledAt ? new Date(snapshot.cancelledAt) : null,
      shopifyCreatedAt: new Date(snapshot.createdAt),
    },
    update: {
      name: snapshot.name,
      financialStatus: snapshot.displayFinancialStatus?.toLowerCase() ?? null,
      fulfillmentStatus: snapshot.displayFulfillmentStatus?.toLowerCase() ?? null,
      customerName: address?.name ?? undefined,
      customerEmail: snapshot.email ?? undefined,
      phone: address?.phone ?? snapshot.phone ?? undefined,
      shippingAddress: toAddressJson(address, snapshot),
      countryCode: address?.countryCodeV2 ?? undefined,
      totalPrice: snapshot.totalPrice,
      totalShipping: snapshot.totalShipping,
      totalTax: snapshot.totalTax,
      totalDiscount: snapshot.totalDiscounts,
      tags: snapshot.tags,
      note: snapshot.note,
      riskLevel: snapshot.riskLevel,
      canceledAt: snapshot.cancelledAt ? new Date(snapshot.cancelledAt) : null,
    },
  });

  for (const li of snapshot.lineItems) {
    await prisma.orderLineItem.upsert({
      where: { orderId_shopifyLineItemId: { orderId: order.id, shopifyLineItemId: li.id } },
      create: {
        orderId: order.id,
        shopifyLineItemId: li.id,
        productVariantId: li.variantId ? (variantByShopifyId.get(li.variantId) ?? null) : null,
        title: li.title,
        variantTitle: li.variantTitle,
        sku: li.sku,
        shopifyProductId: li.productId,
        shopifyVariantId: li.variantId,
        image: li.image,
        quantity: li.quantity,
        fulfillableQuantity: li.unfulfilledQuantity,
        price: li.price,
        totalDiscount: li.totalDiscount,
        isFulfilled: li.unfulfilledQuantity === 0,
      },
      update: {
        productVariantId: li.variantId ? (variantByShopifyId.get(li.variantId) ?? null) : null,
        title: li.title,
        variantTitle: li.variantTitle,
        sku: li.sku,
        image: li.image,
        quantity: li.quantity,
        fulfillableQuantity: li.unfulfilledQuantity,
        price: li.price,
        totalDiscount: li.totalDiscount,
        isFulfilled: li.unfulfilledQuantity === 0,
      },
    });
  }

  return evaluateAndStoreOrder(shop, order.id);
}

function toAddressJson(address: ShopifyOrderSnapshot["shippingAddress"], snapshot: ShopifyOrderSnapshot): Prisma.InputJsonValue {
  if (!address) return {};
  const taxAttribute = snapshot.customAttributes.find((a) => /cpf|rut|tax|pccc|customs|kimlik|dni|nif|codice/i.test(a.key));
  return {
    firstName: address.firstName,
    lastName: address.lastName,
    name: address.name,
    company: address.company,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    provinceCode: address.provinceCode,
    zip: address.zip,
    country: address.country,
    countryCode: address.countryCodeV2,
    phone: address.phone ?? snapshot.phone ?? snapshot.customer?.phone ?? null,
    taxNumber: taxAttribute?.value ?? null,
  };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

/**
 * Run address validation and mapping resolution for every line, then derive
 * the pipeline stage. Persists issues and per-line resolutions.
 */
export async function evaluateAndStoreOrder(shop: ShopWithSettings, orderId: string): Promise<Order> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      lineItems: true,
      purchaseOrders: {
        include: { trackings: { select: { id: true } }, items: { select: { orderLineItemId: true } } },
      },
    },
  });
  if (!order) throw new Error("Order not found");
  const settings = shop.parsedSettings.orders;

  const stored = order.shippingAddress as ShippingAddress;
  // The fallback phone is applied to the copy the supplier order is built from,
  // never to the stored record. Writing it back destroyed the customer's real
  // number irreversibly, and support could no longer reach the buyer.
  let address = stored;
  if (settings.overridePhone && settings.phoneFallback) address = { ...address, phone: settings.phoneFallback };
  else if (!address.phone && settings.phoneFallback) address = { ...address, phone: settings.phoneFallback };
  let validation = validateAddress(address, { requireLatin: true });
  if (!validation.ok && settings.autoFixAddress) {
    const fixed = applySuggestions(validation.normalized, validation.issues);
    const revalidated = validateAddress(fixed, { requireLatin: true });
    if (revalidated.issues.filter((i) => i.severity === "error").length < validation.issues.filter((i) => i.severity === "error").length) {
      validation = revalidated;
      address = fixed;
    }
  }

  const country = validation.normalized.countryCode ?? order.countryCode ?? "*";
  const lineResults: Array<{ id: string; resolution: ResolveResult | null; isManaged: boolean }> = [];
  for (const li of order.lineItems) {
    const isManaged = Boolean(li.productVariantId);
    if (!isManaged || li.isCanceled || li.isFulfilled) {
      lineResults.push({ id: li.id, resolution: null, isManaged });
      continue;
    }
    const resolution = await resolveForVariant(li.productVariantId!, country, li.fulfillableQuantity || li.quantity);
    lineResults.push({ id: li.id, resolution, isManaged });
  }

  const evaluation = evaluatePipeline({
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    canceledAt: order.canceledAt,
    lineItems: order.lineItems.map((li) => {
      const r = lineResults.find((x) => x.id === li.id)!;
      return {
        id: li.id,
        title: li.title,
        quantity: li.quantity,
        fulfillableQuantity: li.fulfillableQuantity,
        isCanceled: li.isCanceled,
        isFulfilled: li.isFulfilled,
        isManaged: r.isManaged,
        resolution: r.resolution,
      };
    }),
    addressIssues: validation.issues,
    purchaseOrders: order.purchaseOrders.map((po) => ({ status: po.status as PurchaseOrderStatus, hasTracking: po.trackings.length > 0 })),
    // Which lines a live purchase order actually covers. Without it a
    // partly-ordered order reads as fully in flight and the lines nobody
    // ordered are never placed and never flagged.
    coveredLineItemIds: [
      ...new Set(
        order.purchaseOrders
          .filter((po) => !["FAILED", "CANCELED", "DRAFT"].includes(po.status))
          .flatMap((po) => po.items.map((i) => i.orderLineItemId))
          .filter((id): id is string => Boolean(id)),
      ),
    ],
    settings: {
      requirePaidOrder: settings.requirePaidOrder,
      blockHighRisk: settings.blockHighRisk,
      blockPartiallyPaid: settings.blockPartiallyPaid,
    },
    riskLevel: order.riskLevel,
  });

  const persistedAddress = {
    ...(order.shippingAddress as object),
    ...validation.normalized,
    // Whatever the fallback did for validation, the record keeps the customer's
    // own number.
    phone: stored.phone ?? null,
  } as Prisma.InputJsonValue;

  // Serialised per order. Shopify delivers ORDERS_PAID and ORDERS_FULFILLED
  // milliseconds apart and the worker runs several jobs at once, so without the
  // lock the slower evaluation commits last and overwrites the newer stage with
  // its own stale reading, parking the order in the wrong tab for good.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${order.id}))`;
    for (const r of lineResults) {
      // A line the evaluator deliberately skipped (unmanaged, cancelled, already
      // fulfilled) keeps the snapshot it was fulfilled under. Overwriting it
      // with {} erased the record of which SKU and unit cost the order actually
      // used, exactly when a dispute needs it.
      if (r.resolution === null) continue;
      await tx.orderLineItem.update({
        where: { id: r.id },
        data: { resolution: r.resolution as unknown as Prisma.InputJsonValue },
      });
    }
    await tx.order.update({
      where: { id: order.id },
      data: {
        stage: evaluation.stage as OrderStage,
        issues: evaluation.issues as unknown as Prisma.InputJsonValue,
        shippingAddress: persistedAddress,
        countryCode: validation.normalized.countryCode ?? order.countryCode,
      },
    });
  });

  return (await prisma.order.findUnique({ where: { id: order.id } }))!;
}

/**
 * The address to send to a supplier: the stored record plus the merchant's
 * phone-fallback rules, applied here rather than baked into the record.
 */
export function supplierAddressFor(order: { shippingAddress: unknown }, settings: ShopWithSettings["parsedSettings"]["orders"]): ShippingAddress {
  const address = order.shippingAddress as ShippingAddress;
  if (settings.phoneFallback && (settings.overridePhone || !address.phone)) {
    return { ...address, phone: settings.phoneFallback };
  }
  return address;
}

/** Pull recent orders from Shopify (initial sync / manual "sync orders"). */
export async function syncOrdersFromShopify(shop: ShopWithSettings, client: GraphqlClient, options: { days?: number; max?: number; onProgress?: (n: number) => Promise<unknown> } = {}) {
  const days = options.days ?? 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  let after: string | null = null;
  let count = 0;
  do {
    const page = await fetchOrdersPage(client, { first: 50, after, query: `created_at:>=${since} status:any` });
    for (const snapshot of page.nodes) {
      try {
        await upsertOrderFromSnapshot(shop, snapshot);
        count += 1;
        if (options.onProgress) await options.onProgress(1);
      } catch (error) {
        logger.error("Order sync failed", { order: snapshot.name, error });
      }
      if (options.max && count >= options.max) return count;
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  await logActivity(shop.id, { action: "orders.synced", message: `${count} order(s) synced from Shopify (last ${days} days).` });
  return count;
}

export async function refreshOrderFromShopify(shop: ShopWithSettings, client: GraphqlClient, shopifyOrderId: string) {
  const snapshot = await fetchOrder(client, shopifyOrderId);
  if (!snapshot) return null;
  return upsertOrderFromSnapshot(shop, snapshot);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function listOrders(
  shopId: string,
  options: { stage?: OrderStage | "ALL"; search?: string; page?: number; pageSize?: number; country?: string; from?: Date; to?: Date } = {},
) {
  const page = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page as number)) : 1;
  const pageSize = Math.min(250, options.pageSize ?? 50);
  const where: Prisma.OrderWhereInput = {
    shopId,
    ...(options.stage && options.stage !== "ALL" ? { stage: options.stage } : {}),
    ...(options.country ? { countryCode: options.country.toUpperCase() } : {}),
    ...(options.from || options.to ? { shopifyCreatedAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } } : {}),
    ...(options.search
      ? {
          OR: [
            { name: { contains: options.search, mode: "insensitive" } },
            { customerName: { contains: options.search, mode: "insensitive" } },
            { customerEmail: { contains: options.search, mode: "insensitive" } },
            { purchaseOrders: { some: { externalOrderId: { contains: options.search, mode: "insensitive" } } } },
            { purchaseOrders: { some: { trackings: { some: { number: { contains: options.search, mode: "insensitive" } } } } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        lineItems: { orderBy: { createdAt: "asc" } },
        purchaseOrders: { include: { trackings: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { shopifyCreatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function countOrdersByStage(shopId: string): Promise<Record<OrderStage, number>> {
  const rows = await prisma.order.groupBy({ by: ["stage"], where: { shopId }, _count: { _all: true } });
  const base: Record<OrderStage, number> = {
    PENDING: 0, AWAITING_ORDER: 0, AWAITING_PAYMENT: 0, AWAITING_SHIPMENT: 0, AWAITING_DELIVERY: 0, FULFILLED: 0, CANCELED: 0, FAILED: 0, IGNORED: 0,
  };
  for (const r of rows) base[r.stage] = r._count._all;
  return base;
}

export async function getOrderDetail(shopId: string, id: string) {
  return prisma.order.findFirst({
    where: { id, shopId },
    include: {
      lineItems: { orderBy: { createdAt: "asc" }, include: { productVariant: { include: { product: { select: { id: true, title: true } } } } } },
      purchaseOrders: { include: { items: true, trackings: true, supplierAccount: { select: { label: true, platform: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export async function updateOrderAddress(shop: ShopWithSettings, client: GraphqlClient | null, orderId: string, address: ShippingAddress, options: { pushToShopify: boolean }, actor?: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, shopId: shop.id } });
  if (!order) throw new Error("Order not found");
  const merged: ShippingAddress = { ...(order.shippingAddress as ShippingAddress), ...address };
  await prisma.order.update({ where: { id: orderId }, data: { shippingAddress: merged as Prisma.InputJsonValue, countryCode: merged.countryCode ?? order.countryCode, phone: merged.phone ?? order.phone } });
  if (options.pushToShopify && client) {
    await updateOrderShippingAddress(client, order.shopifyOrderId, {
      firstName: merged.firstName ?? undefined,
      lastName: merged.lastName ?? undefined,
      company: merged.company ?? undefined,
      address1: merged.address1 ?? undefined,
      address2: merged.address2 ?? undefined,
      city: merged.city ?? undefined,
      province: merged.province ?? undefined,
      zip: merged.zip ?? undefined,
      country: merged.country ?? undefined,
      phone: merged.phone ?? undefined,
    });
  }
  await logActivity(shop.id, { actor, action: "order.address_updated", entity: "Order", entityId: orderId, message: `Shipping address updated for ${order.name}.` });
  return evaluateAndStoreOrder(shop, orderId);
}

/** Force a line to be ignored (e.g. a gift card) so it no longer blocks the order. */
export async function setLineItemIgnored(shop: ShopWithSettings, orderId: string, lineItemId: string, ignored: boolean) {
  await prisma.orderLineItem.updateMany({ where: { id: lineItemId, orderId }, data: { isCanceled: ignored } });
  return evaluateAndStoreOrder(shop, orderId);
}

export function orderIssues(order: Order): OrderIssue[] {
  return (order.issues as unknown as OrderIssue[]) ?? [];
}

export function lineResolution(line: OrderLineItem): ResolveResult | null {
  const r = line.resolution as unknown as ResolveResult;
  return r && typeof r === "object" && "ok" in r ? r : null;
}
