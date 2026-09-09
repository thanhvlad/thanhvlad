import { createHash } from "node:crypto";
import type { Prisma, PurchaseOrder, PurchaseOrderStatus, SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import type { ResolveResult, ResolvedSupplierLine } from "~/domain/mapping/types";
import { evaluateOrder as evaluatePipeline } from "~/domain/orders/pipeline";
import { AppError, errorMessage, isRetryable } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money, sum, type Decimal } from "~/lib/money";
import { logActivity } from "./activity.server";
import { getKnownRate } from "./currency.server";
import { notify } from "./notifications.server";
import { evaluateAndStoreOrder, lineResolution, orderIssues, supplierAddressFor } from "./orders.server";
import { chooseShippingForShop } from "./shipping.server";
import type { ShopWithSettings } from "./shop.server";
import { offlineClient, type GraphqlClient } from "./shopify/graphql.server";
import { addOrderTags, createFulfillmentWithTracking, updateFulfillmentTracking } from "./shopify/orders.server";
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

interface GroupLine {
  lineItemId: string;
  lineItemTitle: string;
  resolved: ResolvedSupplierLine;
  supplierProductId: string;
}

interface Group {
  platform: SupplierPlatform;
  lines: GroupLine[];
}

/** Per-supplier-product shipping choice, applied to that product's items only. */
interface ShippingChoice {
  carrierCode: string | null;
  carrierName: string | null;
  shipFromCountry: string | null;
  estimatedDeliveryDays: number | null;
  cost: string | null;
  reason: string;
}

const NO_SHIPPING_CHOICE: ShippingChoice = {
  carrierCode: null,
  carrierName: null,
  shipFromCountry: null,
  estimatedDeliveryDays: null,
  cost: null,
  reason: "",
};

/** How long a purchase order may sit in SUBMITTING before it is treated as dead. */
const SUBMITTING_TIMEOUT_MS = 10 * 60_000;

/**
 * One supplier line, identified so coverage survives a bundle that spans two
 * platforms: keying on the Shopify line alone would mark the whole line covered
 * as soon as either half was ordered.
 */
function coverageKey(orderLineItemId: string | null, supplierVariantId: string | null): string {
  return `${orderLineItemId ?? ""}:${supplierVariantId ?? ""}`;
}

/**
 * Stable reference for a purchase order, reused across retries.
 *
 * Suppliers de-duplicate on the reference we send them, so it has to survive a
 * retry: a fresh cuid per attempt means a lost response is re-placed as a brand
 * new order and the merchant pays twice.
 */
function idempotencyKeyFor(orderId: string, platform: string, lines: GroupLine[]): string {
  const parts = lines
    .map((l) => `${l.lineItemId}#${l.resolved.supplierVariantId}x${l.resolved.quantity}`)
    .sort();
  const digest = createHash("sha256").update(`${orderId}|${platform}|${parts.join("|")}`).digest("hex");
  return `dh-${digest.slice(0, 24)}`;
}

/**
 * Turn one Shopify order into supplier purchase orders and submit them.
 *
 * Lines are grouped per platform (one upstream order per supplier account) and
 * shipping is quoted per supplier product, because two products on the same
 * platform routinely ship from different warehouses.
 *
 * Concurrency: the coverage read and the purchase-order writes happen inside a
 * transaction holding an advisory lock on the order, so a scheduled auto-place
 * and a merchant clicking "Order now" at the same moment cannot both decide the
 * order is unordered and both place it upstream.
 */
