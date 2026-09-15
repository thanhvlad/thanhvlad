/**
 * Extension-mode placement, the extension order API, and the rule that
 * simulated tracking never reaches a real Shopify order.
 *
 * Everything fulfillment.server.ts talks to is replaced with a stub, so these
 * run without a database or Shopify and assert what would have been written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseShopSettings } from "~/domain/settings/shop-settings";
import { resetRateLimits } from "~/lib/rate-limit.server";
import type { ShopWithSettings } from "~/services/shop.server";

const mocks = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      $transaction: fn(),
      order: { findUnique: fn(), update: fn() },
      purchaseOrder: { findFirst: fn(), findMany: fn(), create: fn(), update: fn(), updateMany: fn(), count: fn(), groupBy: fn() },
      activityLog: { findFirst: fn() },
      purchaseOrderItem: { findMany: fn() },
      supplierVariant: { findUnique: fn() },
      trackingNumber: { findMany: fn(), findFirst: fn(), updateMany: fn(), update: fn(), upsert: fn() },
      orderLineItem: { findMany: fn(), update: fn() },
      shop: { findUnique: fn() },
    },
    tx: { $executeRaw: fn(), purchaseOrder: { findFirst: fn(), create: fn(), update: fn() }, trackingNumber: { deleteMany: fn() } },
    logActivity: fn(),
    notify: fn(),
    evaluateAndStoreOrder: fn(),
    lineResolution: fn(),
    orderIssues: fn(),
    getShippingOptions: fn(),
    chooseShippingForShop: fn(),
    placementModeForShop: fn(),
    adapterForShop: fn(),
    placeOrder: fn(),
    createFulfillmentWithTracking: fn(),
    updateFulfillmentTracking: fn(),
    addOrderTags: fn(),
    offlineClient: fn(),
    gql: fn(),
  };
});

vi.mock("~/db.server", () => ({ default: mocks.prisma }));
vi.mock("~/services/activity.server", () => ({ logActivity: mocks.logActivity }));
vi.mock("~/services/notifications.server", () => ({ notify: mocks.notify }));
vi.mock("~/services/currency.server", () => ({ getKnownRate: async () => 1 }));
vi.mock("~/services/orders.server", () => ({
  evaluateAndStoreOrder: mocks.evaluateAndStoreOrder,
  lineResolution: mocks.lineResolution,
  orderIssues: mocks.orderIssues,
  supplierAddressFor: (order: { shippingAddress: unknown }) => order.shippingAddress,
}));
vi.mock("~/services/shipping.server", () => ({ chooseShippingForShop: mocks.chooseShippingForShop }));
vi.mock("~/services/shop.server", () => ({ withSettings: (shop: object) => ({ ...shop, parsedSettings: parseShopSettings({}) }) }));
vi.mock("~/services/shopify/graphql.server", () => ({ offlineClient: mocks.offlineClient, gql: mocks.gql }));
vi.mock("~/services/shopify/orders.server", () => ({
  addOrderTags: mocks.addOrderTags,
  createFulfillmentWithTracking: mocks.createFulfillmentWithTracking,
  updateFulfillmentTracking: mocks.updateFulfillmentTracking,
}));
vi.mock("~/services/supplier-accounts.server", () => ({ touchSupplierAccount: vi.fn() }));
vi.mock("~/services/suppliers/catalog.server", () => ({ getShippingOptions: mocks.getShippingOptions }));
vi.mock("~/services/suppliers/index.server", () => ({
  EXTENSION_PLACEMENT_STEPS: "(extension steps)",
  adapterForShop: mocks.adapterForShop,
  placementModeForShop: mocks.placementModeForShop,
  supplierProductUrl: (platform: string, id: string | null) => (platform === "ALIEXPRESS" && id ? `https://www.aliexpress.com/item/${id}.html` : null),
  unavailableReason: (platform: string) => `${platform} cannot be reached from DropshipHub yet.`,
}));

const fulfillment = await import("~/services/fulfillment.server");

function makeShop(overrides: Partial<ShopWithSettings> = {}): ShopWithSettings {
  return {
    id: "shop1",
    domain: "real-store.myshopify.com",
    currency: "USD",
    isDevelopmentStore: false,
    isActive: true,
    apiToken: "dsh_abcdefghijklmnopqrstuvwxyz012345",
    parsedSettings: parseShopSettings({}),
    ...overrides,
  } as ShopWithSettings;
}

const address = { name: "Jane Doe", phone: "+15125550100", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701", countryCode: "US", country: "United States" };

const resolved = {
  mappingRowId: "m1",
  supplierVariantId: "sv1",
  externalProductId: "1005006001",
  externalSkuId: "12000031",
  skuAttr: "14:193#Black",
  platform: "ALIEXPRESS",
  title: "Wireless earbuds, black",
  quantity: 2,
  unitCost: "3.50",
  currency: "USD",
};

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order1",
    shopId: "shop1",
    name: "#1001",
    isTest: false,
    currency: "USD",
    shopifyOrderId: "gid://shopify/Order/1",
    shippingAddress: address,
    customerEmail: "jane@example.com",
    countryCode: "US",
    lineItems: [{ id: "li1", shopifyLineItemId: "gid://shopify/LineItem/1", productVariantId: "pv1", isCanceled: false, isFulfilled: false, title: "Earbuds" }],
    purchaseOrders: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  const { prisma, tx } = mocks;
  prisma.$transaction.mockImplementation(async (work: (t: typeof tx) => unknown) => work(tx));
  prisma.purchaseOrderItem.findMany.mockResolvedValue([]);
  prisma.supplierVariant.findUnique.mockResolvedValue({ supplierProductId: "sp1" });
  prisma.purchaseOrder.findMany.mockResolvedValue([]);
  prisma.purchaseOrder.update.mockResolvedValue({});
  prisma.purchaseOrder.create.mockResolvedValue({});
  prisma.order.update.mockResolvedValue({});
  prisma.trackingNumber.updateMany.mockResolvedValue({ count: 0 });
  tx.purchaseOrder.findFirst.mockResolvedValue(null);
  tx.purchaseOrder.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "po1", ...data }));
  mocks.evaluateAndStoreOrder.mockResolvedValue({});
  mocks.orderIssues.mockReturnValue([]);
  mocks.lineResolution.mockReturnValue({ ok: true, lines: [resolved], totalCost: "7.00" });
  mocks.getShippingOptions.mockResolvedValue([{ carrierCode: "CAINIAO_STANDARD" }]);
  mocks.chooseShippingForShop.mockResolvedValue({
    ok: true,
    option: { carrierCode: "CAINIAO_STANDARD", carrierName: "AliExpress Standard Shipping", shipFromCountry: "CN", maxDeliveryDays: 20, cost: "1.99" },
    reason: "Cheapest tracked option.",
  });
  mocks.adapterForShop.mockResolvedValue({ adapter: { platform: "ALIEXPRESS", simulated: false, placeOrder: mocks.placeOrder }, account: null });
  mocks.offlineClient.mockResolvedValue({});
});

describe("placeSupplierOrders in extension mode", () => {
  it("creates an AWAITING_PLACEMENT purchase order with full items, under the lock, and calls no supplier", async () => {
    mocks.placementModeForShop.mockResolvedValue("extension");
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow());

    const outcome = await fulfillment.placeSupplierOrders(makeShop(), "order1");

    expect(outcome).toMatchObject({ ok: true, purchaseOrderIds: ["po1"], awaitingPlacementIds: ["po1"] });
    expect(mocks.placeOrder).not.toHaveBeenCalled();
    // The advisory lock and the idempotency key work exactly as for an API placement.
    expect(mocks.tx.$executeRaw).toHaveBeenCalled();
    const { data } = mocks.tx.purchaseOrder.create.mock.calls[0][0];
    expect(data.status).toBe("AWAITING_PLACEMENT");
    expect(data.idempotencyKey).toMatch(/^dh-[0-9a-f]{24}$/);
    expect(data).toMatchObject({ platform: "ALIEXPRESS", itemsCost: "7.00", shippingCost: "1.99", totalCost: "8.99" });
    expect(data.raw).toMatchObject({ placementMode: "extension", simulated: false });
    expect(data.items.create).toEqual([
      expect.objectContaining({
        externalProductId: "1005006001",
        externalSkuId: "12000031",
        externalSkuAttr: "14:193#Black",
        quantity: 2,
        unitCost: "3.50",
        carrierName: "AliExpress Standard Shipping",
      }),
    ]);
    // Told what to do next, and not told it was placed.
    expect(mocks.notify).toHaveBeenCalledWith("shop1", expect.objectContaining({ title: expect.stringMatching(/ready to place with the Chrome extension/) }));
    expect(mocks.addOrderTags).not.toHaveBeenCalled();
  });

  it("is a no-op when the same purchase order already exists", async () => {
    mocks.placementModeForShop.mockResolvedValue("extension");
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow());
    mocks.tx.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", status: "AWAITING_PLACEMENT" });

    const outcome = await fulfillment.placeSupplierOrders(makeShop(), "order1");

    expect(mocks.tx.purchaseOrder.create).not.toHaveBeenCalled();
    expect(outcome.awaitingPlacementIds).toEqual([]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("fails a platform nothing can place with the reason, once, instead of simulating it", async () => {
    mocks.placementModeForShop.mockResolvedValue("unavailable");
    mocks.lineResolution.mockReturnValue({ ok: true, lines: [{ ...resolved, platform: "TEMU" }], totalCost: "7.00" });
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow());
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "failed1" });

    const first = await fulfillment.placeSupplierOrders(makeShop(), "order1");
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/TEMU cannot be reached/);
    expect(mocks.prisma.purchaseOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "FAILED", errorCode: "SUPPLIER_UNAVAILABLE", platform: "TEMU" }),
    });

    // The auto-place tick comes back; it must not stack another FAILED row.
    await fulfillment.placeSupplierOrders(makeShop(), "order1");
    expect(mocks.prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
    expect(mocks.placeOrder).not.toHaveBeenCalled();
    expect(mocks.tx.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("will not run the Demo supplier for a real customer's order on a real store", async () => {
    mocks.placementModeForShop.mockResolvedValue("demo");
    mocks.lineResolution.mockReturnValue({ ok: true, lines: [{ ...resolved, platform: "MOCK" }], totalCost: "7.00" });
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow());
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);

    const outcome = await fulfillment.placeSupplierOrders(makeShop(), "order1");
    expect(outcome.ok).toBe(false);
    expect(mocks.prisma.purchaseOrder.create).toHaveBeenCalledWith({ data: expect.objectContaining({ errorCode: "DEMO_SUPPLIER_REAL_ORDER" }) });
    expect(mocks.placeOrder).not.toHaveBeenCalled();
  });

  it("still lets the Demo supplier run on a test order, for the reviewer walkthrough", () => {
    expect(fulfillment.placementRefusal("demo", "MOCK", { isTest: true, isDevelopmentStore: false })).toBeNull();
    expect(fulfillment.placementRefusal("demo", "MOCK", { isTest: false, isDevelopmentStore: true })).toBeNull();
    expect(fulfillment.placementRefusal("extension", "ALIEXPRESS", { isTest: false, isDevelopmentStore: false })).toBeNull();
  });
});

describe("simulated purchase orders and Shopify", () => {
  it("recognises Demo supplier orders and MOCK- ids left on real platforms", () => {
    expect(fulfillment.isSimulatedPurchaseOrder({ platform: "MOCK", externalOrderId: null })).toBe(true);
    expect(fulfillment.isSimulatedPurchaseOrder({ platform: "ALIEXPRESS", externalOrderId: "MOCK-LX1-42" })).toBe(true);
    expect(fulfillment.isSimulatedPurchaseOrder({ platform: "ALIEXPRESS", externalOrderId: "8190000000000000", raw: { simulated: true } })).toBe(true);
    expect(fulfillment.isSimulatedPurchaseOrder({ platform: "ALIEXPRESS", externalOrderId: "8190000000000000", raw: {} })).toBe(false);
  });

  it("allows simulated writes only on test orders or development stores, and then silently", () => {
    const simulated = { platform: "MOCK" as const, externalOrderId: "MOCK-1" };
    expect(fulfillment.shopifyWritePolicy(simulated, { orderIsTest: false, isDevelopmentStore: false }).allowed).toBe(false);
    expect(fulfillment.shopifyWritePolicy(simulated, { orderIsTest: true, isDevelopmentStore: false })).toEqual({ allowed: true, notifyCustomer: false, trackingUrls: false });
    expect(fulfillment.shopifyWritePolicy({ platform: "ALIEXPRESS", externalOrderId: "8190" }, { orderIsTest: false, isDevelopmentStore: false })).toEqual({
      allowed: true,
      notifyCustomer: true,
      trackingUrls: true,
    });
  });

  function pendingTracking(purchaseOrder: Record<string, unknown>) {
    return {
      id: "t1",
      purchaseOrderId: "po1",
      number: "DEMO-0000000042",
      carrierName: "Demo carrier",
      carrierCode: "DEMO",
      trackingUrl: "https://global.cainiao.com/detail.htm?mailNoList=LP1",
      notifyCustomer: true,
      purchaseOrder: { id: "po1", orderId: "order1", items: [{ orderLineItemId: "li1" }], trackings: [], ...purchaseOrder },
    };
  }

  it("never creates a fulfilment from simulated tracking on a real order", async () => {
    mocks.prisma.trackingNumber.findMany.mockResolvedValue([
      pendingTracking({ platform: "ALIEXPRESS", externalOrderId: "MOCK-LX1-42", raw: {}, order: { name: "#1001", isTest: false, shopifyOrderId: "gid://shopify/Order/1" } }),
    ]);

    const result = await fulfillment.syncPendingTracking(makeShop(), undefined, {} as never);

    expect(mocks.createFulfillmentWithTracking).not.toHaveBeenCalled();
    expect(mocks.updateFulfillmentTracking).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 0, failed: 0 });
    // Excluded in the query too, so rows that can never sync do not crowd out real ones.
    const where = mocks.prisma.trackingNumber.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain("MOCK-");
    expect(JSON.stringify(where)).toContain("\"isTest\":true");
    // And the merchant can see why.
    expect(mocks.prisma.trackingNumber.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { syncError: expect.stringMatching(/Demo supplier/) } }),
    );
  });

  it("fulfils a test order from the Demo supplier without emailing or linking a carrier", async () => {
    mocks.prisma.trackingNumber.findMany.mockResolvedValue([
      pendingTracking({ platform: "MOCK", externalOrderId: "MOCK-LX1-42", raw: {}, order: { name: "#1001", isTest: true, shopifyOrderId: "gid://shopify/Order/1" } }),
    ]);
    mocks.prisma.orderLineItem.findMany.mockResolvedValue([{ id: "li1", shopifyLineItemId: "gid://shopify/LineItem/1", fulfillableQuantity: 1 }]);
    mocks.createFulfillmentWithTracking.mockResolvedValue({ skipped: false, id: "gid://shopify/Fulfillment/1", fulfilled: { "gid://shopify/LineItem/1": 1 } });

    await fulfillment.syncPendingTracking(makeShop(), undefined, {} as never);

    expect(mocks.createFulfillmentWithTracking).toHaveBeenCalledTimes(1);
    const input = mocks.createFulfillmentWithTracking.mock.calls[0][1];
    expect(input.notifyCustomer).toBe(false);
    expect(input.tracking.urls).toEqual([]);
  });

  it("leaves real tracking exactly as it was", async () => {
    mocks.prisma.trackingNumber.findMany.mockResolvedValue([
      pendingTracking({ platform: "ALIEXPRESS", externalOrderId: "8190000000000000", raw: {}, order: { name: "#1001", isTest: false, shopifyOrderId: "gid://shopify/Order/1" } }),
    ]);
    mocks.prisma.orderLineItem.findMany.mockResolvedValue([{ id: "li1", shopifyLineItemId: "gid://shopify/LineItem/1", fulfillableQuantity: 1 }]);
    mocks.createFulfillmentWithTracking.mockResolvedValue({ skipped: false, id: "gid://shopify/Fulfillment/1", fulfilled: { "gid://shopify/LineItem/1": 1 } });

    await fulfillment.syncPendingTracking(makeShop(), undefined, {} as never);

    const input = mocks.createFulfillmentWithTracking.mock.calls[0][1];
    expect(input.notifyCustomer).toBe(true);
    expect(input.tracking.urls).toHaveLength(1);
  });
});

describe("fulfilment-service routing", () => {
  const APP_LOCATION = "gid://shopify/Location/99";
  const routed = (overrides: Partial<import("~/services/fulfillment.server").RoutedFulfillmentOrder>) => ({
    id: "gid://shopify/FulfillmentOrder/1",
    status: "OPEN",
    requestStatus: "UNSUBMITTED",
    locationId: APP_LOCATION,
    lineItems: [{ lineItemId: "gid://shopify/LineItem/1", remainingQuantity: 1 }],
    ...overrides,
  });

  it("holds back lines at the app's location until their request is accepted", () => {
    for (const requestStatus of ["UNSUBMITTED", "SUBMITTED", "REJECTED", "CANCELLATION_REQUESTED"]) {
      const routing = fulfillment.fulfillmentServiceRouting([routed({ requestStatus, status: requestStatus === "UNSUBMITTED" ? "OPEN" : "IN_PROGRESS" })], APP_LOCATION);
      expect(routing.serviceLineItemIds.has("gid://shopify/LineItem/1")).toBe(true);
      expect(routing.awaitingRequest.has("gid://shopify/LineItem/1")).toBe(true);
    }
    for (const requestStatus of ["ACCEPTED", "CANCELLATION_REJECTED"]) {
      const routing = fulfillment.fulfillmentServiceRouting([routed({ requestStatus, status: "IN_PROGRESS" })], APP_LOCATION);
      expect(routing.serviceLineItemIds.has("gid://shopify/LineItem/1")).toBe(true);
      expect(routing.awaitingRequest.size).toBe(0);
    }
  });

  it("leaves the merchant's own locations, finished fulfilment orders and unregistered shops alone", () => {
    expect(fulfillment.fulfillmentServiceRouting([routed({ locationId: "gid://shopify/Location/1" })], APP_LOCATION).serviceLineItemIds.size).toBe(0);
    expect(fulfillment.fulfillmentServiceRouting([routed({ status: "CLOSED" })], APP_LOCATION).serviceLineItemIds.size).toBe(0);
    expect(fulfillment.fulfillmentServiceRouting([routed({ lineItems: [{ lineItemId: "gid://shopify/LineItem/1", remainingQuantity: 0 }] })], APP_LOCATION).serviceLineItemIds.size).toBe(0);
    expect(fulfillment.fulfillmentServiceRouting([routed({})], null).serviceLineItemIds.size).toBe(0);
  });

  function trackingRow(purchaseOrder: Record<string, unknown>) {
    return {
      id: "t1",
      purchaseOrderId: "po1",
      number: "LP00000000001",
      carrierName: "Cainiao",
      carrierCode: "CAINIAO",
      trackingUrl: null,
      notifyCustomer: true,
      purchaseOrder: { id: "po1", orderId: "order1", items: [{ orderLineItemId: "li1" }], trackings: [], ...purchaseOrder },
    };
  }

  function routingResponse(requestStatus: string, status: string) {
    return {
      order: {
        fulfillmentOrders: {
          nodes: [{ id: "gid://shopify/FulfillmentOrder/1", status, requestStatus, assignedLocation: { location: { id: APP_LOCATION } }, lineItems: { nodes: [{ remainingQuantity: 1, lineItem: { id: "gid://shopify/LineItem/1" } }] } }],
        },
      },
    };
  }

  it("does not fulfil an unrequested fulfilment order at the app's location, and says why", async () => {
    mocks.prisma.trackingNumber.findMany.mockResolvedValue([
      trackingRow({ platform: "ALIEXPRESS", externalOrderId: "8190000000000000", raw: {}, order: { name: "#1001", isTest: false, shopifyOrderId: "gid://shopify/Order/1" } }),
    ]);
    mocks.prisma.orderLineItem.findMany.mockResolvedValue([{ id: "li1", shopifyLineItemId: "gid://shopify/LineItem/1", fulfillableQuantity: 1 }]);
    mocks.gql.mockResolvedValue(routingResponse("UNSUBMITTED", "OPEN"));

    const result = await fulfillment.syncPendingTracking(makeShop({ fulfillmentLocationId: APP_LOCATION }), undefined, {} as never);

    expect(mocks.createFulfillmentWithTracking).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 0, failed: 0 });
    expect(mocks.prisma.trackingNumber.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { syncError: expect.stringMatching(/Request fulfillment/) } }),
    );
  });

  it("fulfils once the request has been accepted", async () => {
    mocks.prisma.trackingNumber.findMany.mockResolvedValue([
      trackingRow({ platform: "ALIEXPRESS", externalOrderId: "8190000000000000", raw: {}, order: { name: "#1001", isTest: false, shopifyOrderId: "gid://shopify/Order/1" } }),
    ]);
    mocks.prisma.orderLineItem.findMany.mockResolvedValue([{ id: "li1", shopifyLineItemId: "gid://shopify/LineItem/1", fulfillableQuantity: 1 }]);
    mocks.gql.mockResolvedValue(routingResponse("ACCEPTED", "IN_PROGRESS"));
    mocks.createFulfillmentWithTracking.mockResolvedValue({ skipped: false, id: "gid://shopify/Fulfillment/1", fulfilled: { "gid://shopify/LineItem/1": 1 } });

    await fulfillment.syncPendingTracking(makeShop({ fulfillmentLocationId: APP_LOCATION }), undefined, {} as never);

    expect(mocks.createFulfillmentWithTracking).toHaveBeenCalledTimes(1);
  });
});

describe("syncPurchaseOrder", () => {
  it("does not poll an order placed from the browser", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", platform: "ALIEXPRESS", externalOrderId: "8190000000000000", status: "AWAITING_PAYMENT", raw: {}, trackings: [], order: {} });
    mocks.placementModeForShop.mockResolvedValue("extension");

    const result = await fulfillment.syncPurchaseOrder(makeShop(), "po1");

    expect(result).toEqual({ changed: false, status: "AWAITING_PAYMENT", newTracking: 0 });
    expect(mocks.adapterForShop).not.toHaveBeenCalled();
  });

  it("does not poll a MOCK- id left on a real platform, even with the API connected", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", platform: "ALIEXPRESS", externalOrderId: "MOCK-LX1-42", status: "PAID", raw: {}, trackings: [], order: {} });
    mocks.placementModeForShop.mockResolvedValue("api");

    await fulfillment.syncPurchaseOrder(makeShop(), "po1");

    expect(mocks.adapterForShop).not.toHaveBeenCalled();
  });
});

describe("extension request guard", () => {
  function request(headers: Record<string, string> = {}, body?: BodyInit) {
    return new Request("https://app.example.com/api/extension/orders", { method: body === undefined ? "GET" : "POST", headers, body });
  }

  it("refuses a malformed token without touching the database", async () => {
    await expect(fulfillment.authenticateExtensionRequest(request({ authorization: "Bearer x" }), { scope: "t", limit: 5 })).rejects.toMatchObject({ status: 401 });
    await expect(fulfillment.authenticateExtensionRequest(request(), { scope: "t", limit: 5 })).rejects.toMatchObject({ status: 401 });
    expect(mocks.prisma.shop.findUnique).not.toHaveBeenCalled();
  });

  it("limits by address before looking a token up, so a flood of bad tokens costs no queries", async () => {
    mocks.prisma.shop.findUnique.mockResolvedValue(null);
    const bad = () => request({ authorization: "Bearer dsh_not_a_real_token_000000", "x-forwarded-for": "203.0.113.9" });
    for (let i = 0; i < 120; i += 1) {
      await expect(fulfillment.authenticateExtensionRequest(bad(), { scope: "t", limit: 1000 })).rejects.toMatchObject({ status: 401 });
    }
    await expect(fulfillment.authenticateExtensionRequest(bad(), { scope: "t", limit: 1000 })).rejects.toMatchObject({ status: 429 });
    expect(mocks.prisma.shop.findUnique).toHaveBeenCalledTimes(120);
  });

  it("limits each shop's token per scope", async () => {
    mocks.prisma.shop.findUnique.mockResolvedValue({ id: "shop1", isActive: true, settings: {} });
    const good = () => request({ authorization: "Bearer dsh_abcdefghijklmnopqrstuvwxyz012345" });
    await expect(fulfillment.authenticateExtensionRequest(good(), { scope: "orders-read", limit: 2 })).resolves.toMatchObject({ id: "shop1" });
    await expect(fulfillment.authenticateExtensionRequest(good(), { scope: "orders-read", limit: 2 })).resolves.toMatchObject({ id: "shop1" });
    await expect(fulfillment.authenticateExtensionRequest(good(), { scope: "orders-read", limit: 2 })).rejects.toMatchObject({ status: 429 });
    expect(() => fulfillment.spendExtensionBudget("shop1", { scope: "capture", limit: 3, cost: 4 })).toThrow(/Too many requests/);
  });

  it("caps the body by declared length and by what actually arrives", async () => {
    await expect(fulfillment.readJsonBody(request({ "content-length": "999999" }, "{}"), 1024)).rejects.toMatchObject({ status: 413 });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"a":"${"x".repeat(4096)}"}`));
        controller.close();
      },
    });
    const chunked = new Request("https://app.example.com/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(fulfillment.readJsonBody(chunked, 1024)).rejects.toMatchObject({ status: 413 });
    await expect(fulfillment.readJsonBody(request({}, "not json"), 1024)).rejects.toMatchObject({ status: 400 });
    await expect(fulfillment.readJsonBody(request({}, '{"ok":1}'), 1024)).resolves.toEqual({ ok: 1 });
  });
});

describe("extension order bodies", () => {
  it("accepts a real report", () => {
    expect(fulfillment.ExtensionPlacedBody.safeParse({ externalOrderIds: ["8190000000000000"], totalCost: "12.40", currency: "USD" }).success).toBe(true);
    expect(fulfillment.ExtensionTrackingBody.safeParse({ number: "LP00123456789CN", carrier: "Cainiao" }).success).toBe(true);
  });

  it("rejects hostile or invented input", () => {
    const placed = fulfillment.ExtensionPlacedBody;
    expect(placed.safeParse({ externalOrderIds: [] }).success).toBe(false);
    expect(placed.safeParse({ externalOrderIds: ["<script>"] }).success).toBe(false);
    expect(placed.safeParse({ externalOrderIds: ["MOCK-LX1-42"] }).success).toBe(false);
    expect(placed.safeParse({ externalOrderIds: Array.from({ length: 21 }, (_, i) => String(i)) }).success).toBe(false);
    expect(placed.safeParse({ externalOrderIds: ["1"], totalCost: "-5" }).success).toBe(false);
    expect(placed.safeParse({ externalOrderIds: ["1"], currency: "usd" }).success).toBe(false);
    expect(placed.safeParse({ externalOrderIds: ["1"], status: "DELIVERED" }).success).toBe(false);
    const tracking = fulfillment.ExtensionTrackingBody;
    expect(tracking.safeParse({ number: "a b c d" }).success).toBe(false);
    expect(tracking.safeParse({ number: "x".repeat(65) }).success).toBe(false);
    expect(tracking.safeParse({ number: "LP001234", url: "https://evil.example" }).success).toBe(false);
  });
});

describe("listAwaitingPlacement", () => {
  it("returns what a supplier checkout needs, and nothing it does not", async () => {
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([
      {
        id: "po1",
        platform: "ALIEXPRESS",
        currency: "USD",
        totalCost: "8.99",
        supplierNote: "No invoice please",
        createdAt: new Date("2026-09-14T10:00:00Z"),
        order: { name: "#1001", shippingAddress: { ...address, email: "jane@example.com" } },
        items: [
          {
            title: "Wireless earbuds",
            quantity: 2,
            externalProductId: "1005006001",
            externalSkuId: "12000031",
            externalSkuAttr: "14:193#Black",
            unitCost: "3.50",
            currency: "USD",
            carrierCode: "CAINIAO_FULFILLMENT_STD",
            carrierName: "AliExpress Standard Shipping",
            supplierVariant: { attributes: [{ name: "Color", value: "Black" }], supplierProduct: { url: "https://www.aliexpress.com/item/1005006001.html" } },
            orderLineItem: { variantTitle: "Black" },
          },
        ],
      },
    ]);

    const [order] = await fulfillment.listAwaitingPlacement(makeShop());

    expect(mocks.prisma.purchaseOrder.findMany.mock.calls[0][0].where).toEqual({ order: { shopId: "shop1", canceledAt: null }, status: "AWAITING_PLACEMENT" });
    expect(order).toMatchObject({ id: "po1", orderName: "#1001", note: "No invoice please", createdAt: "2026-09-14T10:00:00.000Z" });
    expect(order.shippingAddress).toMatchObject({ name: "Jane Doe", firstName: "Jane", lastName: "Doe", phone: "+15125550100", address1: "1 Main St", zip: "78701", countryCode: "US" });
    expect(JSON.stringify(order)).not.toContain("jane@example.com");
    expect(order.items[0]).toEqual({
      title: "Wireless earbuds",
      variantLabel: "Color: Black",
      quantity: 2,
      externalProductId: "1005006001",
      productUrl: "https://www.aliexpress.com/item/1005006001.html",
      externalSkuId: "12000031",
      skuAttr: "14:193#Black",
      unitCost: "3.50",
      currency: "USD",
      carrierCode: "CAINIAO_FULFILLMENT_STD",
      carrierName: "AliExpress Standard Shipping",
    });
  });

  it("prefers Shopify's own first and last name, and the item's carrier over the purchase order's", async () => {
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([
      {
        id: "po2",
        platform: "ALIEXPRESS",
        currency: "USD",
        totalCost: "3.50",
        supplierNote: null,
        carrierCode: "CAINIAO_STANDARD",
        createdAt: new Date("2026-09-14T10:00:00Z"),
        order: { name: "#1002", shippingAddress: { ...address, name: "Mary Ann van Buren", firstName: "Mary Ann", lastName: "van Buren" } },
        items: [
          { title: "A", quantity: 1, externalProductId: "1", externalSkuId: "2", externalSkuAttr: null, unitCost: "1", currency: "USD", carrierCode: "CAINIAO_FULFILLMENT_STD", carrierName: null, supplierVariant: null, orderLineItem: null },
          { title: "B", quantity: 1, externalProductId: "3", externalSkuId: "4", externalSkuAttr: null, unitCost: "1", currency: "USD", carrierCode: null, carrierName: null, supplierVariant: null, orderLineItem: null },
        ],
      },
    ]);
    const [order] = await fulfillment.listAwaitingPlacement(makeShop());
    expect(order.shippingAddress).toMatchObject({ firstName: "Mary Ann", lastName: "van Buren" });
    expect(order.items.map((i) => i.carrierCode)).toEqual(["CAINIAO_FULFILLMENT_STD", "CAINIAO_STANDARD"]);
  });
});

describe("consigneeNames", () => {
  it("splits a full name only when Shopify gave no first or last name", () => {
    expect(fulfillment.consigneeNames({ name: "Jane Doe" })).toEqual({ firstName: "Jane", lastName: "Doe" });
    expect(fulfillment.consigneeNames({ name: "  Mary  Ann   Smith " })).toEqual({ firstName: "Mary Ann", lastName: "Smith" });
    expect(fulfillment.consigneeNames({ name: "Cher" })).toEqual({ firstName: "Cher", lastName: null });
    expect(fulfillment.consigneeNames({ name: "" })).toEqual({ firstName: null, lastName: null });
    expect(fulfillment.consigneeNames({})).toEqual({ firstName: null, lastName: null });
    // One half present is Shopify's answer; guessing the other from `name` would duplicate it.
    expect(fulfillment.consigneeNames({ name: "Jane Doe", lastName: "Doe" })).toEqual({ firstName: null, lastName: "Doe" });
    expect(fulfillment.consigneeNames({ name: "X Y", firstName: " Jane ", lastName: "Doe" })).toEqual({ firstName: "Jane", lastName: "Doe" });
  });
});

describe("markPlacedFromExtension", () => {
  const waiting = {
    id: "po1",
    status: "AWAITING_PLACEMENT",
    platform: "ALIEXPRESS",
    currency: "USD",
    itemsCost: "7.00",
    shippingCost: "1.99",
    totalCost: "8.99",
    externalOrderId: null,
    paymentUrl: null,
    raw: { placementMode: "extension" },
    order: { id: "order1", name: "#1001", shopifyOrderId: "gid://shopify/Order/1" },
  };

  it("is scoped to the token's shop", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po_other_shop", { externalOrderIds: ["8190000000000000"] });
    expect(answer.status).toBe(404);
    expect(mocks.prisma.purchaseOrder.findFirst.mock.calls[0][0].where).toEqual({ id: "po_other_shop", order: { shopId: "shop1" } });
  });

  it("records the order ids, the payment link and the reported total, then re-evaluates", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(waiting);
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000001", "8190000000000002"], totalCost: "12.40", currency: "USD" });

    expect(answer.status).toBe(200);
    const call = mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "po1", status: "AWAITING_PLACEMENT" });
    expect(call.data).toMatchObject({
      status: "AWAITING_PAYMENT",
      externalOrderId: "8190000000000001",
      totalCost: "12.40",
      shippingCost: "5.40",
      paymentUrl: "https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001",
    });
    expect(call.data.placedAt).toBeInstanceOf(Date);
    expect(call.data.raw).toMatchObject({ placementMode: "extension", externalOrderIds: ["8190000000000001", "8190000000000002"], placedBy: "extension" });
    expect(mocks.evaluateAndStoreOrder).toHaveBeenCalledWith(expect.objectContaining({ id: "shop1" }), "order1");
    expect(mocks.addOrderTags).toHaveBeenCalled();
  });

  it("keeps the estimate when the total comes in another currency", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(waiting);
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
    await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000001"], totalCost: "310000", currency: "VND" });
    const { data } = mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(data.totalCost).toBe("8.99");
    expect(data.raw.reportedTotal).toEqual({ amount: "310000", currency: "VND" });
  });

  it("refuses to record an order whose Shopify order was cancelled meanwhile", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...waiting, order: { ...waiting.order, canceledAt: new Date() } });
    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000001"] });
    expect(answer.status).toBe(409);
    expect(mocks.prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("answers the same report twice with success and writes nothing the second time", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...waiting, status: "AWAITING_PAYMENT", externalOrderId: "8190000000000001", raw: { externalOrderIds: ["8190000000000001"] } });
    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000001"] });
    expect(answer).toMatchObject({ status: 200, body: { alreadyRecorded: true } });
    expect(mocks.prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a different id on a purchase order that is already placed", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...waiting, status: "AWAITING_PAYMENT", externalOrderId: "8190000000000001", raw: { externalOrderIds: ["8190000000000001"] } });
    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000009"] });
    expect(answer.status).toBe(409);
    expect(mocks.prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("gives the loser of a race the conflict, not a second write", async () => {
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ ...waiting, status: "AWAITING_PAYMENT", externalOrderId: "8190000000000001", raw: { externalOrderIds: ["8190000000000001"] } });
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 0 });
    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000009"] });
    expect(answer.status).toBe(409);
    expect(mocks.evaluateAndStoreOrder).not.toHaveBeenCalled();
  });
});

describe("addTrackingFromExtension", () => {
  it("refuses tracking for an order that has not been placed", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", status: "AWAITING_PLACEMENT" });
    const answer = await fulfillment.addTrackingFromExtension(makeShop(), "po1", { number: "LP00123456789CN" });
    expect(answer.status).toBe(409);
    expect(mocks.prisma.trackingNumber.upsert).not.toHaveBeenCalled();
  });

  it("goes through the manual tracking path for a placed order", async () => {
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ id: "po1", status: "AWAITING_PAYMENT" })
      .mockResolvedValueOnce({ id: "po1", orderId: "order1", status: "AWAITING_PAYMENT" });
    mocks.prisma.trackingNumber.upsert.mockResolvedValue({ id: "t1", number: "LP00123456789CN" });
    mocks.prisma.trackingNumber.findMany.mockResolvedValue([]);

    const answer = await fulfillment.addTrackingFromExtension(makeShop(), "po1", { number: "LP00123456789CN", carrier: "Cainiao" });

    expect(answer).toMatchObject({ status: 200, body: { ok: true, trackingId: "t1" } });
    expect(mocks.prisma.trackingNumber.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ number: "LP00123456789CN", carrierName: "Cainiao" }) }),
    );
    expect(mocks.prisma.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SHIPPED" }) }));
  });
});

describe("linking a supplier order from the order page", () => {
  const legacySimulated = {
    id: "po1",
    orderId: "order1",
    status: "SHIPPED",
    platform: "ALIEXPRESS",
    externalOrderId: "MOCK-LX1-42",
    raw: { response: { orderId: "MOCK-LX1-42" } },
    order: { name: "#1001", canceledAt: null },
  };

  it("deletes the mock's unsynced tracking in the same transaction, so it can never reach the buyer", async () => {
    // A tiny table stands in for TrackingNumber, so the tracking run after the
    // link sees exactly what the link left behind.
    const rows = [
      { id: "t1", purchaseOrderId: "po1", number: "LP00987654321CN", syncedToShopify: false },
      { id: "t2", purchaseOrderId: "po1", number: "LP00111111111CN", syncedToShopify: true },
    ];
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(legacySimulated);
    mocks.tx.trackingNumber.deleteMany.mockImplementation(async ({ where }: { where: { purchaseOrderId: string; syncedToShopify: boolean } }) => {
      const doomed = rows.filter((r) => r.purchaseOrderId === where.purchaseOrderId && r.syncedToShopify === where.syncedToShopify);
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return { count: doomed.length };
    });
    mocks.tx.purchaseOrder.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...legacySimulated, ...data }));

    const linked = await fulfillment.markPurchaseOrderManual(makeShop(), "po1", "8190000000000077", "merchant@example.com");

    expect(linked).toMatchObject({ discardedTracking: 1, status: "PLACED" });
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.trackingNumber.deleteMany).toHaveBeenCalledWith({ where: { purchaseOrderId: "po1", syncedToShopify: false } });
    const { data } = mocks.tx.purchaseOrder.update.mock.calls[0][0];
    expect(data).toMatchObject({ externalOrderId: "8190000000000077", status: "PLACED" });
    // Nothing depends on the id prefix any more to remember what happened.
    expect(data.raw).toMatchObject({ simulated: false, simulatedHistory: true, discardedSimulatedTracking: 1 });
    // The mock's stored response is shed on the way, not carried forward.
    expect(data.raw.response).toBeUndefined();
    expect(mocks.logActivity).toHaveBeenCalledWith(
      "shop1",
      expect.objectContaining({ message: expect.stringMatching(/1 tracking number\(s\) made up by the Demo supplier were deleted/) }),
    );
    expect(rows.map((r) => r.number)).toEqual(["LP00111111111CN"]);

    // The next tracking run: only unsynced rows are read, and none is left.
    mocks.prisma.trackingNumber.findMany.mockImplementation(async () =>
      rows
        .filter((r) => !r.syncedToShopify)
        .map((r) => ({ ...r, purchaseOrder: { ...legacySimulated, externalOrderId: "8190000000000077", items: [], trackings: [] } })),
    );
    await fulfillment.syncPendingTracking(makeShop(), undefined, {} as never);
    expect(mocks.createFulfillmentWithTracking).not.toHaveBeenCalled();
  });

  it("leaves a real purchase order's tracking alone", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...legacySimulated, externalOrderId: null, status: "FAILED", raw: {} });
    mocks.tx.purchaseOrder.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...legacySimulated, ...data }));

    const linked = await fulfillment.markPurchaseOrderManual(makeShop(), "po1", "8190000000000077");

    expect(linked.discardedTracking).toBe(0);
    expect(mocks.tx.trackingNumber.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.purchaseOrder.update.mock.calls[0][0].data.raw).toBeUndefined();
  });

  it("refuses an invented or malformed order number, and a cancelled order", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(legacySimulated);
    await expect(fulfillment.markPurchaseOrderManual(makeShop(), "po1", "MOCK-LX1-99")).rejects.toThrow(/not a real supplier order number/);
    await expect(fulfillment.markPurchaseOrderManual(makeShop(), "po1", "81900 <b>")).rejects.toThrow(/supplier's order number/);

    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...legacySimulated, order: { name: "#1001", canceledAt: new Date() } });
    await expect(fulfillment.markPurchaseOrderManual(makeShop(), "po1", "8190000000000077")).rejects.toThrow(/cancelled in Shopify/);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("sends a purchase order still waiting for the extension through the extension's own path", async () => {
    const waiting = {
      id: "po1",
      status: "AWAITING_PLACEMENT",
      platform: "ALIEXPRESS",
      currency: "USD",
      itemsCost: "7.00",
      shippingCost: "1.99",
      totalCost: "8.99",
      externalOrderId: null,
      paymentUrl: null,
      raw: { placementMode: "extension" },
      order: { id: "order1", name: "#1001", shopifyOrderId: "gid://shopify/Order/1", canceledAt: null },
    };
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(waiting);
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const linked = await fulfillment.markPurchaseOrderManual(makeShop(), "po1", "8190000000000001", "merchant@example.com");

    expect(linked.status).toBe("AWAITING_PAYMENT");
    const call = mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "po1", status: "AWAITING_PLACEMENT" });
    expect(call.data).toMatchObject({ status: "AWAITING_PAYMENT", paymentUrl: expect.stringContaining("8190000000000001") });
    expect(call.data.paymentDueAt).toBeInstanceOf(Date);
    expect(call.data.raw.placedBy).toBe("order-page");
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ actor: "merchant@example.com", action: "order.placed" }));
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("recording an order the merchant already paid for", () => {
  it("moves it straight to paid, with no payment deadline", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: "po1",
      status: "AWAITING_PLACEMENT",
      platform: "ALIEXPRESS",
      currency: "USD",
      itemsCost: "7.00",
      shippingCost: "1.99",
      totalCost: "8.99",
      externalOrderId: null,
      paymentUrl: null,
      raw: null,
      order: { id: "order1", name: "#1001", shopifyOrderId: "gid://shopify/Order/1", canceledAt: null },
    });
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const answer = await fulfillment.markPlacedFromExtension(makeShop(), "po1", { externalOrderIds: ["8190000000000001"], paid: true });

    expect(answer).toMatchObject({ status: 200, body: { ok: true, status: "PAID" } });
    const { data } = mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ status: "PAID", paymentDueAt: null });
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(data.paymentMarkedAt).toBeInstanceOf(Date);
    // A null raw spreads to nothing rather than breaking the write.
    expect(data.raw).toMatchObject({ externalOrderIds: ["8190000000000001"], placedBy: "extension" });
  });

  it("accepts only a real boolean for paid", () => {
    expect(fulfillment.ExtensionPlacedBody.safeParse({ externalOrderIds: ["8190000000000001"], paid: true }).success).toBe(true);
    expect(fulfillment.ExtensionPlacedBody.safeParse({ externalOrderIds: ["8190000000000001"], paid: "yes" }).success).toBe(false);
  });
});

describe("cancelling a purchase order", () => {
  it("cancels one waiting for the extension locally, without asking any supplier", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", orderId: "order1", status: "AWAITING_PLACEMENT", platform: "ALIEXPRESS", externalOrderId: null, raw: {} });
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await fulfillment.cancelPurchaseOrder(makeShop(), "po1", "Shopify order cancelled", "webhook");

    expect(result).toEqual({ upstream: false, alreadyCanceled: false, neverPlaced: true });
    expect(mocks.adapterForShop).not.toHaveBeenCalled();
    expect(mocks.prisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "po1", status: "AWAITING_PLACEMENT" },
      data: expect.objectContaining({ status: "CANCELED", errorMessage: "Shopify order cancelled" }),
    });
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ message: expect.stringMatching(/Nothing had been ordered/) }));
    expect(mocks.evaluateAndStoreOrder).toHaveBeenCalledWith(expect.anything(), "order1");
  });

  it("does not overwrite an order the extension recorded as placed while the cancel was running", async () => {
    // First read: still waiting. By the write, the merchant has marked it placed and paid.
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ id: "po1", orderId: "order1", status: "AWAITING_PLACEMENT", platform: "ALIEXPRESS", externalOrderId: null, raw: {} })
      .mockResolvedValueOnce({ id: "po1", orderId: "order1", status: "PAID", platform: "ALIEXPRESS", externalOrderId: "8190000000000001", raw: {} });
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    const cancelOrder = vi.fn().mockResolvedValue(false);
    mocks.adapterForShop.mockResolvedValue({ adapter: { platform: "ALIEXPRESS", cancelOrder }, account: null });

    const result = await fulfillment.cancelPurchaseOrder(makeShop(), "po1", "Shopify order cancelled", "webhook");

    // It took the placed-order path the second time round, so the merchant is
    // told the supplier order exists rather than that nothing was ordered.
    expect(result.neverPlaced).toBe(false);
    expect(mocks.logActivity).not.toHaveBeenCalledWith("shop1", expect.objectContaining({ message: expect.stringMatching(/Nothing had been ordered/) }));
  });

  it("does not ask the supplier even if an id was somehow stored before placement", async () => {
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", orderId: "order1", status: "AWAITING_PLACEMENT", platform: "ALIEXPRESS", externalOrderId: "8190000000000001", raw: {} });
    await fulfillment.cancelPurchaseOrder(makeShop(), "po1");
    expect(mocks.adapterForShop).not.toHaveBeenCalled();
  });

  it("asks the supplier for a placed one", async () => {
    const cancelOrder = vi.fn().mockResolvedValue(true);
    mocks.adapterForShop.mockResolvedValue({ adapter: { platform: "ALIEXPRESS", cancelOrder }, account: null });
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", orderId: "order1", status: "AWAITING_PAYMENT", platform: "ALIEXPRESS", externalOrderId: "8190000000000001", raw: {} });
    const result = await fulfillment.cancelPurchaseOrder(makeShop(), "po1", "changed mind");
    expect(cancelOrder).toHaveBeenCalledWith("8190000000000001", "changed mind");
    expect(result.upstream).toBe(true);
  });

  it("leaves an already cancelled one untouched when the webhook repeats", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ id: "po1", orderId: "order1", status: "CANCELED", platform: "ALIEXPRESS", externalOrderId: null, raw: {} });
    const result = await fulfillment.cancelPurchaseOrder(makeShop(), "po1");
    expect(result.alreadyCanceled).toBe(true);
    expect(mocks.prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });
});

describe("what the extension and the banners count", () => {
  it("re-exports the extension wording from the supplier registry, where it is pinned", () => {
    // The exact words are asserted against the real registry in suppliers.test.ts.
    expect(fulfillment.EXTENSION_PLACEMENT_STEPS).toBe("(extension steps)");
  });

  const WAITING_WHERE = { where: { order: { shopId: "shop1", canceledAt: null }, status: "AWAITING_PLACEMENT" } };

  it("leaves purchase orders on cancelled Shopify orders out of the waiting count", async () => {
    mocks.prisma.purchaseOrder.count.mockResolvedValue(2);
    await fulfillment.countAwaitingPlacement("shop1");
    expect(mocks.prisma.purchaseOrder.count).toHaveBeenCalledWith(WAITING_WHERE);
  });

  it("counts the payment page's banner with the same rule", async () => {
    const payments = await import("~/services/payments.server");
    mocks.prisma.purchaseOrder.groupBy.mockResolvedValue([]);
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    mocks.prisma.purchaseOrder.count.mockResolvedValue(1);
    const queue = await payments.getPaymentQueue("shop1");
    expect(queue.awaitingPlacement).toBe(1);
    expect(mocks.prisma.purchaseOrder.count).toHaveBeenCalledWith(WAITING_WHERE);
  });

  it("offers tracking only for placed, real, untracked purchase orders on live orders", async () => {
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([
      {
        id: "po9",
        platform: "ALIEXPRESS",
        status: "PAID",
        externalOrderId: "8190000000000001",
        raw: { externalOrderIds: ["8190000000000001", "8190000000000002"] },
        placedAt: new Date("2026-09-14T08:00:00Z"),
        order: { name: "#1009" },
      },
    ]);

    const list = await fulfillment.listAwaitingTracking(makeShop());

    expect(mocks.prisma.purchaseOrder.findMany.mock.calls[0][0].where).toEqual({
      order: { shopId: "shop1", canceledAt: null },
      status: { in: ["PLACED", "AWAITING_PAYMENT", "PAID"] },
      externalOrderId: { not: null },
      trackings: { none: {} },
      NOT: { OR: [{ platform: "MOCK" }, { externalOrderId: { startsWith: "MOCK-" } }] },
    });
    expect(list).toEqual([
      { id: "po9", orderName: "#1009", platform: "ALIEXPRESS", status: "PAID", externalOrderIds: ["8190000000000001", "8190000000000002"], placedAt: "2026-09-14T08:00:00.000Z" },
    ]);
  });

  it("names the purchase orders still waiting for the extension when placement finds nothing new", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow({ purchaseOrders: [{ id: "po1", status: "AWAITING_PLACEMENT" }] }));
    mocks.prisma.purchaseOrderItem.findMany.mockResolvedValue([
      { orderLineItemId: "li1", supplierVariantId: "sv1", purchaseOrder: { status: "AWAITING_PLACEMENT", createdAt: new Date(), errorCode: null } },
    ]);

    const outcome = await fulfillment.placeSupplierOrders(makeShop(), "order1");

    expect(outcome).toMatchObject({ ok: true, purchaseOrderIds: ["po1"], awaitingPlacementIds: ["po1"] });
  });
});

describe("what a purchase order keeps of the supplier's answers", () => {
  const upstreamAnswer = {
    externalOrderId: "8190000000000055",
    status: "AWAITING_PAYMENT",
    itemsCost: "7.00",
    shippingCost: "1.99",
    totalCost: "8.99",
    currency: "USD",
    paymentUrl: null,
    raw: { receiver: { name: "Jane Doe", phone: "+15125550100", address: "1 Main St" } },
  };

  it("stores the order ids from an API placement, not the response that echoes the buyer's address", async () => {
    mocks.placementModeForShop.mockResolvedValue("api");
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow());
    mocks.placeOrder.mockResolvedValue(upstreamAnswer);

    await fulfillment.placeSupplierOrders(makeShop(), "order1");

    const placed = mocks.prisma.purchaseOrder.update.mock.calls.map((call) => call[0].data).find((data) => data.externalOrderId);
    expect(placed.raw).toEqual({ shippingReason: "Cheapest tracked option.", placementMode: "api", simulated: false, externalOrderIds: ["8190000000000055"] });
    expect(JSON.stringify(placed.raw)).not.toContain("Jane");
  });

  it("does not hand the customer's email to the supplier", async () => {
    mocks.placementModeForShop.mockResolvedValue("api");
    mocks.prisma.order.findUnique.mockResolvedValue(orderRow());
    mocks.placeOrder.mockResolvedValue(upstreamAnswer);

    await fulfillment.placeSupplierOrders(makeShop(), "order1");

    const payload = mocks.placeOrder.mock.calls[0][0];
    expect(payload.address.email).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("jane@example.com");
    expect(payload.address).toMatchObject({ name: "Jane Doe", address1: "1 Main St", countryCode: "US" });
  });

  it("drops the status response on a sync, along with what older versions stored", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: "po1",
      platform: "ALIEXPRESS",
      externalOrderId: "8190000000000055",
      status: "AWAITING_PAYMENT",
      itemsCost: "7.00",
      shippingCost: "1.99",
      currency: "USD",
      paymentUrl: null,
      paidAt: null,
      shippedAt: null,
      canceledAt: null,
      raw: { externalOrderIds: ["8190000000000055"], placementMode: "api", response: { receiver: "Jane Doe" }, lastStatus: { receiver: "Jane Doe" } },
      trackings: [],
      order: {},
    });
    mocks.placementModeForShop.mockResolvedValue("api");
    const getOrder = vi.fn().mockResolvedValue({ status: "AWAITING_PAYMENT", raw: { receiver: "Jane Doe" } });
    mocks.adapterForShop.mockResolvedValue({ adapter: { platform: "ALIEXPRESS", getOrder }, account: null });

    await fulfillment.syncPurchaseOrder(makeShop(), "po1");

    expect(mocks.prisma.purchaseOrder.update.mock.calls[0][0].data.raw).toEqual({ externalOrderIds: ["8190000000000055"], placementMode: "api" });
  });

  it("keeps exactly the keys something reads back", () => {
    expect(
      fulfillment.purchaseOrderRawReadBack({
        externalOrderIds: ["1"],
        shippingReason: "r",
        placementMode: "extension",
        simulated: true,
        simulatedHistory: true,
        discardedSimulatedTracking: 2,
        placedBy: "extension",
        reportedTotal: { amount: "1", currency: "USD" },
        paymentUrl: "https://example.com/pay",
        response: { name: "Ada" },
        lastStatus: {},
      }),
    ).toEqual({
      externalOrderIds: ["1"],
      shippingReason: "r",
      placementMode: "extension",
      simulated: true,
      simulatedHistory: true,
      discardedSimulatedTracking: 2,
      placedBy: "extension",
      reportedTotal: { amount: "1", currency: "USD" },
      paymentUrl: "https://example.com/pay",
    });
    expect(fulfillment.purchaseOrderRawReadBack(null)).toEqual({});
    expect(fulfillment.purchaseOrderRawReadBack(["x"])).toEqual({});
  });
});

describe("recording who opened an order", () => {
  const now = new Date("2026-09-14T12:00:00Z");

  it("logs the first view by a person, scoped to that person, order and the last hour", async () => {
    mocks.prisma.activityLog.findFirst.mockResolvedValue(null);

    const written = await fulfillment.recordOrderView("shop1", { id: "order1", name: "#1001" }, "staff@example.com", now);

    expect(written).toBe(true);
    expect(mocks.prisma.activityLog.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: "shop1",
        action: "order.viewed",
        entity: "Order",
        entityId: "order1",
        actor: "staff@example.com",
        createdAt: { gte: new Date("2026-09-14T11:00:00Z") },
      },
      select: { id: true },
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(
      "shop1",
      expect.objectContaining({ actor: "staff@example.com", action: "order.viewed", entity: "Order", entityId: "order1" }),
    );
  });

  it("writes nothing when the same person opened it within the hour", async () => {
    mocks.prisma.activityLog.findFirst.mockResolvedValue({ id: "a1" });

    const written = await fulfillment.recordOrderView("shop1", { id: "order1", name: "#1001" }, "staff@example.com", now);

    expect(written).toBe(false);
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("never stops the page loading when the log cannot be read", async () => {
    mocks.prisma.activityLog.findFirst.mockRejectedValue(new Error("connection reset"));

    await expect(fulfillment.recordOrderView("shop1", { id: "order1", name: "#1001" }, "staff@example.com", now)).resolves.toBe(false);
  });
});

describe("the payment queue, one page at a time", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const BASE = { order: { shopId: "shop1" }, status: { in: ["PLACED", "AWAITING_PAYMENT"] }, paymentMarkedAt: null };

  function queueRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `po${i}`,
      platform: "ALIEXPRESS",
      externalOrderId: `81900000000000${i}`,
      status: "AWAITING_PAYMENT",
      itemsCost: "7.00",
      shippingCost: "1.99",
      totalCost: "8.99",
      currency: "USD",
      placedAt: now,
      paymentDueAt: new Date(now.getTime() - 3_600_000),
      paymentUrl: null,
      order: { id: `order${i}`, name: `#10${i}`, shopifyCreatedAt: now, customerName: "Jane", customerEmail: null, countryCode: "US" },
      supplierAccount: null,
      _count: { items: 1 },
    }));
  }

  beforeEach(() => {
    mocks.prisma.purchaseOrder.groupBy.mockImplementation(async ({ by }: { by: string[] }) => {
      if (by[0] === "status") return [{ status: "AWAITING_PAYMENT", _count: { _all: 120 } }, { status: "PLACED", _count: { _all: 5 } }];
      if (by[0] === "currency") return [{ currency: "USD", _sum: { totalCost: "1123.75" }, _count: { _all: 125 } }];
      return [{ platform: "ALIEXPRESS", _count: { _all: 125 } }];
    });
    mocks.prisma.purchaseOrder.count.mockResolvedValue(3);
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ placedAt: now, order: { name: "#1001", shopifyCreatedAt: now } });
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue(queueRows(2));
  });

  it("reads one page of the selected tab in the database", async () => {
    const payments = await import("~/services/payments.server");

    const queue = await payments.getPaymentQueue("shop1", now, { tab: "AWAITING_PAYMENT", page: 2, pageSize: 50 });

    const query = mocks.prisma.purchaseOrder.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ ...BASE, status: "AWAITING_PAYMENT" });
    expect(query.skip).toBe(50);
    expect(query.take).toBe(50);
    expect(query.orderBy).toEqual([{ paymentDueAt: "asc" }, { placedAt: "asc" }, { id: "asc" }]);
    expect(queue).toMatchObject({ tab: "AWAITING_PAYMENT", page: 2, pageSize: 50, total: 120, count: 125 });
  });

  it("works out the figures over the whole queue, not the page on screen", async () => {
    const payments = await import("~/services/payments.server");

    const queue = await payments.getPaymentQueue("shop1", now, { page: 1, pageSize: 2 });

    expect(queue.items).toHaveLength(2);
    expect(queue.tabCounts).toEqual({ all: 125, AWAITING_PAYMENT: 120, PLACED: 5, overdue: 3 });
    expect(queue.totals).toEqual([{ currency: "USD", amount: "1123.75", count: 125 }]);
    expect(queue.byPlatform).toEqual([{ platform: "ALIEXPRESS", count: 125, bulkUrl: expect.any(String) }]);
    expect(queue.oldest).toEqual({ orderName: "#1001", at: now });
    const counted = mocks.prisma.purchaseOrder.count.mock.calls.map((call) => call[0].where);
    expect(counted).toContainEqual({ ...BASE, paymentDueAt: { lte: now } });
    expect(counted).toContainEqual({ ...BASE, paymentDueAt: { gt: now, lte: new Date("2026-09-14T18:00:00Z") } });
    expect(counted).toContainEqual({ ...BASE, paymentDueAt: { not: null } });
  });

  it("shows the last page instead of an empty one when the page asked for is past the end", async () => {
    const payments = await import("~/services/payments.server");

    const queue = await payments.getPaymentQueue("shop1", now, { tab: "PLACED", page: 9, pageSize: 50 });

    expect(queue.page).toBe(1);
    expect(mocks.prisma.purchaseOrder.findMany.mock.calls[0][0].skip).toBe(0);
  });

  it("filters the overdue tab by the deadline and ignores an unknown tab name", async () => {
    const payments = await import("~/services/payments.server");
    expect(payments.paymentTabWhere("shop1", "overdue", now)).toEqual({ ...BASE, paymentDueAt: { lte: now } });
    expect(payments.paymentTab("DELIVERED")).toBe("all");
    expect(payments.paymentTab("overdue")).toBe("overdue");
  });

  it("asks for no rows at all when the queue is empty", async () => {
    const payments = await import("~/services/payments.server");
    mocks.prisma.purchaseOrder.groupBy.mockResolvedValue([]);

    const queue = await payments.getPaymentQueue("shop1", now);

    expect(queue).toMatchObject({ items: [], count: 0, total: 0, page: 1 });
    expect(mocks.prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
  });
});
