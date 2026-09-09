import { createHash } from "node:crypto";
import { assertNoUserErrors, gql, type GraphqlClient, type UserError } from "./graphql.server";

/**
 * Shopify fulfilment service registration.
 *
 * Registering the app as a fulfilment service creates a Shopify *location* owned
 * by the app. Any variant whose inventory sits at that location shows a native
 * **Request fulfillment** button on the Shopify order page; clicking it sends a
 * `fulfillment_orders/fulfillment_request_submitted` webhook here, which the app
 * accepts and then fulfils with the supplier's tracking number.
 *
 * This is opt-in from Settings → Fulfilment service rather than automatic on
 * install: it changes where a merchant's inventory lives, which is not something
 * to do behind their back.
 */

const FULFILLMENT_SERVICE_CREATE = `#graphql
  mutation DropshipFulfillmentServiceCreate(
    $name: String!
    $callbackUrl: URL!
    $trackingSupport: Boolean!
    $inventoryManagement: Boolean!
  ) {
    fulfillmentServiceCreate(
      name: $name
      callbackUrl: $callbackUrl
      trackingSupport: $trackingSupport
      inventoryManagement: $inventoryManagement
    ) {
      fulfillmentService {
        id
        serviceName
        handle
        callbackUrl
        trackingSupport
        location { id name }
      }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_SERVICE_UPDATE = `#graphql
  mutation DropshipFulfillmentServiceUpdate($id: ID!, $name: String, $callbackUrl: URL, $trackingSupport: Boolean) {
    fulfillmentServiceUpdate(id: $id, name: $name, callbackUrl: $callbackUrl, trackingSupport: $trackingSupport) {
      fulfillmentService { id serviceName callbackUrl location { id name } }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_SERVICE_DELETE = `#graphql
  mutation DropshipFulfillmentServiceDelete($id: ID!, $destinationLocationId: ID) {
    fulfillmentServiceDelete(id: $id, destinationLocationId: $destinationLocationId) {
      deletedId
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_SERVICES_QUERY = `#graphql
  query DropshipFulfillmentServices {
    shop {
      fulfillmentServices {
        id
        serviceName
        handle
        callbackUrl
        trackingSupport
        type
        location { id name isActive }
      }
    }
  }
`;

export interface FulfillmentServiceInfo {
  id: string;
  serviceName: string;
  handle: string;
  callbackUrl: string | null;
  locationId: string | null;
  locationName: string | null;
}

/** Every fulfilment service on the shop, so we can find one we registered before. */
export async function listFulfillmentServices(client: GraphqlClient): Promise<FulfillmentServiceInfo[]> {
  const data = await gql<{
    shop: {
      fulfillmentServices: Array<{
        id: string;
        serviceName: string;
        handle: string;
        callbackUrl: string | null;
        type: string;
        location: { id: string; name: string } | null;
      }>;
    };
  }>(client, FULFILLMENT_SERVICES_QUERY);
  return data.shop.fulfillmentServices.map((s) => ({
    id: s.id,
    serviceName: s.serviceName,
    handle: s.handle,
    callbackUrl: s.callbackUrl,
    locationId: s.location?.id ?? null,
    locationName: s.location?.name ?? null,
  }));
}

export async function createFulfillmentService(
  client: GraphqlClient,
  input: { name: string; callbackUrl: string },
): Promise<FulfillmentServiceInfo> {
  const data = await gql<{
    fulfillmentServiceCreate: {
      fulfillmentService: {
        id: string;
        serviceName: string;
        handle: string;
        callbackUrl: string | null;
        location: { id: string; name: string } | null;
      } | null;
      userErrors: UserError[];
    };
  }>(client, FULFILLMENT_SERVICE_CREATE, {
    name: input.name,
    callbackUrl: input.callbackUrl,
    trackingSupport: true,
    // The app already mirrors supplier stock onto the merchant's own location,
    // so it does not also want Shopify asking it for inventory levels.
    inventoryManagement: false,
  });
  assertNoUserErrors(data.fulfillmentServiceCreate.userErrors, "fulfillmentServiceCreate");
  const service = data.fulfillmentServiceCreate.fulfillmentService;
  if (!service) throw new Error("Shopify returned no fulfilment service");
  return {
    id: service.id,
    serviceName: service.serviceName,
    handle: service.handle,
    callbackUrl: service.callbackUrl,
    locationId: service.location?.id ?? null,
    locationName: service.location?.name ?? null,
  };
}

export async function updateFulfillmentServiceCallback(client: GraphqlClient, id: string, callbackUrl: string) {
  const data = await gql<{ fulfillmentServiceUpdate: { userErrors: UserError[] } }>(client, FULFILLMENT_SERVICE_UPDATE, {
    id,
    callbackUrl,
    trackingSupport: true,
  });
  assertNoUserErrors(data.fulfillmentServiceUpdate.userErrors, "fulfillmentServiceUpdate");
}

export async function deleteFulfillmentService(client: GraphqlClient, id: string, destinationLocationId?: string | null) {
  const data = await gql<{ fulfillmentServiceDelete: { deletedId: string | null; userErrors: UserError[] } }>(
    client,
    FULFILLMENT_SERVICE_DELETE,
    { id, destinationLocationId: destinationLocationId ?? null },
  );
  assertNoUserErrors(data.fulfillmentServiceDelete.userErrors, "fulfillmentServiceDelete");
  return data.fulfillmentServiceDelete.deletedId;
}

// ---------------------------------------------------------------------------
// Responding to fulfilment requests
// ---------------------------------------------------------------------------

const ACCEPT_REQUEST = `#graphql
  mutation DropshipAcceptFulfillmentRequest($id: ID!, $message: String) {
    fulfillmentOrderAcceptFulfillmentRequest(id: $id, message: $message) {
      fulfillmentOrder { id status requestStatus }
      userErrors { field message }
    }
  }
`;

const REJECT_REQUEST = `#graphql
  mutation DropshipRejectFulfillmentRequest($id: ID!, $message: String, $reason: FulfillmentOrderRejectionReason) {
    fulfillmentOrderRejectFulfillmentRequest(id: $id, message: $message, reason: $reason) {
      fulfillmentOrder { id status requestStatus }
      userErrors { field message }
    }
  }
`;

const ACCEPT_CANCELLATION = `#graphql
  mutation DropshipAcceptCancellationRequest($id: ID!, $message: String) {
    fulfillmentOrderAcceptCancellationRequest(id: $id, message: $message) {
      fulfillmentOrder { id status requestStatus }
      userErrors { field message }
    }
  }
`;

const REJECT_CANCELLATION = `#graphql
  mutation DropshipRejectCancellationRequest($id: ID!, $message: String) {
    fulfillmentOrderRejectCancellationRequest(id: $id, message: $message) {
      fulfillmentOrder { id status requestStatus }
      userErrors { field message }
    }
  }
`;

export type RejectionReason =
  | "INCORRECT_ADDRESS"
  | "INVENTORY_OUT_OF_STOCK"
  | "INELIGIBLE_PRODUCT"
  | "UNDELIVERABLE_DESTINATION"
  | "OTHER";

export async function acceptFulfillmentRequest(client: GraphqlClient, fulfillmentOrderId: string, message?: string) {
  const data = await gql<{
    fulfillmentOrderAcceptFulfillmentRequest: {
      fulfillmentOrder: { id: string; status: string; requestStatus: string } | null;
      userErrors: UserError[];
    };
  }>(client, ACCEPT_REQUEST, { id: fulfillmentOrderId, message: message ?? null });
  assertNoUserErrors(data.fulfillmentOrderAcceptFulfillmentRequest.userErrors, "fulfillmentOrderAcceptFulfillmentRequest");
  return data.fulfillmentOrderAcceptFulfillmentRequest.fulfillmentOrder;
}

export async function rejectFulfillmentRequest(
  client: GraphqlClient,
  fulfillmentOrderId: string,
  message: string,
  reason: RejectionReason = "OTHER",
) {
  const data = await gql<{
    fulfillmentOrderRejectFulfillmentRequest: {
      fulfillmentOrder: { id: string; status: string; requestStatus: string } | null;
      userErrors: UserError[];
    };
  }>(client, REJECT_REQUEST, { id: fulfillmentOrderId, message, reason });
  assertNoUserErrors(data.fulfillmentOrderRejectFulfillmentRequest.userErrors, "fulfillmentOrderRejectFulfillmentRequest");
  return data.fulfillmentOrderRejectFulfillmentRequest.fulfillmentOrder;
}

export async function acceptCancellationRequest(client: GraphqlClient, fulfillmentOrderId: string, message?: string) {
  const data = await gql<{ fulfillmentOrderAcceptCancellationRequest: { userErrors: UserError[] } }>(
    client,
    ACCEPT_CANCELLATION,
    { id: fulfillmentOrderId, message: message ?? null },
  );
  assertNoUserErrors(data.fulfillmentOrderAcceptCancellationRequest.userErrors, "fulfillmentOrderAcceptCancellationRequest");
}

export async function rejectCancellationRequest(client: GraphqlClient, fulfillmentOrderId: string, message: string) {
  const data = await gql<{ fulfillmentOrderRejectCancellationRequest: { userErrors: UserError[] } }>(
    client,
    REJECT_CANCELLATION,
    { id: fulfillmentOrderId, message },
  );
  assertNoUserErrors(data.fulfillmentOrderRejectCancellationRequest.userErrors, "fulfillmentOrderRejectCancellationRequest");
}

// ---------------------------------------------------------------------------
// Moving inventory onto the app's location
// ---------------------------------------------------------------------------

// The @idempotent key is REQUIRED on this mutation from Admin API 2026-04
// onwards, and this app pins 2026-07. Without it every assignment is rejected -
// which is why assigning products to the fulfilment service could never succeed.
/**
 * A stable idempotency key. Shopify requires one on the inventory mutations from
 * API 2026-04; deriving it from the payload means a genuine retry of the same
 * write reuses it, which is the entire point. A fresh uuid per attempt would
 * satisfy the API and protect nothing.
 */
function idempotencyKey(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 36);
}

const INVENTORY_ACTIVATE = `#graphql
  mutation DropshipInventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int, $key: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $key) {
      inventoryLevel { id quantities(names: ["available"]) { name quantity } }
      userErrors { field message }
    }
  }