export async function placeSupplierOrders(
  shop: ShopWithSettings,
  orderId: string,
  options: {
    force?: boolean;
    actor?: string;
    supplierNote?: string | null;
    /**
     * Restrict placement to these Shopify line items. Shopify splits an order
     * into several fulfilment orders and asks about them one at a time, so
     * without a scope a single "Request fulfillment" on one of them orders
     * every outstanding line on the whole order upstream.
     */
    shopifyLineItemIds?: string[];
  } = {},
): Promise<PlaceOrderOutcome> {
  const order = await evaluateAndStoreOrder(shop, orderId);
  const full = await prisma.order.findUnique({ where: { id: orderId }, include: { lineItems: true, purchaseOrders: true } });
  if (!full) return { orderId, ok: false, purchaseOrderIds: [], error: "Order not found" };
  if (full.shopId !== shop.id) return { orderId, ok: false, purchaseOrderIds: [], error: "Order not found" };

  const issues = orderIssues(order).filter((i) => i.severity === "error");
  if (issues.length > 0 && !options.force) {
    return { orderId, ok: false, purchaseOrderIds: [], error: "Order is not ready", issues: issues.map((i) => i.message) };
  }

  const covered = await coveredSupplierLines(orderId);

  const scope = options.shopifyLineItemIds?.length ? new Set(options.shopifyLineItemIds) : null;

  const groups = new Map<string, Group>();
  for (const li of full.lineItems) {
    if (scope && !scope.has(li.shopifyLineItemId)) continue;
    if (!li.productVariantId || li.isCanceled || li.isFulfilled) continue;
    const resolution = lineResolution(li);
    if (!resolution?.ok) continue;
    for (const resolved of resolution.lines) {
      if (covered.has(coverageKey(li.id, resolved.supplierVariantId))) continue;
      const sv = await prisma.supplierVariant.findUnique({ where: { id: resolved.supplierVariantId }, select: { supplierProductId: true } });
      const key = resolved.platform;
      const group = groups.get(key) ?? { platform: resolved.platform as SupplierPlatform, lines: [] };
      group.lines.push({ lineItemId: li.id, lineItemTitle: li.title, resolved, supplierProductId: sv?.supplierProductId ?? "" });
      groups.set(key, group);
    }
  }

  if (groups.size === 0) {
    // Placing an order that is already placed is a safe no-op, not an error:
    // the bulk job, the auto-place tick and the merchant's button all reach
    // here, and any of them can arrive second.
    const live = full.purchaseOrders.filter((po) => !["FAILED", "CANCELED", "DRAFT"].includes(po.status));
    if (live.length > 0) {
      return { orderId, ok: true, purchaseOrderIds: live.map((po) => po.id) };
    }
    return { orderId, ok: false, purchaseOrderIds: [], error: "Nothing to order: every line is unmapped, fulfilled or already ordered." };
  }

  // The phone fallback is applied here, on the way to the supplier, so the
  // stored order keeps the customer's own number.
  const address = supplierAddressFor(full, shop.parsedSettings.orders);
  const country = (address.countryCode ?? full.countryCode ?? "US").toUpperCase();
  const purchaseOrderIds: string[] = [];
  const errors: string[] = [];

  for (const group of groups.values()) {
    const { adapter, account } = await adapterForShop(shop.id, group.platform);

    // Shipping is quoted per supplier product, with that product's own
    // quantity, and stored per item. One quote for the whole group priced the
    // wrong product and forced its carrier and warehouse onto every other line.
    let shipping: Map<string, ShippingChoice>;
    try {
      shipping = await quoteShippingPerProduct(shop, group, country);
    } catch (error) {
      if (error instanceof AppError && error.code === "NO_SHIPPING") {
        errors.push(error.message);
        await recordFailedPurchaseOrder(shop, full.id, group, account?.id ?? null, "NO_SHIPPING", error.message);
        continue;
      }
      throw error;
    }
    const choiceFor = (line: GroupLine) => shipping.get(line.supplierProductId) ?? NO_SHIPPING_CHOICE;
    // The purchase order keeps the dominant choice for display; the authority
    // for what was actually asked of the supplier is on each item.
    const headline = choiceFor(group.lines[0]);
    const idempotencyKey = idempotencyKeyFor(full.id, group.platform, group.lines);

    const created = await createPurchaseOrderExclusively({
      orderId: full.id,
      idempotencyKey,
      supplierAccountId: account?.id ?? null,
      group,
      headline,
      choiceFor,
      supplierNote: options.supplierNote ?? shop.parsedSettings.orders.supplierNote,
      shippingReason: [...new Set([...shipping.values()].map((c) => c.reason).filter(Boolean))].join(" "),
    });
    if (!created.po) {
      // Another caller got there first between our coverage read and this
      // write, or the same purchase order already exists.
      logger.info("Skipping duplicate purchase order", { orderId, platform: group.platform, reason: created.reason });
      continue;
    }
    const po = created.po;
    purchaseOrderIds.push(po.id);

    const payload: PlaceOrderInput = {
      reference: po.idempotencyKey ?? po.id,
      items: group.lines.map((l) => ({
        externalProductId: l.resolved.externalProductId,
        externalSkuId: l.resolved.externalSkuId,
        externalSkuAttr: l.resolved.skuAttr ?? null,
        quantity: l.resolved.quantity,
        carrierCode: choiceFor(l).carrierCode,
        shipFromCountry: choiceFor(l).shipFromCountry,
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
      // A supplier that does not itemise the order returns "0.00" for these.
      // Storing that verbatim wipes the cost this app already computed from the
      // mapped variants and the chosen shipping quote, so the purchase order -
      // and every payment total built from it - reads zero for a real order.
      // Take the adapter's figure only when it actually carries one.
      const itemsCost = d(result.itemsCost).isZero() ? d(po.itemsCost) : d(result.itemsCost);
      const shippingCost = d(result.shippingCost).isZero() ? d(po.shippingCost) : d(result.shippingCost);
      const totalCost = d(result.totalCost).isZero() ? itemsCost.plus(shippingCost) : d(result.totalCost);
      const converted = await toShopCurrency(shop.currency, result.currency, itemsCost, shippingCost);
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: {
          status: toPurchaseOrderStatus(result.status),
          externalOrderId: result.externalOrderId,
          itemsCost: money(itemsCost),
          shippingCost: money(shippingCost),
          totalCost: money(totalCost),
          currency: result.currency,
          ...converted,
          placedAt: new Date(),
          paymentUrl: result.paymentUrl ?? null,
          paymentDueAt: result.paymentDueAt ?? null,
          errorCode: null,
          errorMessage: null,
          raw: { ...(po.raw as object), externalOrderIds: result.externalOrderIds ?? [result.externalOrderId], response: sanitize(result.raw) } as Prisma.InputJsonValue,
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
      // A transport failure says nothing about whether the supplier committed
      // the order; only an explicit rejection does.
      const unconfirmed = isRetryable(error) && !(error instanceof AppError && error.code === "SUPPLIER_REJECTED");
      errors.push(`${group.platform}: ${message}`);
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: unconfirmed
          ? // The request may well have been committed upstream; calling it
            // FAILED invites a retry that orders the goods a second time. It
            // stays SUBMITTING, flagged, until the merchant or the sweeper
            // resolves it — and the retry reuses this row and its reference.
            { errorCode: "UNCONFIRMED", errorMessage: message }
          : { status: "FAILED", errorCode: error instanceof AppError ? error.code : "SUPPLIER_ERROR", errorMessage: message },
      });
      await logActivity(shop.id, {
        actor: options.actor,
        action: unconfirmed ? "order.place_unconfirmed" : "order.place_failed",
        entity: "Order",
        entityId: full.id,
        level: "error",
        message: unconfirmed
          ? `${full.name}: no reply from ${group.platform} — ${message}. Check your ${group.platform} order list before retrying.`
          : `${full.name}: ${group.platform} rejected the order — ${message}`,
      });
      if (shop.parsedSettings.notifications.onOrderFailed) {
        await notify(shop.id, {
          type: "order.failed",
          severity: "critical",
          title: unconfirmed ? `Order ${full.name} may not have reached ${group.platform}` : `Order ${full.name} failed at ${group.platform}`,
          body: unconfirmed ? `${message}. Check your ${group.platform} order list before retrying.` : message,
          link: `/app/orders/${full.id}`,
          dedupeKey: `order-failed:${po.id}`,
          dedupeMinutes: 30,
        });
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

/**
 * Supplier lines an existing purchase order already covers.
 *
 * A purchase order stuck in SUBMITTING past the timeout stops counting: the
 * process that created it is gone, so its lines would otherwise be blocked
 * forever with no way to place or retry them.
 */
async function coveredSupplierLines(orderId: string): Promise<Set<string>> {
  const items = await prisma.purchaseOrderItem.findMany({
    where: { purchaseOrder: { orderId, status: { notIn: ["FAILED", "CANCELED", "DRAFT"] } } },
    select: {
      orderLineItemId: true,
      supplierVariantId: true,
      purchaseOrder: { select: { status: true, createdAt: true, errorCode: true } },
    },
  });
  const cutoff = Date.now() - SUBMITTING_TIMEOUT_MS;
  const live = items.filter((i) => {
    if (i.purchaseOrder.status !== "SUBMITTING") return true;
    // An unconfirmed submission still counts: it may have reached the supplier.
    if (i.purchaseOrder.errorCode === "UNCONFIRMED") return true;
    return i.purchaseOrder.createdAt.getTime() > cutoff;
  });
  return new Set(live.map((i) => coverageKey(i.orderLineItemId, i.supplierVariantId)));
}

/**
 * Quote shipping once per supplier product in the group.
 *
 * Products on one platform routinely ship from different warehouses and offer
 * different carriers, so a single quote taken from the first line — priced for
 * the whole group's quantity — was both the wrong price and the wrong carrier
 * for everything else in the order.
 */
async function quoteShippingPerProduct(
  shop: ShopWithSettings,
  group: Group,
  country: string,
): Promise<Map<string, ShippingChoice>> {
  const byProduct = new Map<string, GroupLine[]>();
  for (const line of group.lines) {
    byProduct.set(line.supplierProductId, [...(byProduct.get(line.supplierProductId) ?? []), line]);
  }

  const choices = new Map<string, ShippingChoice>();
  for (const [supplierProductId, lines] of byProduct) {
    if (!supplierProductId) {
      choices.set(supplierProductId, { ...NO_SHIPPING_CHOICE, reason: "No supplier product on file; supplier default used." });
      continue;
    }
    try {
      const quotes = await getShippingOptions(shop.id, supplierProductId, {
        shipToCountry: country,
        externalSkuId: lines[0].resolved.externalSkuId,
        quantity: lines.reduce((n, l) => n + l.resolved.quantity, 0),
        maxAgeMinutes: 60,
      });
      const choice = await chooseShippingForShop(shop.id, shop.parsedSettings.shipping, quotes, country);
      if (!choice.ok && shop.parsedSettings.shipping.fallback === "NONE") {
        throw new AppError("NO_SHIPPING", choice.reason);
      }
      choices.set(supplierProductId, {
        carrierCode: choice.option?.carrierCode ?? null,
        carrierName: choice.option?.carrierName ?? null,
        shipFromCountry: choice.option?.shipFromCountry ?? null,
        estimatedDeliveryDays: choice.option?.maxDeliveryDays ?? null,
        cost: choice.option ? money(d(choice.option.cost)) : null,
        reason: choice.reason,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "NO_SHIPPING") throw error;
      logger.warn("Shipping quote failed; continuing with supplier default", { supplierProductId, error });
      choices.set(supplierProductId, {
        ...NO_SHIPPING_CHOICE,
        reason: `Shipping quote failed (${errorMessage(error)}); supplier default used.`,
      });
    }
  }
  return choices;
}

/**
 * Create the purchase order under a lock on its Shopify order.
 *
 * Four call sites can reach placement concurrently (the auto-place tick, the
 * bulk job, the fulfilment-request webhook and the merchant's own button) and
 * the worker runs several at once, so a plain read-then-write on coverage lets
 * two of them place the same order upstream. The advisory lock serialises them
 * per order, and the unique key on (orderId, idempotencyKey) is the backstop.
 */
async function createPurchaseOrderExclusively(input: {
  orderId: string;
  idempotencyKey: string;
  supplierAccountId: string | null;
  group: Group;
  headline: ShippingChoice;
  choiceFor: (line: GroupLine) => ShippingChoice;
  supplierNote: string | null;
  shippingReason: string;
}): Promise<{ po: PurchaseOrder | null; reason?: string }> {
  const { group, choiceFor } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      // Transaction-scoped: released on commit or rollback, no cleanup needed.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.orderId}))`;

      const existing = await tx.purchaseOrder.findFirst({
        where: { orderId: input.orderId, idempotencyKey: input.idempotencyKey },
        select: { id: true, status: true },
      });
      if (existing) return { po: null, reason: `already exists (${existing.status})` };

      // Re-read coverage now that we hold the lock: a concurrent caller may
      // have created a purchase order since our first read.
      const covered = await coveredSupplierLines(input.orderId);
      if (group.lines.every((l) => covered.has(coverageKey(l.lineItemId, l.resolved.supplierVariantId)))) {
        return { po: null, reason: "covered by a concurrent placement" };
      }

      const po = await tx.purchaseOrder.create({
        data: {
          orderId: input.orderId,
          idempotencyKey: input.idempotencyKey,
          supplierAccountId: input.supplierAccountId,
          platform: group.platform,
          status: "SUBMITTING",
          currency: group.lines[0].resolved.currency,
          itemsCost: money(sum(group.lines.map((l) => d(l.resolved.unitCost).times(l.resolved.quantity)))),
          carrierCode: input.headline.carrierCode,
          carrierName: input.headline.carrierName,
          shipFromCountry: input.headline.shipFromCountry,
          estimatedDeliveryDays: input.headline.estimatedDeliveryDays,
          supplierNote: input.supplierNote,
          attempts: 1,
          lastAttemptAt: new Date(),
          raw: { shippingReason: input.shippingReason } as Prisma.InputJsonValue,
          items: {
            create: group.lines.map((l) => {
              const choice = choiceFor(l);
              return {
                orderLineItemId: l.lineItemId,
                supplierVariantId: l.resolved.supplierVariantId,
                externalProductId: l.resolved.externalProductId,
                externalSkuId: l.resolved.externalSkuId,
                externalSkuAttr: l.resolved.skuAttr ?? null,
                title: l.resolved.title,
                quantity: l.resolved.quantity,
                unitCost: l.resolved.unitCost,
                currency: l.resolved.currency,
                carrierCode: choice.carrierCode,
                carrierName: choice.carrierName,
                shipFromCountry: choice.shipFromCountry,
                estimatedDeliveryDays: choice.estimatedDeliveryDays,
                shippingCost: choice.cost,
              };
            }),
          },
        },
      });
      return { po };
    });
  } catch (error) {
    // The unique index caught a race the lock could not (a different database
    // connection pool, say). Not an error: the order is already placed.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      return { po: null, reason: "duplicate rejected by the database" };
    }
    throw error;
  }
}

/**
 * Convert supplier amounts into the shop's currency.
 *
 * Purchase orders are denominated in whatever the supplier reports — AliExpress
 * answers in the account's currency, CJ in USD — and the order-level totals are
 * displayed and reported as shop currency. Summing them unconverted turns a
 * $12.40 cost into "£12.40" and a ¥88 cost into a loss.
 */
async function toShopCurrency(
  shopCurrency: string,
  supplierCurrency: string,
  itemsCost: string | number | Decimal,
  shippingCost: string | number | Decimal,
): Promise<{ shopCurrency: string; shopItemsCost: string; shopShippingCost: string; fxRate: string } | Record<string, never>> {
  if (!supplierCurrency || !shopCurrency) return {};
  try {
    const rate = await getKnownRate(supplierCurrency, shopCurrency);
    if (rate === null) return {};
    return {
      shopCurrency,
      shopItemsCost: money(d(itemsCost).times(rate)),
      shopShippingCost: money(d(shippingCost).times(rate)),
      fxRate: d(rate).toFixed(8),
    };
  } catch (error) {
    logger.warn("Could not convert supplier cost to shop currency", { supplierCurrency, shopCurrency, error });
    return {};
  }
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
          externalSkuAttr: l.resolved.skuAttr ?? null,
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

/**
 * Look a purchase order up inside the calling shop.
 *
 * Every mutation below takes an id straight from a form field, so the lookup
 * has to be scoped: by primary key alone, a merchant could retry, cancel or
 * re-place another store's purchase order.
 */
async function ownedPurchaseOrder<T extends Prisma.PurchaseOrderInclude>(
  shopId: string,
  purchaseOrderId: string,
  include?: T,
) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, order: { shopId } },
    ...(include ? { include } : {}),
  });
  if (!po) throw new Error("Purchase order not found");
  return po as Prisma.PurchaseOrderGetPayload<{ include: T }>;
}

