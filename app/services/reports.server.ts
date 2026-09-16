import prisma, { chunkedTransaction } from "~/db.server";
import { d, money, sum, type MoneyInput } from "~/lib/money";
import { logger } from "~/lib/logger.server";
import { countOrdersByStage } from "./orders.server";
import { countProducts } from "./products.server";
import { countUnread } from "./notifications.server";

function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

type RollupOrder = {
  shopifyCreatedAt: Date | null;
  stage: string;
  totalPrice: MoneyInput;
  supplierCost: MoneyInput;
  supplierShipping: MoneyInput;
  lineItems: Array<{ quantity: number; productVariantId: string | null }>;
  purchaseOrders: Array<{ status: string }>;
};

const ROLLUP_SELECT = {
  shopifyCreatedAt: true,
  stage: true,
  totalPrice: true,
  supplierCost: true,
  supplierShipping: true,
  lineItems: { select: { quantity: true, productVariantId: true } },
  purchaseOrders: { select: { status: true } },
} as const;

/** The DailyMetric figures for one day's orders. Pure, so it can be tested without a database. */
export function aggregateOrders(orders: RollupOrder[]) {
  const revenue = sum(orders.filter((o) => o.stage !== "CANCELED").map((o) => o.totalPrice));
  const productCost = sum(orders.map((o) => o.supplierCost));
  const shippingCost = sum(orders.map((o) => o.supplierShipping));
  return {
    orders: orders.length,
    itemsSold: orders.reduce((n, o) => n + o.lineItems.filter((li) => li.productVariantId).reduce((m, li) => m + li.quantity, 0), 0),
    revenue: money(revenue),
    productCost: money(productCost),
    shippingCost: money(shippingCost),
    profit: money(revenue.minus(productCost).minus(shippingCost)),
    ordersPlaced: orders.filter((o) => o.purchaseOrders.some((po) => !["FAILED", "CANCELED", "DRAFT"].includes(po.status))).length,
    ordersFulfilled: orders.filter((o) => o.stage === "FULFILLED" || o.stage === "AWAITING_DELIVERY").length,
    ordersFailed: orders.filter((o) => o.stage === "FAILED").length,
  };
}

/** Group orders by the UTC day they were created, for every day in [from, to]. */
export function groupOrdersByDay<T extends { shopifyCreatedAt: Date | null }>(orders: T[], from: Date, to: Date) {
  const days = new Map<number, T[]>();
  for (let cursor = startOfDay(from).getTime(); cursor <= startOfDay(to).getTime(); cursor += 86_400_000) {
    days.set(cursor, []);
  }
  for (const order of orders) {
    if (!order.shopifyCreatedAt) continue;
    days.get(startOfDay(order.shopifyCreatedAt).getTime())?.push(order);
  }
  return days;
}

/** Aggregate one UTC day into DailyMetric. Idempotent. */
export async function rollupDailyMetrics(shopId: string, day: Date) {
  const from = startOfDay(day);
  const to = new Date(from.getTime() + 86_400_000);

  const orders = await prisma.order.findMany({
    where: { shopId, shopifyCreatedAt: { gte: from, lt: to }, isTest: false },
    select: ROLLUP_SELECT,
  });
  const figures = aggregateOrders(orders);

  return prisma.dailyMetric.upsert({
    where: { shopId_day: { shopId, day: from } },
    create: { shopId, day: from, ...figures },
    update: figures,
  });
}

/**
 * Re-aggregate every day in a range.
 *
 * One read for the whole range and bounded write transactions, rather than a
 * read and an upsert per day: "Recalculate" on a year of reports ran about 730
 * sequential queries inside the request that asked for it.
 */
export async function rollupRange(shopId: string, from: Date, to: Date) {
  const start = startOfDay(from);
  const end = startOfDay(to);
  const orders = await prisma.order.findMany({
    where: { shopId, shopifyCreatedAt: { gte: start, lt: new Date(end.getTime() + 86_400_000) }, isTest: false },
    select: ROLLUP_SELECT,
  });
  const byDay = groupOrdersByDay(orders, start, end);
  await chunkedTransaction(
    [...byDay.entries()].map(([time, dayOrders]) => {
      const day = new Date(time);
      const figures = aggregateOrders(dayOrders);
      return prisma.dailyMetric.upsert({
        where: { shopId_day: { shopId, day } },
        create: { shopId, day, ...figures },
        update: figures,
      });
    }),
  );
  return byDay.size;
}

export interface ReportRange {
  from: Date;
  to: Date;
}

