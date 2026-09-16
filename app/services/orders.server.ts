import type { Order, OrderLineItem, OrderStage, Prisma, PurchaseOrder } from "@prisma/client";
import prisma from "~/db.server";
import { addressIsCompleteForShopify, applySuggestions, validateAddress, type ShippingAddress } from "~/domain/orders/address";
import { evaluateOrder as evaluatePipeline, type OrderIssue, type PurchaseOrderStatus } from "~/domain/orders/pipeline";
import type { ResolveResult } from "~/domain/mapping/types";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { resolveForVariant } from "./mapping.server";
import { notify } from "./notifications.server";
import type { ShopWithSettings } from "./shop.server";
import type { GraphqlClient } from "./shopify/graphql.server";
import { orderNeedsCustomerData } from "./compliance.server";
import { fetchOrder, fetchOrdersPage, updateOrderShippingAddress, type ShopifyOrderSnapshot } from "./shopify/orders.server";

export type OrderWithItems = Order & { lineItems: OrderLineItem[]; purchaseOrders: PurchaseOrder[] };

// ---------------------------------------------------------------------------
// Ingest from Shopify
// ---------------------------------------------------------------------------

/**
 * Mirror a Shopify order locally (idempotent) and re-evaluate its pipeline state.
 *
 * The customer's name, email, phone, street address and order note are only
 * stored when the app can act on the order (see orderNeedsCustomerData). The
 * install sync pulls every order from the last 30 days and every order webhook
 * lands here, so without the check a store selling mostly its own stock kept a
 * full address book of customers this app would never ship to. An order that
 * later gains a managed line gets its details on the next webhook or refresh,
 * because Shopify still has them.
 *
 * Shopify can also withhold those details: until the app is approved for
 * Protected customer data it answers name, email, phone and address as null,
 * with an access error naming each field (snapshot.redactedFields). An empty
 * value Shopify withheld is not the customer removing their address, so it
 * never overwrites what is already stored - otherwise one refresh of a placed
 * order erased the address its supplier order and any re-placement depend on.
 * The withholding is recorded instead (recordWithheldCustomerData).
 */
export async function upsertOrderFromSnapshot(shop: ShopWithSettings, snapshot: ShopifyOrderSnapshot): Promise<Order> {
  const address = snapshot.shippingAddress;
  const managedVariants = await prisma.productVariant.findMany({
    where: { product: { shopId: shop.id }, shopifyVariantId: { in: snapshot.lineItems.map((li) => li.variantId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, shopifyVariantId: true },
  });
  const variantByShopifyId = new Map(managedVariants.map((v) => [v.shopifyVariantId, v.id]));

  const stored = await prisma.order.findUnique({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: snapshot.id } },
    select: { id: true, customerName: true, customerEmail: true, phone: true, shippingAddress: true },
  });
  const keepCustomerData = await needsCustomerData(stored?.id ?? null, managedVariants.length);
  const withheld = withheldCustomerFields(snapshot.redactedFields);
  const fresh: CustomerColumns = keepCustomerData
    ? customerFields(snapshot)
    : { customerName: null, customerEmail: null, phone: null, note: null, shippingAddress: minimalAddressJson(address) };
  const { data: customer, kept } = keepWithheldCustomerData(fresh, stored, withheld, { personal: keepCustomerData });

  const order = await prisma.order.upsert({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: snapshot.id } },
    create: {
      shopId: shop.id,
      shopifyOrderId: snapshot.id,
      name: snapshot.name,
      orderNumber: snapshot.orderNumber,
      financialStatus: snapshot.displayFinancialStatus?.toLowerCase() ?? null,
      fulfillmentStatus: snapshot.displayFulfillmentStatus?.toLowerCase() ?? null,
      ...customer,
      countryCode: address?.countryCodeV2 ?? null,
      currency: snapshot.currencyCode,
      totalPrice: snapshot.totalPrice,
      totalShipping: snapshot.totalShipping,
      totalTax: snapshot.totalTax,
      totalDiscount: snapshot.totalDiscounts,
      tags: snapshot.tags,
      riskLevel: snapshot.riskLevel,
      isTest: snapshot.test,
      canceledAt: snapshot.cancelledAt ? new Date(snapshot.cancelledAt) : null,
      shopifyCreatedAt: new Date(snapshot.createdAt),
    },
    update: {
      name: snapshot.name,
      financialStatus: snapshot.displayFinancialStatus?.toLowerCase() ?? null,
      fulfillmentStatus: snapshot.displayFulfillmentStatus?.toLowerCase() ?? null,
      // An order that stopped needing the details (its product was unlinked
      // before anything was ordered) has them cleared rather than kept.
      ...(keepCustomerData
        ? {
            customerName: customer.customerName ?? undefined,
            customerEmail: customer.customerEmail ?? undefined,
            phone: customer.phone ?? undefined,
            note: customer.note,
            shippingAddress: customer.shippingAddress,
          }
        : customer),
      countryCode: address?.countryCodeV2 ?? undefined,
      totalPrice: snapshot.totalPrice,
      totalShipping: snapshot.totalShipping,
      totalTax: snapshot.totalTax,
      totalDiscount: snapshot.totalDiscounts,
      tags: snapshot.tags,
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

  if (withheld.length > 0) await recordWithheldCustomerData(shop.id, order, withheld, kept);

  return evaluateAndStoreOrder(shop, order.id);
}

/**
 * Whether this order may hold the customer's details: it has a managed line, or
 * the stored copy already has a supplier order or fulfilment request behind it.
 */
async function needsCustomerData(storedOrderId: string | null, managedLines: number): Promise<boolean> {
  if (managedLines > 0) return true;
  if (!storedOrderId) return false;
  const [purchaseOrders, fulfillmentRequests] = await Promise.all([
    prisma.purchaseOrder.count({ where: { orderId: storedOrderId } }),
    prisma.fulfillmentRequest.count({ where: { orderId: storedOrderId } }),
  ]);
  return orderNeedsCustomerData({ managedLines, purchaseOrders, fulfillmentRequests });
}

// ---------------------------------------------------------------------------
// Customer data Shopify withheld
// ---------------------------------------------------------------------------

/** The Order columns that hold the customer's details. */
export interface CustomerColumns {
  customerName: string | null;
  customerEmail: string | null;
  phone: string | null;
  note: string | null;
  shippingAddress: Prisma.InputJsonValue;
}

/** Snapshot paths that carry protected customer data; "*" means Shopify did not say which field. */
const CUSTOMER_DATA_PATHS = ["email", "phone", "customer", "shippingAddress"];

/**
 * The withheld paths that concern the customer's details, out of everything
 * Shopify refused on the order. Exported for tests.
 */
export function withheldCustomerFields(redactedFields: string[] | undefined): string[] {
  return (redactedFields ?? []).filter((path) => path === "*" || CUSTOMER_DATA_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)));
}

