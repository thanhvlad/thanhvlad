/**
 * Plans and subscriptions against a real database.
 *
 * Shopify itself is replaced by a fake billing context that answers
 * `check()` with whatever the test says the store has bought; everything
 * downstream — the account row, the limits, the gates — is the real code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ShopWithSettings } from "~/services/shop.server";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.SUPPLIER_DRIVER = "mock";
process.env.REDIS_URL = "";

vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: { admin: async () => ({ admin: { graphql: async () => new Response("{}") }, session: {} }) },
  login: undefined,
  apiVersion: "2026-07",
  addDocumentResponseHeaders: () => undefined,
  registerWebhooks: async () => undefined,
  sessionStorage: {},
  default: {},
}));

type Subscription = { id: string; name: string; status: string; test: boolean; trialDays: number; currentPeriodEnd: string; createdAt: string };

function fakeBilling(subscriptions: Subscription[]) {
  const cancelled: string[] = [];
  return {
    cancelled,
    api: {
      check: async () => ({ hasActivePayment: subscriptions.some((s) => s.status === "ACTIVE"), appSubscriptions: subscriptions }),
      request: async () => {
        throw new Error("request() is a redirect in the real thing");
      },
      cancel: async ({ subscriptionId }: { subscriptionId: string }) => {
        cancelled.push(subscriptionId);
        return {};
      },
    },
  };
}

describe.skipIf(!TEST_DB)("billing and plan limits (postgres)", () => {
  let prisma: PrismaClient;
  let shop: ShopWithSettings;
  let sister: ShopWithSettings;
  const stamp = Date.now();

  beforeAll(async () => {
    prisma = (await import("~/db.server")).default;
    const { getOrCreateShop } = await import("~/services/shop.server");
    shop = await getOrCreateShop(`billing-${stamp}.myshopify.com`);
    sister = await getOrCreateShop(`billing-sister-${stamp}.myshopify.com`);
    // Same account, as Settings → Stores would arrange it.
    await prisma.shop.update({ where: { id: sister.id }, data: { accountId: shop.accountId } });
    sister = { ...sister, accountId: shop.accountId };
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: [shop.id, sister.id] } } }).catch(() => undefined);
    if (shop.accountId) await prisma.account.delete({ where: { id: shop.accountId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("starts every account on the free plan", async () => {
    const { getAccountBilling } = await import("~/services/billing.server");
    const billing = await getAccountBilling(shop);
    expect(billing.plan).toBe("FREE");
    expect(billing.subscription).toBeNull();
    expect(billing.usage.stores).toBe(2);
    expect(billing.isTest).toBe(true);
  });

  it("refuses an addition that would cross the free plan's cap, and says which plan fixes it", async () => {
    const { assertWithinPlan, PlanLimitError } = await import("~/services/billing.server");
    await expect(assertWithinPlan(shop, "products", 1)).resolves.toMatchObject({ allowed: true, plan: "FREE" });
    const failure = await assertWithinPlan(shop, "products", 5000).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PlanLimitError);
    expect((failure as InstanceType<typeof PlanLimitError>).messageKey).toBe("err.planLimitUpgrade");
    expect((failure as InstanceType<typeof PlanLimitError>).messageVars).toMatchObject({ plan: "Basic", limit: 3000, upgrade: "Advanced" });
  });

  it("caps staff invitations on the free plan", async () => {
    const { inviteStaff } = await import("~/services/staff.server");
    await inviteStaff(shop.id, shop.accountId!, { email: `first-${stamp}@example.com`, role: "STAFF" });
    // Re-inviting the same person is not a second seat.
    await expect(inviteStaff(shop.id, shop.accountId!, { email: `first-${stamp}@example.com`, role: "ADMIN" })).resolves.toBeTruthy();
    await expect(inviteStaff(shop.id, shop.accountId!, { email: `second-${stamp}@example.com`, role: "STAFF" })).rejects.toMatchObject({ code: "PLAN_LIMIT" });
  });

  it("adopts the plan Shopify reports and remembers which store pays for it", async () => {
    const { syncSubscription, getAccountBilling } = await import("~/services/billing.server");
    const { api } = fakeBilling([
      { id: "gid://shopify/AppSubscription/1", name: "Pro", status: "ACTIVE", test: true, trialDays: 14, currentPeriodEnd: "2026-10-08T00:00:00Z", createdAt: "2026-09-08T00:00:00Z" },
    ]);
    expect(await syncSubscription(shop, api)).toBe("PRO");
    const billing = await getAccountBilling(shop);
    expect(billing.plan).toBe("PRO");
    expect(billing.subscription?.id).toBe("gid://shopify/AppSubscription/1");
    expect(billing.subscription?.trialEndsAt?.toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(billing.isBillingShop).toBe(true);

    // The staff cap is now the Pro one.
    const { inviteStaff } = await import("~/services/staff.server");
    await expect(inviteStaff(shop.id, shop.accountId!, { email: `second-${stamp}@example.com`, role: "STAFF" })).resolves.toBeTruthy();
  });

  it("does not let a sister store's empty billing check strip the account", async () => {
    const { syncSubscription, getAccountBilling } = await import("~/services/billing.server");
    const { api } = fakeBilling([]);
    // Shopify has no subscription for the sister store; that is expected.
    expect(await syncSubscription(sister, api)).toBe("PRO");
    const billing = await getAccountBilling(sister);
    expect(billing.plan).toBe("PRO");
    expect(billing.isBillingShop).toBe(false);
    expect(billing.billingShopDomain).toBe(shop.domain);
  });

  it("ignores a cancellation webhook for a subscription that was already replaced", async () => {
    const { applySubscriptionWebhook, getAccountBilling } = await import("~/services/billing.server");
    await applySubscriptionWebhook(shop, { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/0", name: "Advanced", status: "CANCELLED" } });
    expect((await getAccountBilling(shop)).plan).toBe("PRO");
  });

  it("drops to the free plan when Shopify says the subscription ended", async () => {
    const { applySubscriptionWebhook, getAccountBilling } = await import("~/services/billing.server");
    await applySubscriptionWebhook(shop, { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Pro", status: "EXPIRED" } });
    const billing = await getAccountBilling(shop);
    expect(billing.plan).toBe("FREE");
    expect(billing.subscription).toBeNull();
  });

  it("cancels with Shopify and records the downgrade", async () => {
    const { syncSubscription, cancelSubscription, getAccountBilling } = await import("~/services/billing.server");
    const live = fakeBilling([
      { id: "gid://shopify/AppSubscription/2", name: "Advanced", status: "ACTIVE", test: true, trialDays: 0, currentPeriodEnd: "2026-10-08T00:00:00Z", createdAt: "2026-09-08T00:00:00Z" },
    ]);
    expect(await syncSubscription(shop, live.api)).toBe("ADVANCED");

    // Only the billing store may cancel.
    await expect(cancelSubscription(sister, live.api)).rejects.toMatchObject({ code: "BILLING_SHOP" });
    expect(live.cancelled).toEqual([]);

    await cancelSubscription(shop, live.api, "merchant");
    expect(live.cancelled).toEqual(["gid://shopify/AppSubscription/2"]);
    expect((await getAccountBilling(shop)).plan).toBe("FREE");

    const { listActivity } = await import("~/services/activity.server");
    const actions = (await listActivity(shop.id, { limit: 50 })).map((a) => a.action);
    expect(actions.filter((a) => a === "billing.plan_changed").length).toBeGreaterThanOrEqual(3);
  });
});
