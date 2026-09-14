import { createHash, randomUUID } from "node:crypto";
import { AppError, errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { unauthenticated } from "~/shopify.server";

/**
 * The shape shared by `admin.graphql` (authenticated request context) and the
 * client returned by `unauthenticated.admin(shop)` (background jobs).
 */
export type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown>; headers?: Record<string, string> },
) => Promise<Response>;

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface GraphqlError {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string; [key: string]: unknown };
}

interface CostExtension {
  requestedQueryCost?: number | null;
  actualQueryCost?: number | null;
  throttleStatus?: { currentlyAvailable: number; restoreRate: number; maximumAvailable: number };
}

/** A GraphQL response, whichever way the client handed it to us. */
export interface GraphqlEnvelope<T = unknown> {
  data?: T | null;
  errors: GraphqlError[];
  extensions?: { cost?: CostExtension };
}

export interface GqlOptions {
  /**
   * The caller asserts that sending this mutation twice leaves Shopify in the
   * same state as sending it once — in practice a `productSet` that upserts on
   * a known product id.
   *
   * Only replay-safe operations are retried after a failure that may have
   * happened *after* Shopify executed the request (a dropped connection, a
   * 502). Queries and mutations carrying `@idempotent` are replay-safe on their
   * own; everything else defaults to "tell the caller, do not guess".
   */
  replaySafe?: boolean;
  /**
   * Accept a response in which Shopify withheld some fields, and return the
   * rest with the withheld paths listed in `deniedPaths`.
   *
   * Off by default, because Shopify reports two very different things with the
   * same ACCESS_DENIED code: protected customer data the app is not approved
   * for, and an access scope the app does not have. Treating every denial as
   * "partial data" turned a missing scope into a silent null, and callers read
   * null as "gone": a product was deleted locally, a fulfilment order list came
   * back empty and tracking was retired. Only a caller that knows which fields
   * may legitimately be redacted opts in, and a function narrows it further to
   * exactly those paths. A missing scope is never accepted either way.
   */
  allowRedacted?: boolean | ((path: Array<string | number>) => boolean);
}

export interface GqlResult<T> {
  data: T;
  /**
   * Paths Shopify withheld because the app is not approved for that protected
   * customer data. The rest of `data` is real; these fields read as null.
   */
  deniedPaths: Array<Array<string | number>>;
}

const MAX_ATTEMPTS = 5;
/** A 1,000-point query against an empty bucket restoring 50/s waits 20 s. */
const MAX_THROTTLE_WAIT_MS = 30_000;

