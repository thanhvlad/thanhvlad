import prisma from "~/db.server";
import { d, money, sum } from "~/lib/money";
import { countOrdersByStage } from "./orders.server";
import { countProducts } from "./products.server";
import { countUnread } from "./notifications.server";

function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/** Aggregate one UTC day into DailyMetric. Idempotent. */
export async function rollupDailyMetrics(shopId: string, day: Date) {
  const from = startOfDay(day);
  const to = new Date(from.getTime() + 86_400_000);

  const orders = await prisma.order.findMany({
    where: { shopId, shopifyCreatedAt: { gte: from, lt: to }, isTest: false },
    include: { lineItems: { select: { quantity: true, productVariantId: true } }, purchaseOrders: { select: { status: true, placedAt: true } } },
  });

  const revenue = sum(orders.filter((o) => o.stage !== "CANCELED").map((o) => o.totalPrice));
  const productCost = sum(orders.map((o) => o.supplierCost));
  const shippingCost = sum(orders.map((o) => o.supplierShipping));
  const itemsSold = orders.reduce((n, o) => n + o.lineItems.filter((li) => li.productVariantId).reduce((m, li) => m + li.quantity, 0), 0);
  const ordersPlaced = orders.filter((o) => o.purchaseOrders.some((po) => !["FAILED", "CANCELED", "DRAFT"].includes(po.status))).length;
  const ordersFulfilled = orders.filter((o) => o.stage === "FULFILLED" || o.stage === "AWAITING_DELIVERY").length;
  const ordersFailed = orders.filter((o) => o.stage === "FAILED").length;

  return prisma.dailyMetric.upsert({
    where: { shopId_day: { shopId, day: from } },
    create: {
      shopId,
      day: from,
      orders: orders.length,
      itemsSold,
      revenue: money(revenue),
      productCost: money(productCost),
      shippingCost: money(shippingCost),
      profit: money(revenue.minus(productCost).minus(shippingCost)),
      ordersPlaced,
      ordersFulfilled,
      ordersFailed,
    },
    update: {
      orders: orders.length,
      itemsSold,
      revenue: money(revenue),
      productCost: money(productCost),
      shippingCost: money(shippingCost),
      profit: money(revenue.minus(productCost).minus(shippingCost)),
      ordersPlaced,
      ordersFulfilled,
      ordersFailed,
    },
  });
}

export async function rollupRange(shopId: string, from: Date, to: Date) {
  let cursor = startOfDay(from);
  const end = startOfDay(to);
  let days = 0;
  while (cursor <= end) {
    await rollupDailyMetrics(shopId, cursor);
    cursor = new Date(cursor.getTime() + 86_400_000);
    days += 1;
  }
  return days;
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

export async function getDashboardStats(shopId: string) {
  const today = startOfDay(new Date());
  const weekAgo = new Date(today.getTime() - 6 * 86_400_000);
  await rollupDailyMetrics(shopId, today).catch(() => undefined);

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
