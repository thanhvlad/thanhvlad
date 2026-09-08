import { assertNoUserErrors, gql, type GraphqlClient, type UserError } from "./graphql.server";

export interface ShopifyOrderSnapshot {
  id: string;
  name: string;
  orderNumber: number | null;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  tags: string[];
  test: boolean;
  riskLevel: string | null;
  currencyCode: string;
  totalPrice: string;
  totalShipping: string;
  totalTax: string;
  totalDiscounts: string;
  customer: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null;
  shippingAddress: {
    firstName: string | null;
    lastName: string | null;
    name: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCodeV2: string | null;
    phone: string | null;
  } | null;
  lineItems: Array<{
    id: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    unfulfilledQuantity: number;
    productId: string | null;
    variantId: string | null;
    image: string | null;
    price: string;
    totalDiscount: string;
    requiresShipping: boolean;
  }>;
  customAttributes: Array<{ key: string; value: string | null }>;
}

const ORDER_FIELDS = `#graphql
  fragment DropshipOrderFields on Order {
    id
    name
    createdAt
    cancelledAt
    displayFinancialStatus
    displayFulfillmentStatus
    email
    phone
    note
    tags
    test
    risk { assessments { riskLevel } }
    currencyCode
    totalPriceSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    totalTaxSet { shopMoney { amount } }
    totalDiscountsSet { shopMoney { amount } }
    customer { firstName lastName email phone }
    customAttributes { key value }
    shippingAddress {
      firstName lastName name company address1 address2 city province provinceCode zip country countryCodeV2 phone
    }
    lineItems(first: 100) {
      nodes {
        id
        title
        variantTitle
        sku
        quantity
        unfulfilledQuantity
        requiresShipping
        product { id }
        variant { id }
        image { url }
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
      }
    }
  }
`;

const ORDER_QUERY = `#graphql
  ${ORDER_FIELDS}
  query DropshipOrder($id: ID!) {
    order(id: $id) { ...DropshipOrderFields }
  }
`;

const ORDERS_QUERY = `#graphql
  ${ORDER_FIELDS}
  query DropshipOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes { ...DropshipOrderFields }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeOrder(raw: any): ShopifyOrderSnapshot {
  const risks: Array<{ riskLevel: string }> = raw.risk?.assessments ?? [];
  const highest = risks.map((r) => r.riskLevel).sort((a, b) => rank(b) - rank(a))[0] ?? null;
  const numberMatch = /(\d+)/.exec(raw.name ?? "");
  return {
    id: raw.id,
    name: raw.name,
    orderNumber: numberMatch ? Number(numberMatch[1]) : null,
    createdAt: raw.createdAt,
    cancelledAt: raw.cancelledAt ?? null,
    displayFinancialStatus: raw.displayFinancialStatus ?? null,
    displayFulfillmentStatus: raw.displayFulfillmentStatus ?? null,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
    note: raw.note ?? null,
    tags: raw.tags ?? [],
    test: Boolean(raw.test),
    riskLevel: highest,
    currencyCode: raw.currencyCode,
    totalPrice: raw.totalPriceSet?.shopMoney?.amount ?? "0",
    totalShipping: raw.totalShippingPriceSet?.shopMoney?.amount ?? "0",
    totalTax: raw.totalTaxSet?.shopMoney?.amount ?? "0",
    totalDiscounts: raw.totalDiscountsSet?.shopMoney?.amount ?? "0",
    customer: raw.customer ?? null,
    shippingAddress: raw.shippingAddress ?? null,
    customAttributes: raw.customAttributes ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineItems: (raw.lineItems?.nodes ?? []).map((li: any) => ({
      id: li.id,
      title: li.title,
      variantTitle: li.variantTitle ?? null,
      sku: li.sku ?? null,
      quantity: li.quantity,
      unfulfilledQuantity: li.unfulfilledQuantity ?? li.quantity,
      productId: li.product?.id ?? null,
      variantId: li.variant?.id ?? null,
      image: li.image?.url ?? null,
      price: li.originalUnitPriceSet?.shopMoney?.amount ?? "0",
      totalDiscount: li.totalDiscountSet?.shopMoney?.amount ?? "0",
      requiresShipping: Boolean(li.requiresShipping),
    })),
  };
}

function rank(level: string): number {
  return level === "HIGH" ? 3 : level === "MEDIUM" ? 2 : level === "LOW" ? 1 : 0;
}

export async function fetchOrder(client: GraphqlClient, id: string) {
  const data = await gql<{ order: unknown }>(client, ORDER_QUERY, { id });
  return data.order ? normalizeOrder(data.order) : null;
}

export async function fetchOrdersPage(
  client: GraphqlClient,
  options: { first?: number; after?: string | null; query?: string },
) {
  const data = await gql<{
    orders: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(client, ORDERS_QUERY, {
    first: options.first ?? 50,
    after: options.after ?? null,
    query: options.query ?? null,
  });
  return { nodes: data.orders.nodes.map(normalizeOrder), pageInfo: data.orders.pageInfo };
}

// ---------------------------------------------------------------------------
// Tags & notes
// ---------------------------------------------------------------------------

const TAGS_ADD = `#graphql
  mutation DropshipTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