export async function getReport(shopId: string, range: ReportRange) {
  const from = startOfDay(range.from);
  const to = startOfDay(range.to);
  const series = await prisma.dailyMetric.findMany({ where: { shopId, day: { gte: from, lte: to } }, orderBy: { day: "asc" } });

  const totals = {
    orders: series.reduce((n, m) => n + m.orders, 0),
    itemsSold: series.reduce((n, m) => n + m.itemsSold, 0),
    revenue: money(sum(series.map((m) => m.revenue))),
    productCost: money(sum(series.map((m) => m.productCost))),
    shippingCost: money(sum(series.map((m) => m.shippingCost))),
    profit: money(sum(series.map((m) => m.profit))),
    ordersPlaced: series.reduce((n, m) => n + m.ordersPlaced, 0),
    ordersFulfilled: series.reduce((n, m) => n + m.ordersFulfilled, 0),
    ordersFailed: series.reduce((n, m) => n + m.ordersFailed, 0),
  };
  const revenue = d(totals.revenue);
  const marginPercent = revenue.isZero() ? "0.00" : d(totals.profit).dividedBy(revenue).times(100).toFixed(2);

  // Top products by units, from managed line items in range.
  const lines = await prisma.orderLineItem.findMany({
    where: { order: { shopId, shopifyCreatedAt: { gte: from, lt: new Date(to.getTime() + 86_400_000) }, stage: { not: "CANCELED" } }, productVariantId: { not: null } },
    select: { quantity: true, price: true, shopifyProductId: true, title: true, productVariant: { select: { product: { select: { id: true, title: true, featuredImage: true } } } } },
  });
  const byProduct = new Map<string, { id: string; title: string; image: string | null; units: number; revenue: ReturnType<typeof d> }>();
  for (const line of lines) {
    const product = line.productVariant?.product;
    const key = product?.id ?? line.shopifyProductId ?? line.title;
    const entry = byProduct.get(key) ?? { id: product?.id ?? key, title: product?.title ?? line.title, image: product?.featuredImage ?? null, units: 0, revenue: d(0) };
    entry.units += line.quantity;
    entry.revenue = entry.revenue.plus(d(line.price).times(line.quantity));
    byProduct.set(key, entry);
  }
  const topProducts = [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, 10).map((p) => ({ ...p, revenue: money(p.revenue) }));

  // Destination breakdown.
  const byCountry = await prisma.order.groupBy({
    by: ["countryCode"],
    where: { shopId, shopifyCreatedAt: { gte: from, lt: new Date(to.getTime() + 86_400_000) }, stage: { not: "CANCELED" } },
    _count: { _all: true },
    _sum: { totalPrice: true },
    orderBy: { _count: { countryCode: "desc" } },
    take: 10,
  });

  return {
    series: series.map((m) => ({
      day: m.day.toISOString().slice(0, 10),
      orders: m.orders,
      revenue: m.revenue.toString(),
      cost: money(d(m.productCost).plus(m.shippingCost)),
      profit: m.profit.toString(),
    })),
    totals: { ...totals, marginPercent },
    topProducts,
    byCountry: byCountry.map((c) => ({ countryCode: c.countryCode ?? "??", orders: c._count._all, revenue: money(c._sum.totalPrice ?? 0) })),
  };
}

/** How old today's figures may be before a dashboard view refreshes them. */
export const DASHBOARD_METRIC_MAX_AGE_MS = 10 * 60_000;
const refreshing = new Map<string, Promise<unknown>>();

/**
 * Keep today's DailyMetric roughly current without making the dashboard wait.
 *
 * Every dashboard GET used to load all of today's orders with their lines and
 * purchase orders and upsert a row before any of its own queries started, so
 * the home screen got slower with every order a shop took. The scheduler rolls
 * metrics up anyway; the dashboard only fills a gap. With no row yet for today
 * it waits once, so a first visit is not empty; a row that is merely old is
 * refreshed in the background and the view shows it as it stands.
 */
async function refreshTodayIfStale(shopId: string, today: Date) {
  const existing = await prisma.dailyMetric.findUnique({ where: { shopId_day: { shopId, day: today } }, select: { updatedAt: true } });
  if (existing && Date.now() - existing.updatedAt.getTime() < DASHBOARD_METRIC_MAX_AGE_MS) return;
  let run = refreshing.get(shopId);
  if (!run) {
    run = rollupDailyMetrics(shopId, today)
      .catch((error) => logger.warn("Dashboard metric refresh failed", { shopId, error }))
      .finally(() => refreshing.delete(shopId));
    refreshing.set(shopId, run);
  }
  if (!existing) await run;
}

export async function getDashboardStats(shopId: string) {
  const today = startOfDay(new Date());
  const weekAgo = new Date(today.getTime() - 6 * 86_400_000);
  await refreshTodayIfStale(shopId, today);

  const [stages, products, unread, importCount, supplierAccounts, week, recentFailures, activeJobs] = await Promise.all([
    countOrdersByStage(shopId),
    countProducts(shopId),
    countUnread(shopId),
    prisma.importedProduct.count({ where: { shopId, status: { in: ["DRAFT", "READY", "FAILED"] } } }),
    prisma.supplierAccount.count({ where: { OR: [{ shopId }, { shop: { id: shopId } }], isActive: true } }),
    prisma.dailyMetric.findMany({ where: { shopId, day: { gte: weekAgo, lte: today } }, orderBy: { day: "asc" } }),
    prisma.order.count({ where: { shopId, stage: "FAILED" } }),
    prisma.jobRun.count({ where: { shopId, status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);

  const weekRevenue = money(sum(week.map((m) => m.revenue)));
  const weekProfit = money(sum(week.map((m) => m.profit)));
  const weekOrders = week.reduce((n, m) => n + m.orders, 0);

  return {
    stages,
    products,
    unread,
    importCount,
    supplierAccounts,
    week: { revenue: weekRevenue, profit: weekProfit, orders: weekOrders, series: week.map((m) => ({ day: m.day.toISOString().slice(0, 10), revenue: m.revenue.toString(), profit: m.profit.toString(), orders: m.orders })) },
    recentFailures,
    activeJobs,
  };
}
