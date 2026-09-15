import { createHash } from "node:crypto";
import type { OrderLineItem, Prisma, PurchaseOrder, PurchaseOrderStatus, SupplierPlatform } from "@prisma/client";
import { z } from "zod";
import prisma from "~/db.server";
import type { ResolveResult, ResolvedSupplierLine } from "~/domain/mapping/types";
import type { ShippingAddress } from "~/domain/orders/address";
import { evaluateOrder as evaluatePipeline } from "~/domain/orders/pipeline";
import { AppError, errorMessage, isRetryable } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money, sum, type Decimal } from "~/lib/money";
import { rateLimit } from "~/lib/rate-limit.server";
import { logActivity } from "./activity.server";
import { getKnownRate } from "./currency.server";
import { notify } from "./notifications.server";
import { evaluateAndStoreOrder, lineResolution, orderIssues, supplierAddressFor } from "./orders.server";
import { chooseShippingForShop } from "./shipping.server";
import { withSettings, type ShopWithSettings } from "./shop.server";
import { gql, offlineClient, type GraphqlClient } from "./shopify/graphql.server";
import { addOrderTags, createFulfillmentWithTracking, updateFulfillmentTracking } from "./shopify/orders.server";
import { touchSupplierAccount } from "./supplier-accounts.server";
import { orderPaymentUrl } from "./suppliers/aliexpress.server";
import { getShippingOptions } from "./suppliers/catalog.server";
import { EXTENSION_PLACEMENT_STEPS, adapterForShop, placementModeForShop, supplierProductUrl, unavailableReason, type PlacementMode } from "./suppliers/index.server";
import type { PlaceOrderInput, SupplierOrderState } from "./suppliers/types";

// ---------------------------------------------------------------------------
// Place orders
// ---------------------------------------------------------------------------

