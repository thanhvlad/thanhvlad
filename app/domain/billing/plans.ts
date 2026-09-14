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
  /** Claude-assisted variant mapping. Supplier ranking is deterministic and
   * is gated by `supplierOptimizer`, not by this flag. */
  aiMapping: boolean;
  /** Supplier comparison and the one-click optimizer. */
  supplierOptimizer: boolean;
  /** Auto-place supplier orders on a delay. */
  autoPlaceOrders: boolean;
  /**
   * AI landing-page rewrites per account per calendar month (UTC).
   *
   * Unlike every other limit this one is a running cost, not a count of rows:
   * one rewrite is one Claude call carrying the writing contract, the shop's
   * worked examples, the supplier text and up to eight images, and it answers
   * with a 900-2,100 word page plus thinking. At Opus-class list prices that is
   * roughly US$0.25-0.50 per product. Before this existed the rewrite had no
   * plan gate at all, so a free store could bulk-rewrite its whole 3,000
   * product cap - hundreds of dollars of model spend with no revenue behind it.
   *
   * The allowances are sized so a month of typical use costs about 40% of the
   * plan's price at US$0.40 a rewrite (rewrites ~= price / 2.5), which leaves
   * room for the expensive tail. The free tier gets three: enough to see the
   * feature on real products, small enough that an abandoned free install
   * costs about a dollar.
   */
  aiRewritesPerMonth: number;
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
    limits: { products: 3000, stores: 3, staff: 1, aiMapping: false, supplierOptimizer: true, autoPlaceOrders: false, aiRewritesPerMonth: 3 },
  },
  ADVANCED: {
    id: "ADVANCED",
    displayName: "Advanced",
    monthlyPrice: 19.9,
    trialDays: 14,
    limits: { products: 20000, stores: 10, staff: 5, aiMapping: true, supplierOptimizer: true, autoPlaceOrders: true, aiRewritesPerMonth: 20 },
  },
  PRO: {
    id: "PRO",
    displayName: "Pro",
    monthlyPrice: 49.9,
    trialDays: 14,
    limits: { products: 75000, stores: 25, staff: 10, aiMapping: true, supplierOptimizer: true, autoPlaceOrders: true, aiRewritesPerMonth: 50 },
  },
  ENTERPRISE: {
    id: "ENTERPRISE",
    displayName: "Enterprise",
    monthlyPrice: 499,
    trialDays: 14,
    limits: { products: 100000, stores: 50, staff: null, aiMapping: true, supplierOptimizer: true, autoPlaceOrders: true, aiRewritesPerMonth: 500 },
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

/**
 * The most products one rewrite request may carry.
 *
 * The job runs one model call per product, one after another, so a large batch
 * both spends the month's allowance in a single click and holds the inline
 * queue for an hour. Twenty-five is one page of the import list, which is all a
 * merchant can select at once anyway.
 */
export const MAX_AI_REWRITE_BATCH = 25;

/** The usage period a moment falls in: its UTC calendar month, "2026-09". */
export function aiUsagePeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** When the allowance for the period containing `at` starts over. */
export function aiUsageResetsAt(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

export interface AiRewriteAllowance {
  plan: PlanId;
  limit: number;
  used: number;
  remaining: number;
  /** The cheapest plan with a larger allowance, for the upgrade hint. */
  upgradeTo: PlanId | null;
}

/** What is left of a plan's monthly rewrite allowance after `used` of it. */
export function aiRewriteAllowance(plan: PlanId, used: number): AiRewriteAllowance {
  const limit = PLANS[plan].limits.aiRewritesPerMonth;
  const spent = Math.max(0, Math.floor(used));
  const upgradeTo = PLAN_ORDER.find((id) => planRank(id) > planRank(plan) && PLANS[id].limits.aiRewritesPerMonth > limit) ?? null;
  return { plan, limit, used: spent, remaining: Math.max(0, limit - spent), upgradeTo };
}

export type AiRewriteRefusal = "none-selected" | "batch-too-large" | "quota-exhausted" | "quota-short";

/**
 * Whether a batch of `requested` rewrites may be queued, and if not, why.
 *
 * Checked before queueing so the merchant is told at the click rather than
 * after half a batch has run; the per-product reservation in the job is what
 * actually holds the line when two batches race.
 */
export function checkAiRewriteRequest(allowance: AiRewriteAllowance, requested: number): AiRewriteRefusal | null {
  if (requested <= 0) return "none-selected";
  if (requested > MAX_AI_REWRITE_BATCH) return "batch-too-large";
  if (allowance.remaining === 0) return "quota-exhausted";
  if (requested > allowance.remaining) return "quota-short";
  return null;
}
