/**
 * The Admin GraphQL wrapper's retry and error policy.
 *
 * The failures these guard against were all invisible in normal use: with
 * @shopify/shopify-api 14 the client throws before `gql` reads the body, so the
 * throttle backoff never ran, every error was retried three times whether or not
 * it could succeed, a timed-out first push could be replayed into a duplicate
 * listing, and a single redacted customer field made an order fail to sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "~/lib/errors";
import {
  classifyTransportError,
  envelopeFromThrown,
  gql,
  gqlInternals,
  gqlResult,
  hasIdempotencyKey,
  isMissingScopeError,
  isMutation,
  operationIdempotencyKey,
  redactionAccepted,
  throttleWaitMs,
  type GraphqlClient,
} from "~/services/shopify/graphql.server";

vi.mock("~/shopify.server", () => ({ unauthenticated: {} }));
vi.mock("~/lib/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const QUERY = `#graphql
  query DropshipShop { shop { name } }
`;
const MUTATION = `#graphql
  mutation DropshipProductSet($input: ProductSetInput!) {
    productSet(input: $input) { product { id } userErrors { field message } }
  }
`;
const IDEMPOTENT_MUTATION = `#graphql
  mutation DropshipInventorySet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { field message } }
  }
`;

/** What @shopify/shopify-api 14 throws for a 200 response carrying `errors`. */
class FakeGraphqlQueryError extends Error {
  body: unknown;
  constructor(body: { data?: unknown; errors: unknown[]; extensions?: unknown }) {
    super("GraphQL operation failed");
    this.body = {
      data: body.data,
      extensions: body.extensions,
      errors: { networkStatusCode: 200, message: "GraphQL Client: An error occurred", graphQLErrors: body.errors },
    };
  }
}

class FakeHttpRequestError extends Error {}

class FakeHttpResponseError extends Error {
  response: { code: number; statusText: string; body: unknown; headers: Record<string, string>; retryAfter?: number };
  constructor(code: number, retryAfter?: number) {
    super(`Received an error response (${code})`);
    this.response = { code, statusText: "", body: {}, headers: {}, retryAfter };
  }
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });

function scripted(steps: Array<() => Promise<Response>>) {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const client: GraphqlClient = async (_query, options) => {
    calls.push(options?.variables);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return step();
  };
  return { client, calls };
}

const throttled = (currentlyAvailable = 10) =>
  new FakeGraphqlQueryError({
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    extensions: {
      cost: { requestedQueryCost: 110, actualQueryCost: null, throttleStatus: { maximumAvailable: 1000, currentlyAvailable, restoreRate: 50 } },
    },
  });