export interface PlaceOrderOutcome {
  orderId: string;
  ok: boolean;
  purchaseOrderIds: string[];
  /**
   * The subset of `purchaseOrderIds` that was priced and is now waiting for the
   * merchant to place it with the Chrome extension. Nothing was sent upstream
   * for these, so a caller must not report them as placed.
   */
  awaitingPlacementIds?: string[];
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
 * Group an order's still-outstanding lines by supplier platform.
 *
 * Shared by placement and by pricing, so the merchant is quoted for exactly the
 * lines that would be ordered. Two readers of one grouping rule is the point:
 * a quote derived from a second, similar loop would drift away from what
 * placement actually does, and the merchant would approve the wrong number.
 */
async function groupOutstandingLines(
  orderId: string,
  lineItems: OrderLineItem[],
  shopifyLineItemIds?: string[],
): Promise<Map<string, Group>> {
  const covered = await coveredSupplierLines(orderId);
  const scope = shopifyLineItemIds?.length ? new Set(shopifyLineItemIds) : null;

  const groups = new Map<string, Group>();
  for (const li of lineItems) {
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
  return groups;
}

export interface SupplierQuoteLine {
  title: string;
  quantity: number;
  unitCost: string;
  lineCost: string;
  platform: SupplierPlatform;
  carrierName: string | null;
  estimatedDeliveryDays: number | null;
  shippingCost: string;
}

export interface SupplierQuote {
  currency: string;
  itemsCost: string;
  shippingCost: string;
  totalCost: string;
  lines: SupplierQuoteLine[];
  /** Lines that cannot be priced yet, with the reason, so nothing is hidden. */
  unpriced: string[];
  quotedAt: string;
}

/**
 * Price what placing this order would cost, without placing anything.
 *
 * This exists so "Request fulfillment" in Shopify can become a decision the
 * merchant makes on a number rather than a button that quietly spends their
 * money. Shipping is quoted from the supplier exactly as placement would quote
 * it, so the figure the merchant approves is the figure that gets ordered,
 * barring a genuine upstream price change between the two.
 */
export async function quoteSupplierOrders(
  shop: ShopWithSettings,
  orderId: string,
  options: { shopifyLineItemIds?: string[] } = {},
): Promise<SupplierQuote> {
  const full = await prisma.order.findUnique({ where: { id: orderId }, include: { lineItems: true } });
  if (!full || full.shopId !== shop.id) throw new Error("Order not found");

  const groups = await groupOutstandingLines(orderId, full.lineItems, options.shopifyLineItemIds);
  const address = supplierAddressFor(full, shop.parsedSettings.orders);
  const country = (address.countryCode ?? full.countryCode ?? "US").toUpperCase();

  const lines: SupplierQuoteLine[] = [];
  const unpriced: string[] = [];
  let items = d(0);
  let shippingTotal = d(0);

  for (const group of groups.values()) {
    let shipping: Map<string, ShippingChoice> | null = null;
    try {
      shipping = await quoteShippingPerProduct(shop, group, country);
    } catch (error) {
      // A missing shipping quote is worth showing rather than throwing: the
      // merchant still learns the item cost and why the total is incomplete.
      unpriced.push(errorMessage(error));
    }

    // Shipping is quoted per supplier product, so it is charged once per
    // product and not once per line of that product.
    const shippingCharged = new Set<string>();
    for (const line of group.lines) {
      const choice = shipping?.get(line.supplierProductId) ?? NO_SHIPPING_CHOICE;
      const unit = d(line.resolved.unitCost ?? 0);
      const lineCost = unit.times(line.resolved.quantity);
      let lineShipping = d(0);
      if (choice.cost !== null && !shippingCharged.has(line.supplierProductId)) {
        lineShipping = d(choice.cost);
        shippingCharged.add(line.supplierProductId);
      }
      items = items.plus(lineCost);
      shippingTotal = shippingTotal.plus(lineShipping);
      lines.push({
        title: line.resolved.title || line.lineItemTitle,
        quantity: line.resolved.quantity,
        unitCost: money(unit),
        lineCost: money(lineCost),
        platform: group.platform,
        carrierName: choice.carrierName,
        estimatedDeliveryDays: choice.estimatedDeliveryDays,
        shippingCost: money(lineShipping),
      });
    }
  }

  return {
    currency: shop.currency,
    itemsCost: money(items),
    shippingCost: money(shippingTotal),
    totalCost: money(items.plus(shippingTotal)),
    lines,
    unpriced,
    quotedAt: new Date().toISOString(),
  };
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

  const groups = await groupOutstandingLines(orderId, full.lineItems, options.shopifyLineItemIds);

  if (groups.size === 0) {
    // Placing an order that is already placed is a safe no-op, not an error:
    // the bulk job, the auto-place tick and the merchant's button all reach
    // here, and any of them can arrive second.
    const live = full.purchaseOrders.filter((po) => !["FAILED", "CANCELED", "DRAFT"].includes(po.status));
    if (live.length > 0) {
      // The ones still waiting for the extension are named, so a caller that
      // arrives second does not report an order nobody has bought as placed.
      const waiting = live.filter((po) => po.status === "AWAITING_PLACEMENT").map((po) => po.id);
      return { orderId, ok: true, purchaseOrderIds: live.map((po) => po.id), awaitingPlacementIds: waiting };
    }
    return { orderId, ok: false, purchaseOrderIds: [], error: "Nothing to order: every line is unmapped, fulfilled or already ordered." };
  }

  // The phone fallback is applied here, on the way to the supplier, so the
  // stored order keeps the customer's own number.
  const address = supplierAddressFor(full, shop.parsedSettings.orders);
  const country = (address.countryCode ?? full.countryCode ?? "US").toUpperCase();
  const purchaseOrderIds: string[] = [];
  const awaitingPlacementIds: string[] = [];
  const errors: string[] = [];
  let placedUpstream = 0;

  for (const group of groups.values()) {
    const mode = await placementModeForShop(shop.id, group.platform);

    // Refused before anything is priced or written as live. Under the old
    // registry these fell through to the mock, which "placed" them and later
    // invented tracking for a real buyer.
    const refusal = placementRefusal(mode, group.platform, { isTest: full.isTest, isDevelopmentStore: shop.isDevelopmentStore });
    if (refusal) {
      errors.push(`${group.platform}: ${refusal.message}`);
      await recordFailedPurchaseOrder(shop, full.id, group, null, refusal.code, refusal.message, { onlyOnce: true });
      continue;
    }

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
      mode,
      simulated: Boolean(adapter.simulated),
    });
    if (!created.po) {
      // Another caller got there first between our coverage read and this
      // write, or the same purchase order already exists.
      logger.info("Skipping duplicate purchase order", { orderId, platform: group.platform, reason: created.reason });
      continue;
    }
    const po = created.po;
    purchaseOrderIds.push(po.id);

    if (mode === "extension") {
      // Nothing goes upstream: the merchant's browser places this order on the
      // supplier's site. It is priced now, so the payment queue and the
      // order's profit read correctly while it waits.
      const converted = await toShopCurrency(shop.currency, po.currency, po.itemsCost, po.shippingCost);
      if (Object.keys(converted).length > 0) {
        await prisma.purchaseOrder.update({ where: { id: po.id }, data: converted });
      }
      awaitingPlacementIds.push(po.id);
      await logActivity(shop.id, {
        actor: options.actor,
        action: "order.awaiting_placement",
        entity: "Order",
        entityId: full.id,
        message: `${full.name}: ${group.platform} order priced at ${money(po.totalCost)} ${po.currency} and waiting to be placed with the Chrome extension.`,
        meta: { purchaseOrderId: po.id },
      });
      continue;
    }

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
        // No email: neither supplier integration sends one, and a buyer's
        // address is the least customer data a supplier needs to ship.
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
          // Only the ids are kept. The supplier's full response echoes the
          // consignee's name, address and phone, and nothing ever read it back.
          raw: { ...purchaseOrderRawReadBack(po.raw), externalOrderIds: result.externalOrderIds ?? [result.externalOrderId] } as Prisma.InputJsonValue,
        },
      });
      if (account) await touchSupplierAccount(account.id);
      placedUpstream += 1;
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

  if (awaitingPlacementIds.length > 0) {
    await notify(shop.id, {
      type: "order.placed",
      severity: "info",
      title: `${full.name} is ready to place with the Chrome extension`,
      body: `Nothing has been ordered yet. ${EXTENSION_PLACEMENT_STEPS}`,
      link: `/app/orders/${full.id}`,
      dedupeKey: `awaiting-placement:${full.id}`,
      dedupeMinutes: 60,
    });
  }

  // Tagged only when something actually reached a supplier. An order waiting
  // for the extension is tagged when the extension reports it placed.
  if (placedUpstream > 0) await tagPlacedOrder(shop, full.id, full.shopifyOrderId);

  return {
    orderId,
    ok: errors.length === 0,
    purchaseOrderIds,
    awaitingPlacementIds,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

async function tagPlacedOrder(shop: ShopWithSettings, orderId: string, shopifyOrderId: string) {
  if (!shop.parsedSettings.orders.tagOnPlaced) return;
  try {
    const client = await offlineClient(shop.domain);
    await addOrderTags(client, shopifyOrderId, [shop.parsedSettings.orders.tagOnPlaced]);
  } catch (error) {
    logger.warn("Could not tag Shopify order", { orderId, error });
  }
}

/**
 * Why a group may not be placed at all in this mode, or null when it may.
 *
 * The Demo supplier only runs for test orders or on development stores. On a
 * real order it would walk a purchase order through invented payment and
 * shipping, and the order page would show a real buyer's parcel as on its way
 * when nothing was bought.
 */
export function placementRefusal(
  mode: PlacementMode,
  platform: SupplierPlatform,
  context: { isTest: boolean; isDevelopmentStore: boolean },
): { code: string; message: string } | null {
  if (mode === "unavailable") return { code: "SUPPLIER_UNAVAILABLE", message: unavailableReason(platform) };
  if (mode === "demo" && !context.isTest && !context.isDevelopmentStore) {
    return {
      code: "DEMO_SUPPLIER_REAL_ORDER",
      message: "The Demo supplier only simulates orders, so it cannot fulfil a real customer's order. Link this product to a real supplier, or use a test order.",
    };
  }
  return null;
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
  mode: PlacementMode;
  simulated: boolean;
}): Promise<{ po: PurchaseOrder | null; reason?: string }> {
  const { group, choiceFor } = input;
  const itemsCost = sum(group.lines.map((l) => d(l.resolved.unitCost).times(l.resolved.quantity)));
  // Shipping is charged once per supplier product, exactly as the quote does,
  // so a purchase order waiting for the extension carries the same total the
  // merchant would have approved.
  const shippingByProduct = new Map<string, string>();
  for (const line of group.lines) {
    const cost = choiceFor(line).cost;
    if (cost !== null && !shippingByProduct.has(line.supplierProductId)) shippingByProduct.set(line.supplierProductId, cost);
  }
  const shippingCost = sum([...shippingByProduct.values()].map((c) => d(c)));
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
          // Created straight into its waiting state, inside the same lock and
          // under the same idempotency key as an API placement, so a second
          // caller sees it as covering these lines and does nothing.
          status: input.mode === "extension" ? "AWAITING_PLACEMENT" : "SUBMITTING",
          currency: group.lines[0].resolved.currency,
          itemsCost: money(itemsCost),
          shippingCost: money(shippingCost),
          totalCost: money(itemsCost.plus(shippingCost)),
          carrierCode: input.headline.carrierCode,
          carrierName: input.headline.carrierName,
          shipFromCountry: input.headline.shipFromCountry,
          estimatedDeliveryDays: input.headline.estimatedDeliveryDays,
          supplierNote: input.supplierNote,
          attempts: 1,
          lastAttemptAt: new Date(),
          raw: { shippingReason: input.shippingReason, placementMode: input.mode, simulated: input.simulated } as Prisma.InputJsonValue,
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

async function recordFailedPurchaseOrder(
  shop: ShopWithSettings,
  orderId: string,
  group: Group,
  supplierAccountId: string | null,
  code: string,
  message: string,
  options: { onlyOnce?: boolean } = {},
) {
  if (options.onlyOnce) {
    // A refusal that no retry can change (no way to reach the platform) would
    // otherwise add a fresh FAILED row on every auto-place tick.
    const existing = await prisma.purchaseOrder.findFirst({
      where: { orderId, platform: group.platform, status: "FAILED", errorCode: code },
      select: { id: true },
    });
    if (existing) return;
  }
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
  // A simulated order id (the Demo supplier's, or one the mock invented for a
  // real platform before it was taken off real platforms) names nothing at any
  // supplier, so there is nothing that could be ordered twice.
  if (po.externalOrderId && !isSimulatedPurchaseOrder(po)) {
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

/**
 * The merchant placed a purchase order on the supplier's site by hand and links
 * its order number from the order page.
 *
 * A purchase order still waiting for the extension goes through exactly the
 * path the extension uses, so both reach Awaiting payment with a payment link,
 * a due date, the placed tag and a fresh cost roll-up. Linking it straight to
 * PLACED left none of those behind.
 *
 * A simulated purchase order (the mock gave it a MOCK- id before the mock was
 * taken off real platforms) still holds the tracking numbers the mock made up.
 * Once its id is replaced nothing marks it as simulated any more, so the next
 * tracking run would have sent that invented number to a real buyer. Those
 * unsynced rows are deleted in the same transaction as the link, and the
 * purchase order records that it once was simulated.
 */
export async function markPurchaseOrderManual(shop: ShopWithSettings, purchaseOrderId: string, externalOrderId: string, actor?: string) {
  const parsed = SupplierOrderId.safeParse(externalOrderId);
  if (!parsed.success) throw new Error(`The supplier order number ${parsed.error.issues[0].message}.`);
  const id = parsed.data;

  const owned = await ownedPurchaseOrder(shop.id, purchaseOrderId, { order: { select: { name: true, canceledAt: true } } });
  if (owned.order.canceledAt) {
    throw new Error(`${owned.order.name} was cancelled in Shopify, so the supplier order was not linked. Cancel it on the supplier's site instead.`);
  }

  if (owned.status === "AWAITING_PLACEMENT") {
    const answer = await markPlacedFromExtension(shop, owned.id, { externalOrderIds: [id] }, { actor: actor ?? "merchant" });
    if (answer.status !== 200) throw new Error(String(answer.body.error ?? "The supplier order could not be linked."));
    return { purchaseOrderId: owned.id, status: String(answer.body.status), discardedTracking: 0 };
  }

  const simulated = isSimulatedPurchaseOrder(owned);
  const raw = purchaseOrderRawReadBack(owned.raw);
  const { po, discarded } = await prisma.$transaction(async (tx) => {
    const removed = simulated ? await tx.trackingNumber.deleteMany({ where: { purchaseOrderId: owned.id, syncedToShopify: false } }) : { count: 0 };
    const updated = await tx.purchaseOrder.update({
      where: { id: owned.id },
      data: {
        externalOrderId: id,
        status: "PLACED",
        placedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        ...(simulated
          ? {
              // The Demo supplier stays simulated whatever id it is given; a
              // real platform with a real order number no longer is, and the
              // history flag keeps the past visible without the id prefix.
              raw: { ...raw, simulated: owned.platform === "MOCK", simulatedHistory: true, discardedSimulatedTracking: removed.count } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    return { po: updated, discarded: removed.count };
  });

  await logActivity(shop.id, {
    actor,
    action: "order.manual_link",
    entity: "Order",
    entityId: po.orderId,
    message: discarded
      ? `Supplier order ${id} linked manually. ${discarded} tracking number(s) made up by the Demo supplier were deleted so they can never reach the customer.`
      : `Supplier order ${id} linked manually.`,
    meta: { purchaseOrderId: po.id, ...(simulated ? { discardedSimulatedTracking: discarded } : {}) },
  });
  await rollupOrderCosts(po.orderId);
  await evaluateAndStoreOrder(shop, po.orderId);
  return { purchaseOrderId: po.id, status: po.status, discardedTracking: discarded };
}

/**
 * Cancel a purchase order.
 *
 * One still waiting for the extension exists nowhere but here, so there is no
 * supplier to ask: it is cancelled locally without touching any adapter. The
 * ORDERS_CANCELLED webhook relies on that for every such purchase order on a
 * cancelled Shopify order. A purchase order already cancelled is left as it is,
 * so a repeated webhook does not rewrite its date and reason.
 */
export async function cancelPurchaseOrder(shop: ShopWithSettings, purchaseOrderId: string, reason?: string, actor?: string) {
  const po = await ownedPurchaseOrder(shop.id, purchaseOrderId, { order: true });
  if (po.status === "CANCELED") return { upstream: false, alreadyCanceled: true, neverPlaced: false };

  const neverPlaced = po.status === "AWAITING_PLACEMENT";
  let upstream = false;
  if (po.externalOrderId && !neverPlaced) {
    const { adapter } = await adapterForShop(shop.id, po.platform);
    if (adapter.cancelOrder) {
      upstream = await adapter.cancelOrder(po.externalOrderId, reason).catch(() => false);
    }
  }
  if (neverPlaced) {
    // Conditional, like the extension's "Mark as placed" write it races with.
    // A cancel that read AWAITING_PLACEMENT just before the merchant recorded
    // the AliExpress order would otherwise stamp CANCELED over an order they
    // had already paid for. When the status moved under us, start again from
    // what is stored now, which takes the placed-order path.
    const claimed = await prisma.purchaseOrder.updateMany({
      where: { id: po.id, status: "AWAITING_PLACEMENT" },
      data: { status: "CANCELED", canceledAt: new Date(), errorMessage: reason ?? null },
    });
    if (claimed.count === 0) {
      logger.warn("Purchase order changed while being cancelled; re-reading", { purchaseOrderId: po.id });
      return cancelPurchaseOrder(shop, purchaseOrderId, reason, actor);
    }
  } else {
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: "CANCELED", canceledAt: new Date(), errorMessage: reason ?? null } });
  }
  await logActivity(shop.id, {
    actor,
    action: "order.supplier_canceled",
    entity: "Order",
    entityId: po.orderId,
    message: neverPlaced
      ? `${po.platform} order waiting to be placed with the Chrome extension was cancelled. Nothing had been ordered from the supplier.`
      : `Supplier order ${po.externalOrderId ?? po.id} canceled${upstream ? " at the supplier" : " locally (supplier could not cancel)"}.`,
    meta: { purchaseOrderId: po.id },
  });
  await rollupOrderCosts(po.orderId);
  await evaluateAndStoreOrder(shop, po.orderId);
  return { upstream, alreadyCanceled: false, neverPlaced };
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
  DRAFT: 0, FAILED: 1, SUBMITTING: 2, AWAITING_PLACEMENT: 3, PLACED: 4, AWAITING_PAYMENT: 5, PAID: 6, SHIPPED: 7, DELIVERED: 8, CANCELED: 9,
};

/**
 * True when a purchase order's supplier side was invented: placed through the
 * Demo supplier, or - before the mock was taken off real platforms - given a
 * MOCK- order id under a real platform's name. Nothing it says about payment,
 * shipping or tracking came from a supplier.
 */
export function isSimulatedPurchaseOrder(po: { platform: SupplierPlatform; externalOrderId: string | null; raw?: unknown }): boolean {
  if (po.platform === "MOCK") return true;
  if (po.externalOrderId?.startsWith("MOCK-")) return true;
  return Boolean(po.raw && typeof po.raw === "object" && (po.raw as { simulated?: unknown }).simulated === true);
}

/**
 * Whether a purchase order may write to the Shopify order: create a fulfilment,
 * attach tracking, email the buyer.
 *
 * A simulated purchase order may do so only on a test order or a development
 * store, where the reviewer's walkthrough needs to see the fulfilment appear,
 * and even then silently and with no carrier link. On a real order it never
 * may: an invented tracking number in a shipping email is a lie told to a
 * buyer who is still waiting for goods nobody bought.
 */
export function shopifyWritePolicy(
  po: { platform: SupplierPlatform; externalOrderId: string | null; raw?: unknown },
  context: { orderIsTest: boolean; isDevelopmentStore: boolean },
): { allowed: boolean; notifyCustomer: boolean; trackingUrls: boolean } {
  if (!isSimulatedPurchaseOrder(po)) return { allowed: true, notifyCustomer: true, trackingUrls: true };
  if (context.orderIsTest || context.isDevelopmentStore) return { allowed: true, notifyCustomer: false, trackingUrls: false };
  return { allowed: false, notifyCustomer: false, trackingUrls: false };
}

/** Prisma filter for purchase orders `isSimulatedPurchaseOrder` would flag by platform or id. */
const SIMULATED_PO_WHERE: Prisma.PurchaseOrderWhereInput = {
  OR: [{ platform: "MOCK" }, { externalOrderId: { startsWith: "MOCK-" } }],
};

const SIMULATED_TRACKING_BLOCKED =
  "Not sent to Shopify: this tracking number was made up by the Demo supplier, and this is a real customer order. Nothing was ordered from a supplier.";

/** Modes in which the app itself can ask the supplier about an order. */
const POLLABLE_MODES = new Set<PlacementMode>(["api", "demo"]);

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
export async function syncPurchaseOrder(
  shop: ShopWithSettings,
  purchaseOrderId: string,
  options: { mode?: PlacementMode } = {},
): Promise<{ changed: boolean; status: PurchaseOrderStatus; newTracking: number }> {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, order: { shopId: shop.id } }, include: { order: true, trackings: true } });
  if (!po || !po.externalOrderId) return { changed: false, status: po?.status ?? "DRAFT", newTracking: 0 };

  // Only an order the app placed through an API (or the Demo supplier) can be
  // asked about. One placed from the browser is followed by what the merchant
  // and the extension report; one given a MOCK- id under a real platform's
  // name has no supplier to ask, and polling it through the mock is exactly
  // how invented tracking used to reach real buyers.
  if (po.platform !== "MOCK" && isSimulatedPurchaseOrder(po)) return { changed: false, status: po.status, newTracking: 0 };
  const mode = options.mode ?? (await placementModeForShop(shop.id, po.platform));
  if (!POLLABLE_MODES.has(mode)) return { changed: false, status: po.status, newTracking: 0 };

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
      // The upstream status response is not stored: it repeats the buyer's
      // address and nothing reads it. Rewriting raw here also drops the copy
      // older versions of the app kept.
      raw: purchaseOrderRawReadBack(po.raw),
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
    select: { id: true, platform: true },
  });
  // One mode lookup per platform rather than per purchase order: the answer
  // cannot differ between two orders of the same shop and platform.
  const modes = new Map<SupplierPlatform, PlacementMode>();
  let changed = 0;
  for (const po of open) {
    try {
      if (!modes.has(po.platform)) modes.set(po.platform, await placementModeForShop(shop.id, po.platform));
      const result = await syncPurchaseOrder(shop, po.id, { mode: modes.get(po.platform) });
      if (result.changed || result.newTracking) changed += 1;
    } catch (error) {
      logger.warn("Purchase order sync failed", { purchaseOrderId: po.id, error, retryable: isRetryable(error) });
    }
    if (options.onProgress) await options.onProgress();
  }
  return { checked: open.length, changed };
}

