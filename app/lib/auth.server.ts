import { authenticate } from "~/shopify.server";
import { bootJobs } from "~/services/jobs/index.server";
import { getOrCreateShop, type ShopWithSettings } from "~/services/shop.server";
import type { GraphqlClient } from "~/services/shopify/graphql.server";

/**
 * Authenticate an embedded-admin request and load the matching Shop row.
 * Every `/app/*` loader and action starts here.
 */
export async function requireShop(request: Request) {
  bootJobs();
  const { admin, billing, session } = await authenticate.admin(request);
  const shop: ShopWithSettings = await getOrCreateShop(session.shop);
  const graphql = admin.graphql as unknown as GraphqlClient;
  const actor = session.onlineAccessInfo?.associated_user?.email ?? "merchant";
  return { admin, billing, session, shop, graphql, actor };
}

export type RequireShopResult = Awaited<ReturnType<typeof requireShop>>;

/** Read an intent + fields from a form submission. */
export async function readForm(request: Request) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const get = (key: string) => {
    const value = form.get(key);
    return value === null ? "" : String(value);
  };
  const getAll = (key: string) => form.getAll(key).map(String);
  const json = <T>(key: string, fallback: T): T => {
    const raw = form.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(String(raw)) as T;
    } catch {
      return fallback;
    }
  };
  return { form, intent, get, getAll, json };
}