`;

const INVENTORY_DEACTIVATE = `#graphql
  mutation DropshipInventoryDeactivate($inventoryLevelId: ID!) {
    inventoryDeactivate(inventoryLevelId: $inventoryLevelId) {
      userErrors { field message }
    }
  }
`;

const INVENTORY_LEVELS_QUERY = `#graphql
  query DropshipInventoryLevels($inventoryItemId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      id
      inventoryLevels(first: 20) {
        nodes { id location { id name } quantities(names: ["available"]) { name quantity } }
      }
    }
  }
`;

/**
 * Stock a variant at the app's fulfilment location so Shopify routes its
 * fulfilment orders to us. Existing locations are left alone — a merchant may
 * legitimately stock the same SKU in their own warehouse too.
 */
export async function assignVariantToLocation(
  client: GraphqlClient,
  inventoryItemId: string,
  locationId: string,
  available: number,
) {
  const data = await gql<{ inventoryActivate: { userErrors: UserError[] } }>(client, INVENTORY_ACTIVATE, {
    inventoryItemId,
    locationId,
    available: Math.max(0, available),
    key: idempotencyKey("inventoryActivate", inventoryItemId, locationId, available),
  });
  assertNoUserErrors(data.inventoryActivate.userErrors, "inventoryActivate");
}

export async function inventoryLevelsFor(client: GraphqlClient, inventoryItemId: string) {
  const data = await gql<{
    inventoryItem: {
      inventoryLevels: {
        nodes: Array<{ id: string; location: { id: string; name: string }; quantities: Array<{ name: string; quantity: number }> }>;
      };
    } | null;
  }>(client, INVENTORY_LEVELS_QUERY, { inventoryItemId });
  return (data.inventoryItem?.inventoryLevels.nodes ?? []).map((n) => ({
    id: n.id,
    locationId: n.location.id,
    locationName: n.location.name,
    available: n.quantities.find((q) => q.name === "available")?.quantity ?? 0,
  }));
}

export async function deactivateInventoryLevel(client: GraphqlClient, inventoryLevelId: string) {
  const data = await gql<{ inventoryDeactivate: { userErrors: UserError[] } }>(client, INVENTORY_DEACTIVATE, {
    inventoryLevelId,
  });
  assertNoUserErrors(data.inventoryDeactivate.userErrors, "inventoryDeactivate");
}