// ---------------------------------------------------------------------------
// Fulfilment-service routing
// ---------------------------------------------------------------------------

const FULFILLMENT_ROUTING_QUERY = `#graphql
  query DropshipFulfillmentRouting($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 50) {
        nodes {
          id
          status
          requestStatus
          assignedLocation { location { id } }
          lineItems(first: 100) { nodes { remainingQuantity lineItem { id } } }
        }
      }
    }
  }
`;

export interface RoutedFulfillmentOrder {
  id: string;
  status: string;
  requestStatus: string;
  locationId: string | null;
  lineItems: Array<{ lineItemId: string; remainingQuantity: number }>;
}

/** Where each fulfilment order of a Shopify order sits, and whether it was requested. */
export async function fetchFulfillmentRouting(client: GraphqlClient, shopifyOrderId: string): Promise<RoutedFulfillmentOrder[]> {
  const data = await gql<{
    order: {
      fulfillmentOrders: {
        nodes: Array<{
          id: string;
          status: string;
          requestStatus: string;
          assignedLocation: { location: { id: string } | null } | null;
          lineItems: { nodes: Array<{ remainingQuantity: number; lineItem: { id: string } }> };
        }>;
      };
    } | null;
  }>(client, FULFILLMENT_ROUTING_QUERY, { id: shopifyOrderId });
  return (data.order?.fulfillmentOrders.nodes ?? []).map((fo) => ({
    id: fo.id,
    status: fo.status,
    requestStatus: fo.requestStatus,
    locationId: fo.assignedLocation?.location?.id ?? null,
    lineItems: fo.lineItems.nodes.map((li) => ({ lineItemId: li.lineItem.id, remainingQuantity: li.remainingQuantity })),
  }));
}