/**
 * Retry a purchase order.
 *
 * The row is reused rather than deleted and recreated, so its idempotency key
 * is unchanged and the supplier can recognise the retry as the same order. A
 * purchase order abandoned in SUBMITTING (the process died mid-placement) is
 * retryable too — otherwise its lines are blocked forever with nothing in the
 * product able to unstick them.
 */
export async function retryPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string, actor?: string) {
  const po = await ownedPurchaseOrder(shop.id, purchaseOrderId);
  const stale = po.status === "SUBMITTING" && Date.now() - po.createdAt.getTime() > SUBMITTING_TIMEOUT_MS;
  if (po.status !== "FAILED" && po.status !== "CANCELED" && !stale) {
    throw new Error("Only failed, canceled or abandoned purchase orders can be retried.");
  }
  if (po.externalOrderId) {
    throw new Error(
      `This purchase order already has a supplier order (${po.externalOrderId}). Cancel it at the supplier before retrying, or the goods are ordered twice.`,
    );
  }
  await prisma.purchaseOrder.delete({ where: { id: po.id } });
  await logActivity(shop.id, {
    actor,
    action: "order.retry",
    entity: "Order",
    entityId: po.orderId,
    message: `Retrying the ${po.platform} purchase order.`,
  });
  return placeSupplierOrders(shop, po.orderId, { actor, force: true });
}

