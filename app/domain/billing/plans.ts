/**
 * Plan catalogue and limits.
 *
 * Pure: no database, no Shopify. The service layer turns an Account row into a
 * plan id and counts usage; everything about *what* a plan allows lives here so
 * it can be unit-tested and read in one place.
 *
 * Prices are in USD and are what Shopify charges the merchant every 30 days;
 * the Billing API config in `app/shopify.server.ts` is derived from this table,
 * so a price change here is the only edit needed. Shopify shows `displayName`
 * on its approval page, and that exact string comes back as the subscription
 * name in `billing.check()` and in the `app_subscriptions/update` webhook — it
 * is how a subscription is recognised, so it must not contain the app name or
 * anything that might be edited independently.
 */

export type PlanId = "FREE" | "ADVANCED" | "PRO" | "ENTERPRISE";

/** Something a plan caps. `null` means unlimited. */
export type LimitedResource = "products" | "stores" | "staff";

export interface PlanLimits {
  /** Managed products across every store on the account. */
  products: number | null;
  /** Shopify stores that may share the account. */
  stores: number | null;
  /** Staff members on the account (the owner is not counted). */
  staff: number | null;
  /** Claude-assisted variant mapping and supplier switching. */
  aiMapping: boolean;
  /** Supplier comparison and the one-click optimizer. */
  supplierOptimizer: boolean;
  /** Auto-place supplier orders on a delay. */
  autoPlaceOrders: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  /** The name Shopify shows and echoes back; see the module comment. */
  displayName: string;
  /** USD per 30 days. 0 is the free tier and never touches the Billing API. */
  monthlyPrice: number;
  trialDays: number;
  limits: PlanLimits;
}

export const PLAN_ORDER: PlanId[] = ["FREE", "ADVANCED", "PRO", "ENTERPRISE"];

export const PLANS: Record<PlanId, PlanDefinition> = {
  FREE: {
    id: "FREE",
    displayName: "Basic",
    monthlyPrice: 0,
    trialDays: 0,
    limits: { products: 3000, stores: 3, staff: 1, aiMapping: false, supplierOptimizer: true, autoPlaceOrders: false },
  },
  ADVANCED: {
    id: "ADVANCED",
    displayName: "Advanced",
    monthlyPrice: 19.9,
    trialDays: 14,
    limits: { products: 20000, stores: 10, staff: 5, aiMapping: true, supplierOptimizer: true, autoPlaceOrders: true },
  },
  PRO: {
    id: "PRO",
    displayName: "Pro",
    monthlyPrice: 49.9,
    trialDays: 14,
    limits: { products: 75000, stores: 25, staff: 10, aiMapping: true, supplierOptimizer: true, autoPlaceOrders: true },
  },
  ENTERPRISE: {
    id: "ENTERPRISE",
    displayName: "Enterprise",
    monthlyPrice: 499,
    trialDays: 14,
    limits: { products: 100000, stores: 50, staff: null, aiMapping: true, supplierOptimizer: true, autoPlaceOrders: true },
  },
};

export const PAID_PLANS: PlanId[] = PLAN_ORDER.filter((id) => PLANS[id].monthlyPrice > 0);

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/** The plan a Shopify subscription name refers to, or null for an unknown name. */
export function planFromSubscriptionName(name: string | null | undefined): PlanId | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  for (const id of PLAN_ORDER) {
    if (PLANS[id].displayName.toLowerCase() === wanted || id.toLowerCase() === wanted) return id;
  }
  return null;
}

export function planRank(id: PlanId): number {
  return PLAN_ORDER.indexOf(id);
}

export interface LimitCheck {
  allowed: boolean;
  plan: PlanId;
  resource: LimitedResource;
  /** `null` when the plan has no cap on this resource. */
  limit: number | null;
  current: number;
  /** How many more may be added before the cap; `null` when unlimited. */
  remaining: number | null;
  /** The cheapest plan that would allow the requested total, if any. */
  upgradeTo: PlanId | null;
}

/**
 * Whether `current + adding` fits inside the plan's cap on `resource`.
 *
 * Adding zero is a plain "am I over?" check. The suggested upgrade is the
 * cheapest plan whose cap fits the requested total, so the merchant is pointed
 * at what actually solves the problem rather than at the top tier.
 */
export function checkLimit(plan: PlanId, resource: LimitedResource, current: number, adding = 1): LimitCheck {
  const limit = PLANS[plan].limits[resource];
  const wanted = Math.max(0, current) + Math.max(0, adding);
  const allowed = limit === null || wanted <= limit;
  const remaining = limit === null ? null : Math.max(0, limit - Math.max(0, current));
  const upgradeTo = allowed ? null : (PLAN_ORDER.find((id) => planRank(id) > planRank(plan) && fits(id, resource, wanted)) ?? null);
  return { allowed, plan, resource, limit, current: Math.max(0, current), remaining, upgradeTo };
}

function fits(plan: PlanId, resource: LimitedResource, wanted: number): boolean {
  const limit = PLANS[plan].limits[resource];
  return limit === null || wanted <= limit;
}

export type PlanFeature = "aiMapping" | "supplierOptimizer" | "autoPlaceOrders";

export function planAllows(plan: PlanId, feature: PlanFeature): boolean {
  return PLANS[plan].limits[feature];
}

/** The cheapest plan that includes a feature, for upgrade hints. */
export function cheapestPlanWith(feature: PlanFeature): PlanId | null {
  return PLAN_ORDER.find((id) => PLANS[id].limits[feature]) ?? null;
}

/**
 * The plan an account is entitled to given what Shopify says about its
 * subscription. Anything but an active (or accepted, i.e. approved and about
 * to activate) subscription falls back to the free tier — a frozen or expired
 * subscription is one the merchant is not paying for.
 */
export function entitledPlan(subscription: { name: string | null | undefined; status: string | null | undefined } | null): PlanId {
  if (!subscription) return "FREE";
  const status = (subscription.status ?? "").toUpperCase();
  if (status !== "ACTIVE" && status !== "ACCEPTED") return "FREE";
  return planFromSubscriptionName(subscription.name) ?? "FREE";
}

/** Usage as a share of the cap, for progress bars; 0 for an unlimited resource. */
export function usageFraction(plan: PlanId, resource: LimitedResource, current: number): number {
  const limit = PLANS[plan].limits[resource];
  if (limit === null || limit === 0) return 0;
  return Math.min(1, Math.max(0, current) / limit);
}
