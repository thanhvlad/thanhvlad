/**
 * The Shopify helpers built on the GraphQL wrapper: order fetches under
 * protected-data redaction, the inventory write's mandatory input, and the
 * product push's variant read-back and media report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "~/lib/errors";
import { gqlInternals, type GraphqlClient } from "~/services/shopify/graphql.server";
import {
  createFulfillmentWithTracking,
  fetchOrder,
  fetchOrdersPage,
  planFulfillment,
  redactableOrderPath,
  redactedFieldsByNode,
  type FulfillmentOrderInfo,
} from "~/services/shopify/orders.server";
import { createProduct, fetchProduct, setInventoryQuantities, summariseMedia, type PushProductInput } from "~/services/shopify/products.server";
import { assignVariantToLocation, createFulfillmentService, listFulfillmentServices, updateFulfillmentServiceCallback } from "~/services/shopify/fulfillment-service.server";

vi.mock("~/shopify.server", () => ({ unauthenticated: {} }));
vi.mock("~/lib/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Call = { operation: string; variables: Record<string, unknown> | undefined; query: string };

function fakeClient(answer: (operation: string, variables: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const client: GraphqlClient = async (query, options) => {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
    calls.push({ operation, variables: options?.variables, query });
    const result = answer(operation, options?.variables ?? {});
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result));
  };
  return { client, calls };
}

class ThrownGraphqlError extends Error {
  body: unknown;
  constructor(data: unknown, errors: unknown[]) {
    super("GraphQL operation failed");
    this.body = { data, errors: { graphQLErrors: errors } };
  }
}

const rawOrder = (id: number, overrides: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${1000 + id}`,
  createdAt: "2026-09-01T00:00:00Z",
  currencyCode: "USD",
  email: "buyer@example.com",
  phone: null,
  shippingAddress: { name: "Ada", address1: "1 Main St", city: "Hanoi", countryCodeV2: "VN" },
  lineItems: { nodes: [] },
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(gqlInternals, "sleep").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("redactedFieldsByNode", () => {
  it("assigns list paths to their node and drops indexes inside it", () => {
    const map = redactedFieldsByNode(
      [
        ["orders", "nodes", 0, "shippingAddress"],
        ["orders", "nodes", 1, "customer", "defaultPhoneNumber"],
        ["orders", "nodes", 1, "lineItems", "nodes", 3, "image"],
      ],
      ["orders", "nodes"],
    );
    expect(map.whole).toBe(false);
    expect(map.forNode(0)).toEqual(["shippingAddress"]);
    expect(map.forNode(1)).toEqual(["customer.defaultPhoneNumber", "lineItems.image"]);
    expect(map.forNode(2)).toEqual([]);
  });

  it("flags a denial of the whole result", () => {
    expect(redactedFieldsByNode([["order"]], ["order"]).whole).toBe(true);
    expect(redactedFieldsByNode([[]], ["order"]).whole).toBe(true);
  });
});

describe("fetchOrder under protected-data redaction", () => {
  it("still returns the order, with the withheld fields named", async () => {
    const { client } = fakeClient(
      () =>
        new ThrownGraphqlError({ order: rawOrder(1, { shippingAddress: null, phone: null }) }, [
          { message: "This app is not approved to access the Order object.", path: ["order", "shippingAddress"] },
          { message: "This app is not approved to access the Order object.", path: ["order", "phone"] },
        ]),
    );
    const order = await fetchOrder(client, "gid://shopify/Order/1");
    expect(order?.name).toBe("#1001");
    expect(order?.shippingAddress).toBeNull();
    expect(order?.redactedFields).toEqual(["phone", "shippingAddress"]);
  });

  it("reports an empty list when nothing was withheld", async () => {
    const { client } = fakeClient(() => ({ data: { order: rawOrder(2) } }));
    const order = await fetchOrder(client, "gid://shopify/Order/2");
    expect(order?.redactedFields).toEqual([]);
  });

  it("throws instead of pretending the order does not exist when the order itself is withheld", async () => {
    const { client } = fakeClient(
      () => new ThrownGraphqlError({ order: null }, [{ message: "This app is not approved to access the Order object.", path: ["order"] }]),
    );
    const error = await fetchOrder(client, "gid://shopify/Order/3").catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("no longer asks for the Customer object, which needs the read_customers scope", async () => {
    const { client, calls } = fakeClient(() => ({ data: { order: rawOrder(6) } }));
    const order = await fetchOrder(client, "gid://shopify/Order/6");
    expect(calls[0].query).not.toMatch(/\bcustomer\s*\{/);
    expect(order?.customer).toBeNull();
    // What a shipment needs still comes from the order itself.
    expect(order?.email).toBe("buyer@example.com");
    expect(order?.shippingAddress?.name).toBe("Ada");
    expect(calls[0].query).toMatch(/shippingAddress\s*\{[^}]*\bphone\b/);
  });

  it("throws when a field outside the protected order fields is denied", async () => {
    const { client } = fakeClient(
      () =>
        new ThrownGraphqlError({ order: rawOrder(7, { lineItems: { nodes: [null] } }) }, [
          { message: "Access denied for lineItems field.", path: ["order", "lineItems", "nodes", 0], extensions: { code: "ACCESS_DENIED" } },
        ]),
    );
    const error = await fetchOrder(client, "gid://shopify/Order/7").catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("throws when a protected field is denied for a missing access scope rather than approval", async () => {
    const { client } = fakeClient(
      () =>
        new ThrownGraphqlError({ order: rawOrder(8, { phone: null }) }, [
          { message: "Access denied for phone field. Required access: `read_orders` access scope.", path: ["order", "phone"], extensions: { code: "ACCESS_DENIED" } },
        ]),
    );
    const error = await fetchOrder(client, "gid://shopify/Order/8").catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("throws when a whole order in a page is withheld instead of crashing on a null node", async () => {
    const { client } = fakeClient(
      () =>
        new ThrownGraphqlError({ orders: { nodes: [rawOrder(9), null], pageInfo: { hasNextPage: false, endCursor: null } } }, [
          { message: "This app is not approved to access the Order object.", path: ["orders", "nodes", 1] },
        ]),
    );
    const error = await fetchOrdersPage(client, {}).catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("recognises protected order paths exactly", () => {
    const one = redactableOrderPath(["order"]);
    expect(one(["order", "shippingAddress"])).toBe(true);
    expect(one(["order", "shippingAddress", "phone"])).toBe(true);
    expect(one(["order", "email"])).toBe(true);
    expect(one(["order"])).toBe(false);
    expect(one(["order", "lineItems"])).toBe(false);
    expect(one(["shop", "email"])).toBe(false);
    const page = redactableOrderPath(["orders", "nodes"]);
    expect(page(["orders", "nodes", 2, "phone"])).toBe(true);
    expect(page(["orders", "nodes", "phone"])).toBe(false);
    expect(page(["orders", "nodes", 2])).toBe(false);
  });

  it("keeps a page of orders and attributes each redaction to its own order", async () => {
    const { client } = fakeClient(
      () =>
        new ThrownGraphqlError(
          { orders: { nodes: [rawOrder(4), rawOrder(5, { shippingAddress: null })], pageInfo: { hasNextPage: false, endCursor: null } } },
          [{ message: "This app is not approved to access the Order object.", path: ["orders", "nodes", 1, "shippingAddress"] }],
        ),
    );
    const page = await fetchOrdersPage(client, {});
    expect(page.nodes.map((n) => n.redactedFields)).toEqual([[], ["shippingAddress"]]);
  });
});

describe("setInventoryQuantities", () => {
  it("sends changeFromQuantity explicitly as null on every quantity", async () => {
    const { client, calls } = fakeClient(() => ({ data: { inventorySetQuantities: { userErrors: [] } } }));
    await setInventoryQuantities(client, "gid://shopify/Location/1", [
      { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 10 },
      { inventoryItemId: "gid://shopify/InventoryItem/2", quantity: -3 },
    ]);
    const input = calls[0].variables?.input as { quantities: Array<Record<string, unknown>> };
    for (const q of input.quantities) {
      expect(Object.prototype.hasOwnProperty.call(q, "changeFromQuantity")).toBe(true);
      expect(q.changeFromQuantity).toBeNull();
    }
    expect(input.quantities[1].quantity).toBe(0);
  });

  it("does not reuse the previous sync's key for the same quantities", async () => {
    const { client, calls } = fakeClient(() => ({ data: { inventorySetQuantities: { userErrors: [] } } }));
    const quantities = [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 10 }];
    await setInventoryQuantities(client, "gid://shopify/Location/1", quantities);
    await setInventoryQuantities(client, "gid://shopify/Location/1", quantities);
    expect(calls[0].variables?.key).not.toBe(calls[1].variables?.key);
  });

  it("reuses the key when a job attempt is retried with the same operation id", async () => {
    const { client, calls } = fakeClient(() => ({ data: { inventorySetQuantities: { userErrors: [] } } }));
    const quantities = [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 10 }];
    await setInventoryQuantities(client, "gid://shopify/Location/1", quantities, { operationId: "job-7:product-1" });
    await setInventoryQuantities(client, "gid://shopify/Location/1", quantities, { operationId: "job-7:product-1" });
    expect(calls[0].variables?.key).toBe(calls[1].variables?.key);
  });
});

describe("assignVariantToLocation", () => {
  it("activates again on a second assignment instead of hitting the idempotency cache", async () => {
    const { client, calls } = fakeClient(() => ({ data: { inventoryActivate: { userErrors: [] } } }));
    await assignVariantToLocation(client, "gid://shopify/InventoryItem/1", "gid://shopify/Location/9", 4);
    await assignVariantToLocation(client, "gid://shopify/InventoryItem/1", "gid://shopify/Location/9", 4);
    const keys = calls.filter((c) => c.operation === "DropshipInventoryActivate").map((c) => c.variables?.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("createProduct", () => {
  const input: PushProductInput = {
    title: "Lamp",
    descriptionHtml: "",
    tags: [],
    status: "DRAFT",
    optionNames: ["Size"],
    images: ["https://cdn.supplier.test/a.jpg"],
    variants: [{ optionValues: ["S"], price: "10.00", inventoryQuantity: 1 }],
    locationId: null,
    trackInventory: true,
    weightUnit: "GRAMS",
  };
  const variant = (n: number) => ({
    id: `gid://shopify/ProductVariant/${n}`,
    title: `V${n}`,
    sku: null,
    price: "10.00",
    compareAtPrice: null,
    position: n,
    inventoryItem: { id: `gid://shopify/InventoryItem/${n}` },
    selectedOptions: [{ name: "Size", value: `V${n}` }],
  });

  it("pages in variants beyond the first 250 so every one can be mapped", async () => {
    const { client, calls } = fakeClient((operation, variables) => {
      if (operation === "DropshipProductSet") {
        return {
          data: {
            productSet: {
              userErrors: [],
              product: {
                id: "gid://shopify/Product/1",
                handle: "lamp",
                title: "Lamp",
                status: "DRAFT",
                featuredMedia: null,
                media: { nodes: [{ id: "gid://shopify/MediaImage/1", alt: "Lamp", status: "FAILED", mediaErrors: [{ code: "IMAGE_DOWNLOAD_FAILURE", details: "403 from source", message: "Download failed" }] }] },
                variants: { nodes: Array.from({ length: 250 }, (_, i) => variant(i + 1)), pageInfo: { hasNextPage: true, endCursor: "c250" } },
              },
            },
          },
        };
      }
      expect(variables.after).toBe("c250");
      return {
        data: { product: { variants: { nodes: Array.from({ length: 50 }, (_, i) => variant(251 + i)), pageInfo: { hasNextPage: false, endCursor: null } } } },
      };
    });
    const pushed = await createProduct(client, input);
    expect(pushed.variants).toHaveLength(300);
    expect(calls.map((c) => c.operation)).toEqual(["DropshipProductSet", "DropshipProductVariantsPage"]);
    expect(pushed.failedMedia).toEqual([{ id: "gid://shopify/MediaImage/1", alt: "Lamp", message: "403 from source" }]);
  });

  it("returns the created product id when reading the remaining variants fails", async () => {
    const productSet = {
      data: {
        productSet: {
          userErrors: [],
          product: {
            id: "gid://shopify/Product/2",
            handle: "lamp",
            title: "Lamp",
            status: "DRAFT",
            featuredMedia: null,
            variants: { nodes: Array.from({ length: 250 }, (_, i) => variant(i + 1)), pageInfo: { hasNextPage: true, endCursor: "c250" } },
          },
        },
      },
    };
    for (const failure of [() => new Error("socket hang up"), () => ({ data: { product: null } })]) {
      const { client } = fakeClient((operation) => (operation === "DropshipProductSet" ? structuredClone(productSet) : failure()));
      const pushed = await createProduct(client, input);
      expect(pushed.id).toBe("gid://shopify/Product/2");
      expect(pushed.variantsIncomplete).toBe(true);
      expect(pushed.variants).toHaveLength(250);
    }
  });

  it("reports a complete read-back as complete", async () => {
    const { client } = fakeClient(() => ({
      data: {
        productSet: {
          userErrors: [],
          product: { id: "gid://shopify/Product/3", handle: "lamp", title: "Lamp", status: "DRAFT", featuredMedia: null, variants: { nodes: [variant(1)], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
    }));
    expect((await createProduct(client, input)).variantsIncomplete).toBe(false);
  });

  it("does not hand fetchProduct a partial variant list when the product vanishes between pages", async () => {
    const { client } = fakeClient((operation) =>
      operation === "DropshipProduct"
        ? {
            data: {
              product: {
                id: "gid://shopify/Product/4",
                handle: "lamp",
                title: "Lamp",
                status: "ACTIVE",
                vendor: null,
                featuredMedia: null,
                variants: { nodes: [variant(1)], pageInfo: { hasNextPage: true, endCursor: "c1" } },
              },
            },
          }
        : { data: { product: null } },
    );
    const error = await fetchProduct(client, "gid://shopify/Product/4").catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_PRODUCT_VANISHED");
  });

  it("does not replay a first push after a dropped connection, but does replay an upsert", async () => {
    const dropped = () => new Error("socket hang up");
    const first = fakeClient(() => dropped());
    await expect(createProduct(first.client, input)).rejects.toBeInstanceOf(AppError);
    expect(first.calls).toHaveLength(1);

    let attempts = 0;
    const upsert = fakeClient(() => {
      attempts += 1;
      if (attempts === 1) return dropped();
      return {
        data: {
          productSet: {
            userErrors: [],
            product: { id: "gid://shopify/Product/1", handle: "lamp", title: "Lamp", status: "DRAFT", featuredMedia: null, variants: { nodes: [variant(1)] } },
          },
        },
      };
    });
    const pushed = await createProduct(upsert.client, { ...input, id: "gid://shopify/Product/1" });
    expect(pushed.id).toBe("gid://shopify/Product/1");
    expect(upsert.calls).toHaveLength(2);
  });
});

describe("planFulfillment", () => {
  const fo = (overrides: Partial<FulfillmentOrderInfo> & Pick<FulfillmentOrderInfo, "id" | "lineItems">): FulfillmentOrderInfo => ({
    status: "OPEN",
    requestStatus: "UNSUBMITTED",
    locationId: "gid://shopify/Location/1",
    atServiceLocation: false,
    ...overrides,
  });
  const APP_LOCATION = "gid://shopify/Location/99";

  it("does not offer a split line's full quantity to every fulfilment order", () => {
    const plan = planFulfillment(
      [
        fo({ id: "fo1", lineItems: [{ id: "fol1", lineItemId: "li1", remainingQuantity: 2 }] }),
        fo({ id: "fo2", lineItems: [{ id: "fol2", lineItemId: "li1", remainingQuantity: 1 }] }),
      ],
      [{ lineItemId: "li1", quantity: 2 }],
    );
    expect(plan.lineItemsByFulfillmentOrder).toEqual([{ fulfillmentOrderId: "fo1", fulfillmentOrderLineItems: [{ id: "fol1", quantity: 2 }] }]);
    expect(plan.fulfilled).toEqual({ li1: 2 });
    expect(plan.awaitingRequest).toEqual([]);
  });

  it("spreads a wanted quantity across fulfilment orders when one is not enough", () => {
    const plan = planFulfillment(
      [
        fo({ id: "fo1", lineItems: [{ id: "fol1", lineItemId: "li1", remainingQuantity: 2 }] }),
        fo({ id: "fo2", status: "IN_PROGRESS", lineItems: [{ id: "fol2", lineItemId: "li1", remainingQuantity: 5 }] }),
      ],
      [{ lineItemId: "li1", quantity: 3 }],
    );
    expect(plan.lineItemsByFulfillmentOrder.map((f) => f.fulfillmentOrderLineItems[0].quantity)).toEqual([2, 1]);
    expect(plan.fulfilled).toEqual({ li1: 3 });
  });

  it("holds lines at the app's location until the request is accepted", () => {
    const items = [{ lineItemId: "li1", quantity: 1 }];
    for (const requestStatus of ["UNSUBMITTED", "SUBMITTED", "REJECTED", "CANCELLATION_REQUESTED", "CANCELLATION_ACCEPTED", "CLOSED"]) {
      const plan = planFulfillment([fo({ id: "fo1", locationId: APP_LOCATION, requestStatus, lineItems: [{ id: "fol1", lineItemId: "li1", remainingQuantity: 1 }] })], items, APP_LOCATION);
      expect(plan.lineItemsByFulfillmentOrder, requestStatus).toEqual([]);
      expect(plan.awaitingRequest, requestStatus).toEqual(["li1"]);
    }
    for (const requestStatus of ["ACCEPTED", "CANCELLATION_REJECTED"]) {
      const plan = planFulfillment(
        [fo({ id: "fo1", status: "IN_PROGRESS", locationId: APP_LOCATION, requestStatus, lineItems: [{ id: "fol1", lineItemId: "li1", remainingQuantity: 1 }] })],
        items,
        APP_LOCATION,
      );
      expect(plan.fulfilled, requestStatus).toEqual({ li1: 1 });
      expect(plan.awaitingRequest, requestStatus).toEqual([]);
    }
  });

  it("recognises a fulfilment-service location from Shopify's answer when the caller names none", () => {
    const plan = planFulfillment(
      [fo({ id: "fo1", atServiceLocation: true, lineItems: [{ id: "fol1", lineItemId: "li1", remainingQuantity: 1 }] })],
      [{ lineItemId: "li1", quantity: 1 }],
    );
    expect(plan.awaitingRequest).toEqual(["li1"]);
  });

  it("does not wait on a held fulfilment order once the merchant's own location covers the quantity", () => {
    const plan = planFulfillment(
      [
        fo({ id: "held", locationId: APP_LOCATION, lineItems: [{ id: "folA", lineItemId: "li1", remainingQuantity: 1 }] }),
        fo({ id: "own", lineItems: [{ id: "folB", lineItemId: "li1", remainingQuantity: 1 }] }),
      ],
      [{ lineItemId: "li1", quantity: 1 }],
      APP_LOCATION,
    );
    expect(plan.lineItemsByFulfillmentOrder.map((f) => f.fulfillmentOrderId)).toEqual(["own"]);
    expect(plan.awaitingRequest).toEqual([]);
  });
});

describe("createFulfillmentWithTracking", () => {
  const foNode = (requestStatus: string, fulfillmentService: { id: string } | null) => ({
    id: "gid://shopify/FulfillmentOrder/1",
    status: requestStatus === "ACCEPTED" ? "IN_PROGRESS" : "OPEN",
    requestStatus,
    assignedLocation: { location: { id: "gid://shopify/Location/99", fulfillmentService } },
    lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", remainingQuantity: 2, lineItem: { id: "gid://shopify/LineItem/1" } }] },
  });
  const input = {
    orderId: "gid://shopify/Order/1",
    items: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }],
    tracking: { numbers: ["LP123"] },
    notifyCustomer: false,
    idempotencyKey: "k1",
  };

  it("refuses, without calling fulfillmentCreate, while the service request is not accepted", async () => {
    const { client, calls } = fakeClient(() => ({
      data: { order: { fulfillmentOrders: { nodes: [foNode("UNSUBMITTED", { id: "gid://shopify/FulfillmentService/1" })] } } },
    }));
    const error = await createFulfillmentWithTracking(client, input).catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_FULFILLMENT_NOT_REQUESTED");
    expect(calls.map((c) => c.operation)).toEqual(["DropshipFulfillmentOrders"]);
  });

  it("fulfils an accepted request at the app's location", async () => {
    const { client, calls } = fakeClient((operation) =>
      operation === "DropshipFulfillmentOrders"
        ? { data: { order: { fulfillmentOrders: { nodes: [foNode("ACCEPTED", { id: "gid://shopify/FulfillmentService/1" })] } } } }
        : { data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS" }, userErrors: [] } } },
    );
    const result = await createFulfillmentWithTracking(client, { ...input, fulfillmentServiceLocationId: "gid://shopify/Location/99" });
    expect(result).toMatchObject({ id: "gid://shopify/Fulfillment/1", skipped: false, fulfilled: { "gid://shopify/LineItem/1": 2 } });
    expect(calls.map((c) => c.operation)).toEqual(["DropshipFulfillmentOrders", "DropshipFulfillmentCreate"]);
  });
});

describe("summariseMedia", () => {
  it("separates failed from still-processing media", () => {
    expect(
      summariseMedia([
        { id: "1", alt: null, status: "READY" },
        { id: "2", alt: null, status: "PROCESSING" },
        { id: "3", alt: null, status: "FAILED", mediaErrors: [] },
      ]),
    ).toEqual({ failedMedia: [{ id: "3", alt: null, message: "Shopify could not process this image." }], processingMediaCount: 1 });
  });
});

describe("fulfilment service registration", () => {
  // The app sends tracking with each fulfilment and has no list for Shopify's
  // hourly /fetch_tracking_numbers call, so it must never claim to answer it.
  it("registers without tracking support", async () => {
    const { client, calls } = fakeClient(() => ({
      data: {
        fulfillmentServiceCreate: {
          fulfillmentService: { id: "gid://shopify/FulfillmentService/1", serviceName: "DropshipHub", handle: "dropshiphub", callbackUrl: "https://app.example.com/api/fulfillment-service", trackingSupport: false, location: { id: "gid://shopify/Location/9", name: "DropshipHub" } },
          userErrors: [],
        },
      },
    }));

    const service = await createFulfillmentService(client, { name: "DropshipHub", callbackUrl: "https://app.example.com/api/fulfillment-service" });

    expect(calls[0].operation).toBe("DropshipFulfillmentServiceCreate");
    expect(calls[0].variables).toMatchObject({ trackingSupport: false, inventoryManagement: false });
    expect(service).toMatchObject({ locationId: "gid://shopify/Location/9", trackingSupport: false });
  });

  it("turns tracking support off whenever it re-points an existing registration", async () => {
    const { client, calls } = fakeClient(() => ({ data: { fulfillmentServiceUpdate: { fulfillmentService: null, userErrors: [] } } }));

    await updateFulfillmentServiceCallback(client, "gid://shopify/FulfillmentService/1", "https://app.example.com/api/fulfillment-service");

    expect(calls[0].operation).toBe("DropshipFulfillmentServiceUpdate");
    expect(calls[0].variables).toMatchObject({ id: "gid://shopify/FulfillmentService/1", trackingSupport: false });
  });

  it("reports what an existing registration claims, so an old one can be corrected", async () => {
    const { client } = fakeClient(() => ({
      data: {
        shop: {
          fulfillmentServices: [
            { id: "gid://shopify/FulfillmentService/1", serviceName: "DropshipHub", handle: "dropshiphub", callbackUrl: null, trackingSupport: true, type: "THIRD_PARTY", location: null },
          ],
        },
      },
    }));

    const [service] = await listFulfillmentServices(client);

    expect(service.trackingSupport).toBe(true);
  });
});
