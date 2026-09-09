import { AppError } from "~/lib/errors";
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

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number; restoreRate: number; maximumAvailable: number };
    };
  };
}

const MAX_ATTEMPTS = 4;

/**
 * Run a query and unwrap `data`, retrying on throttling and transient network
 * errors. Throws AppError("SHOPIFY_GRAPHQL") on GraphQL-level errors.
 */
export async function gql<T>(
  client: GraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const response = await client(query, { variables });
      const body = (await response.json()) as GraphqlEnvelope<T>;

      if (body.errors?.length) {
        const throttled = body.errors.some(
          (e) => e.extensions?.code === "THROTTLED" || /throttled/i.test(e.message),
        );
        if (throttled && attempt < MAX_ATTEMPTS) {
          const restore = body.extensions?.cost?.throttleStatus?.restoreRate ?? 50;
          const waitMs = Math.min(5000, Math.ceil((1000 / restore) * 100) * attempt);
          logger.warn("Shopify GraphQL throttled; backing off", { attempt, waitMs });
          await sleep(waitMs);
          continue;
        }
        throw new AppError("SHOPIFY_GRAPHQL", body.errors.map((e) => e.message).join("; "), {
          retryable: throttled,
          details: { errors: body.errors },
        });
      }
      if (!body.data) {
        throw new AppError("SHOPIFY_GRAPHQL", "Empty GraphQL response", { retryable: true });
      }
      return body.data;
    } catch (error) {
      lastError = error;
      if (error instanceof AppError && !error.retryable) throw error;
      if (attempt >= MAX_ATTEMPTS) break;
      await sleep(300 * attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AppError("SHOPIFY_GRAPHQL", "GraphQL request failed", { retryable: true });
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
