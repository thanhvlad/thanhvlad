import type { Prisma, PurchaseOrderStatus, SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money, sum } from "~/lib/money";
import { logActivity } from "./activity.server";
import { awaitingPlacementWhere, rollupOrderCosts, syncPurchaseOrder } from "./fulfillment.server";
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

/**
 * Statuses that mean "placed upstream but not paid for yet".
 *
 * AWAITING_PLACEMENT is deliberately not one of them: that order does not
 * exist at the supplier yet, so there is nothing to pay and no payment link
 * that could work. The queue counts it separately.
 */
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

/** The views of the payment queue; the Overdue view is derived from the deadline. */
export const PAYMENT_TABS = ["all", "AWAITING_PAYMENT", "PLACED", "overdue"] as const;
export type PaymentTab = (typeof PAYMENT_TABS)[number];

/** Rows per page of the payment queue. */
export const PAYMENT_PAGE_SIZE = 50;

/** A tab from the query string, falling back to "all" for anything unknown. */
export function paymentTab(value: string | null | undefined): PaymentTab {
  return PAYMENT_TABS.includes(value as PaymentTab) ? (value as PaymentTab) : "all";
}

/** Every purchase order that belongs in the queue at all. */
export function unpaidWhere(shopId: string): Prisma.PurchaseOrderWhereInput {
  return { order: { shopId }, status: { in: UNPAID_STATUSES }, paymentMarkedAt: null };
}

/** The rows one tab shows. Overdue means the supplier's deadline is now or past. */
export function paymentTabWhere(shopId: string, tab: PaymentTab, now: Date): Prisma.PurchaseOrderWhereInput {
  const base = unpaidWhere(shopId);
  switch (tab) {
    case "AWAITING_PAYMENT":
    case "PLACED":
      return { ...base, status: tab };
    case "overdue":
      return { ...base, paymentDueAt: { lte: now } };
    default:
      return base;
  }
}

export interface PaymentQueue {
  /** One page of the selected tab. */
  items: UnpaidPurchaseOrder[];
  tab: PaymentTab;
  page: number;
  pageSize: number;
  /** Rows in the selected tab, across every page. */
  total: number;
  /** Every unpaid purchase order, whatever the tab and page. */
  count: number;
  tabCounts: Record<PaymentTab, number>;
  /** Totals per currency, since a shop can order from several platforms. */
  totals: Array<{ currency: string; amount: string; count: number }>;
  byPlatform: Array<{ platform: SupplierPlatform; count: number; bulkUrl: string | null }>;
  expiringSoon: number;
  overdue: number;
  /** Whether any unpaid order carries a supplier deadline at all. */
  hasDeadlines: boolean;
  /** The unpaid order placed longest ago. */
  oldest: { orderName: string; at: Date | null } | null;
  /** Priced orders still to be placed with the Chrome extension, before they can be paid. */
  awaitingPlacement: number;
}

/**
 * The payment queue: one page of rows for the selected tab, and figures for
 * the whole queue.
 *
 * It used to load every unpaid purchase order and let the screen filter and
 * count them, which grows without bound for a busy store and renders hundreds
 * of rows at once. Rows are now paged in the database, and the stat strip, the
 * banners and the tab counts come from counts and sums over the whole queue, so
 * they stay right whichever page is open.
 *
 * `now` is injected so the countdown is testable and so a single request
 * renders a consistent set of deadlines.
 */
export async function getPaymentQueue(
  shopId: string,
  now: Date = new Date(),
  options: { tab?: PaymentTab; page?: number; pageSize?: number } = {},
): Promise<PaymentQueue> {
  const tab = options.tab ?? "all";
  const pageSize = options.pageSize ?? PAYMENT_PAGE_SIZE;
  const base = unpaidWhere(shopId);
  const soon = new Date(now.getTime() + 6 * 3_600_000);

  const [byStatus, byCurrency, platforms, overdue, expiringSoon, withDeadline, oldestRow, awaitingPlacement] = await Promise.all([
    prisma.purchaseOrder.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    prisma.purchaseOrder.groupBy({ by: ["currency"], where: base, _sum: { totalCost: true }, _count: { _all: true } }),
    prisma.purchaseOrder.groupBy({ by: ["platform"], where: base, _count: { _all: true } }),
    prisma.purchaseOrder.count({ where: paymentTabWhere(shopId, "overdue", now) }),
    prisma.purchaseOrder.count({ where: { ...base, paymentDueAt: { gt: now, lte: soon } } }),
    prisma.purchaseOrder.count({ where: { ...base, paymentDueAt: { not: null } } }),
    // An unpaid order has been placed, so placedAt is nearly always set; the
    // rare one without it sorts last rather than posing as the oldest.
    prisma.purchaseOrder.findFirst({
      where: base,
      orderBy: [{ placedAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      select: { placedAt: true, order: { select: { name: true, shopifyCreatedAt: true } } },
    }),
    // The same rule the orders list and the extension use, so the banner never
    // promises more orders to place than the extension actually lists.
    prisma.purchaseOrder.count({ where: awaitingPlacementWhere(shopId) }),
  ]);

  const statusCount = (status: PurchaseOrderStatus) => byStatus.find((row) => row.status === status)?._count._all ?? 0;
  const count = byStatus.reduce((n, row) => n + row._count._all, 0);
  const tabCounts: Record<PaymentTab, number> = {
    all: count,
    AWAITING_PAYMENT: statusCount("AWAITING_PAYMENT"),
    PLACED: statusCount("PLACED"),
    overdue,
  };

  // A page past the end (its rows were paid since the link was made) shows the
  // last page instead of an empty table.
  const total = tabCounts[tab];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pages);

  const rows = total
    ? await prisma.purchaseOrder.findMany({
        where: paymentTabWhere(shopId, tab, now),
        include: {
          order: { select: { id: true, name: true, shopifyCreatedAt: true, customerName: true, customerEmail: true, countryCode: true } },
          supplierAccount: { select: { label: true } },
          _count: { select: { items: true } },
        },
        // The id breaks ties, so a row cannot appear on two pages or on none.
        orderBy: [{ paymentDueAt: "asc" }, { placedAt: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      })
    : [];

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

  return {
    items,
    tab,
    page,
    pageSize,
    total,
    count,
    tabCounts,
    totals: byCurrency.map((row) => ({ currency: row.currency, amount: money(row._sum.totalCost ?? 0), count: row._count._all })),
    byPlatform: platforms.map((row) => ({ platform: row.platform, count: row._count._all, bulkUrl: bulkPaymentUrl(row.platform) })),
    expiringSoon,
    overdue,
    hasDeadlines: withDeadline > 0,
    oldest: oldestRow ? { orderName: oldestRow.order.name, at: oldestRow.placedAt ?? oldestRow.order.shopifyCreatedAt } : null,
    awaitingPlacement,
  };
}

export async function countUnpaid(shopId: string): Promise<number> {
  return prisma.purchaseOrder.count({ where: unpaidWhere(shopId) });
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