/** Fulfilment-order statuses that still have work in them. */
const OPEN_FULFILLMENT_ORDER_STATUSES = new Set(["OPEN", "IN_PROGRESS", "SCHEDULED", "ON_HOLD"]);

/**
 * Request states in which the app, as the fulfilment service, has been asked to
 * fulfil and has said yes. A rejected cancellation leaves the accepted request
 * standing, so it counts too.
 */
const FULFILLABLE_REQUEST_STATUSES = new Set(["ACCEPTED", "CANCELLATION_REJECTED"]);

/**
 * Which Shopify line items belong to the app's fulfilment-service location.
 *
 * `serviceLineItemIds` are placed only through a fulfilment request, never by
 * auto-place. `awaitingRequest` are those not yet requested and accepted, which
 * the app must not fulfil: Built for Shopify 5.8.4 allows a fulfilment service
 * to fulfil only after the merchant asks, and an unrequested fulfilment order
 * at the app's location was fulfilled the moment a tracking number arrived.
 *
 * Lines at the merchant's own locations are not affected: there the app acts
 * as an order-management app on the merchant's behalf, as it always has.
 */
export function fulfillmentServiceRouting(
  fulfillmentOrders: RoutedFulfillmentOrder[],
  appLocationId: string | null | undefined,
): { serviceLineItemIds: Set<string>; awaitingRequest: Set<string> } {
  const serviceLineItemIds = new Set<string>();
  const awaitingRequest = new Set<string>();
  if (!appLocationId) return { serviceLineItemIds, awaitingRequest };
  for (const fo of fulfillmentOrders) {
    if (fo.locationId !== appLocationId || !OPEN_FULFILLMENT_ORDER_STATUSES.has(fo.status)) continue;
    const fulfillable = fo.status === "IN_PROGRESS" && FULFILLABLE_REQUEST_STATUSES.has(fo.requestStatus);
    for (const li of fo.lineItems) {
      if (li.remainingQuantity <= 0) continue;
      serviceLineItemIds.add(li.lineItemId);
      if (!fulfillable) awaitingRequest.add(li.lineItemId);
    }
  }
  return { serviceLineItemIds, awaitingRequest };
}

