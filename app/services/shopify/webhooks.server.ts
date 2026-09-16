import type { Session } from "@shopify/shopify-api";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { assertNoUserErrors, gql, type GraphqlClient, type UserError } from "./graphql.server";

/**
 * Make sure a store will actually send us its events.
 *
 * Subscriptions can live in two places. Declared in shopify.app.toml and
 * pushed with `shopify app deploy`, they are app-level: every store that
 * installs gets them, and the Admin API's `webhookSubscriptions` query does not
 * even list them. Registered at runtime with `registerWebhooks`, they are
 * shop-level: one store at a time.
 *
 * This app's toml has never been deployed, so today every subscription is
 * shop-level, created for the first store by hand. A second store arriving got
 * nothing - it installed cleanly and then never heard about an order. Until
 * the config is deployed, each install registers its own; once it is, the flag
 * flips and the shop-level copies are removed instead, because a store holding
 * both receives every event twice under two different ids, which the
 * per-delivery dedupe cannot see through.
 */

// `uri`, not `endpoint`: the endpoint union is deprecated in 2026-07, and
// public apps must stay on supported fields.
const LIST = `#graphql
  query DropshipWebhookSubscriptions {
    webhookSubscriptions(first: 100) {
      nodes { id topic uri }
    }
  }
`;

const DELETE = `#graphql
  mutation DropshipWebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
  }
`;

/**
 * Returns the topics that could not be verified; an empty list means the store
 * is fully subscribed and the caller may skip the check for a while. The
 * session must be the offline one: registration run with a staff member's
 * online token fails for every topic that person has no permission for.
 */
export async function ensureWebhooks(
  session: Session,
  client: GraphqlClient,
  register: (options: { session: Session }) => Promise<unknown>,
): Promise<{ failed: string[] }> {
  if (!env().WEBHOOKS_FROM_APP_CONFIG) {
    const result = (await register({ session })) as Record<string, Array<{ success: boolean; result?: unknown }>> | undefined;
    const failed = failedTopics(result);
    const outcomes = Object.keys(result ?? {});
    if (failed.length) logger.error("Webhook registration failed for some topics", { shop: session.shop, topics: outcomes.length, failed });
    else logger.info("Webhooks registered for shop", { shop: session.shop, topics: outcomes.length });
    return { failed };
  }

  // App-level subscriptions are in force: anything shop-level pointing at us
  // is now a duplicate delivery.
  const host = new URL(env().SHOPIFY_APP_URL).host;
  const data = await gql<{ webhookSubscriptions: { nodes: Array<{ id: string; topic: string; uri: string | null }> } }>(client, LIST);
  const ours = data.webhookSubscriptions.nodes.filter((n) => pointsAtHost(n.uri, host));
  for (const sub of ours) {
    const out = await gql<{ webhookSubscriptionDelete: { userErrors: UserError[] } }>(client, DELETE, { id: sub.id });
    assertNoUserErrors(out.webhookSubscriptionDelete.userErrors, "webhookSubscriptionDelete");
  }
  if (ours.length) logger.info("Removed shop-level webhook duplicates", { shop: session.shop, removed: ours.length });
  return { failed: [] };
}

/** Topics with at least one unsuccessful registration. Exported for the test. */
export function failedTopics(result: Record<string, Array<{ success: boolean }>> | undefined | null): string[] {
  return Object.entries(result ?? {})
    .filter(([, entries]) => entries.some((e) => !e.success))
    .map(([topic]) => topic);
}

/** Whether a subscription's uri delivers to this app's host. Exported for the test. */
export function pointsAtHost(uri: string | null | undefined, host: string): boolean {
  if (!uri) return false;
  try {
    return new URL(uri).host === host;
  } catch {
    return false;
  }
}
