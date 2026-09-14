/**
 * The app as a Shopify fulfilment service: when it answers a request, how, and
 * what happens to a request nobody decides on.
 *
 * Shopify, the database and supplier placement are stubbed, so these assert the
 * calls the app would make. The rule under test is Shopify's own: a request is
 * rejected only while SUBMITTED, an accepted one can only be closed, and every
 * request must be answered within a day.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseShopSettings } from "~/domain/settings/shop-settings";
import type { ShopWithSettings } from "~/services/shop.server";

const mocks = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      order: { findUnique: fn() },
      fulfillmentRequest: { findUnique: fn(), findFirst: fn(), findMany: fn(), upsert: fn(), update: fn(), updateMany: fn() },
      purchaseOrder: { findMany: fn() },
      trackingNumber: { count: fn() },
    },
    gql: fn(),
    offlineClient: fn(),
    logActivity: fn(),
    notify: fn(),
    placeSupplierOrders: fn(),
    quoteSupplierOrders: fn(),
    cancelPurchaseOrder: fn(),
    evaluateAndStoreOrder: fn(),
    orderIssues: fn(),
    refreshOrderFromShopify: fn(),
    acceptFulfillmentRequest: fn(),
    rejectFulfillmentRequest: fn(),
    acceptCancellationRequest: fn(),
    rejectCancellationRequest: fn(),
  };
});

vi.mock("~/db.server", () => ({ default: mocks.prisma }));
vi.mock("~/lib/env.server", () => ({ env: () => ({ SHOPIFY_APP_URL: "https://app.example.com", SHOPIFY_API_SECRET: "secret" }) }));
vi.mock("~/services/activity.server", () => ({ logActivity: mocks.logActivity }));
vi.mock("~/services/notifications.server", () => ({ notify: mocks.notify }));
vi.mock("~/services/fulfillment.server", () => ({
  placeSupplierOrders: mocks.placeSupplierOrders,
  quoteSupplierOrders: mocks.quoteSupplierOrders,
  cancelPurchaseOrder: mocks.cancelPurchaseOrder,
}));
vi.mock("~/services/orders.server", () => ({
  evaluateAndStoreOrder: mocks.evaluateAndStoreOrder,
  orderIssues: mocks.orderIssues,
  refreshOrderFromShopify: mocks.refreshOrderFromShopify,
}));
vi.mock("~/services/shopify/graphql.server", () => ({
  gql: mocks.gql,
  offlineClient: mocks.offlineClient,
  gid: (type: string, id: string | number) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`),
  assertNoUserErrors: (errors: Array<{ message: string }> | null | undefined, context: string) => {
    if (errors?.length) throw new Error(`${context}: ${errors.map((e) => e.message).join("; ")}`);
  },
}));
vi.mock("~/services/shopify/fulfillment-service.server", () => ({
  acceptFulfillmentRequest: mocks.acceptFulfillmentRequest,
  rejectFulfillmentRequest: mocks.rejectFulfillmentRequest,
  acceptCancellationRequest: mocks.acceptCancellationRequest,
  rejectCancellationRequest: mocks.rejectCancellationRequest,
  assignVariantToLocation: vi.fn(),
  createFulfillmentService: vi.fn(),
  deleteFulfillmentService: vi.fn(),
  inventoryLevelsFor: vi.fn(),
  listFulfillmentServices: vi.fn(),
  updateFulfillmentServiceCallback: vi.fn(),
}));

const service = await import("~/services/fulfillment-service.server");

const APP_LOCATION = "gid://shopify/Location/99";
const FO_ID = "gid://shopify/FulfillmentOrder/7";

function makeShop(orders: Record<string, unknown> = {}): ShopWithSettings {
  return {
    id: "shop1",
    domain: "real-store.myshopify.com",
    isActive: true,
    fulfillmentLocationId: APP_LOCATION,
    parsedSettings: parseShopSettings({ orders }),
  } as unknown as ShopWithSettings;
}

function rawFulfillmentOrder(requestStatus: string, status = requestStatus === "ACCEPTED" ? "IN_PROGRESS" : "OPEN") {
  return {
    id: FO_ID,
    status,
    requestStatus,
    orderId: "gid://shopify/Order/1",
    assignedLocation: { location: { id: APP_LOCATION } },
    lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", totalQuantity: 2, lineItem: { id: "gid://shopify/LineItem/1" } }] },
    merchantRequests: { nodes: [{ message: "Fragile", kind: "FULFILLMENT_REQUEST", sentAt: "2026-09-14T08:00:00Z" }] },
  };
}

/** Answer each Admin API operation the service sends by its operation name. */
function shopifyAnswers(options: { live?: ReturnType<typeof rawFulfillmentOrder> | null; submitted?: ReturnType<typeof rawFulfillmentOrder>[] } = {}) {
  mocks.gql.mockImplementation(async (_client: unknown, query: string, variables: Record<string, unknown>) => {
    if (query.includes("DropshipFulfillmentOrderForRequest")) return { fulfillmentOrder: options.live ?? null };
    if (query.includes("DropshipAssignedFulfillmentOrders")) {
      const nodes = variables.status === "FULFILLMENT_REQUESTED" ? (options.submitted ?? []) : [];
      return { assignedFulfillmentOrders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    if (query.includes("DropshipCloseFulfillmentOrder")) return { fulfillmentOrderClose: { userErrors: [] } };
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  });
}

const closeCalls = () => mocks.gql.mock.calls.filter(([, query]) => String(query).includes("DropshipCloseFulfillmentOrder"));

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req1",
    orderId: "order1",
    shopifyFulfillmentOrderId: FO_ID,
    status: "AWAITING_APPROVAL",
    requestedAt: new Date(),
    order: { id: "order1", name: "#1001" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.offlineClient.mockResolvedValue({});
  mocks.prisma.order.findUnique.mockResolvedValue({ id: "order1", name: "#1001" });
  mocks.prisma.fulfillmentRequest.findUnique.mockResolvedValue(null);
  mocks.prisma.fulfillmentRequest.upsert.mockImplementation(async () => requestRow({ status: "SUBMITTED" }));
  mocks.prisma.fulfillmentRequest.update.mockResolvedValue({});
  mocks.prisma.fulfillmentRequest.findMany.mockResolvedValue([]);
  mocks.evaluateAndStoreOrder.mockResolvedValue({});
  mocks.orderIssues.mockReturnValue([]);
  mocks.quoteSupplierOrders.mockResolvedValue({ currency: "USD", itemsCost: "7.00", shippingCost: "1.00", totalCost: "8.00", lines: [], unpriced: [], quotedAt: "" });
  mocks.placeSupplierOrders.mockResolvedValue({ orderId: "order1", ok: true, purchaseOrderIds: ["po1"] });
});

describe("reading Shopify's notifications", () => {
  it("finds the fulfilment order in both webhook shapes", () => {
    expect(service.fulfillmentOrderIdFromPayload({ submitted_fulfillment_order: { id: FO_ID }, original_fulfillment_order: { id: FO_ID } })).toBe(FO_ID);
    expect(service.fulfillmentOrderIdFromPayload({ fulfillment_order: { id: 7 } })).toBe(FO_ID);
    expect(service.fulfillmentOrderIdFromPayload({ kind: "FULFILLMENT_REQUEST" })).toBeNull();
  });

  it("accepts only a body signed with the app's secret", () => {
    const body = JSON.stringify({ kind: "FULFILLMENT_REQUEST" });
    const signature = createHmac("sha256", "secret").update(body).digest("base64");
    expect(service.verifyShopifyHmac(body, signature, "secret")).toBe(true);
    expect(service.verifyShopifyHmac(body, signature, "other")).toBe(false);
    expect(service.verifyShopifyHmac(`${body} `, signature, "secret")).toBe(false);
    expect(service.verifyShopifyHmac(body, null, "secret")).toBe(false);
    // An unset secret must never make every signature "valid".
    expect(service.verifyShopifyHmac(body, createHmac("sha256", "").update(body).digest("base64"), "")).toBe(false);
  });
});

describe("a new fulfilment request", () => {
  it("with approval on, prices it and leaves Shopify unanswered", async () => {
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });

    await service.handleFulfillmentRequest(makeShop(), "FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED", { submitted_fulfillment_order: { id: FO_ID } });

    expect(mocks.quoteSupplierOrders).toHaveBeenCalledWith(expect.anything(), "order1", { shopifyLineItemIds: ["gid://shopify/LineItem/1"] });
    expect(mocks.prisma.fulfillmentRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "AWAITING_APPROVAL" }) }));
    expect(mocks.acceptFulfillmentRequest).not.toHaveBeenCalled();
    expect(mocks.rejectFulfillmentRequest).not.toHaveBeenCalled();
    expect(mocks.placeSupplierOrders).not.toHaveBeenCalled();
    // The note typed in Shopify's dialog is kept, read from the fulfilment order.
    expect(mocks.prisma.fulfillmentRequest.upsert.mock.calls[0][0].create.requestMessage).toBe("Fragile");
  });

  it("with approval off, places the supplier order and only then accepts", async () => {
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });

    await service.handleFulfillmentRequest(makeShop({ requireApprovalOnFulfillmentRequest: false }), "T", { submitted_fulfillment_order: { id: FO_ID } });

    expect(mocks.placeSupplierOrders).toHaveBeenCalledWith(expect.anything(), "order1", expect.objectContaining({ shopifyLineItemIds: ["gid://shopify/LineItem/1"] }));
    expect(mocks.acceptFulfillmentRequest).toHaveBeenCalledWith(expect.anything(), FO_ID, expect.any(String));
    expect(mocks.placeSupplierOrders.mock.invocationCallOrder[0]).toBeLessThan(mocks.acceptFulfillmentRequest.mock.invocationCallOrder[0]);
    expect(mocks.prisma.fulfillmentRequest.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED" }) }));
  });

  it("with approval off, holds a request whose placement failed instead of accepting it", async () => {
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });
    mocks.placeSupplierOrders.mockResolvedValue({ orderId: "order1", ok: false, purchaseOrderIds: [], error: "Supplier timed out" });

    await service.handleFulfillmentRequest(makeShop({ requireApprovalOnFulfillmentRequest: false }), "T", { submitted_fulfillment_order: { id: FO_ID } });

    expect(mocks.acceptFulfillmentRequest).not.toHaveBeenCalled();
    expect(mocks.rejectFulfillmentRequest).not.toHaveBeenCalled();
    expect(mocks.prisma.fulfillmentRequest.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: "AWAITING_APPROVAL", quoteError: "Supplier timed out" } }),
    );
  });

  it("rejects while it is still SUBMITTED when the order cannot be fulfilled", async () => {
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });
    mocks.orderIssues.mockReturnValue([{ code: "OUT_OF_STOCK", severity: "error", message: "Out of stock at the supplier" }]);

    await service.handleFulfillmentRequest(makeShop(), "T", { submitted_fulfillment_order: { id: FO_ID } });

    expect(mocks.rejectFulfillmentRequest).toHaveBeenCalledWith(expect.anything(), FO_ID, expect.stringMatching(/Out of stock/), "INVENTORY_OUT_OF_STOCK");
    expect(mocks.quoteSupplierOrders).not.toHaveBeenCalled();
  });

  it("does nothing for a request already waiting on the merchant, or one Shopify no longer holds", async () => {
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });
    mocks.prisma.fulfillmentRequest.findUnique.mockResolvedValue(requestRow());
    await service.handleFulfillmentRequest(makeShop(), "T", { submitted_fulfillment_order: { id: FO_ID } });
    expect(mocks.prisma.fulfillmentRequest.upsert).not.toHaveBeenCalled();

    mocks.prisma.order.findUnique.mockClear();
    shopifyAnswers({ live: rawFulfillmentOrder("ACCEPTED") });
    await service.handleFulfillmentRequest(makeShop(), "T", { submitted_fulfillment_order: { id: FO_ID } });
    expect(mocks.prisma.order.findUnique).not.toHaveBeenCalled();
  });
});

