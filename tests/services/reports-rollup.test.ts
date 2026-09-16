/**
 * Metric rollups and the dashboard's use of them.
 *
 * The dashboard used to recompute today's metrics before rendering on every
 * visit, and "Recalculate" issued a read and an upsert per day of the range.
 * These tests pin down the cheaper shape without changing the figures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateOrders,
  DASHBOARD_METRIC_MAX_AGE_MS,
  getDashboardStats,
  groupOrdersByDay,
  rollupRange,
} from "~/services/reports.server";

const db = vi.hoisted(() => ({
  order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  dailyMetric: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  importedProduct: { count: vi.fn() },
  supplierAccount: { count: vi.fn() },
  jobRun: { count: vi.fn() },
  orderLineItem: { findMany: vi.fn() },
}));
const chunked = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("~/db.server", () => ({ default: db, prisma: db, chunkedTransaction: chunked }));
vi.mock("~/lib/logger.server", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("~/services/orders.server", () => ({ countOrdersByStage: vi.fn(async () => ({})) }));
vi.mock("~/services/products.server", () => ({ countProducts: vi.fn(async () => ({ total: 0 })) }));
vi.mock("~/services/notifications.server", () => ({ countUnread: vi.fn(async () => 0) }));

const order = (overrides: Partial<Parameters<typeof aggregateOrders>[0][number]> = {}) => ({
  shopifyCreatedAt: new Date("2026-09-10T08:00:00Z"),
  stage: "AWAITING_ORDER",
  totalPrice: "20.00",
  supplierCost: "6.00",
  supplierShipping: "2.00",
  lineItems: [
    { quantity: 2, productVariantId: "v1" },
    { quantity: 5, productVariantId: null },
  ],
  purchaseOrders: [] as Array<{ status: string }>,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.dailyMetric.findMany.mockResolvedValue([]);
  db.dailyMetric.upsert.mockImplementation(async (args: { create: unknown }) => args.create);
  db.importedProduct.count.mockResolvedValue(0);
  db.supplierAccount.count.mockResolvedValue(0);
  db.jobRun.count.mockResolvedValue(0);
});
afterEach(() => vi.useRealTimers());

describe("aggregateOrders", () => {
  it("computes the same figures the per-day rollup always did", () => {
    const figures = aggregateOrders([
      order(),
      order({ stage: "CANCELED", totalPrice: "99.00" }),
      order({ stage: "FULFILLED", purchaseOrders: [{ status: "PLACED" }] }),
      order({ stage: "FAILED", purchaseOrders: [{ status: "FAILED" }] }),
    ]);
    expect(figures).toEqual({
      orders: 4,
      itemsSold: 8,
      revenue: "60.00",
      productCost: "24.00",
      shippingCost: "8.00",
      profit: "28.00",
      ordersPlaced: 1,
      ordersFulfilled: 1,
      ordersFailed: 1,
    });
  });
});

describe("groupOrdersByDay", () => {
  it("gives every day in the range a bucket, empty ones included", () => {
    const days = groupOrdersByDay(
      [order(), order({ shopifyCreatedAt: new Date("2026-09-12T23:59:00Z") }), order({ shopifyCreatedAt: null })],
      new Date("2026-09-10T15:00:00Z"),
      new Date("2026-09-12T01:00:00Z"),
    );
    expect([...days.keys()].map((t) => new Date(t).toISOString().slice(0, 10))).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
    expect([...days.values()].map((list) => list.length)).toEqual([1, 0, 1]);
  });
});

describe("rollupRange", () => {
  it("reads the range once and writes in bounded transactions", async () => {
    const rolled = await rollupRange("shop-1", new Date("2026-01-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"));
    expect(rolled).toBe(365);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(chunked).toHaveBeenCalledTimes(1);
    expect(db.dailyMetric.upsert).toHaveBeenCalledTimes(365);
  });
});

describe("getDashboardStats", () => {
  it("does not recompute today's metrics while they are fresh", async () => {
    db.dailyMetric.findUnique.mockResolvedValue({ updatedAt: new Date() });
    await getDashboardStats("shop-1");
    expect(db.dailyMetric.upsert).not.toHaveBeenCalled();
  });

  it("recomputes before answering when today has no row yet", async () => {
    db.dailyMetric.findUnique.mockResolvedValue(null);
    await getDashboardStats("shop-1");
    expect(db.dailyMetric.upsert).toHaveBeenCalledTimes(1);
  });

  it("refreshes stale figures without holding the page for it", async () => {
    db.dailyMetric.findUnique.mockResolvedValue({ updatedAt: new Date(Date.now() - DASHBOARD_METRIC_MAX_AGE_MS - 1000) });
    let release: () => void = () => undefined;
    db.order.findMany.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
    await getDashboardStats("shop-1");
    expect(db.dailyMetric.upsert).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(db.dailyMetric.upsert).toHaveBeenCalledTimes(1));
  });
});