function isWithheld(withheld: string[], sources: string[]): boolean {
  // A path withholds its children ("shippingAddress" covers its phone) and a
  // withheld child makes its parent unreliable ("customer.defaultEmailAddress.emailAddress").
  return withheld.some((path) => path === "*" || sources.some((source) => path === source || source.startsWith(`${path}.`) || path.startsWith(`${source}.`)));
}

/** Where each stored value comes from in the snapshot, mirroring customerFields and toAddressJson. */
const COLUMN_SOURCES = {
  customerName: ["shippingAddress.name", "shippingAddress.firstName", "shippingAddress.lastName", "customer.firstName", "customer.lastName"],
  customerEmail: ["email", "customer.defaultEmailAddress"],
  phone: ["shippingAddress.phone", "phone", "customer.defaultPhoneNumber"],
} as const;

const ADDRESS_SOURCES: Record<keyof ShippingAddress, string[]> = {
  firstName: ["shippingAddress.firstName"],
  lastName: ["shippingAddress.lastName"],
  name: ["shippingAddress.name"],
  company: ["shippingAddress.company"],
  address1: ["shippingAddress.address1"],
  address2: ["shippingAddress.address2"],
  city: ["shippingAddress.city"],
  province: ["shippingAddress.province"],
  provinceCode: ["shippingAddress.provinceCode"],
  zip: ["shippingAddress.zip"],
  country: ["shippingAddress.country"],
  countryCode: ["shippingAddress.countryCodeV2"],
  phone: ["shippingAddress.phone", "phone", "customer.defaultPhoneNumber"],
  // Read from the order's custom attributes, but only written when an address
  // came back, so a withheld address drops it too.
  taxNumber: ["shippingAddress.taxNumber", "customAttributes"],
};

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The customer columns to write, with every value Shopify withheld taken from
 * the stored order instead of being cleared. Returns which fields were kept.
 *
 * Only a value that is empty now, that Shopify said it withheld, and that the
 * order already holds is kept; a field Shopify returned is always written as
 * returned. With `personal: false` (an order the app does not fulfil, which
 * keeps no personal details by design) only the destination country is kept.
 * Exported for tests.
 */