describe("the merchant's decision", () => {
  it("approving places the order and accepts the request", async () => {
    mocks.prisma.fulfillmentRequest.findFirst.mockResolvedValue(requestRow());
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });

    const outcome = await service.approveFulfillmentRequest(makeShop(), "req1", "merchant@example.com");

    expect(outcome.ok).toBe(true);
    expect(mocks.acceptFulfillmentRequest).toHaveBeenCalledWith(expect.anything(), FO_ID, expect.any(String));
  });

  it("approving a request the merchant withdrew in Shopify orders nothing", async () => {
    mocks.prisma.fulfillmentRequest.findFirst.mockResolvedValue(requestRow());
    shopifyAnswers({ live: rawFulfillmentOrder("UNSUBMITTED") });

    const outcome = await service.approveFulfillmentRequest(makeShop(), "req1");

    expect(outcome.ok).toBe(false);
    expect(mocks.placeSupplierOrders).not.toHaveBeenCalled();
    expect(mocks.prisma.fulfillmentRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CLOSED" }) }));
  });

  it("declining a SUBMITTED request rejects it", async () => {
    mocks.prisma.fulfillmentRequest.findFirst.mockResolvedValue(requestRow());
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED") });

    const outcome = await service.declineFulfillmentRequest(makeShop(), "req1", "Changed my mind");

    expect(outcome.ok).toBe(true);
    expect(mocks.rejectFulfillmentRequest).toHaveBeenCalledWith(expect.anything(), FO_ID, "Changed my mind", "OTHER");
    expect(closeCalls()).toHaveLength(0);
  });

  it("declining a request the old flow already accepted closes it, since Shopify refuses to reject it", async () => {
    mocks.prisma.fulfillmentRequest.findFirst.mockResolvedValue(requestRow());
    shopifyAnswers({ live: rawFulfillmentOrder("ACCEPTED") });

    const outcome = await service.declineFulfillmentRequest(makeShop(), "req1", "");

    expect(outcome.ok).toBe(true);
    expect(mocks.rejectFulfillmentRequest).not.toHaveBeenCalled();
    expect(closeCalls()).toHaveLength(1);
    expect(closeCalls()[0][2]).toEqual({ id: FO_ID, message: "The merchant declined this fulfilment." });
  });

  it("approving a request the old flow already accepted does not accept it twice", async () => {
    mocks.prisma.fulfillmentRequest.findFirst.mockResolvedValue(requestRow());
    shopifyAnswers({ live: rawFulfillmentOrder("ACCEPTED") });

    const outcome = await service.approveFulfillmentRequest(makeShop(), "req1");

    expect(outcome.ok).toBe(true);
    expect(mocks.placeSupplierOrders).toHaveBeenCalled();
    expect(mocks.acceptFulfillmentRequest).not.toHaveBeenCalled();
  });
});

