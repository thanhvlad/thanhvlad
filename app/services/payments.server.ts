import type { PurchaseOrderStatus, SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money, sum } from "~/lib/money";
import { logActivity } from "./activity.server";
import { rollupOrderCosts, syncPurchaseOrder } from "./fulfillment.server";
import { notify } from "./notifications.server";
import { evaluateAndStoreOrder } from "./orders.server";
import type { ShopWithSettings } from "./shop.server";
import { ALIEXPRESS_UNPAID_ORDERS_URL, orderPaymentUrl } from "./suppliers/aliexpress.server";

/**
 * Supplier payment is made on the supplier's own site — AliExpress will not let
 * an app charge a merchant's account. This module keeps the queue of unpaid
 * supplier orders, hands the merchant deep links to pay them, and notices when
 * the supplier reports the payment so the pipeline moves on.
 */

/** Statuses that mean "placed upstream but not paid for yet". */
export const UNPAID_STATUSES: PurchaseOrderStatus[] = ["PLACED", "AWAITING_PAYMENT"];

/** Where to send the merchant to pay several orders at once, per platform. */
export function bulkPaymentUrl(platform: SupplierPlatform): string | null {
  switch (platform) {
    case "ALIEXPRESS":
      return ALIEXPRESS_UNPAID_ORDERS_URL;
    case "CJ_DROPSHIPPING":
      return "https://cjdropshipping.com/myCJ/orders.html";
    default:
      return null;
  }
}

/** Deep link for one order, falling back to the platform's order list. */
export function paymentUrlFor(platform: SupplierPlatform, externalOrderId: string | null, stored: string | null): string | null {
  if (stored) return stored;
  if (!externalOrderId) return bulkPaymentUrl(platform);
  if (platform === "ALIEXPRESS") return orderPaymentUrl(externalOrderId);
  return bulkPaymentUrl(platform);
}

export interface UnpaidPurchaseOrder {
  id: string;
  orderId: string;
  orderName: string;
  orderCreatedAt: Date | null;
  customer: string | null;
  countryCode: string | null;
  platform: SupplierPlatform;
  externalOrderId: string | null;
  status: PurchaseOrderStatus;
  itemsCost: string;
  shippingCost: string;
  totalCost: string;
  currency: string;
  placedAt: Date | null;
  paymentDueAt: Date | null;
  paymentUrl: string | null;
  /** Hours until the supplier auto-cancels; negative when already overdue. */
  hoursLeft: number | null;
  itemCount: number;
  supplierAccount: string | null;
}

export interface PaymentQueue {
  items: UnpaidPurchaseOrder[];
  /** Totals per currency, since a shop can order from several platforms. */
  totals: Array<{ currency: string; amount: string; count: number }>;
  byPlatform: Array<{ platform: SupplierPlatform; count: number; bulkUrl: string | null }>;
  expiringSoon: number;
  overdue: number;
}

/**
 * The payment queue. `now` is injected so the countdown is testable and so a
 * single request renders a consistent set of deadlines.
 */
export async function getPaymentQueue(shopId: string, now: Date = new Date()): Promise<PaymentQueue> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { order: { shopId }, status: { in: UNPAID_STATUSES }, paymentMarkedAt: null },
    include: {
      order: { select: { id: true, name: true, shopifyCreatedAt: true, customerName: true, customerEmail: true, countryCode: true } },
      supplierAccount: { select: { label: true } },
      _count: { select: { items: true } },
    },
    orderBy: [{ paymentDueAt: "asc" }, { placedAt: "asc" }],
  });

  const items: UnpaidPurchaseOrder[] = rows.map((po) => ({
    id: po.id,
    orderId: po.order.id,
    orderName: po.order.name,
    orderCreatedAt: po.order.shopifyCreatedAt,
    customer: po.order.customerName ?? po.order.customerEmail,
    countryCode: po.order.countryCode,
    platform: po.platform,
    externalOrderId: po.externalOrderId,
    status: po.status,
    itemsCost: money(po.itemsCost),
    shippingCost: money(po.shippingCost),
    totalCost: money(po.totalCost),
    currency: po.currency,
    placedAt: po.placedAt,
    paymentDueAt: po.paymentDueAt,
    paymentUrl: paymentUrlFor(po.platform, po.externalOrderId, po.paymentUrl),
    hoursLeft: po.paymentDueAt ? (po.paymentDueAt.getTime() - now.getTime()) / 3_600_000 : null,
    itemCount: po._count.items,
    supplierAccount: po.supplierAccount?.label ?? null,
  }));

  const byCurrency = new Map<string, { amount: ReturnType<typeof d>; count: number }>();
  for (const item of items) {
    const entry = byCurrency.get(item.currency) ?? { amount: d(0), count: 0 };
    entry.amount = entry.amount.plus(d(item.totalCost));
    entry.count += 1;
    byCurrency.set(item.currency, entry);
  }

  const platforms = new Map<SupplierPlatform, number>();
  for (const item of items) platforms.set(item.platform, (platforms.get(item.platform) ?? 0) + 1);

  return {
    items,
    totals: [...byCurrency.entries()].map(([currency, v]) => ({ currency, amount: money(v.amount), count: v.count })),
    byPlatform: [...platforms.entries()].map(([platform, count]) => ({ platform, count, bulkUrl: bulkPaymentUrl(platform) })),
    expiringSoon: items.filter((i) => i.hoursLeft !== null && i.hoursLeft > 0 && i.hoursLeft <= 6).length,
    overdue: items.filter((i) => i.hoursLeft !== null && i.hoursLeft <= 0).length,
  };
}