const AWAITING_FULFILLMENT_REQUEST =
  "Not sent to Shopify yet: these items are routed to DropshipHub's fulfilment location, and Shopify only lets the app fulfil them after you press Request fulfillment and the request is accepted.";

/**
 * Push tracking numbers to Shopify as fulfilments. One fulfilment per tracking
 * number covering the line items of its purchase order.
 */
export async function syncPendingTracking(shop: ShopWithSettings, purchaseOrderId?: string, client?: GraphqlClient) {
  const base: Prisma.PurchaseOrderWhereInput = { order: { shopId: shop.id }, ...(purchaseOrderId ? { id: purchaseOrderId } : {}) };

  // Simulated tracking on a real order is never sent. It is left out of the
  // query itself, not skipped after it: the query takes the oldest 100, and
  // rows that can never sync would otherwise crowd out real tracking forever.
  // The reason is written on the row once so the order page can say why.
  let scope = base;
  if (!shop.isDevelopmentStore) {
    await prisma.trackingNumber.updateMany({
      where: { syncedToShopify: false, syncError: null, purchaseOrder: { AND: [base, SIMULATED_PO_WHERE, { order: { isTest: false } }] } },
      data: { syncError: SIMULATED_TRACKING_BLOCKED },
    });
    // Written as what may sync rather than NOT(what may not): in SQL a NOT over
    // `externalOrderId LIKE 'MOCK-%'` is NULL for a purchase order with no
    // supplier id yet, which would silently drop real, hand-entered tracking.
    scope = {
      AND: [
        base,
        {
          OR: [
            { order: { isTest: true } },
            { platform: { not: "MOCK" }, OR: [{ externalOrderId: null }, { NOT: { externalOrderId: { startsWith: "MOCK-" } } }] },
          ],
        },
      ],
    };
  }

  const pending = await prisma.trackingNumber.findMany({
    where: { syncedToShopify: false, purchaseOrder: scope },
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
    // Checked again per purchase order, whatever the query above excluded: it
    // also catches a purchase order flagged simulated only in its raw data, and
    // it keeps this rule true if the query is ever edited.
    const policy = shopifyWritePolicy(po, { orderIsTest: po.order.isTest, isDevelopmentStore: shop.isDevelopmentStore });
    if (!policy.allowed) {
      await prisma.trackingNumber.updateMany({ where: { id: { in: trackings.map((t) => t.id) } }, data: { syncError: SIMULATED_TRACKING_BLOCKED } });
      logger.warn("Refused to send simulated tracking to a real Shopify order", { purchaseOrderId: poId, orderId: po.orderId });
      continue;
    }
    const lineItemIds = po.items.map((i) => i.orderLineItemId).filter((id): id is string => Boolean(id));
    const lines = await prisma.orderLineItem.findMany({ where: { id: { in: lineItemIds } } });
    const outstanding = lines.filter((l) => l.fulfillableQuantity > 0);
    const trackingIds = trackings.map((t) => t.id);
    const numbers = trackings.map((t) => t.number);
    const company = settings.carrierNameOverride || trackings[0].carrierName || trackings[0].carrierCode || undefined;
    const urlFor = (t: (typeof trackings)[number]) =>
      settings.trackingUrlTemplate ? settings.trackingUrlTemplate.replace("{tracking}", t.number) : t.trackingUrl;

    try {
      if (outstanding.length > 0 && shop.fulfillmentLocationId) {
        // The whole shipment waits rather than going out in part: a partial
        // fulfilment would mark the tracking synced and the held lines would
        // never be fulfilled once the request was accepted. The rows stay
        // unsynced, so the next tick tries again.
        const routing = fulfillmentServiceRouting(await fetchFulfillmentRouting(graphql, po.order.shopifyOrderId), shop.fulfillmentLocationId);
        if (outstanding.some((l) => routing.awaitingRequest.has(l.shopifyLineItemId))) {
          await prisma.trackingNumber.updateMany({ where: { id: { in: trackingIds } }, data: { syncError: AWAITING_FULFILLMENT_REQUEST } });
          continue;
        }
      }
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
          tracking: { numbers, company, urls: policy.trackingUrls ? trackings.map(urlFor).filter((u): u is string => Boolean(u)) : [] },
          notifyCustomer: policy.notifyCustomer && trackings.some((t) => t.notifyCustomer) && settings.notifyCustomer,
        });

        if (result.skipped) {
          // Shopify has nothing left to fulfil even though we thought it did:
          // the merchant fulfilled outside the app. Attach to the existing
          // fulfilment if we know it, otherwise stop retrying and say why.
          await attachOrRetire(graphql, shop, po, trackings, numbers, company, result.reason, policy.notifyCustomer);
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
        await attachOrRetire(graphql, shop, po, trackings, numbers, company, "No unfulfilled quantity left on the Shopify order.", policy.notifyCustomer);
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
  /** False for simulated tracking, whatever the shop's setting says. */
  mayNotifyCustomer: boolean,
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
    mayNotifyCustomer && shop.parsedSettings.fulfillment.notifyCustomer,
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
// Order page access
// ---------------------------------------------------------------------------

/** One "viewed" entry per person per order per this window. */
export const ORDER_VIEW_LOG_WINDOW_MS = 60 * 60_000;

/**
 * Record that someone opened an order's page.
 *
 * The page shows the buyer's name, email, phone and address, and Shopify's
 * protected customer data requirements ask an app to log access to that data.
 * A refresh, or a merchant flicking between tabs, must not bury the order's
 * real history under identical lines, so a person who already has an entry for
 * this order inside the window gets no second one. Two loads racing each other
 * can both write; that costs a duplicate line, which is harmless.
 *
 * Never throws: failing to write the log must not stop the merchant reading
 * the order. Returns whether an entry was written.
 */
export async function recordOrderView(
  shopId: string,
  order: { id: string; name: string },
  actor: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const recent = await prisma.activityLog.findFirst({
      where: {
        shopId,
        action: "order.viewed",
        entity: "Order",
        entityId: order.id,
        actor,
        createdAt: { gte: new Date(now.getTime() - ORDER_VIEW_LOG_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return false;
    await logActivity(shopId, {
      actor,
      action: "order.viewed",
      entity: "Order",
      entityId: order.id,
      message: `${order.name} was opened by ${actor}, showing the customer's contact details and address.`,
    });
    return true;
  } catch (error) {
    logger.warn("Could not record an order view", { shopId, orderId: order.id, error });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extension placement API
//
// Until the AliExpress API is connected, the merchant's own browser places
// supplier orders: the extension lists purchase orders waiting for placement,
// the merchant buys them on AliExpress, and the extension reports the order ids
// and, later, the tracking back. The routes under /api/extension/orders are
// thin; the rules live here so they are tested once.
// ---------------------------------------------------------------------------

// The wording lives with the placement modes in the supplier registry, which
// describes AliExpress with it too; it is re-exported here for existing callers.
export { EXTENSION_PLACEMENT_STEPS };

/** Largest body each extension endpoint reads before refusing. */
export const EXTENSION_BODY_LIMITS = {
  /** A captured product with a few hundred variants is well under this. */
  capture: 512 * 1024,
  /** Order ids, a total and a tracking number. */
  orders: 16 * 1024,
} as const;

/** A refusal with the HTTP status the extension should see. */
export class ExtensionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ExtensionApiError";
  }
}

/**
 * The caller's address, for the pre-authentication limiter. Fly and most
 * proxies put the client first in x-forwarded-for; the value only keys a
 * rate-limit bucket, so a spoofed one costs the spoofer their own budget.
 */
function clientAddress(request: Request): string {
  // Only headers the reverse proxy in front of the app sets. Caddy writes
  // X-Forwarded-For from the connection's own address and does not trust a
  // client's copy; Fly-Client-IP is passed through untouched, so reading it
  // first let any caller pick a fresh address per request and walk past the
  // per-address rate limit.
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Tokens are `dsh_` plus base64url; anything else is refused without a lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * Authenticate an extension call by its bearer token (Settings → Advanced) and
 * apply the limits.
 *
 * The per-address limit runs before the token lookup: an invalid-token flood
 * used to cost one database query per request with no limit at all. The
 * per-shop limit runs after; a request that fans out pays the rest of its cost
 * through `spendExtensionBudget` once it knows how much work it carries.
 */
export async function authenticateExtensionRequest(
  request: Request,
  options: { scope: string; limit: number; windowMs?: number },
): Promise<ShopWithSettings> {
  const byAddress = rateLimit(`extension-ip:${clientAddress(request)}`, { limit: 120, windowMs: 60_000 });
  if (!byAddress.allowed) {
    throw new ExtensionApiError(429, `Too many requests. Try again in ${byAddress.retryAfter}s.`, { "Retry-After": String(byAddress.retryAfter) });
  }

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ExtensionApiError(401, "Missing bearer token");
  if (!TOKEN_SHAPE.test(token)) throw new ExtensionApiError(401, "Invalid token");
  const row = await prisma.shop.findUnique({ where: { apiToken: token } });
  if (!row || !row.isActive) throw new ExtensionApiError(401, "Invalid token");

  spendExtensionBudget(row.id, { ...options, cost: 1 });
  return withSettings(row);
}

/**
 * Charge a shop's per-scope budget for `cost` units of work. Capture takes up
 * to 25 links per request, and a limit counted per request let one caller make
 * 750 supplier lookups a minute.
 */
export function spendExtensionBudget(shopId: string, options: { scope: string; limit: number; windowMs?: number; cost: number }) {
  for (let i = 0; i < options.cost; i += 1) {
    const limited = rateLimit(`extension-${options.scope}:${shopId}`, { limit: options.limit, windowMs: options.windowMs ?? 60_000 });
    if (!limited.allowed) {
      throw new ExtensionApiError(429, `Too many requests. Try again in ${limited.retryAfter}s.`, { "Retry-After": String(limited.retryAfter) });
    }
  }
}

/**
 * Read a JSON body, refusing anything larger than `maxBytes`.
 *
 * `request.json()` buffers whatever arrives before any validation runs, so a
 * caller holding a valid token could make the server hold an arbitrarily large
 * body in memory. The declared length is checked first, and the stream is
 * counted as it is read, because a chunked body declares no length at all.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ExtensionApiError(413, `Body too large (limit ${maxBytes} bytes)`);
  }
  if (!request.body) throw new ExtensionApiError(400, "Body must be JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ExtensionApiError(413, `Body too large (limit ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtensionApiError(400, "Body must be JSON");
  }
}

/** Purchase order ids are cuids; the route refuses anything else before a query. */
export const PURCHASE_ORDER_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

const SupplierOrderId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "must be the supplier's order number")
  // A MOCK- id marks an order the Demo supplier invented; accepting one here
  // would let a real purchase order pass for a simulated one, or the reverse.
  .refine((v) => !/^mock-/i.test(v), "is not a real supplier order number");

/** POST /api/extension/orders/:id/placed */
export const ExtensionPlacedBody = z
  .object({
    externalOrderIds: z.array(SupplierOrderId).min(1).max(20),
    totalCost: z
      .string()
      .trim()
      .regex(/^\d{1,12}(\.\d{1,4})?$/, "must be a plain decimal amount")
      .optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "must be a three-letter currency code")
      .optional(),
    /**
     * Whether the merchant already paid for it at checkout, which is how an
     * AliExpress purchase normally goes. Left out, the order waits in the
     * payment queue with AliExpress's 24-hour deadline, as before.
     */
    paid: z.boolean().optional(),
  })
  .strict();

/** POST /api/extension/orders/:id/tracking */
export const ExtensionTrackingBody = z
  .object({
    number: z
      .string()
      .trim()
      .min(4)
      .max(64)
      .regex(/^[A-Za-z0-9-]+$/, "must be a tracking number"),
    carrier: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** The first problem with a hostile body, phrased for the extension to show. */
export function describeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  return `${first.path.join(".") || "body"} ${first.message}`;
}

export interface ExtensionOrder {
  id: string;
  orderName: string;
  createdAt: string;
  note: string | null;
  platform: SupplierPlatform;
  currency: string;
  totalCost: string;
  shippingAddress: {
    name: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    phone: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCode: string | null;
    taxNumber: string | null;
  };
  items: Array<{
    title: string;
    variantLabel: string | null;
    quantity: number;
    externalProductId: string | null;
    productUrl: string | null;
    externalSkuId: string | null;
    skuAttr: string | null;
    unitCost: string;
    currency: string;
    carrierCode: string | null;
    carrierName: string | null;
  }>;
}

/**
 * First and last name for a supplier checkout. AliExpress's address form has
 * two required boxes and no single "name" field, so the extension cannot fill
 * it from `name` alone. Shopify's own split is used whenever it has one; a
 * guess is made only for an address that carries nothing but a full name, and
 * then the last word is the surname because that is how the name box on a
 * Shopify checkout is usually typed. A one-word name stays a first name and
 * the merchant supplies the rest.
 */
export function consigneeNames(address: ShippingAddress): { firstName: string | null; lastName: string | null } {
  const first = address.firstName?.trim() || null;
  const last = address.lastName?.trim() || null;
  if (first || last) return { firstName: first, lastName: last };
  const words = (address.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { firstName: null, lastName: null };
  if (words.length === 1) return { firstName: words[0], lastName: null };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

function variantLabel(attributes: unknown, fallback: string | null): string | null {
  if (Array.isArray(attributes)) {
    const parts = attributes
      .map((a) => (a && typeof a === "object" ? (a as { name?: unknown; value?: unknown }) : null))
      .filter((a): a is { name?: unknown; value?: unknown } => Boolean(a && a.value))
      .map((a) => (a.name ? `${String(a.name)}: ${String(a.value)}` : String(a.value)));
    if (parts.length > 0) return parts.join(" / ");
  }
  return fallback;
}

/**
 * GET /api/extension/orders: purchase orders waiting to be placed.
 *
 * Carries the customer's shipping address, because a supplier checkout needs
 * it; that is why these routes send no CORS headers and are only called from
 * the extension's own pages. The email address is left out: no supplier
 * checkout asks for it.
 */
export async function listAwaitingPlacement(shop: ShopWithSettings): Promise<ExtensionOrder[]> {
  const rows = await prisma.purchaseOrder.findMany({
    // A cancelled Shopify order drops off the list at once: nothing clears its
    // purchase order yet, and buying goods for it is money straight down the drain.
    where: { order: { shopId: shop.id, canceledAt: null }, status: "AWAITING_PLACEMENT" },
    include: {
      order: { select: { name: true, shippingAddress: true } },
      items: {
        include: {
          supplierVariant: { select: { attributes: true, supplierProduct: { select: { url: true } } } },
          orderLineItem: { select: { variantTitle: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  return rows.map((po) => {
    // The same address placement would have sent upstream, phone fallback and all.
    const address: ShippingAddress = supplierAddressFor(po.order, shop.parsedSettings.orders);
    return {
      id: po.id,
      orderName: po.order.name,
      createdAt: po.createdAt.toISOString(),
      note: po.supplierNote,
      platform: po.platform,
      currency: po.currency,
      totalCost: money(po.totalCost),
      shippingAddress: {
        name: address.name ?? [address.firstName, address.lastName].filter(Boolean).join(" "),
        ...consigneeNames(address),
        company: address.company ?? null,
        phone: address.phone ?? null,
        address1: address.address1 ?? null,
        address2: address.address2 ?? null,
        city: address.city ?? null,
        province: address.province ?? null,
        provinceCode: address.provinceCode ?? null,
        zip: address.zip ?? null,
        country: address.country ?? null,
        countryCode: address.countryCode ?? null,
        taxNumber: address.taxNumber ?? null,
      },
      items: po.items.map((item) => ({
        title: item.title,
        variantLabel: variantLabel(item.supplierVariant?.attributes, item.orderLineItem?.variantTitle ?? null),
        quantity: item.quantity,
        externalProductId: item.externalProductId,
        productUrl: supplierProductUrl(po.platform, item.externalProductId, item.supplierVariant?.supplierProduct.url),
        externalSkuId: item.externalSkuId,
        skuAttr: item.externalSkuAttr,
        unitCost: money(item.unitCost),
        currency: item.currency,
        // The confirm page takes the carrier as its shippingCompany parameter.
        // An item chosen before carriers were stored per item has only the
        // purchase order's headline carrier, which is the same choice.
        carrierCode: item.carrierCode ?? po.carrierCode ?? null,
        carrierName: item.carrierName,
      })),
    };
  });
}

/**
 * Purchase orders still to be placed with the extension, as the orders list and
 * the payment page count them. A cancelled Shopify order is left out, exactly
 * as the extension's own list leaves it out: the banners said there was more to
 * buy than the extension offered, and buying for a cancelled order wastes money.
 */
export function awaitingPlacementWhere(shopId: string): Prisma.PurchaseOrderWhereInput {
  return { order: { shopId, canceledAt: null }, status: "AWAITING_PLACEMENT" };
}

export async function countAwaitingPlacement(shopId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: awaitingPlacementWhere(shopId) });
}

/** Statuses in which a supplier order exists upstream but no tracking has come back yet. */
const PLACED_WITHOUT_TRACKING: PurchaseOrderStatus[] = ["PLACED", "AWAITING_PAYMENT", "PAID"];

/**
 * Purchase orders the extension may add tracking to: placed, with no tracking
 * number yet, on an order that is still live. A simulated purchase order is left
 * out, since nothing was shipped for it and it has no real parcel to track.
 */
export function awaitingTrackingWhere(shopId: string): Prisma.PurchaseOrderWhereInput {
  return {
    order: { shopId, canceledAt: null },
    status: { in: PLACED_WITHOUT_TRACKING },
    externalOrderId: { not: null },
    trackings: { none: {} },
    NOT: SIMULATED_PO_WHERE,
  };
}

export interface ExtensionTrackingCandidate {
  id: string;
  orderName: string;
  platform: SupplierPlatform;
  status: PurchaseOrderStatus;
  externalOrderIds: string[];
  placedAt: string | null;
}

/** GET /api/extension/orders, second list: placed supplier orders still waiting for tracking. */
export async function listAwaitingTracking(shop: ShopWithSettings): Promise<ExtensionTrackingCandidate[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: awaitingTrackingWhere(shop.id),
    select: { id: true, platform: true, status: true, externalOrderId: true, raw: true, placedAt: true, order: { select: { name: true } } },
    orderBy: { placedAt: "asc" },
    take: 50,
  });
  return rows.map((po) => ({
    id: po.id,
    orderName: po.order.name,
    platform: po.platform,
    status: po.status,
    externalOrderIds: storedSupplierOrderIds(po),
    placedAt: po.placedAt?.toISOString() ?? null,
  }));
}

export interface ExtensionAnswer {
  status: number;
  body: Record<string, unknown>;
}

function storedSupplierOrderIds(po: { externalOrderId: string | null; raw: unknown }): string[] {
  const raw = po.raw && typeof po.raw === "object" ? (po.raw as { externalOrderIds?: unknown }).externalOrderIds : undefined;
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) return raw as string[];
  return po.externalOrderId ? [po.externalOrderId] : [];
}

function sameIds(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((v) => right.has(v));
}

/**
 * The answer for a purchase order that is no longer waiting: the same report
 * again is fine (the extension retries when a response is lost), anything else
 * is a conflict. Silently overwriting would lose the id of an order the
 * merchant has already paid for.
 */
function answerForSettled(
  po: { id: string; status: PurchaseOrderStatus; externalOrderId: string | null; paymentUrl: string | null; raw: unknown },
  ids: string[],
): ExtensionAnswer {
  if (po.externalOrderId && sameIds(storedSupplierOrderIds(po), ids)) {
    return {
      status: 200,
      body: { ok: true, alreadyRecorded: true, purchaseOrderId: po.id, status: po.status, externalOrderId: po.externalOrderId, paymentUrl: po.paymentUrl },
    };
  }
  return {
    status: 409,
    body: {
      ok: false,
      error: po.externalOrderId
        ? `This purchase order is already recorded as supplier order ${storedSupplierOrderIds(po).join(", ")}.`
        : `This purchase order is ${po.status.toLowerCase().replace(/_/g, " ")}, not waiting to be placed.`,
      status: po.status,
    },
  };
}

/** POST /api/extension/orders/:id/placed */
export async function markPlacedFromExtension(
  shop: ShopWithSettings,
  purchaseOrderId: string,
  input: z.infer<typeof ExtensionPlacedBody>,
  options: { actor?: string } = {},
): Promise<ExtensionAnswer> {
  const actor = options.actor ?? "extension";
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, order: { shopId: shop.id } },
    include: { order: { select: { id: true, name: true, shopifyOrderId: true, canceledAt: true } } },
  });
  if (!po) return { status: 404, body: { ok: false, error: "Purchase order not found" } };

  const ids = [...new Set(input.externalOrderIds.map((v) => v.trim()))];
  if (po.status !== "AWAITING_PLACEMENT") return answerForSettled(po, ids);
  if (po.order.canceledAt) {
    // Recorded as placed, it would sit in the payment queue for an order the
    // customer no longer wants. The merchant cancels it on AliExpress instead.
    return { status: 409, body: { ok: false, error: `${po.order.name} was cancelled in Shopify. Cancel the supplier order on AliExpress; it was not recorded.` } };
  }

  const primary = ids[0];
  const reportedCurrency = input.currency ?? po.currency;
  const sameCurrency = reportedCurrency === po.currency;
  // A total in the purchase order's own currency replaces the estimate, with
  // the difference taken as shipping. One in another currency cannot be split
  // honestly, so it is kept for the record and the estimate stands.
  const totalCost = input.totalCost && sameCurrency ? d(input.totalCost) : d(po.totalCost);
  const remainder = totalCost.minus(d(po.itemsCost));
  const shippingCost = input.totalCost && sameCurrency ? (remainder.isNegative() ? d(0) : remainder) : d(po.shippingCost);
  const converted = await toShopCurrency(shop.currency, po.currency, po.itemsCost, shippingCost);
  const aliexpress = po.platform === "ALIEXPRESS";
  const now = new Date();
  const paid = input.paid === true;
  const status: PurchaseOrderStatus = paid ? "PAID" : "AWAITING_PAYMENT";
  const raw = purchaseOrderRawReadBack(po.raw);

  // No tracking rows are cleared here, unlike the manual link of a simulated
  // purchase order: one waiting for placement was created in extension mode,
  // is never simulated, and cannot carry tracking, which is refused until the
  // purchase order is placed.
  const updated = await prisma.purchaseOrder.updateMany({
    // Conditional on the status, so two reports racing each other cannot both
    // win: the loser re-reads and gets the idempotent answer or a conflict.
    where: { id: po.id, status: "AWAITING_PLACEMENT" },
    data: {
      status,
      externalOrderId: primary,
      placedAt: now,
      totalCost: money(totalCost),
      shippingCost: money(shippingCost),
      ...converted,
      paymentUrl: aliexpress ? orderPaymentUrl(primary) : null,
      // AliExpress cancels an unpaid order after 24 hours. One the merchant
      // paid at checkout has no deadline and leaves the payment queue at once.
      paymentDueAt: aliexpress && !paid ? new Date(now.getTime() + 24 * 3_600_000) : null,
      ...(paid ? { paidAt: now, paymentMarkedAt: now } : {}),
      errorCode: null,
      errorMessage: null,
      raw: {
        ...raw,
        externalOrderIds: ids,
        placedBy: actor === "extension" ? "extension" : "order-page",
        ...(input.totalCost ? { reportedTotal: { amount: input.totalCost, currency: reportedCurrency } } : {}),
      } as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) {
    const fresh = await prisma.purchaseOrder.findFirst({ where: { id: po.id } });
    if (!fresh) return { status: 404, body: { ok: false, error: "Purchase order not found" } };
    return answerForSettled(fresh, ids);
  }

  await logActivity(shop.id, {
    actor,
    action: "order.placed",
    entity: "Order",
    entityId: po.order.id,
    message: `${po.order.name}: supplier order ${ids.join(", ")} placed on ${po.platform}, recorded ${actor === "extension" ? "from the Chrome extension" : "on the order page"}${paid ? " as paid" : ""}.`,
    meta: { purchaseOrderId: po.id },
  });
  await rollupOrderCosts(po.order.id);
  await evaluateAndStoreOrder(shop, po.order.id);
  await tagPlacedOrder(shop, po.order.id, po.order.shopifyOrderId);

  return {
    status: 200,
    body: {
      ok: true,
      purchaseOrderId: po.id,
      status,
      externalOrderId: primary,
      paymentUrl: aliexpress ? orderPaymentUrl(primary) : null,
    },
  };
}

/** Statuses in which a purchase order has not reached a supplier, so tracking makes no sense. */
const NOT_PLACED: PurchaseOrderStatus[] = ["DRAFT", "SUBMITTING", "AWAITING_PLACEMENT", "FAILED", "CANCELED"];

/** POST /api/extension/orders/:id/tracking - the same path as tracking typed on the order page. */
export async function addTrackingFromExtension(
  shop: ShopWithSettings,
  purchaseOrderId: string,
  input: z.infer<typeof ExtensionTrackingBody>,
): Promise<ExtensionAnswer> {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, order: { shopId: shop.id } }, select: { id: true, status: true } });
  if (!po) return { status: 404, body: { ok: false, error: "Purchase order not found" } };
  if (NOT_PLACED.includes(po.status)) {
    return {
      status: 409,
      body: { ok: false, error: "Record the supplier order as placed before adding its tracking number.", status: po.status },
    };
  }

  try {
    const tracking = await addManualTracking(shop, po.id, { number: input.number, carrierName: input.carrier ?? null }, "extension");
    return { status: 200, body: { ok: true, purchaseOrderId: po.id, trackingId: tracking.id, number: tracking.number } };
  } catch (error) {
    // The number is stored before Shopify is written to. If only that second
    // step failed (no offline session, say), the periodic sync picks it up, and
    // telling the extension it failed would make the merchant enter it twice.
    const stored = await prisma.trackingNumber.findFirst({ where: { purchaseOrderId: po.id, number: input.number } });
    if (!stored) throw error;
    logger.warn("Extension tracking stored; Shopify sync deferred", { purchaseOrderId: po.id, error });
    return { status: 200, body: { ok: true, purchaseOrderId: po.id, trackingId: stored.id, number: stored.number, syncDeferred: true } };
  }
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

/**
 * The keys of PurchaseOrder.raw the app reads back, and nothing else.
 *
 * raw used to carry the supplier's whole placement and status responses, which
 * repeat the consignee's name, address and phone. Nothing read them, so they
 * were customer data kept for no purpose. Every write goes through this list,
 * which also sheds what older versions stored the next time a row is touched.
 */
const PURCHASE_ORDER_RAW_KEYS = [
  "externalOrderIds",
  "shippingReason",
  "placementMode",
  "simulated",
  "simulatedHistory",
  "discardedSimulatedTracking",
  "placedBy",
  "reportedTotal",
  // Older purchase orders kept the payment link here before the column existed.
  "paymentUrl",
] as const;

export function purchaseOrderRawReadBack(raw: unknown): Record<string, Prisma.InputJsonValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const key of PURCHASE_ORDER_RAW_KEYS) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key] as Prisma.InputJsonValue;
  }
  return out;
}

export type { PurchaseOrder, ResolveResult };
export { evaluatePipeline };