describe("reconcileFulfillmentRequests", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("does nothing for a shop that never registered the service", async () => {
    const shop = { ...makeShop(), fulfillmentLocationId: null } as ShopWithSettings;
    expect(await service.reconcileFulfillmentRequests(shop, { now })).toMatchObject({ skipped: "not registered" });
    expect(mocks.gql).not.toHaveBeenCalled();
  });

  it("picks up a submitted request no webhook delivered", async () => {
    shopifyAnswers({ submitted: [rawFulfillmentOrder("SUBMITTED")] });

    const result = await service.reconcileFulfillmentRequests(makeShop(), { now, client: {} as never });

    expect(result.processed).toBe(1);
    expect(mocks.prisma.fulfillmentRequest.upsert).toHaveBeenCalled();
  });

  it("declines a request nobody approved inside the window, before Shopify's day is up", async () => {
    expect(service.APPROVAL_WINDOW_MS).toBeLessThan(24 * 3_600_000);
    // Still listed by Shopify as submitted, and already waiting on the
    // merchant, so only the deadline acts on it.
    shopifyAnswers({ live: rawFulfillmentOrder("SUBMITTED"), submitted: [rawFulfillmentOrder("SUBMITTED")] });
    mocks.prisma.fulfillmentRequest.findUnique.mockResolvedValue(requestRow({ requestedAt: hoursAgo(21) }));
    mocks.prisma.fulfillmentRequest.findMany.mockResolvedValue([requestRow({ requestedAt: hoursAgo(21) })]);

    const result = await service.reconcileFulfillmentRequests(makeShop(), { now, client: {} as never });

    expect(result.expired).toBe(1);
    expect(mocks.rejectFulfillmentRequest).toHaveBeenCalledWith(expect.anything(), FO_ID, expect.stringMatching(/in time/), "OTHER");
    expect(mocks.notify).toHaveBeenCalledWith("shop1", expect.objectContaining({ title: expect.stringMatching(/declined automatically/) }));
  });

  it("reminds about a request waiting half a day, and forgets one withdrawn in Shopify", async () => {
    shopifyAnswers({ submitted: [rawFulfillmentOrder("SUBMITTED")] });
    mocks.prisma.fulfillmentRequest.findUnique.mockResolvedValue(requestRow({ requestedAt: hoursAgo(13) }));
    mocks.prisma.fulfillmentRequest.findMany.mockResolvedValue([
      requestRow({ requestedAt: hoursAgo(13) }),
      requestRow({ id: "req2", shopifyFulfillmentOrderId: "gid://shopify/FulfillmentOrder/8", requestedAt: hoursAgo(2) }),
    ]);

    const result = await service.reconcileFulfillmentRequests(makeShop(), { now, client: {} as never });

    expect(result.reminded).toBe(1);
    expect(result.withdrawn).toBe(1);
    expect(mocks.prisma.fulfillmentRequest.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "req2" }, data: expect.objectContaining({ status: "CLOSED" }) }));
    expect(mocks.rejectFulfillmentRequest).not.toHaveBeenCalled();
  });
});
