/**
 * The background job handlers that report on supplier placement, run retention,
 * sync stock and rewrite landing pages.
 *
 * Every service a handler calls is a stub and `registerHandler` is captured, so
 * each test runs one handler exactly as the queue would and asserts what it
 * asked of the services and what it told the merchant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    handlers: new Map<string, (payload: Record<string, unknown>, meta: { jobId: string; attempt: number }) => Promise<unknown>>(),
    prisma: { order: { findMany: fn() }, session: { findMany: fn() }, shop: { findMany: fn(), findUnique: fn() } },
    placeSupplierOrders: fn(),
    notify: fn(),
    applyRetention: fn(),
    runInventorySync: fn(),
    rewriteImportedProduct: fn(),
    getAiRewriteAllowance: fn(),
    landingExamples: fn(),
    pushImportedProduct: fn(),
    getShopById: fn(),
    offlineClient: fn(),
    hasFeature: fn(),
    reconcileFulfillmentRequests: fn(),
  };
});

vi.mock("~/db.server", () => ({ default: mocks.prisma }));
vi.mock("~/services/currency.server", () => ({ refreshRates: vi.fn() }));
vi.mock("~/services/fulfillment.server", () => ({
  EXTENSION_PLACEMENT_STEPS:
    "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.",
  fetchFulfillmentRouting: vi.fn(),
  fulfillmentServiceRouting: vi.fn(),
  placeSupplierOrders: mocks.placeSupplierOrders,
  syncOpenPurchaseOrders: vi.fn(),
  syncPendingTracking: vi.fn(),
}));
vi.mock("~/services/fulfillment-service.server", () => ({ reconcileFulfillmentRequests: mocks.reconcileFulfillmentRequests }));
vi.mock("~/services/landing-rewrite.server", () => ({
  getAiRewriteAllowance: mocks.getAiRewriteAllowance,
  landingExamples: mocks.landingExamples,
  rewriteImportedProduct: mocks.rewriteImportedProduct,
}));
vi.mock("~/services/import.server", () => ({ addToImportList: vi.fn(), pushImportedProduct: mocks.pushImportedProduct }));
vi.mock("~/services/inventory-sync.server", () => ({ runInventorySync: mocks.runInventorySync }));
vi.mock("~/services/jobs.server", () => ({
  runJob: async (_id: string, work: (ctx: { progress: () => Promise<void> }) => Promise<unknown>) => work({ progress: async () => undefined }),
}));
vi.mock("~/services/billing.server", () => ({ hasFeature: mocks.hasFeature }));
vi.mock("~/services/compliance.server", () => ({ applyRetention: mocks.applyRetention }));
vi.mock("~/services/notifications.server", () => ({ notify: mocks.notify, sendDigest: vi.fn() }));
vi.mock("~/services/payments.server", () => ({ checkPayments: vi.fn(), sendPaymentReminders: vi.fn() }));
vi.mock("~/services/orders.server", () => ({ syncOrdersFromShopify: vi.fn() }));
vi.mock("~/services/reports.server", () => ({ rollupRange: vi.fn() }));
vi.mock("~/services/shop.server", () => ({ getShopById: mocks.getShopById }));
vi.mock("~/services/shopify/graphql.server", () => ({ offlineClient: mocks.offlineClient }));
vi.mock("~/services/webhooks.server", () => ({ processWebhookEvent: vi.fn() }));
vi.mock("~/services/jobs/queue.server", () => ({
  enqueue: vi.fn(),
  registerHandler: (name: string, handler: (payload: Record<string, unknown>, meta: { jobId: string; attempt: number }) => Promise<unknown>) => {
    mocks.handlers.set(name, handler);
  },
}));

const jobs = await import("~/services/jobs/handlers.server");
jobs.registerAllHandlers();

function run(name: string, payload: Record<string, unknown>, jobId = "job-42") {
  const handler = mocks.handlers.get(name);
  if (!handler) throw new Error(`No handler for ${name}`);
  return handler(payload, { jobId, attempt: 1 });
}

const shop = {
  id: "shop1",
  accountId: "acct1",
  domain: "real-store.myshopify.com",
  isActive: true,
  fulfillmentLocationId: null,
  parsedSettings: { orders: { autoPlaceOrders: true, autoPlaceDelayMinutes: 5 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getShopById.mockResolvedValue(shop);
  mocks.offlineClient.mockResolvedValue({});
  mocks.landingExamples.mockResolvedValue([]);
  mocks.hasFeature.mockResolvedValue(true);
});

describe("place-orders", () => {
  it("counts orders that only went to the extension queue apart from placed ones", async () => {
    mocks.placeSupplierOrders
      .mockResolvedValueOnce({ orderId: "o1", ok: true, purchaseOrderIds: ["po1"], awaitingPlacementIds: [] })
      .mockResolvedValueOnce({ orderId: "o2", ok: true, purchaseOrderIds: ["po2"], awaitingPlacementIds: ["po2"] })
      .mockResolvedValueOnce({ orderId: "o3", ok: true, purchaseOrderIds: ["po3"], awaitingPlacementIds: ["po3"] });

    const result = await run("place-orders", { shopId: "shop1", orderIds: ["o1", "o2", "o3"], jobRunId: "run1" });

    expect(result).toMatchObject({ ok: 1, awaitingPlacement: 2, failed: 0 });
    const notice = mocks.notify.mock.calls[0][1];
    expect(notice.title).toBe("Placed 1 supplier order(s), 2 waiting to be placed with the Chrome extension");
    expect(notice.body).toMatch(/You place and pay for the order there, then record the AliExpress order number in the extension/);
    expect(notice.link).toBe("/app/orders?stage=AWAITING_ORDER");
  });

  it("never says Placed when nothing was placed", () => {
    const notice = jobs.placeOrdersNotice({ placed: 0, waiting: 3, failed: 1 });
    expect(notice.title).toBe("3 waiting to be placed with the Chrome extension, 1 failed");
    expect(notice.severity).toBe("warning");
    expect(notice.link).toBe("/app/orders?stage=FAILED");
    expect(jobs.placeOrdersNotice({ placed: 2, waiting: 0, failed: 0 })).toMatchObject({ title: "Placed 2 supplier order(s)", body: undefined, link: "/app/orders?stage=AWAITING_PAYMENT" });
  });
});

describe("purge-uninstalled", () => {
  it("runs the whole retention pass, not only the uninstalled-store purge", async () => {
    mocks.applyRetention.mockResolvedValue({ purged: [], ordersRedacted: 3, exportsRemoved: 0, webhookPayloadsMinimised: 2, webhookEventsDeleted: 1 });

    const result = await run("purge-uninstalled", {});

    expect(mocks.applyRetention).toHaveBeenCalledTimes(1);
    expect(mocks.applyRetention.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(result).toMatchObject({ ordersRedacted: 3 });
  });
});

describe("inventory-sync", () => {
  it("passes the run id as the operation id, so a retried attempt repeats the same stock writes", async () => {
    mocks.runInventorySync.mockResolvedValue({ plannedActions: [], productsChecked: 1 });
    await run("inventory-sync", { shopId: "shop1" }, "sched-inventory-7");
    expect(mocks.runInventorySync.mock.calls[0][2]).toMatchObject({ operationId: "sched-inventory-7" });

    await run("inventory-sync", { shopId: "shop1", jobRunId: "run9" }, "other-job");
    expect(mocks.runInventorySync.mock.calls[1][2]).toMatchObject({ operationId: "run9" });
  });
});

describe("rewrite-landing", () => {
  const usedUp = "This month's AI rewrite allowance is used up, so this product was not rewritten. Upgrade under Settings → Plan or wait for next month.";

  it("stops the batch once the allowance is used up, and accounts for the rest", async () => {
    mocks.rewriteImportedProduct
      .mockResolvedValueOnce({ importedProductId: "p1", ok: true, title: "One" })
      .mockResolvedValueOnce({ importedProductId: "p2", ok: false, error: usedUp });

    const result = (await run("rewrite-landing", { shopId: "shop1", importedProductIds: ["p1", "p2", "p3", "p4"], jobRunId: "run1" })) as {
      ok: number;
      failed: number;
      results: Array<{ id: string; ok: boolean; error?: string }>;
    };

    expect(mocks.rewriteImportedProduct).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(3);
    expect(result.results.map((r) => r.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(result.results[3].error).toMatch(/Not attempted/);
    expect(mocks.notify.mock.calls[0][1].body).toMatch(/allowance is used up/);
  });

  it("goes on after a failure that leaves allowance to spare", async () => {
    mocks.rewriteImportedProduct
      .mockResolvedValueOnce({ importedProductId: "p1", ok: false, error: "Rewrite rejected: too short." })
      .mockResolvedValueOnce({ importedProductId: "p2", ok: true });
    mocks.getAiRewriteAllowance.mockResolvedValue({ plan: "GROWTH", limit: 100, used: 10, remaining: 90, upgradeTo: null });

    await run("rewrite-landing", { shopId: "shop1", importedProductIds: ["p1", "p2"], jobRunId: "run1" });

    expect(mocks.rewriteImportedProduct).toHaveBeenCalledTimes(2);
  });

  it("recognises a used-up allowance even when the refusal is worded differently", async () => {
    mocks.getAiRewriteAllowance.mockResolvedValue({ plan: "FREE", limit: 5, used: 5, remaining: 0, upgradeTo: "STARTER" });
    await expect(jobs.rewriteAllowanceUsedUp(shop, { importedProductId: "p1", ok: false, error: "Quota reached." })).resolves.toBe(true);
    await expect(jobs.rewriteAllowanceUsedUp(shop, { importedProductId: "p1", ok: true })).resolves.toBe(false);
  });
});

describe("auto-place-orders", () => {
  it("does not pick up orders whose supplier order is already waiting for the extension", async () => {
    mocks.prisma.order.findMany.mockResolvedValue([]);

    await run("auto-place-orders", { shopId: "shop1" });

    const { where } = mocks.prisma.order.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      shopId: "shop1",
      stage: "AWAITING_ORDER",
      isTest: false,
      purchaseOrders: { none: { status: "AWAITING_PLACEMENT" } },
    });
    expect(where.shopifyCreatedAt.lte).toBeInstanceOf(Date);
  });
});
