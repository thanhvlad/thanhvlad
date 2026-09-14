import { AppError } from "~/lib/errors";
import { assertNoUserErrors, gql, gqlResult, type GraphqlClient, type UserError } from "./graphql.server";

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
  /**
   * Always null from the fetchers here. The order query no longer reads the
   * Customer object: that needs the read_customers scope, and the order itself
   * already carries what a shipment needs (shippingAddress.name, email, and
   * shippingAddress.phone or phone). Kept on the type for snapshots built by
   * hand and for the upsert's fallback, which simply finds nothing.
   */
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
  /**
   * Fields Shopify withheld because the app is not approved for that protected
   * customer data, as dotted paths relative to the order ("shippingAddress",
   * "phone"). Those fields read as null above; this is
   * how the order screen can tell "Shopify would not share the address" apart
   * from "the customer gave no address". Always set by the fetchers here;
   * optional only so a snapshot built by hand (fixtures, the demo script) need
   * not claim anything about it.
   */
  redactedFields?: string[];
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
function normalizeOrder(raw: any): Omit<ShopifyOrderSnapshot, "redactedFields"> {
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
    // Not queried any more; see ShopifyOrderSnapshot.customer.
    customer: null,
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

/**
 * The order fields Shopify may withhold for protected customer data, and so the
 * only denials an order fetch accepts as "sync without them". Anything else - a
 * line item, the order itself, a field behind a missing access scope - still
 * throws, because a null there means something is misconfigured, not private.
 */
export const REDACTABLE_ORDER_FIELDS: ReadonlySet<string> = new Set(["email", "phone", "shippingAddress"]);

/**
 * Accepts a denied path only when it names a protected field of an order under
 * `prefix` (["order"] for one order, ["orders", "nodes"] for a page, where the
 * next segment is the node's index).
 */
export function redactableOrderPath(prefix: string[]) {
  const indexed = prefix.length > 1;
  return (path: Array<string | number>): boolean => {
    if (!prefix.every((segment, i) => path[i] === segment)) return false;
    let at = prefix.length;
    if (indexed) {
      if (typeof path[at] !== "number") return false;
      at += 1;
    }
    const field = path[at];
    return typeof field === "string" && REDACTABLE_ORDER_FIELDS.has(field);
  };
}

export async function fetchOrder(client: GraphqlClient, id: string) {
  const { data, deniedPaths } = await gqlResult<{ order: unknown }>(client, ORDER_QUERY, { id }, {
    allowRedacted: redactableOrderPath(["order"]),
  });
  const redacted = redactedFieldsByNode(deniedPaths, ["order"]);
  if (!data.order) {
    // The order itself was withheld, not just some of its fields. Returning
    // null here would read as "the order was deleted" to every caller.
    if (redacted.whole) throw accessDenied();
    return null;
  }
  return { ...normalizeOrder(data.order), redactedFields: redacted.forNode(0) };
}

export async function fetchOrdersPage(
  client: GraphqlClient,
  options: { first?: number; after?: string | null; query?: string },
) {
  const { data, deniedPaths } = await gqlResult<{
    orders: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null;
  }>(client, ORDERS_QUERY, {
    first: options.first ?? 50,
    after: options.after ?? null,
    query: options.query ?? null,
  }, { allowRedacted: redactableOrderPath(["orders", "nodes"]) });
  const redacted = redactedFieldsByNode(deniedPaths, ["orders", "nodes"]);
  if (!data.orders) {
    if (redacted.whole) throw accessDenied();
    return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }
  // A withheld node is refused by redactableOrderPath already; this keeps a
  // null that slipped through from surfacing as a TypeError inside normalizeOrder.
  if (data.orders.nodes.some((node) => !node)) throw accessDenied();
  return {
    nodes: data.orders.nodes.map((node, index) => ({ ...normalizeOrder(node), redactedFields: redacted.forNode(index) })),
    pageInfo: data.orders.pageInfo,
  };
}

function accessDenied() {
  return new AppError(
    "SHOPIFY_ACCESS_DENIED",
    "Shopify has not approved this app to read orders (protected customer data). Request access in the Partner Dashboard.",
  );
}

/**
 * Map GraphQL error paths onto the orders they belong to.
 *
 * A path under `prefix` followed by a list index belongs to that node (for the
 * single-order query the prefix is just `order`, and every path belongs to node
 * 0). A path that stops at or above the prefix withheld the whole result.
 */
export function redactedFieldsByNode(deniedPaths: Array<Array<string | number>>, prefix: string[]) {
  const perNode = new Map<number, Set<string>>();
  const everyNode = new Set<string>();
  let whole = false;
  const indexed = prefix.length > 1;

  for (const path of deniedPaths) {
    const matchesPrefix = prefix.every((segment, i) => path[i] === segment);
    if (!matchesPrefix || path.length <= prefix.length) {
      // Also covers an error with no path: something was withheld and Shopify
      // did not say what, which is still worth showing rather than dropping.
      whole = true;
      everyNode.add("*");
      continue;
    }
    let rest = path.slice(prefix.length);
    let index: number | null = null;
    if (indexed) {
      if (typeof rest[0] !== "number") {
        everyNode.add(fieldPath(rest));
        continue;
      }
      index = rest[0];
      rest = rest.slice(1);
      if (rest.length === 0) continue;
    }
    const key = index ?? 0;
    const set = perNode.get(key) ?? new Set<string>();
    set.add(fieldPath(rest));
    perNode.set(key, set);
  }

  return {
    whole,
    forNode(index: number): string[] {
      return [...new Set([...everyNode, ...(perNode.get(index) ?? [])])].sort();
    },
  };
}

function fieldPath(path: Array<string | number>): string {
  // "lineItems.nodes.3.image" and "lineItems.nodes.4.image" are one fact.
  return path.filter((p): p is string => typeof p === "string" && p !== "nodes").join(".");
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
          assignedLocation { location { id fulfillmentService { id } } }
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
  requestStatus: string;
  locationId: string | null;
  /** True when the assigned location belongs to a fulfilment service (this app's or another's). */
  atServiceLocation: boolean;
  lineItems: Array<{ id: string; remainingQuantity: number; lineItemId: string }>;
}

export async function fetchFulfillmentOrders(client: GraphqlClient, orderId: string): Promise<FulfillmentOrderInfo[]> {
  const data = await gql<{
    order: {
      fulfillmentOrders: {
        nodes: Array<{
          id: string;
          status: string;
          requestStatus: string;
          assignedLocation: { location: { id: string; fulfillmentService: { id: string } | null } | null } | null;
          lineItems: { nodes: Array<{ id: string; remainingQuantity: number; lineItem: { id: string } }> };
        }>;
      };
    } | null;
  }>(client, FULFILLMENT_ORDERS_QUERY, { id: orderId });
  return (data.order?.fulfillmentOrders.nodes ?? []).map((fo) => ({
    id: fo.id,
    status: fo.status,
    requestStatus: fo.requestStatus,
    locationId: fo.assignedLocation?.location?.id ?? null,
    atServiceLocation: Boolean(fo.assignedLocation?.location?.fulfillmentService),
    lineItems: fo.lineItems.nodes.map((li) => ({
      id: li.id,
      remainingQuantity: li.remainingQuantity,
      lineItemId: li.lineItem.id,
    })),
  }));
}

const FULFILLMENT_CREATE = `#graphql
  mutation DropshipFulfillmentCreate($fulfillment: FulfillmentInput!, $idempotencyKey: String!) {
    fulfillmentCreate(fulfillment: $fulfillment) @idempotent(key: $idempotencyKey) {
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
  /**
   * Stable across retries of the same shipment.
   *
   * Shopify de-duplicates on it, so a retry after a lost response cannot create
   * a second fulfilment — which the customer would see as a second shipment
   * notification for goods that were only sent once.
   */
  idempotencyKey: string;
  /**
   * The app's own fulfilment-service location, when registered. Fulfilment
   * orders there are fulfilled only after the merchant's request was accepted.
   * Locations of any fulfilment service are recognised from Shopify's answer as
   * well, so this is a second check on top of that one rather than the only one.
   */
  fulfillmentServiceLocationId?: string | null;
}

export interface CreateFulfillmentResult {
  id: string | null;
  skipped: boolean;
  reason: string | null;
  /** What Shopify actually accepted, per Shopify line item id. */
  fulfilled: Record<string, number>;
}

/** Request states in which a fulfilment service has been asked to fulfil and said yes. */
const ACCEPTED_REQUEST_STATUSES = new Set(["ACCEPTED", "CANCELLATION_REJECTED"]);

/**
 * Which fulfilment-order line items to fulfil for the wanted quantities.
 *
 * Two rules, both of which the Shopify call alone did not enforce:
 * - A fulfilment order at a fulfilment-service location is used only when its
 *   request was accepted (a rejected cancellation leaves the acceptance
 *   standing). Built for Shopify 5.8.4 lets a fulfilment service fulfil only
 *   after the merchant asks.
 * - The wanted quantity is consumed as it is allocated. A line split across two
 *   fulfilment orders used to be offered in full to each, so a line of 3 split
 *   2 + 1 with only 2 wanted was fulfilled as 2 + 1.
 *
 * Quantities that can only come from a fulfilment order still waiting on its
 * request are listed in `awaitingRequest`; the whole shipment then waits,
 * because a partial fulfilment would leave those lines behind for good.
 */
export function planFulfillment(
  fulfillmentOrders: FulfillmentOrderInfo[],
  items: Array<{ lineItemId: string; quantity: number }>,
  appLocationId?: string | null,
) {
  const wanted = new Map<string, number>();
  for (const item of items) wanted.set(item.lineItemId, (wanted.get(item.lineItemId) ?? 0) + Math.max(0, item.quantity));

  const open = fulfillmentOrders.filter((fo) => ["OPEN", "IN_PROGRESS"].includes(fo.status));
  const held = (fo: FulfillmentOrderInfo) =>
    (fo.atServiceLocation || (Boolean(appLocationId) && fo.locationId === appLocationId)) && !ACCEPTED_REQUEST_STATUSES.has(fo.requestStatus);

  const fulfilled: Record<string, number> = {};
  const lineItemsByFulfillmentOrder: Array<{ fulfillmentOrderId: string; fulfillmentOrderLineItems: Array<{ id: string; quantity: number }> }> = [];
  for (const fo of open.filter((candidate) => !held(candidate))) {
    const lines: Array<{ id: string; quantity: number }> = [];
    for (const li of fo.lineItems) {
      const left = wanted.get(li.lineItemId) ?? 0;
      const quantity = Math.min(li.remainingQuantity, left);
      if (quantity <= 0) continue;
      wanted.set(li.lineItemId, left - quantity);
      fulfilled[li.lineItemId] = (fulfilled[li.lineItemId] ?? 0) + quantity;
      lines.push({ id: li.id, quantity });
    }
    if (lines.length > 0) lineItemsByFulfillmentOrder.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lines });
  }

  const awaitingRequest = new Set<string>();
  for (const fo of open.filter(held)) {
    for (const li of fo.lineItems) {
      if (li.remainingQuantity > 0 && (wanted.get(li.lineItemId) ?? 0) > 0) awaitingRequest.add(li.lineItemId);
    }
  }
  return { lineItemsByFulfillmentOrder, fulfilled, awaitingRequest: [...awaitingRequest] };
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
  const plan = planFulfillment(fulfillmentOrders, input.items, input.fulfillmentServiceLocationId);

  if (plan.awaitingRequest.length > 0) {
    // Thrown rather than reported as skipped: a skipped result tells the caller
    // the goods were fulfilled elsewhere, and it retires the tracking numbers.
    // These have not shipped through Shopify yet; they are waiting for the
    // merchant to request fulfilment, so the next attempt should try again.
    throw new AppError(
      "SHOPIFY_FULFILLMENT_NOT_REQUESTED",
      "These items sit at a fulfilment-service location whose request has not been accepted, so Shopify does not allow fulfilling them yet.",
      { retryable: true, details: { orderId: input.orderId, lineItemIds: plan.awaitingRequest } },
    );
  }
  const { lineItemsByFulfillmentOrder, fulfilled } = plan;
  if (lineItemsByFulfillmentOrder.length === 0) {
    return { id: null, skipped: true, reason: "Nothing left to fulfil for these items.", fulfilled: {} };
  }

  const numbers = [...new Set(input.tracking.numbers.filter(Boolean))];
  const urls = (input.tracking.urls ?? []).filter(Boolean);
  const data = await gql<{
    fulfillmentCreate: { fulfillment: { id: string; status: string } | null; userErrors: UserError[] };
  }>(client, FULFILLMENT_CREATE, {
    idempotencyKey: input.idempotencyKey,
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
