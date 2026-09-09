import type { StaffRole } from "@prisma/client";
import { authenticate } from "~/shopify.server";
import { bootJobs } from "~/services/jobs/index.server";
import { getOrCreateShop, type ShopWithSettings } from "~/services/shop.server";
import type { GraphqlClient } from "~/services/shopify/graphql.server";
import { atLeast, resolveAccess } from "./access.server";

/**
 * Authenticate an embedded-admin request and load the matching Shop row.
 * Every `/app/*` loader and action starts here.
 *
 * It is also where a team member's role is enforced, and it is enforced here
 * precisely because every route passes through it: a check added route by route
 * is a check that will be missing from the next route someone writes. The rule
 * needs no argument in the common case — a GET is reading, anything else is
 * writing — and a screen that is genuinely owner-only passes `minRole`.
 */
export async function requireShop(request: Request, options: { minRole?: StaffRole } = {}) {
  bootJobs();
  const { admin, billing, session } = await authenticate.admin(request);
  const shop: ShopWithSettings = await getOrCreateShop(session.shop);
  const graphql = admin.graphql as unknown as GraphqlClient;
  const actor = session.onlineAccessInfo?.associated_user?.email ?? "merchant";

  const access = await resolveAccess(shop.accountId, shop.domain, actor);
  const minRole = options.minRole ?? (request.method === "GET" ? "READ_ONLY" : "STAFF");
  if (!atLeast(access.role, minRole)) {
    throw new Response(
      `Your account has ${access.role.toLowerCase().replace("_", "-")} access on this store, which does not allow this. Ask an admin to change your role under Settings → Staff.`,
      { status: 403, statusText: "Forbidden" },
    );
  }

  return { admin, billing, session, shop, graphql, actor, role: access.role, access };
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