/** Indirection so tests can run the retry loop without real sleeps. */
export const gqlInternals = {
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * Run a query and unwrap `data`.
 *
 * Throttling is retried after the wait Shopify's cost report asks for, for any
 * operation: a throttled request was refused before execution, so replaying it
 * cannot double anything. Other GraphQL errors are not retried at all — a
 * validation error fails the same way every time. Transport failures (network,
 * 5xx) are retried only for replay-safe operations; see GqlOptions.replaySafe.
 */
export async function gql<T>(
  client: GraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  options: Omit<GqlOptions, "allowRedacted"> = {},
): Promise<T> {
  // Always strict: `gql` has nowhere to report withheld paths, so accepting a
  // redaction here would hand the caller nulls with no way to tell why.
  return (await gqlResult<T>(client, query, variables, { ...options, allowRedacted: false })).data;
}

/**
 * As `gql`, but also reports which fields Shopify redacted for lack of
 * protected-customer-data approval, so a caller can record why they are empty.
 * Redaction is only accepted with `options.allowRedacted`; without it an access
 * denial throws SHOPIFY_ACCESS_DENIED exactly as `gql` does.
 */
export async function gqlResult<T>(
  client: GraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  options: GqlOptions = {},
): Promise<GqlResult<T>> {
  const mutation = isMutation(query);
  const replaySafe = !mutation || hasIdempotencyKey(query) || options.replaySafe === true;
  const operation = operationName(query);

  for (let attempt = 1; ; attempt += 1) {
    let envelope: GraphqlEnvelope<T>;
    try {
      const response = await client(query, { variables });
      envelope = envelopeFromBody<T>(await response.json());
    } catch (error) {
      // @shopify/shopify-api 14 throws GraphqlQueryError for any 200 response
      // that carries `errors`, before this function ever sees the body. Its
      // `body` is the full client response, cost extension and partial data
      // included, so the handling below still applies to it.
      const fromThrown = envelopeFromThrown<T>(error);
      if (!fromThrown) {
        const failure = classifyTransportError(error);
        if (failure.kind === "fatal" || attempt >= MAX_ATTEMPTS) throw error;
        if (failure.kind === "throttled") {
          logger.warn("Shopify GraphQL rate limited (HTTP 429); backing off", { operation, attempt, waitMs: failure.waitMs });
          await gqlInternals.sleep(failure.waitMs);
          continue;
        }
        if (!replaySafe) {
          // The request may have reached Shopify and been executed before the
          // connection dropped. Sending it again could create a second product
          // or a second fulfilment service, so the decision goes back to the
          // caller, who can look before trying again.
          throw new AppError(
            "SHOPIFY_GRAPHQL_UNCONFIRMED",
            `Shopify did not confirm ${operation}; it may or may not have been applied: ${errorMessage(error)}`,
            { retryable: false, cause: error, details: { operation } },
          );
        }
        logger.warn("Shopify GraphQL transport error; retrying", { operation, attempt, error: errorMessage(error) });
        await gqlInternals.sleep(300 * attempt);
        continue;
      }
      envelope = fromThrown;
    }

    if (envelope.errors.length === 0) {
      if (envelope.data === undefined || envelope.data === null) {
        if (replaySafe && attempt < MAX_ATTEMPTS) {
          await gqlInternals.sleep(300 * attempt);
          continue;
        }
        throw new AppError("SHOPIFY_GRAPHQL", `Empty GraphQL response for ${operation}`, { retryable: replaySafe });
      }
      return { data: envelope.data, deniedPaths: [] };
    }

    if (envelope.errors.some(isThrottleError)) {
      const waitMs = throttleWaitMs(envelope.extensions?.cost, attempt);
      if (waitMs === null) {
        throw new AppError("SHOPIFY_GRAPHQL", `${operation} costs more than this store's rate limit bucket holds`, {
          details: { errors: envelope.errors, cost: envelope.extensions?.cost },
        });
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new AppError("SHOPIFY_THROTTLED", `Shopify kept throttling ${operation}`, {
          retryable: true,
          details: { errors: envelope.errors },
        });
      }
      logger.warn("Shopify GraphQL throttled; backing off", { operation, attempt, waitMs });
      await gqlInternals.sleep(waitMs);
      continue;
    }

    if (envelope.errors.every(isAccessDeniedError)) {
      // Protected customer data: "unapproved fields will be redacted", with the
      // reason in `errors` and everything else in `data`. Throwing here turned an
      // unapproved phone number into an order that never synced at all, so a
      // caller that expects it (see GqlOptions.allowRedacted) gets the rest.
      const deniedPaths = envelope.errors.map((e) => e.path ?? []);
      if (!mutation && envelope.data && redactionAccepted(envelope.errors, options.allowRedacted)) {
        logger.warn("Shopify redacted protected customer data", {
          operation,
          paths: [...new Set(deniedPaths.map(pathKey))],
        });
        return { data: envelope.data, deniedPaths };
      }
      throw new AppError("SHOPIFY_ACCESS_DENIED", `Shopify denied access in ${operation}: ${envelope.errors.map((e) => e.message).join("; ")}`, {
        retryable: false,
        details: { operation, errors: envelope.errors },
      });
    }

    throw new AppError("SHOPIFY_GRAPHQL", envelope.errors.map((e) => e.message).join("; "), {
      retryable: false,
      details: { operation, errors: envelope.errors },
    });
  }
}

/**
 * The `@idempotent` key for one write.
 *
 * Shopify remembers a key for 24 hours and answers a repeat from cache without
 * writing. The key used to be a hash of the payload alone, so the hourly sync
 * setting a variant back to 10 after sales took it to 7 sent the same key as
 * the previous hour's "10", and Shopify replied from cache: stock stayed at 7.
 *
 * A key therefore names one operation. Retries inside `gql` resend the same
 * variables and so the same key, which is the protection the key exists for.
 * A caller that retries a whole operation (a job attempt) passes its own stable
 * `operationId`; the payload stays in the hash so that a retry which computed
 * different quantities is a new write rather than a parameter mismatch.
 */
export function operationIdempotencyKey(mutation: string, operationId: string | null | undefined, ...payload: unknown[]): string {
  if (!operationId) return randomUUID();
  return createHash("sha256").update(JSON.stringify([mutation, operationId, ...payload])).digest("hex").slice(0, 36);
}

/** Throw when a mutation payload carries userErrors. */
export function assertNoUserErrors(
  userErrors: UserError[] | undefined | null,
  context: string,
): void {
  if (!userErrors || userErrors.length === 0) return;
  throw new AppError(
    "SHOPIFY_USER_ERROR",
    `${context}: ${userErrors.map((e) => `${e.field?.join(".") ?? "?"}: ${e.message}`).join("; ")}`,
    { details: { userErrors } },
  );
}

/** Background-job client for a shop, using its offline session. */
export async function offlineClient(shopDomain: string): Promise<GraphqlClient> {
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin.graphql as unknown as GraphqlClient;
}

export function gid(type: string, id: string | number): string {
  const raw = String(id);
  return raw.startsWith("gid://") ? raw : `gid://shopify/${type}/${raw}`;
}

export function legacyId(id: string | number | null | undefined): string {
  if (id === null || id === undefined) return "";
  const raw = String(id);
  const idx = raw.lastIndexOf("/");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

/** Iterate a Relay connection until exhausted. */
export async function* paginate<TNode>(
  client: GraphqlClient,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: unknown) => { nodes: TNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
): AsyncGenerator<TNode> {
  let after: string | null = null;
  do {
    const data = await gql<unknown>(client, query, { ...variables, after });
    const page = pick(data);
    for (const node of page.nodes) yield node;
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
}

// ---------------------------------------------------------------------------
// Response and error classification (exported for tests)
// ---------------------------------------------------------------------------

function stripComments(query: string): string {
  return query.replace(/#[^\n]*/g, " ");
}

export function isMutation(query: string): boolean {
  return /(?:^|[\s}])mutation(?=[\s({@])/.test(stripComments(query));
}

export function hasIdempotencyKey(query: string): boolean {
  return /@idempotent\s*\(/.test(stripComments(query));
}

function operationName(query: string): string {
  return /(?:query|mutation)\s+(\w+)/.exec(stripComments(query))?.[1] ?? "GraphQL operation";
}

export function envelopeFromBody<T>(body: unknown): GraphqlEnvelope<T> {
  const raw = (body ?? {}) as { data?: T | null; errors?: unknown; extensions?: GraphqlEnvelope["extensions"] };
  return { data: raw.data, errors: normaliseErrors(raw.errors), extensions: raw.extensions };
}

/**
 * The GraphQL response inside an error thrown by the Shopify client, or null
 * when the error is not a GraphQL-level failure.
 *
 * Duck-typed rather than `instanceof GraphqlQueryError`: the Remix package can
 * resolve its own copy of @shopify/shopify-api, and a class check against the
 * other copy silently fails.
 */
export function envelopeFromThrown<T>(error: unknown): GraphqlEnvelope<T> | null {
  if (!error || typeof error !== "object" || error instanceof Response) return null;
  const body = (error as { body?: unknown }).body as
    | { data?: T | null; errors?: { graphQLErrors?: unknown }; extensions?: GraphqlEnvelope["extensions"] }
    | undefined;
  const graphQLErrors = body?.errors?.graphQLErrors;
  if (!body || !Array.isArray(graphQLErrors)) return null;
  return { data: body.data, errors: normaliseErrors(graphQLErrors), extensions: body.extensions };
}

function normaliseErrors(errors: unknown): GraphqlError[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => {
    const item = (e ?? {}) as Partial<GraphqlError>;
    return { message: String(item.message ?? "GraphQL error"), path: item.path, extensions: item.extensions };
  });
}

export function isThrottleError(error: GraphqlError): boolean {
  return error.extensions?.code === "THROTTLED" || /^throttled$/i.test(error.message.trim());
}

export function isAccessDeniedError(error: GraphqlError): boolean {
  return error.extensions?.code === "ACCESS_DENIED" || /not approved to access|access denied/i.test(error.message);
}

/**
 * A denial caused by an access scope the app was not granted, as opposed to
 * protected customer data it is not approved for. Shopify words the first as
 * "Required access: `read_x` access scope"; that is a configuration fault to
 * surface, never a field to leave empty.
 */
export function isMissingScopeError(error: GraphqlError): boolean {
  return /access scope|required access/i.test(error.message);
}

/** Whether every denial in a response is a redaction the caller said it can live with. */
export function redactionAccepted(errors: GraphqlError[], allow: GqlOptions["allowRedacted"]): boolean {
  if (!allow || errors.length === 0) return false;
  return errors.every((e) => {
    if (isMissingScopeError(e)) return false;
    if (allow === true) return true;
    // A denial with no path withheld something unnamed; nothing narrower than
    // "accept anything" can vouch for it.
    return Array.isArray(e.path) && e.path.length > 0 && allow(e.path);
  });
}

/**
 * How long to wait before a throttled request can pass, from the cost report.
 * Null when it never can: the query asks for more than the bucket holds.
 */
export function throttleWaitMs(cost: CostExtension | undefined, attempt: number): number | null {
  const status = cost?.throttleStatus;
  const requested = cost?.requestedQueryCost;
  if (!status || typeof requested !== "number" || !(status.restoreRate > 0)) {
    return Math.min(MAX_THROTTLE_WAIT_MS, 1000 * attempt);
  }
  if (requested > status.maximumAvailable) return null;
  const deficit = Math.max(0, requested - status.currentlyAvailable);
  // A small margin, because the bucket keeps draining from other requests on
  // the same shop while this one sleeps.
  return Math.min(MAX_THROTTLE_WAIT_MS, Math.ceil((deficit / status.restoreRate) * 1000) + 250 * attempt);
}

export type TransportFailure = { kind: "throttled"; waitMs: number } | { kind: "transient" } | { kind: "fatal" };

/**
 * What a non-GraphQL failure means for a retry.
 *
 * In an authenticated request the Remix package converts HTTP errors into a
 * thrown `Response`, and a 401 there is its re-authentication signal: it must
 * travel up untouched, never be retried or wrapped.
 */
export function classifyTransportError(error: unknown): TransportFailure {
  if (error instanceof Response) {
    if (error.status === 429) return { kind: "throttled", waitMs: 1000 };
    if (error.status >= 500) return { kind: "transient" };
    return { kind: "fatal" };
  }
  if (error instanceof AppError) return { kind: "fatal" };
  const response = (error as { response?: { code?: unknown; retryAfter?: unknown } } | null)?.response;
  if (response && typeof response.code === "number") {
    if (response.code === 429) {
      const retryAfter = typeof response.retryAfter === "number" ? response.retryAfter * 1000 : 1000;
      return { kind: "throttled", waitMs: Math.min(MAX_THROTTLE_WAIT_MS, Math.max(250, retryAfter)) };
    }
    if (response.code >= 500) return { kind: "transient" };
    return { kind: "fatal" };
  }
  // No HTTP response at all: a dropped connection, DNS failure or timeout.
  return { kind: "transient" };
}

function pathKey(path: Array<string | number>): string {
  return path.filter((p) => typeof p === "string").join(".");
}
