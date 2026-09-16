import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-attaching to a fulfilment service registered by an earlier version.
 *
 * The app used to register with trackingSupport:true without implementing
 * fetch_tracking_numbers. New registrations say false, but an existing one only
 * changed when its callback URL moved, so a store that registered early kept
 * the false claim for good.
 */
const mocks = vi.hoisted(() => ({
  shopUpdate: vi.fn(),
  listFulfillmentServices: vi.fn(),
  updateFulfillmentServiceCallback: vi.fn(),
  createFulfillmentService: vi.fn(),
}));

vi.mock("~/db.server", () => ({ default: { shop: { update: mocks.shopUpdate } } }));
vi.mock("~/lib/env.server", () => ({ env: () => ({ SHOPIFY_APP_URL: "https://app.example.com", SHOPIFY_API_SECRET: "secret" }) }));
vi.mock("~/lib/logger.server", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("~/services/activity.server", () => ({ logActivity: vi.fn() }));
vi.mock("~/services/notifications.server", () => ({ notify: vi.fn() }));
vi.mock("~/services/fulfillment.server", () => ({ placeSupplierOrders: vi.fn(), quoteSupplierOrders: vi.fn(), cancelPurchaseOrder: vi.fn() }));
vi.mock("~/services/orders.server", () => ({ evaluateAndStoreOrder: vi.fn(), orderIssues: vi.fn(), refreshOrderFromShopify: vi.fn() }));
vi.mock("~/services/shopify/graphql.server", () => ({ assertNoUserErrors: vi.fn(), gid: (t: string, id: string) => `gid://shopify/${t}/${id}`, gql: vi.fn(), offlineClient: vi.fn() }));
vi.mock("~/services/shopify/fulfillment-service.server", () => ({
  acceptFulfillmentRequest: vi.fn(),
  rejectFulfillmentRequest: vi.fn(),
  acceptCancellationRequest: vi.fn(),
  rejectCancellationRequest: vi.fn(),
  assignVariantToLocation: vi.fn(),
  createFulfillmentService: mocks.createFulfillmentService,
  deleteFulfillmentService: vi.fn(),
  inventoryLevelsFor: vi.fn(),
  listFulfillmentServices: mocks.listFulfillmentServices,
  updateFulfillmentServiceCallback: mocks.updateFulfillmentServiceCallback,
}));

const { registerFulfillmentService, callbackUrl } = await import("~/services/fulfillment-service.server");

const shop = { id: "s1", domain: "a.myshopify.com" } as never;
const client = vi.fn() as never;

function existing(overrides: Record<string, unknown>) {
  return { id: "gid://shopify/FulfillmentService/1", serviceName: "DropshipHub", handle: "dropshiphub", locationId: "gid://shopify/Location/9", locationName: "DropshipHub", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateFulfillmentServiceCallback.mockResolvedValue(undefined);
});

describe("registerFulfillmentService re-attaching to an existing service", () => {
  it("corrects a service that still claims tracking support even when its callback has not moved", async () => {
    mocks.listFulfillmentServices.mockResolvedValue([existing({ callbackUrl: callbackUrl(), trackingSupport: true })]);
    await registerFulfillmentService(shop, client);
    expect(mocks.updateFulfillmentServiceCallback).toHaveBeenCalledWith(client, "gid://shopify/FulfillmentService/1", callbackUrl());
  });

  it("leaves an up-to-date service alone", async () => {
    mocks.listFulfillmentServices.mockResolvedValue([existing({ callbackUrl: callbackUrl(), trackingSupport: false })]);
    await registerFulfillmentService(shop, client);
    expect(mocks.updateFulfillmentServiceCallback).not.toHaveBeenCalled();
  });

  it("still updates a service whose callback moved", async () => {
    mocks.listFulfillmentServices.mockResolvedValue([existing({ callbackUrl: "https://old.example.com/api/fulfillment-service", trackingSupport: false })]);
    await registerFulfillmentService(shop, client);
    expect(mocks.updateFulfillmentServiceCallback).toHaveBeenCalledTimes(1);
  });
});