let sleeps: number[];
beforeEach(() => {
  sleeps = [];
  vi.spyOn(gqlInternals, "sleep").mockImplementation(async (ms: number) => {
    sleeps.push(ms);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("operation detection", () => {
  it("tells mutations from queries, including queries with a `query:` argument", () => {
    expect(isMutation(MUTATION)).toBe(true);
    expect(isMutation(QUERY)).toBe(false);
    expect(isMutation(`query X($query: String) { products(first: 1, query: $query) { nodes { id } } }`)).toBe(false);
    expect(isMutation(`#graphql mutation in a comment\nquery Y { shop { name } }`)).toBe(false);
  });

  it("spots the @idempotent directive", () => {
    expect(hasIdempotencyKey(IDEMPOTENT_MUTATION)).toBe(true);
    expect(hasIdempotencyKey(MUTATION)).toBe(false);
  });
});

describe("throttling", () => {
  it("waits for the bucket to hold the requested cost, then succeeds", async () => {
    const { client, calls } = scripted([
      () => Promise.reject(throttled(10)),
      () => Promise.resolve(ok({ shop: { name: "Store" } })),
    ]);
    await expect(gql(client, QUERY)).resolves.toEqual({ shop: { name: "Store" } });
    expect(calls).toHaveLength(2);
    // (110 - 10) points at 50/s is two seconds, plus the margin.
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[0]).toBeLessThan(3000);
  });

  it("retries a throttled mutation too, because Shopify refused it before executing", async () => {
    const { client, calls } = scripted([
      () => Promise.reject(throttled()),
      () => Promise.resolve(ok({ productSet: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } })),
    ]);
    await gql(client, MUTATION, { input: {} });
    expect(calls).toHaveLength(2);
  });

  it("handles the throttle when the body is returned rather than thrown", async () => {
    const body = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
    const { client, calls } = scripted([
      () => Promise.resolve(new Response(JSON.stringify(body))),
      () => Promise.resolve(ok({ shop: { name: "Store" } })),
    ]);
    await gql(client, QUERY);
    expect(calls).toHaveLength(2);
  });

  it("gives up on a query that costs more than the bucket can ever hold", async () => {
    const tooBig = new FakeGraphqlQueryError({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: { cost: { requestedQueryCost: 1200, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 50 } } },
    });
    const { client, calls } = scripted([() => Promise.reject(tooBig)]);
    await expect(gql(client, QUERY)).rejects.toBeInstanceOf(AppError);
    expect(calls).toHaveLength(1);
  });

  it("backs off on an HTTP 429 using Retry-After", () => {
    expect(classifyTransportError(new FakeHttpResponseError(429, 2))).toEqual({ kind: "throttled", waitMs: 2000 });
    expect(classifyTransportError(new Response("", { status: 429 }))).toEqual({ kind: "throttled", waitMs: 1000 });
  });

  it("computes the wait from the cost report and caps it", () => {
    const status = { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 };
    expect(throttleWaitMs({ requestedQueryCost: 1000, throttleStatus: status }, 1)).toBe(20_250);
    expect(throttleWaitMs({ requestedQueryCost: 1000, throttleStatus: { ...status, restoreRate: 10 } }, 1)).toBe(30_000);
    expect(throttleWaitMs(undefined, 2)).toBe(2000);
  });
});

describe("errors that cannot succeed on retry", () => {
  it("throws a validation error at once", async () => {
    const invalid = new FakeGraphqlQueryError({ errors: [{ message: "Field 'nope' doesn't exist on type 'Shop'" }] });
    const { client, calls } = scripted([() => Promise.reject(invalid)]);
    const error = await gql(client, QUERY).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SHOPIFY_GRAPHQL");
    expect((error as AppError).retryable).toBe(false);
    expect((error as AppError).message).toContain("doesn't exist");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("passes a 401 Response through untouched, since it is the re-authentication signal", async () => {
    const unauthorised = new Response("", { status: 401 });
    const { client, calls } = scripted([() => Promise.reject(unauthorised)]);
    await expect(gql(client, QUERY)).rejects.toBe(unauthorised);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 4xx HTTP error", async () => {
    const forbidden = new FakeHttpResponseError(403);
    const { client, calls } = scripted([() => Promise.reject(forbidden)]);
    await expect(gql(client, QUERY)).rejects.toBe(forbidden);
    expect(calls).toHaveLength(1);
  });
});

describe("replay safety after an ambiguous failure", () => {
  it("retries a query after a dropped connection", async () => {
    const { client, calls } = scripted([
      () => Promise.reject(new FakeHttpRequestError("socket hang up")),
      () => Promise.resolve(ok({ shop: { name: "Store" } })),
    ]);
    await gql(client, QUERY);
    expect(calls).toHaveLength(2);
  });

  it("does not replay a plain mutation that may already have been applied", async () => {
    const { client, calls } = scripted([
      () => Promise.reject(new FakeHttpRequestError("socket hang up")),
      () => Promise.resolve(ok({ productSet: { product: { id: "gid://shopify/Product/2" }, userErrors: [] } })),
    ]);
    const error = await gql(client, MUTATION, { input: { title: "Lamp" } }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SHOPIFY_GRAPHQL_UNCONFIRMED");
    expect(calls).toHaveLength(1);
  });

  it("does not replay a plain mutation after a 502 either", async () => {
    const { client, calls } = scripted([() => Promise.reject(new FakeHttpResponseError(502))]);
    await expect(gql(client, MUTATION, { input: {} })).rejects.toBeInstanceOf(AppError);
    expect(calls).toHaveLength(1);
  });

  it("replays a mutation carrying @idempotent with the very same key", async () => {
    const { client, calls } = scripted([
      () => Promise.reject(new FakeHttpRequestError("ETIMEDOUT")),
      () => Promise.resolve(ok({ inventorySetQuantities: { userErrors: [] } })),
    ]);
    await gql(client, IDEMPOTENT_MUTATION, { input: {}, key: "k-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe("k-1");
    expect(calls[1]?.key).toBe("k-1");
  });

  it("replays a mutation the caller marks replay-safe", async () => {
    const { client, calls } = scripted([
      () => Promise.reject(new FakeHttpResponseError(503)),
      () => Promise.resolve(ok({ productSet: { product: { id: "gid://shopify/Product/3" }, userErrors: [] } })),
    ]);
    await gql(client, MUTATION, { input: { id: "gid://shopify/Product/3" } }, { replaySafe: true });
    expect(calls).toHaveLength(2);
  });
});

describe("protected customer data", () => {
  const redacted = () =>
    new FakeGraphqlQueryError({
      data: { order: { id: "gid://shopify/Order/1", name: "#1001", shippingAddress: null, phone: null } },
      errors: [
        { message: "This app is not approved to access the Order object.", path: ["order", "shippingAddress"] },
        { message: "Access denied for phone field.", path: ["order", "phone"], extensions: { code: "ACCESS_DENIED" } },
      ],
    });

  it("keeps the data Shopify did return and reports what it withheld, when the caller opts in", async () => {
    const { client, calls } = scripted([() => Promise.reject(redacted())]);
    const result = await gqlResult<{ order: { name: string } }>(client, QUERY, undefined, { allowRedacted: true });
    expect(result.data.order.name).toBe("#1001");
    expect(result.deniedPaths).toEqual([
      ["order", "shippingAddress"],
      ["order", "phone"],
    ]);
    expect(calls).toHaveLength(1);
  });

  it("throws SHOPIFY_ACCESS_DENIED without the opt-in, so a denied field never reads as null", async () => {
    const { client } = scripted([() => Promise.reject(redacted())]);
    const error = await gqlResult(client, QUERY).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("keeps gql strict even when a caller passes the opt-in through", async () => {
    const { client } = scripted([() => Promise.reject(redacted())]);
    const options = { allowRedacted: true } as unknown as Parameters<typeof gql>[3];
    const error = await gql(client, QUERY, undefined, options).catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("throws on a denial returned in the body as well as a thrown one", async () => {
    const { client } = scripted([
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { product: null },
              errors: [{ message: "Access denied for product field.", path: ["product"], extensions: { code: "ACCESS_DENIED" } }],
            }),
          ),
        ),
    ]);
    const error = await gql(client, QUERY).catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("never accepts a missing access scope as redaction, even with the opt-in", async () => {
    const scope = new FakeGraphqlQueryError({
      data: { order: { name: "#1001", customer: null } },
      errors: [
        {
          message: "Access denied for customer field. Required access: `read_customers` access scope.",
          path: ["order", "customer"],
          extensions: { code: "ACCESS_DENIED" },
        },
      ],
    });
    const { client } = scripted([() => Promise.reject(scope)]);
    const error = await gqlResult(client, QUERY, undefined, { allowRedacted: true }).catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
  });

  it("accepts only the paths a narrowing predicate allows", async () => {
    const onlyShipping = (path: Array<string | number>) => path[1] === "shippingAddress";
    const { client } = scripted([() => Promise.reject(redacted())]);
    const error = await gqlResult(client, QUERY, undefined, { allowRedacted: onlyShipping }).catch((e) => e);
    expect((error as AppError).code).toBe("SHOPIFY_ACCESS_DENIED");
    expect(redactionAccepted([{ message: "not approved to access", path: ["order", "shippingAddress"] }], onlyShipping)).toBe(true);
    expect(redactionAccepted([{ message: "not approved to access" }], onlyShipping)).toBe(false);
    expect(isMissingScopeError({ message: "Required access: `read_orders` access scope." })).toBe(true);
    expect(isMissingScopeError({ message: "This app is not approved to access the Order object." })).toBe(false);
  });

  it("still throws when a denial comes with another kind of error", async () => {
    const mixed = new FakeGraphqlQueryError({
      data: { order: null },
      errors: [
        { message: "This app is not approved to access the Order object.", path: ["order", "phone"] },
        { message: "Internal error" },
      ],
    });
    const { client } = scripted([() => Promise.reject(mixed)]);
    await expect(gql(client, QUERY)).rejects.toBeInstanceOf(AppError);
  });

  it("never treats a mutation's errors as a partial success", async () => {
    const denied = new FakeGraphqlQueryError({
      data: { orderUpdate: null },
      errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" }, path: ["orderUpdate"] }],
    });
    const { client } = scripted([() => Promise.reject(denied)]);
    await expect(gql(client, MUTATION, { input: {} })).rejects.toBeInstanceOf(AppError);
  });
});

describe("envelopeFromThrown", () => {
  it("ignores errors that carry no GraphQL body", () => {
    expect(envelopeFromThrown(new Error("boom"))).toBeNull();
    expect(envelopeFromThrown(new Response("", { status: 500 }))).toBeNull();
    expect(envelopeFromThrown(new FakeHttpResponseError(500))).toBeNull();
  });
});

describe("operationIdempotencyKey", () => {
  it("gives a fresh key per call when there is no operation to tie it to", () => {
    const a = operationIdempotencyKey("inventorySetQuantities", null, "loc", [{ q: 10 }]);
    const b = operationIdempotencyKey("inventorySetQuantities", null, "loc", [{ q: 10 }]);
    expect(a).not.toBe(b);
  });

  it("repeats the key for a retry of the same operation and payload only", () => {
    const first = operationIdempotencyKey("inventorySetQuantities", "job-1", "loc", [{ q: 10 }]);
    expect(operationIdempotencyKey("inventorySetQuantities", "job-1", "loc", [{ q: 10 }])).toBe(first);
    // The next scheduled run writing the same quantity is a new write.
    expect(operationIdempotencyKey("inventorySetQuantities", "job-2", "loc", [{ q: 10 }])).not.toBe(first);
    // A retry that computed different stock must not collide with the original.
    expect(operationIdempotencyKey("inventorySetQuantities", "job-1", "loc", [{ q: 9 }])).not.toBe(first);
  });
});