export function keepWithheldCustomerData(
  next: CustomerColumns,
  stored: { customerName: string | null; customerEmail: string | null; phone: string | null; shippingAddress: unknown } | null,
  withheld: string[],
  options: { personal: boolean },
): { data: CustomerColumns; kept: string[] } {
  if (!stored || withheld.length === 0) return { data: next, kept: [] };
  const data: CustomerColumns = { ...next };
  const kept: string[] = [];

  if (options.personal) {
    for (const column of Object.keys(COLUMN_SOURCES) as Array<keyof typeof COLUMN_SOURCES>) {
      if (isEmpty(next[column]) && !isEmpty(stored[column]) && isWithheld(withheld, [...COLUMN_SOURCES[column]])) {
        data[column] = stored[column];
        kept.push(column);
      }
    }
  }

  const storedAddress = asObject(stored.shippingAddress);
  const address = { ...asObject(next.shippingAddress) };
  const keys = options.personal ? (Object.keys(ADDRESS_SOURCES) as Array<keyof ShippingAddress>) : (["countryCode"] as const);
  for (const key of keys) {
    if (isEmpty(address[key]) && !isEmpty(storedAddress[key]) && isWithheld(withheld, ADDRESS_SOURCES[key])) {
      address[key] = storedAddress[key];
      kept.push(`shippingAddress.${key}`);
    }
  }
  if (kept.some((field) => field.startsWith("shippingAddress."))) data.shippingAddress = address as Prisma.InputJsonValue;
  return { data, kept };
}

const WITHHELD_ACTION = "order.customer_data_withheld";
/** One notification per shop for good: the cause is the app's approval, not any one order. */
const WITHHELD_DEDUPE_KEY = "protected-customer-data-withheld";

/**
 * Say, once per order in its activity log and once per shop as a notification,
 * that Shopify withheld the customer's details and why.
 *
 * Without this an order simply showed no address, which reads as a customer
 * who gave none or a sync bug. Only field names are recorded, never values.
 * Best effort: a failure to log must not fail the order sync.
 */
async function recordWithheldCustomerData(shopId: string, order: { id: string; name: string }, withheld: string[], kept: string[]): Promise<void> {
  try {
    const already = await prisma.activityLog.findFirst({ where: { shopId, action: WITHHELD_ACTION, entity: "Order", entityId: order.id }, select: { id: true } });
    if (already) return;
    const fields = withheld.includes("*") ? "customer details" : withheld.join(", ");
    await logActivity(shopId, {
      action: WITHHELD_ACTION,
      entity: "Order",
      entityId: order.id,
      level: "warn",
      message:
        `Shopify withheld ${fields} on ${order.name} because the app is not approved for Protected customer data access.` +
        (kept.length > 0 ? " The details already stored on the order were kept." : ""),
      meta: { withheld, kept },
    });
    await notify(shopId, {
      type: "system",
      severity: "warning",
      title: "Shopify is withholding customer details from orders",
      body:
        `Shopify returned ${order.name} without ${fields}. This happens until DropshipHub is approved for Protected customer data access ` +
        "(name, email, phone and address) in the Shopify Partner Dashboard. Until then new orders arrive without the shipping address a supplier order needs; details already stored are kept.",
      link: `/app/orders/${order.id}`,
      dedupeKey: WITHHELD_DEDUPE_KEY,
      dedupeMinutes: "forever",
    });
  } catch (error) {
    logger.warn("Could not record withheld customer data", { shopId, orderId: order.id, error });
  }
}

function customerFields(snapshot: ShopifyOrderSnapshot): CustomerColumns {
  const address = snapshot.shippingAddress;
  const fallbackName = [snapshot.customer?.firstName, snapshot.customer?.lastName].filter(Boolean).join(" ");
  return {
    customerName: address?.name || fallbackName || null,
    customerEmail: snapshot.email ?? snapshot.customer?.email ?? null,
    phone: address?.phone ?? snapshot.phone ?? snapshot.customer?.phone ?? null,
    note: snapshot.note ?? null,
    shippingAddress: toAddressJson(address, snapshot),
  };
}

/**
 * What an order the app will not ship keeps of the address: the destination
 * country, which the reports group by. The same shape a redacted order keeps.
 */
function minimalAddressJson(address: ShopifyOrderSnapshot["shippingAddress"]): Prisma.InputJsonValue {
  return address?.countryCodeV2 ? { countryCode: address.countryCodeV2 } : {};
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
  // Scoped here rather than at each call site: every order mutation funnels
  // through this function, and the ids reach it straight from form fields.
  if (!order || order.shopId !== shop.id) throw new Error("Order not found");
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
  if (options.pushToShopify && !addressIsCompleteForShopify(merged)) {
    throw new Error("This address is incomplete, so it was not sent to Shopify: that would replace the order's real address with blank fields. Edit the address in Shopify instead.");
  }
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