export async function addOrderTags(client: GraphqlClient, orderId: string, tags: string[]) {
  const clean = tags.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return;
  const data = await gql<{ tagsAdd: { userErrors: UserError[] } }>(client, TAGS_ADD, { id: orderId, tags: clean });
  assertNoUserErrors(data.tagsAdd.userErrors, "tagsAdd");
}

const ORDER_UPDATE = `#graphql
  mutation DropshipOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) { userErrors { field message } }
  }
`;

export async function updateOrderNote(client: GraphqlClient, orderId: string, note: string) {
  const data = await gql<{ orderUpdate: { userErrors: UserError[] } }>(client, ORDER_UPDATE, {
    input: { id: orderId, note },
  });
  assertNoUserErrors(data.orderUpdate.userErrors, "orderUpdate");
}

export async function updateOrderShippingAddress(
  client: GraphqlClient,
  orderId: string,
  address: Record<string, string | null | undefined>,
) {
  const data = await gql<{ orderUpdate: { userErrors: UserError[] } }>(client, ORDER_UPDATE, {
    input: { id: orderId, shippingAddress: address },
  });
  assertNoUserErrors(data.orderUpdate.userErrors, "orderUpdate(shippingAddress)");
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query DropshipFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          requestStatus
          assignedLocation { location { id } }
          lineItems(first: 100) {
            nodes { id remainingQuantity lineItem { id } }
          }
        }
      }
    }
  }
`;

export interface FulfillmentOrderInfo {
  id: string;
  status: string;
  locationId: string | null;
  lineItems: Array<{ id: string; remainingQuantity: number; lineItemId: string }>;
}

export async function fetchFulfillmentOrders(client: GraphqlClient, orderId: string): Promise<FulfillmentOrderInfo[]> {
  const data = await gql<{
    order: {
      fulfillmentOrders: {
        nodes: Array<{
          id: string;
          status: string;
          assignedLocation: { location: { id: string } | null } | null;
          lineItems: { nodes: Array<{ id: string; remainingQuantity: number; lineItem: { id: string } }> };
        }>;
      };
    } | null;
  }>(client, FULFILLMENT_ORDERS_QUERY, { id: orderId });
  return (data.order?.fulfillmentOrders.nodes ?? []).map((fo) => ({
    id: fo.id,
    status: fo.status,
    locationId: fo.assignedLocation?.location?.id ?? null,
    lineItems: fo.lineItems.nodes.map((li) => ({
      id: li.id,
      remainingQuantity: li.remainingQuantity,
      lineItemId: li.lineItem.id,
    })),
  }));
}

const FULFILLMENT_CREATE = `#graphql
  mutation DropshipFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { number company url } }
      userErrors { field message }
    }
  }