export async function countUnpaid(shopId: string): Promise<number> {
  return prisma.purchaseOrder.count({
    where: { order: { shopId }, status: { in: UNPAID_STATUSES }, paymentMarkedAt: null },
  });
}

/** Re-read the given (or all) unpaid orders upstream to pick up payments. */
export async function checkPayments(shop: ShopWithSettings, purchaseOrderIds?: string[]) {
  const rows = await prisma.purchaseOrder.findMany({
    where: {
      order: { shopId: shop.id },
      status: { in: UNPAID_STATUSES },
      externalOrderId: { not: null },
      ...(purchaseOrderIds?.length ? { id: { in: purchaseOrderIds } } : {}),
    },
    select: { id: true },
    take: 200,
  });

  let paid = 0;
  let checked = 0;
  const errors: string[] = [];
  for (const row of rows) {
    checked += 1;
    try {
      const result = await syncPurchaseOrder(shop, row.id);
      if (!UNPAID_STATUSES.includes(result.status)) paid += 1;
    } catch (error) {
      errors.push(errorMessage(error));
      logger.warn("Payment check failed", { purchaseOrderId: row.id, error });
    }
  }
  if (paid > 0) {
    await logActivity(shop.id, { action: "payment.detected", message: `${paid} supplier order(s) are now paid.` });
  }
  return { checked, paid, errors };
}

/**
 * Merchant paid on the supplier's site but the supplier has not reported it
 * yet. Records the claim so the order leaves the payment queue; the next
 * upstream sync still has the final say on the real status.
 */
export async function markPaidManually(shop: ShopWithSettings, purchaseOrderId: string, actor?: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, order: { shopId: shop.id } },
    include: { order: { select: { id: true, name: true } } },
  });
  if (!po) throw new Error("Purchase order not found");
  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { paymentMarkedAt: new Date(), paidAt: po.paidAt ?? new Date(), status: po.status === "FAILED" ? po.status : "PAID" },
  });
  await logActivity(shop.id, {
    actor,
    action: "payment.marked",
    entity: "Order",
    entityId: po.order.id,
    message: `${po.order.name}: marked as paid on ${po.platform}.`,
  });
  await rollupOrderCosts(po.order.id);
  await evaluateAndStoreOrder(shop, po.order.id);
  return po;
}

export async function undoManualPayment(shop: ShopWithSettings, purchaseOrderId: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, order: { shopId: shop.id } } });
  if (!po) throw new Error("Purchase order not found");
  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { paymentMarkedAt: null, paidAt: null, status: "AWAITING_PAYMENT" },
  });
  await evaluateAndStoreOrder(shop, po.orderId);
}

/**
 * Warn about orders approaching their auto-cancel deadline. Runs on the
 * payment-reminder schedule; one notification per order per window.
 */
export async function sendPaymentReminders(shop: ShopWithSettings, now: Date = new Date()) {
  const threshold = new Date(now.getTime() + 6 * 3_600_000);
  const due = await prisma.purchaseOrder.findMany({
    where: {
      order: { shopId: shop.id },
      status: { in: UNPAID_STATUSES },
      paymentMarkedAt: null,
      paymentDueAt: { not: null, lte: threshold },
      OR: [{ paymentReminderAt: null }, { paymentReminderAt: { lt: new Date(now.getTime() - 6 * 3_600_000) } }],
    },
    include: { order: { select: { id: true, name: true } } },
    take: 50,
  });
  if (due.length === 0) return { reminded: 0 };

  const totals = money(sum(due.map((po) => po.totalCost)));
  await notify(shop.id, {
    type: "order.failed",
    severity: "warning",
    title: `${due.length} supplier order(s) still need payment`,
    body: `${totals} ${due[0].currency} outstanding. AliExpress cancels unpaid orders after 24 hours.`,
    link: "/app/payments",
    dedupeKey: `payment-reminder:${due.map((p) => p.id).sort().join(",").slice(0, 80)}`,
    dedupeMinutes: 60 * 6,
  });
  await prisma.purchaseOrder.updateMany({
    where: { id: { in: due.map((p) => p.id) } },
    data: { paymentReminderAt: now },
  });
  await logActivity(shop.id, {
    action: "payment.reminder",
    level: "warn",
    message: `Reminder sent for ${due.length} unpaid supplier order(s) (${totals} ${due[0].currency}).`,
    meta: { orders: due.map((p) => p.order.name) },
  });
  return { reminded: due.length };
}

/** Rows for the Orders page "pay" column, keyed by order id. */
export async function unpaidByOrder(shopId: string, orderIds: string[]) {
  if (orderIds.length === 0) return new Map<string, { total: string; currency: string; url: string | null }>();
  const rows = await prisma.purchaseOrder.findMany({
    where: { orderId: { in: orderIds }, order: { shopId }, status: { in: UNPAID_STATUSES }, paymentMarkedAt: null },
    select: { orderId: true, totalCost: true, currency: true, platform: true, externalOrderId: true, paymentUrl: true },
  });
  const map = new Map<string, { total: string; currency: string; url: string | null }>();
  for (const row of rows) {
    const existing = map.get(row.orderId);
    map.set(row.orderId, {
      total: money(d(existing?.total ?? 0).plus(row.totalCost)),
      currency: row.currency,
      url: existing?.url ?? paymentUrlFor(row.platform, row.externalOrderId, row.paymentUrl),
    });
  }
  return map;
}
