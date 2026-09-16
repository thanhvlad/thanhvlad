/**
 * The one Shopify test order used to exercise the extension checkout assist.
 *
 * Creates it as a Shopify test order (never a real sale, left out of reports
 * and payouts), paid through the manual gateway, with a fictitious address and
 * no customer, email or receipt, and without claiming inventory. Cancels it
 * afterwards without a notification or a restock. The tag keeps the two
 * commands honest: `create` refuses while an uncancelled test order exists,
 * and a create whose reply was lost is never re-sent blind.
 *
 *   node --env-file-if-exists=.env --import tsx/esm scripts/test-order.ts <shop-domain> status
 *   node --env-file-if-exists=.env --import tsx/esm scripts/test-order.ts <shop-domain> create <variantGid> [unitAmount]
 *   node --env-file-if-exists=.env --import tsx/esm scripts/test-order.ts <shop-domain> cancel <orderGid>
 */
import { bootJobs, shutdownQueue } from "../app/services/jobs/index.server";
import { getShopByDomain } from "../app/services/shop.server";
import { assertNoUserErrors, gql, offlineClient } from "../app/services/shopify/graphql.server";

const TAG = "dsh-extension-test";

/** A fictitious US address: the 555-01xx exchange is reserved, the street is invented. */
const TEST_ADDRESS = {
  firstName: "Test",
  lastName: "Customer",
  address1: "12345 Northwest Evergreen Parkway Suite 400",
  address2: "Bldg B",
  city: "Austin",
  provinceCode: "TX",
  countryCode: "US",
  zip: "78701",
  phone: "+1 512-555-0100",
};

const LOOKUP = /* GraphQL */ `
  query DshTestOrderLookup($query: String!) {
    orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes { id name test cancelledAt displayFinancialStatus displayFulfillmentStatus tags }
    }
  }
`;

// The selection deliberately asks for no email, phone, address or customer:
// with those fields, a store without protected-customer-data approval would
// answer a successful create with an access error, and a retry would create a
// second order.
const CREATE = /* GraphQL */ `
  mutation DshTestOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors { field message }
      order {
        id
        name
        test
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        tags
        totalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount } }
        lineItems(first: 5) { nodes { id quantity requiresShipping variant { id } originalUnitPriceSet { shopMoney { amount } } } }
      }
    }
  }
`;

const CANCEL = /* GraphQL */ `
  mutation DshTestOrderCancel($orderId: ID!, $staffNote: String) {
    orderCancel(orderId: $orderId, notifyCustomer: false, restock: false, reason: OTHER, staffNote: $staffNote) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

const ORDER_STATE = /* GraphQL */ `
  query DshTestOrderState($id: ID!) {
    order(id: $id) { id name test cancelledAt displayFinancialStatus displayFulfillmentStatus tags }
  }
`;

interface TestOrder {
  id: string;
  name: string;
  test: boolean;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  tags: string[];
}

const [domain, command, argument, amountArg] = process.argv.slice(2);
if (!domain || !["status", "create", "cancel"].includes(command ?? "")) {
  console.error("usage: test-order.ts <shop-domain> status | create <variantGid> [unitAmount] | cancel <orderGid>");
  process.exit(1);
}

bootJobs({ worker: false });

const shop = await getShopByDomain(domain);
if (!shop) {
  console.error(`No shop ${domain} in this database.`);
  process.exit(1);
}
const client = await offlineClient(shop.domain);

async function lookup(): Promise<TestOrder[]> {
  const data = await gql<{ orders: { nodes: TestOrder[] } }>(client, LOOKUP, { query: `tag:${TAG}` });
  return data.orders.nodes;
}

function print(value: unknown) {
  console.info(JSON.stringify(value, null, 2));
}

let exitCode = 0;

if (command === "status") {
  print({ testOrders: await lookup() });
} else if (command === "create") {
  const variantId = argument;
  const amount = amountArg ?? "1.00";
  if (!variantId?.startsWith("gid://shopify/ProductVariant/") || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    console.error("create needs a ProductVariant gid and an optional amount such as 1.00");
    process.exit(1);
  }

  const open = (await lookup()).filter((o) => !o.cancelledAt);
  if (open.length > 0) {
    console.error(`Refusing to create: ${open.length} uncancelled ${TAG} order(s) already exist.`);
    print({ testOrders: open });
    process.exit(3);
  }

  const money = { shopMoney: { amount, currencyCode: shop.currency } };
  const variables = {
    order: {
      test: true,
      currency: shop.currency,
      lineItems: [{ variantId, quantity: 1, requiresShipping: true, priceSet: money }],
      financialStatus: "PAID",
      transactions: [{ kind: "SALE", status: "SUCCESS", test: true, gateway: "manual", amountSet: money }],
      shippingAddress: TEST_ADDRESS,
      tags: [TAG],
      note: "DropshipHub extension end-to-end test. Not a real customer. Do not fulfil. Cancel after the test.",
    },
    options: { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false },
  };

  try {
    const data = await gql<{ orderCreate: { userErrors: Array<{ field?: string[]; message: string }>; order: unknown } }>(client, CREATE, variables);
    assertNoUserErrors(data.orderCreate.userErrors, "orderCreate");
    print({ created: data.orderCreate.order });
  } catch (error) {
    // The reply was lost after Shopify may have committed the order. Sending
    // again could create a second one, so show what the tag finds instead.
    if ((error as { code?: string })?.code === "SHOPIFY_GRAPHQL_UNCONFIRMED") {
      console.error("The create was not confirmed. Not retrying; this is what the tag finds now:");
      print({ testOrders: await lookup() });
      exitCode = 4;
    } else {
      throw error;
    }
  }
} else if (command === "cancel") {
  const orderId = argument;
  if (!orderId?.startsWith("gid://shopify/Order/")) {
    console.error("cancel needs an Order gid");
    process.exit(1);
  }
  const before = await gql<{ order: TestOrder | null }>(client, ORDER_STATE, { id: orderId });
  if (!before.order) {
    console.error("No such order.");
    process.exit(1);
  }
  if (!before.order.tags.includes(TAG) || !before.order.test) {
    console.error(`Refusing to cancel ${before.order.name}: it is not a ${TAG} test order.`);
    process.exit(3);
  }
  if (before.order.cancelledAt) {
    print({ alreadyCancelled: before.order });
  } else {
    const data = await gql<{ orderCancel: { job: { id: string; done: boolean } | null; orderCancelUserErrors: Array<{ field?: string[]; message: string; code?: string }> } }>(
      client,
      CANCEL,
      { orderId, staffNote: `DropshipHub extension test cleanup (${TAG})` },
    );
    assertNoUserErrors(data.orderCancel.orderCancelUserErrors, "orderCancel");
    // The cancel runs as a job; give it a moment and read the order back.
    let after: TestOrder | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      after = (await gql<{ order: TestOrder | null }>(client, ORDER_STATE, { id: orderId })).order;
      if (after?.cancelledAt) break;
    }
    print({ job: data.orderCancel.job, order: after });
    if (!after?.cancelledAt) exitCode = 5;
  }
}

await shutdownQueue();
process.exit(exitCode);