`;

export interface CreateFulfillmentInput {
  orderId: string;
  /** Shopify line item ids to fulfil with their quantities. */
  items: Array<{ lineItemId: string; quantity: number }>;
  /**
   * Tracking numbers for this shipment. A supplier order that ships as several
   * parcels produces several numbers for the same set of line items, and Shopify
   * takes them all on one fulfilment.
   */
  tracking: { numbers: string[]; company?: string | null; urls?: string[] };
  notifyCustomer: boolean;
}

export interface CreateFulfillmentResult {
  id: string | null;
  skipped: boolean;
  reason: string | null;
  /** What Shopify actually accepted, per Shopify line item id. */
  fulfilled: Record<string, number>;
}

/**
 * Create a fulfilment for the given line items with tracking. Handles the
 * fulfilment-order indirection Shopify requires: find the fulfilment orders
 * that hold those line items and fulfil the matching quantities.
 *
 * The quantities Shopify accepted are returned, because they can be lower than
 * what was asked for. The caller decrements by those, never by the whole line.
 */
export async function createFulfillmentWithTracking(
  client: GraphqlClient,
  input: CreateFulfillmentInput,
): Promise<CreateFulfillmentResult> {
  const fulfillmentOrders = await fetchFulfillmentOrders(client, input.orderId);
  const wanted = new Map(input.items.map((i) => [i.lineItemId, i.quantity]));
  const fulfilled: Record<string, number> = {};

  const lineItemsByFulfillmentOrder = fulfillmentOrders
    .filter((fo) => ["OPEN", "IN_PROGRESS"].includes(fo.status))
    .map((fo) => ({
      fulfillmentOrderId: fo.id,
      fulfillmentOrderLineItems: fo.lineItems
        .filter((li) => wanted.has(li.lineItemId) && li.remainingQuantity > 0)
        .map((li) => {
          const quantity = Math.min(li.remainingQuantity, wanted.get(li.lineItemId) ?? 0);
          if (quantity > 0) fulfilled[li.lineItemId] = (fulfilled[li.lineItemId] ?? 0) + quantity;
          return { id: li.id, quantity };
        })
        .filter((li) => li.quantity > 0),
    }))
    .filter((fo) => fo.fulfillmentOrderLineItems.length > 0);

  if (lineItemsByFulfillmentOrder.length === 0) {
    return { id: null, skipped: true, reason: "Nothing left to fulfil for these items.", fulfilled: {} };
  }

  const numbers = [...new Set(input.tracking.numbers.filter(Boolean))];
  const urls = (input.tracking.urls ?? []).filter(Boolean);
  const data = await gql<{
    fulfillmentCreate: { fulfillment: { id: string; status: string } | null; userErrors: UserError[] };
  }>(client, FULFILLMENT_CREATE, {
    fulfillment: {
      lineItemsByFulfillmentOrder,
      notifyCustomer: input.notifyCustomer,
      trackingInfo: {
        numbers,
        company: input.tracking.company ?? undefined,
        urls: urls.length ? urls : undefined,
      },
    },
  });
  assertNoUserErrors(data.fulfillmentCreate.userErrors, "fulfillmentCreate");
  return { id: data.fulfillmentCreate.fulfillment?.id ?? null, skipped: false, reason: null, fulfilled };
}

const FULFILLMENT_TRACKING_UPDATE = `#graphql
  mutation DropshipTrackingUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`;

/**
 * Set the tracking numbers on an existing fulfilment.
 *
 * Shopify *replaces* the tracking set rather than appending to it, so callers
 * must pass every number the fulfilment should end up with — that is how a
 * second parcel for an already-fulfilled shipment reaches the customer.
 */
export async function updateFulfillmentTracking(
  client: GraphqlClient,
  fulfillmentId: string,
  tracking: { numbers: string[]; company?: string | null; urls?: string[] },
  notifyCustomer = false,
) {
  const numbers = [...new Set(tracking.numbers.filter(Boolean))];
  const urls = (tracking.urls ?? []).filter(Boolean);
  const data = await gql<{ fulfillmentTrackingInfoUpdate: { userErrors: UserError[] } }>(
    client,
    FULFILLMENT_TRACKING_UPDATE,
    {
      fulfillmentId,
      notifyCustomer,
      trackingInfoInput: {
        numbers,
        company: tracking.company ?? undefined,
        urls: urls.length ? urls : undefined,
      },
    },
  );
  assertNoUserErrors(data.fulfillmentTrackingInfoUpdate.userErrors, "fulfillmentTrackingInfoUpdate");
}
