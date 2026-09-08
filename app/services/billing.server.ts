import type { Account, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import {
  PLANS,
  checkLimit,
  cheapestPlanWith,
  entitledPlan,
  isPlanId,
  planAllows,
  planFromSubscriptionName,
  type LimitCheck,
  type LimitedResource,
  type PlanFeature,
  type PlanId,
} from "~/domain/billing/plans";
import { AppError } from "~/lib/errors";
import { env } from "~/lib/env.server";
import type { I18nVars } from "~/lib/i18n";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";

/**
 * Plans, subscriptions and limits.
 *
 * Shopify bills per store, while a DropshipHub account can span several
 * stores. The subscription is therefore attached to the *account* and charged
 * to whichever store approved it (`billingShopId`); every store on the account
 * gets the plan's limits. Only that store's `billing.check()` is authoritative,
 * so a sister store never downgrades the account because Shopify, quite
 * correctly, reports no subscription for it.
 *
 * Three things keep the stored plan honest: the plan page reconciles against
 * `billing.check()` whenever it is opened, the `app_subscriptions/update`
 * webhook applies status changes as they happen, and the free tier is the
 * answer whenever neither has anything better to say.
 */

/** The subset of `authenticate.admin()`'s billing context this module needs. */
export interface BillingApi {
  check: (options: { isTest?: boolean }) => Promise<{
    hasActivePayment: boolean;
    appSubscriptions: Array<{ id: string; name: string; status: string; test: boolean; trialDays: number; currentPeriodEnd: string; createdAt: string }>;
  }>;
  request: (options: { plan: string; isTest?: boolean; returnUrl?: string }) => Promise<never>;
  cancel: (options: { subscriptionId: string; isTest?: boolean; prorate?: boolean }) => Promise<unknown>;
}

interface ShopRef {
  id: string;
  domain: string;
  accountId: string | null;
  isDevelopmentStore?: boolean;
}

/** A plan limit or feature the shop's plan does not include. Localisable. */
export class PlanLimitError extends AppError {
  readonly messageKey: string;
  readonly messageVars: I18nVars;

  constructor(message: string, messageKey: string, messageVars: I18nVars, details?: Record<string, unknown>) {
    super("PLAN_LIMIT", message, { details });
    this.name = "PlanLimitError";
    this.messageKey = messageKey;
    this.messageVars = messageVars;
  }
}

/**
 * Test-mode charges are never collected. Development stores cannot be charged
 * at all, and outside production the app must never create a real charge —
 * `BILLING_TEST=true` forces it on anywhere, for staging against a live store.
 */
export function billingIsTest(shop: Pick<ShopRef, "isDevelopmentStore">): boolean {
  const config = env();
  if (config.BILLING_TEST) return true;
  if (config.NODE_ENV !== "production") return true;
  return Boolean(shop.isDevelopmentStore);
}

export interface AccountUsage {
  products: number;
  stores: number;
  staff: number;
}

export async function accountUsage(accountId: string | null): Promise<AccountUsage> {
  if (!accountId) return { products: 0, stores: 1, staff: 0 };
  const [products, stores, staff] = await Promise.all([
    prisma.product.count({ where: { shop: { accountId } } }),
    prisma.shop.count({ where: { accountId, isActive: true } }),
    prisma.staffAccount.count({ where: { accountId, disabledAt: null } }),
  ]);
  return { products, stores: Math.max(1, stores), staff };
}

/** The plan an account currently holds, without talking to Shopify. */
export async function currentPlan(shop: Pick<ShopRef, "accountId">): Promise<PlanId> {
  if (!shop.accountId) return "FREE";
  const account = await prisma.account.findUnique({ where: { id: shop.accountId }, select: { plan: true } });
  return account && isPlanId(account.plan) ? account.plan : "FREE";
}

export interface AccountBilling {
  accountId: string | null;
  plan: PlanId;
  usage: AccountUsage;
  subscription: {
    id: string;
    name: string | null;
    status: string | null;
    trialEndsAt: Date | null;
    renewsAt: Date | null;
  } | null;
  /** Domain of the store the subscription is charged to, when it is not this one. */
  billingShopDomain: string | null;
  isBillingShop: boolean;
  isTest: boolean;
}

export async function getAccountBilling(shop: ShopRef): Promise<AccountBilling> {
  const isTest = billingIsTest(shop);
  if (!shop.accountId) {
    return { accountId: null, plan: "FREE", usage: await accountUsage(null), subscription: null, billingShopDomain: null, isBillingShop: true, isTest };
  }
  const account = await prisma.account.findUnique({ where: { id: shop.accountId } });
  const usage = await accountUsage(shop.accountId);
  if (!account) {
    return { accountId: shop.accountId, plan: "FREE", usage, subscription: null, billingShopDomain: null, isBillingShop: true, isTest };
  }
  const billingShop = account.billingShopId && account.billingShopId !== shop.id
    ? await prisma.shop.findUnique({ where: { id: account.billingShopId }, select: { domain: true } })
    : null;
  return {
    accountId: account.id,
    plan: isPlanId(account.plan) ? account.plan : "FREE",
    usage,
    subscription: account.subscriptionId
      ? {
          id: account.subscriptionId,
          name: account.subscriptionName,
          status: account.subscriptionStatus,
          trialEndsAt: account.trialEndsAt,
          renewsAt: account.planRenewsAt,
        }
      : null,
    billingShopDomain: billingShop?.domain ?? null,
    isBillingShop: !account.billingShopId || account.billingShopId === shop.id,
    isTest,
  };
}

/**
 * Reconcile the stored plan with what Shopify reports for this store.
 *
 * Returns the plan the account holds afterwards. A store that is not the
 * billing store cannot change the plan: Shopify has no subscription for it,
 * and reading that as "cancelled" would strip the whole account every time a
 * sister store opened the page.
 */
export async function syncSubscription(shop: ShopRef, billing: BillingApi): Promise<PlanId> {
  if (!shop.accountId) return "FREE";
  const account = await prisma.account.findUnique({ where: { id: shop.accountId } });
  if (!account) return "FREE";
  if (account.billingShopId && account.billingShopId !== shop.id && account.subscriptionId) {
    return isPlanId(account.plan) ? account.plan : "FREE";
  }

  const result = await billing.check({ isTest: billingIsTest(shop) });
  const live = result.appSubscriptions
    .filter((s) => planFromSubscriptionName(s.name) !== null)
    .sort((a, b) => (a.status === "ACTIVE" ? -1 : 0) - (b.status === "ACTIVE" ? -1 : 0))[0];

  if (!live) {
    if (account.plan !== "FREE" || account.subscriptionId) {
      await setAccountPlan(account, "FREE", { subscription: null, billingShopId: null, shopId: shop.id, reason: "no active subscription" });
    }
    return "FREE";
  }

  const plan = entitledPlan(live);
  const trialEndsAt = live.trialDays > 0 ? new Date(new Date(live.createdAt).getTime() + live.trialDays * 86_400_000) : null;
  await setAccountPlan(account, plan, {
    subscription: { id: live.id, name: live.name, status: live.status, renewsAt: live.currentPeriodEnd ? new Date(live.currentPeriodEnd) : null, trialEndsAt },
    billingShopId: shop.id,
    shopId: shop.id,
    reason: `Shopify reports ${live.name} (${live.status})`,
  });
  return plan;
}

/**
 * `app_subscriptions/update`: Shopify tells us the subscription changed —
 * approved, cancelled by the merchant from the admin, expired, frozen because
 * the store stopped paying Shopify. The payload names the subscription, so
 * only the account that owns it is touched.
 */
export async function applySubscriptionWebhook(shop: ShopRef, payload: Record<string, unknown>): Promise<void> {
  const sub = (payload.app_subscription ?? payload) as Record<string, unknown>;
  const id = String(sub.admin_graphql_api_id ?? sub.id ?? "");
  const name = typeof sub.name === "string" ? sub.name : null;
  const status = typeof sub.status === "string" ? sub.status.toUpperCase() : null;
  if (!id || !shop.accountId) return;

  const account = await prisma.account.findUnique({ where: { id: shop.accountId } });
  if (!account) return;
  const plan = entitledPlan({ name, status });

  if (account.subscriptionId && account.subscriptionId !== id && plan === "FREE") {
    // A stale subscription being cancelled after its replacement was approved
    // says nothing about the replacement.
    logger.info("Ignoring update for a superseded subscription", { shop: shop.domain, id, status });
    return;
  }

  await setAccountPlan(account, plan, {
    subscription: plan === "FREE" ? null : { id, name, status, renewsAt: account.planRenewsAt, trialEndsAt: account.trialEndsAt },
    billingShopId: plan === "FREE" ? null : shop.id,
    shopId: shop.id,
    reason: `webhook ${status ?? "?"} for ${name ?? id}`,
  });
}

/** Cancel the account's subscription with Shopify and drop to the free tier. */
export async function cancelSubscription(shop: ShopRef, billing: BillingApi, actor?: string): Promise<void> {
  if (!shop.accountId) return;
  const account = await prisma.account.findUnique({ where: { id: shop.accountId } });
  if (!account?.subscriptionId) return;
  if (account.billingShopId && account.billingShopId !== shop.id) {
    throw new AppError("BILLING_SHOP", "This subscription is managed from another store on the account.");
  }
  await billing.cancel({ subscriptionId: account.subscriptionId, isTest: billingIsTest(shop), prorate: true });
  await setAccountPlan(account, "FREE", { subscription: null, billingShopId: null, shopId: shop.id, reason: `cancelled by ${actor ?? "merchant"}` });
}

async function setAccountPlan(
  account: Account,
  plan: PlanId,
  options: {
    subscription: { id: string; name: string | null; status: string | null; renewsAt: Date | null; trialEndsAt: Date | null } | null;
    billingShopId: string | null;
    shopId: string;
    reason: string;
  },
) {
  const changed = account.plan !== plan;
  const data: Prisma.AccountUpdateInput = {
    plan,
    subscriptionId: options.subscription?.id ?? null,
    subscriptionName: options.subscription?.name ?? null,
    subscriptionStatus: options.subscription?.status ?? null,
    planRenewsAt: options.subscription?.renewsAt ?? null,
    trialEndsAt: options.subscription?.trialEndsAt ?? null,
    billingShopId: options.billingShopId,
    ...(changed ? { planChangedAt: new Date() } : {}),
  };
  await prisma.account.update({ where: { id: account.id }, data });
  if (changed) {
    logger.info("Account plan changed", { accountId: account.id, from: account.plan, to: plan, reason: options.reason });
    await logActivity(options.shopId, {
      action: "billing.plan_changed",
      message: `Plan changed from ${PLANS[isPlanId(account.plan) ? account.plan : "FREE"].displayName} to ${PLANS[plan].displayName} (${options.reason}).`,
      meta: { from: account.plan, to: plan },
    });
  }
}

/**
 * Refuse an addition that would cross the plan's cap.
 *
 * Counting happens here, at the moment of the change, rather than being cached:
 * a stale count is how a merchant ends up one product over a cap they were
 * never told about.
 */
export async function assertWithinPlan(shop: Pick<ShopRef, "accountId">, resource: LimitedResource, adding = 1): Promise<LimitCheck> {
  const plan = await currentPlan(shop);
  const usage = await accountUsage(shop.accountId);
  const check = checkLimit(plan, resource, usage[resource], adding);
  if (!check.allowed) {
    const limit = check.limit ?? 0;
    const upgrade = check.upgradeTo ? PLANS[check.upgradeTo].displayName : "";
    throw new PlanLimitError(
      `Your ${PLANS[plan].displayName} plan allows ${limit} ${resource}${upgrade ? `; upgrade to ${upgrade} under Settings → Plan to add more` : ""}.`,
      upgrade ? "err.planLimitUpgrade" : "err.planLimit",
      { plan: PLANS[plan].displayName, limit, resource, upgrade },
      { ...check },
    );
  }
  return check;
}

/** Refuse a feature the plan does not include. */
export async function requireFeature(shop: Pick<ShopRef, "accountId">, feature: PlanFeature): Promise<void> {
  const plan = await currentPlan(shop);
  if (planAllows(plan, feature)) return;
  const upgradeTo = cheapestPlanWith(feature);
  const upgrade = upgradeTo ? PLANS[upgradeTo].displayName : "";
  throw new PlanLimitError(
    `${featureLabel(feature)} is not included in the ${PLANS[plan].displayName} plan${upgrade ? `; upgrade to ${upgrade} under Settings → Plan` : ""}.`,
    "err.planFeature",
    { plan: PLANS[plan].displayName, feature: featureLabel(feature), upgrade },
    { plan, feature, upgradeTo },
  );
}

export async function hasFeature(shop: Pick<ShopRef, "accountId">, feature: PlanFeature): Promise<boolean> {
  return planAllows(await currentPlan(shop), feature);
}

function featureLabel(feature: PlanFeature): string {
  switch (feature) {
    case "aiMapping":
      return "AI variant mapping";
    case "supplierOptimizer":
      return "Supplier optimizer";
    case "autoPlaceOrders":
      return "Automatic order placement";
  }
}
