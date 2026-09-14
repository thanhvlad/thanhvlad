/**
 * The Shopify helpers built on the GraphQL wrapper: order fetches under
 * protected-data redaction, the inventory write's mandatory input, and the
 * product push's variant read-back and media report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "~/lib/errors";
import { gqlInternals, type GraphqlClient } from "~/services/shopify/graphql.server";
import { fetchOrder, fetchOrdersPage, redactedFieldsByNode } from "~/services/shopify/orders.server";
import { createProduct, setInventoryQuantities, summariseMedia, type PushProductInput } from "~/services/shopify/products.server";
import { assignVariantToLocation, createFulfillmentService, listFulfillmentServices, updateFulfillmentServiceCallback } from "~/services/shopify/fulfillment-service.server";

vi.mock("~/shopify.server", () => ({ unauthenticated: {} }));
vi.mock("~/lib/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Call = { operation: string; variables: Record<string, unknown> | undefined };

function fakeClient(answer: (operation: string, variables: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const client: GraphqlClient = async (query, options) => {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
    calls.push({ operation, variables: options?.variables });
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
