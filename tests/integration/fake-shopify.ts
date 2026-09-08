import type { GraphqlClient } from "~/services/shopify/graphql.server";

/**
 * A stand-in for `admin.graphql` that answers the app's named operations with
 * plausible data and records every call, so integration tests can run the
 * whole import → order → fulfil flow without a Shopify store.
 */
export interface FakeShopify {
  client: GraphqlClient;
  calls: Array<{ operation: string; variables: Record<string, unknown> | undefined }>;
  /** Line items the fake fulfilment-orders query will report for an order. */
  fulfillmentLineItems: Array<{ lineItemId: string; quantity: number }>;
}

let counter = 1000;
const nextId = (type: string) => `gid://shopify/${type}/${counter++}`;

export function createFakeShopify(): FakeShopify {
  const fake: FakeShopify = { calls: [], fulfillmentLineItems: [], client: async () => new Response("{}") };

  fake.client = async (query, options) => {
    const operation = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
    const variables = options?.variables;
    fake.calls.push({ operation, variables });
    const data = respond(operation, variables ?? {}, fake);
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  };
  return fake;
}

function respond(operation: string, variables: Record<string, unknown>, fake: FakeShopify): unknown {
  switch (operation) {
    case "DropshipShopInfo":
      return {
        shop: { name: "Test Store", email: "owner@test.dev", currencyCode: "USD", ianaTimezone: "UTC", billingAddress: { countryCodeV2: "US" }, currencyFormats: { moneyFormat: "{{amount}} USD" }, plan: { partnerDevelopment: true } },
        locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] },
      };
    case "DropshipProductSet": {
      const input = variables.input as { title: string; handle?: string; status: string; variants: Array<{ optionValues: Array<{ optionName: string; name: string }>; sku?: string; price: string; compareAtPrice?: string }> };
      const productId = nextId("Product");
      return {
        productSet: {
          product: {
            id: productId,
            handle: input.handle ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            title: input.title,
            status: input.status,
            featuredMedia: { preview: { image: { url: "https://cdn.test/1.png" } } },
            variants: {
              nodes: input.variants.map((v, i) => ({
                id: nextId("ProductVariant"),
                title: v.optionValues.map((o) => o.name).join(" / "),
                sku: v.sku ?? null,
                price: v.price,
                compareAtPrice: v.compareAtPrice ?? null,
                position: i + 1,
                inventoryItem: { id: nextId("InventoryItem") },
                selectedOptions: v.optionValues.map((o) => ({ name: o.optionName, value: o.name })),
              })),
            },
          },
          userErrors: [],
        },
      };
    }
    case "DropshipPublications":
      return { publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }] } };
    case "DropshipPublish":
      return { publishablePublish: { userErrors: [] } };
    case "DropshipVariantsUpdate": {
      const variants = variables.variants as Array<{ id: string; price?: string; compareAtPrice?: string }>;
      return { productVariantsBulkUpdate: { productVariants: variants.map((v) => ({ id: v.id, price: v.price ?? "0", compareAtPrice: v.compareAtPrice ?? null })), userErrors: [] } };
    }
    case "DropshipInventorySet":
      return { inventorySetQuantities: { inventoryAdjustmentGroup: { reason: "correction" }, userErrors: [] } };
    case "DropshipProductStatus":
      return { productUpdate: { product: { id: (variables.input as { id: string }).id, status: (variables.input as { status: string }).status }, userErrors: [] } };
    case "DropshipProductDelete":
      return { productDelete: { deletedProductId: (variables.input as { id: string }).id, userErrors: [] } };
    case "DropshipTagsAdd":
      return { tagsAdd: { userErrors: [] } };
    case "DropshipOrderUpdate":
      return { orderUpdate: { userErrors: [] } };
    case "DropshipFulfillmentOrders":
      return {
        order: {
          fulfillmentOrders: {
            nodes: [
              {
                id: "gid://shopify/FulfillmentOrder/1",
                status: "OPEN",
                requestStatus: "UNSUBMITTED",
                assignedLocation: { location: { id: "gid://shopify/Location/1" } },
                lineItems: { nodes: fake.fulfillmentLineItems.map((li, i) => ({ id: `gid://shopify/FulfillmentOrderLineItem/${i + 1}`, remainingQuantity: li.quantity, lineItem: { id: li.lineItemId } })) },
              },
            ],
          },
        },
      };
    case "DropshipFulfillmentCreate":
      return { fulfillmentCreate: { fulfillment: { id: nextId("Fulfillment"), status: "SUCCESS", trackingInfo: [] }, userErrors: [] } };
    case "DropshipTrackingUpdate":
      return { fulfillmentTrackingInfoUpdate: { fulfillment: { id: String(variables.fulfillmentId ?? "") }, userErrors: [] } };
    default:
      return {};
  }
}