/** Merchant placed it by hand; link the upstream id so tracking can sync. */
export async function markPurchaseOrderManual(shop: ShopWithSettings, purchaseOrderId: string, externalOrderId: string, actor?: string) {
  const owned = await ownedPurchaseOrder(shop.id, purchaseOrderId);
  const po = await prisma.purchaseOrder.update({
    where: { id: owned.id },
    data: { externalOrderId: externalOrderId.trim(), status: "PLACED", placedAt: new Date(), errorCode: null, errorMessage: null },
  });
  await logActivity(shop.id, { actor, action: "order.manual_link", entity: "Order", entityId: po.orderId, message: `Supplier order ${externalOrderId} linked manually.` });
  await evaluateAndStoreOrder(shop, po.orderId);
  return po;
}

export async function cancelPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string, reason?: string, actor?: string) {
  const po = await ownedPurchaseOrder(shop.id, purchaseOrderId, { order: true });
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

/**
 * Progress ranking, used to stop a transient upstream read from regressing a
 * purchase order (a "PLACED" answered after "SHIPPED" would hide the tracking).
 *
 * Every status has a distinct rank. DELIVERED and CANCELED sharing rank 5 let a
 * delivered order flip to CANCELED on a post-delivery dispute, zeroing its costs
 * and rewriting that day's profit; PLACED and AWAITING_PAYMENT sharing a rank
 * let a purchase order oscillate between them on every poll.
 */
const ORDER_RANK: Record<PurchaseOrderStatus, number> = {
  DRAFT: 0, FAILED: 1, SUBMITTING: 2, PLACED: 3, AWAITING_PAYMENT: 4, PAID: 5, SHIPPED: 6, DELIVERED: 7, CANCELED: 8,
};

/** Past this, a cancellation is a return or a dispute, not the order falling through. */
const CANCELABLE_UP_TO = ORDER_RANK.PAID;

/**
 * Fold an upstream reading into the stored status without regressing, and
 * without letting a late cancellation rewrite a shipped or delivered order.
 */
function nextStatus(current: PurchaseOrderStatus, upstream: PurchaseOrderStatus): PurchaseOrderStatus {
  if (current === upstream) return current;
  if (upstream === "CANCELED") {
    // A dispute or refund after delivery reads as CANCELED upstream. Accepting
    // it would zero the order's supplier cost and rewrite that day's profit as
    // if the goods had been free.
    return ORDER_RANK[current] <= CANCELABLE_UP_TO ? "CANCELED" : current;
  }
  if (current === "CANCELED") return current;
  return ORDER_RANK[upstream] > ORDER_RANK[current] ? upstream : current;
}

/** Poll one purchase order upstream; pull tracking when shipped. */
export async function syncPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string): Promise<{ changed: boolean; status: PurchaseOrderStatus; newTracking: number }> {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, order: { shopId: shop.id } }, include: { order: true, trackings: true } });
  if (!po || !po.externalOrderId) return { changed: false, status: po?.status ?? "DRAFT", newTracking: 0 };

  const { adapter } = await adapterForShop(shop.id, po.platform);
  const upstream = await adapter.getOrder(po.externalOrderId);
  if (!upstream) return { changed: false, status: po.status, newTracking: 0 };

  const next = toPurchaseOrderStatus(upstream.status);
  const status = nextStatus(po.status, next);
  const changed = status !== po.status;
  const converted = await toShopCurrency(
    shop.currency,
    upstream.currency ?? po.currency,
    upstream.itemsCost ?? po.itemsCost,
    upstream.shippingCost ?? po.shippingCost,
  );

  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: {
      status,
      itemsCost: upstream.itemsCost ?? undefined,
      shippingCost: upstream.shippingCost ?? undefined,
      totalCost: upstream.totalCost ?? undefined,
      currency: upstream.currency ?? undefined,
      ...converted,
      canceledAt: status === "CANCELED" && !po.canceledAt ? new Date() : undefined,
      paidAt: upstream.paidAt ?? (ORDER_RANK[status] >= ORDER_RANK.PAID && !po.paidAt ? new Date() : undefined),
      shippedAt: upstream.shippedAt ?? (ORDER_RANK[status] >= ORDER_RANK.SHIPPED && !po.shippedAt ? new Date() : undefined),
      paymentUrl: upstream.paymentUrl ?? po.paymentUrl ?? undefined,
      // Once the supplier confirms payment the deadline no longer applies.
      paymentDueAt: ORDER_RANK[status] >= ORDER_RANK.PAID ? null : undefined,
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
    include: { purchaseOrder: { include: { order: true, items: true, trackings: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (pending.length === 0) return { synced: 0, failed: 0 };

  const graphql = client ?? (await offlineClient(shop.domain));
  const settings = shop.parsedSettings.fulfillment;
  let synced = 0;
  let failed = 0;

  // A supplier order that ships as several parcels produces several tracking
  // numbers for the same line items. Handling them one at a time made the first
  // parcel consume the whole order and left every later number unsynced with no
  // fulfilment attached, so the customer never received it. They are batched per
  // purchase order and go on one fulfilment.
  const byPurchaseOrder = new Map<string, typeof pending>();
  for (const tracking of pending) {
    byPurchaseOrder.set(tracking.purchaseOrderId, [...(byPurchaseOrder.get(tracking.purchaseOrderId) ?? []), tracking]);
  }

  for (const [poId, trackings] of byPurchaseOrder) {
    const po = trackings[0].purchaseOrder;
    const lineItemIds = po.items.map((i) => i.orderLineItemId).filter((id): id is string => Boolean(id));
    const lines = await prisma.orderLineItem.findMany({ where: { id: { in: lineItemIds } } });
    const outstanding = lines.filter((l) => l.fulfillableQuantity > 0);
    const trackingIds = trackings.map((t) => t.id);
    const numbers = trackings.map((t) => t.number);
    const company = settings.carrierNameOverride || trackings[0].carrierName || trackings[0].carrierCode || undefined;
    const urlFor = (t: (typeof trackings)[number]) =>
      settings.trackingUrlTemplate ? settings.trackingUrlTemplate.replace("{tracking}", t.number) : t.trackingUrl;

    try {
      if (outstanding.length > 0) {
        const result = await createFulfillmentWithTracking(graphql, {
          orderId: po.order.shopifyOrderId,
          // Derived from the purchase order and the exact set of tracking
          // numbers, so a retry of this same shipment is recognised by Shopify
          // rather than fulfilled a second time.
          idempotencyKey: createHash("sha256").update(`${poId}|${[...numbers].sort().join(",")}`).digest("hex").slice(0, 40),
          // Only what is genuinely still outstanding: falling back to the full
          // quantity re-fulfilled the whole order for the second parcel.
          items: outstanding.map((l) => ({ lineItemId: l.shopifyLineItemId, quantity: l.fulfillableQuantity })),
          tracking: { numbers, company, urls: trackings.map(urlFor).filter((u): u is string => Boolean(u)) },
          notifyCustomer: trackings.some((t) => t.notifyCustomer) && settings.notifyCustomer,
        });

        if (result.skipped) {
          // Shopify has nothing left to fulfil even though we thought it did:
          // the merchant fulfilled outside the app. Attach to the existing
          // fulfilment if we know it, otherwise stop retrying and say why.
          await attachOrRetire(graphql, shop, po, trackings, numbers, company, result.reason);
        } else {
          await prisma.trackingNumber.updateMany({
            where: { id: { in: trackingIds } },
            data: { syncedToShopify: true, syncedAt: new Date(), shopifyFulfillmentId: result.id, syncError: null },
          });
          // Record what this batch actually fulfilled, and decrement rather than
          // zeroing, so a later parcel still has quantity to work with.
          await prisma.trackingNumber.update({
            where: { id: trackingIds[0] },
            data: { fulfilledQuantities: result.fulfilled as Prisma.InputJsonValue },
          });
          for (const line of outstanding) {
            const done = result.fulfilled[line.shopifyLineItemId] ?? 0;
            if (done <= 0) continue;
            const remaining = Math.max(0, line.fulfillableQuantity - done);
            await prisma.orderLineItem.update({
              where: { id: line.id },
              data: { fulfillableQuantity: remaining, isFulfilled: remaining === 0 },
            });
          }
        }
      } else {
        await attachOrRetire(graphql, shop, po, trackings, numbers, company, "No unfulfilled quantity left on the Shopify order.");
      }

      synced += trackings.length;
      await logActivity(shop.id, {
        action: "tracking.synced",
        entity: "Order",
        entityId: po.orderId,
        message: `${po.order.name}: tracking ${numbers.join(", ")} synced to Shopify.`,
      });
      if (shop.parsedSettings.orders.tagOnShipped) {
        await addOrderTags(graphql, po.order.shopifyOrderId, [shop.parsedSettings.orders.tagOnShipped]).catch(() => undefined);
      }
      if (shop.parsedSettings.notifications.onTrackingSynced) {
        await notify(shop.id, { type: "tracking.synced", title: `${po.order.name} fulfilled`, body: `Tracking ${numbers.join(", ")}`, link: `/app/orders/${po.orderId}`, dedupeKey: `tracking:${poId}:${numbers.join(",")}` });
      }
    } catch (error) {
      failed += trackings.length;
      const message = errorMessage(error);
      await prisma.trackingNumber.updateMany({ where: { id: { in: trackingIds } }, data: { syncError: message } });
      await logActivity(shop.id, { action: "tracking.sync_failed", entity: "Order", entityId: po.orderId, level: "error", message: `${po.order.name}: could not sync tracking ${numbers.join(", ")} — ${message}` });
    }
    await evaluateAndStoreOrder(shop, po.orderId);
  }
  return { synced, failed };
}

/**
 * Nothing left to fulfil in Shopify for this purchase order.
 *
 * If a fulfilment already exists, append the new numbers to it — that is how a
 * second parcel reaches the customer. If none exists, the order was fulfilled
 * outside the app: stop retrying every twenty minutes and record why, rather
 * than marking the tracking synced with no fulfilment behind it.
 */
async function attachOrRetire(
  graphql: GraphqlClient,
  shop: ShopWithSettings,
  po: { id: string; orderId: string; trackings: Array<{ number: string; shopifyFulfillmentId: string | null }> },
  trackings: Array<{ id: string }>,
  numbers: string[],
  company: string | undefined,
  reason: string | null,
) {
  const fulfillmentId = po.trackings.find((t) => t.shopifyFulfillmentId)?.shopifyFulfillmentId ?? null;
  const trackingIds = trackings.map((t) => t.id);

  if (!fulfillmentId) {
    await prisma.trackingNumber.updateMany({
      where: { id: { in: trackingIds } },
      data: {
        syncedToShopify: true,
        syncedAt: new Date(),
        syncError: `${reason ?? "Nothing left to fulfil"} — the order was fulfilled outside the app, so this tracking number was not attached.`,
      },
    });
    return;
  }

  // Shopify replaces the tracking set, so send every number the fulfilment
  // should end up with, not just the new ones.
  const all = [...new Set([...po.trackings.map((t) => t.number), ...numbers])];
  await updateFulfillmentTracking(
    graphql,
    fulfillmentId,
    { numbers: all, company },
    shop.parsedSettings.fulfillment.notifyCustomer,
  );
  await prisma.trackingNumber.updateMany({
    where: { id: { in: trackingIds } },
    data: { syncedToShopify: true, syncedAt: new Date(), shopifyFulfillmentId: fulfillmentId, syncError: null },
  });
}

/** Manual tracking entry from the order page. */
export async function addManualTracking(
  shop: ShopWithSettings,
  purchaseOrderId: string,
  input: { number: string; carrierName?: string | null; url?: string | null; notifyCustomer?: boolean },
  actor?: string,
  // Optional for the same reason `syncPendingTracking` takes one: a caller that
  // already holds an Admin client (a route, a script) should not make the code
  // reach for the shop's offline session again.
  client?: GraphqlClient,
) {
  const po = await ownedPurchaseOrder(shop.id, purchaseOrderId);
  const tracking = await prisma.trackingNumber.upsert({
    where: { purchaseOrderId_number: { purchaseOrderId, number: input.number.trim() } },
    create: { purchaseOrderId, number: input.number.trim(), carrierName: input.carrierName ?? null, trackingUrl: input.url ?? null, notifyCustomer: input.notifyCustomer ?? true },
    update: { carrierName: input.carrierName ?? undefined, trackingUrl: input.url ?? undefined },
  });
  if (ORDER_RANK[po.status] < ORDER_RANK.SHIPPED) {
    await prisma.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: "SHIPPED", shippedAt: new Date() } });
  }
  await logActivity(shop.id, { actor, action: "tracking.added", entity: "Order", entityId: po.orderId, message: `Tracking ${tracking.number} added manually.` });
  if (shop.parsedSettings.fulfillment.autoFulfill) await syncPendingTracking(shop, purchaseOrderId, client);
  await evaluateAndStoreOrder(shop, po.orderId);
  return tracking;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Recompute order-level supplier cost from live purchase orders.
 *
 * Amounts are taken in shop currency where the conversion is on record, because
 * the order page and the profit report read these columns as shop currency. A
 * purchase order whose currency differs and has no recorded rate is left out of
 * the total rather than added as if the numbers were comparable, and the caller
 * can tell from `unconverted` that the figure is short.
 */
export async function rollupOrderCosts(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { currency: true } });
  const shopCurrency = order?.currency ?? "";
  const pos = await prisma.purchaseOrder.findMany({ where: { orderId, status: { notIn: ["FAILED", "CANCELED", "DRAFT"] } } });

  const items: Prisma.Decimal[] = [];
  const shipping: Prisma.Decimal[] = [];
  let unconverted = 0;
  for (const po of pos) {
    if (po.shopCurrency && po.shopCurrency === shopCurrency && po.shopItemsCost !== null) {
      items.push(po.shopItemsCost);
      shipping.push(po.shopShippingCost ?? d(0));
    } else if (!po.currency || po.currency === shopCurrency) {
      items.push(po.itemsCost);
      shipping.push(po.shippingCost);
    } else {
      unconverted += 1;
      logger.warn("Purchase order cost left out of the order total: no exchange rate on record", {
        orderId,
        purchaseOrderId: po.id,
        from: po.currency,
        to: shopCurrency,
      });
    }
  }

  // Explicit chronological comparator: the default sort stringifies dates, so it
  // orders by weekday name and picks an arbitrary element. And an order with no
  // placement on record has no placedAt, rather than "now".
  const placedTimes = pos
    .map((p) => p.placedAt)
    .filter((v): v is Date => v !== null)
    .map((v) => v.getTime());

  await prisma.order.update({
    where: { id: orderId },
    data: {
      supplierCost: money(sum(items)),
      supplierShipping: money(sum(shipping)),
      placedAt: placedTimes.length ? new Date(Math.min(...placedTimes)) : null,
    },
  });
  return { unconverted };
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
