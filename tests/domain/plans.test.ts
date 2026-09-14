import { describe, expect, it } from "vitest";
import {
  PAID_PLANS,
  PLANS,
  PLAN_ORDER,
  MAX_AI_REWRITE_BATCH,
  aiRewriteAllowance,
  aiUsagePeriod,
  aiUsageResetsAt,
  checkAiRewriteRequest,
  checkLimit,
  cheapestPlanWith,
  entitledPlan,
  planAllows,
  planFromSubscriptionName,
  usageFraction,
} from "~/domain/billing/plans";

describe("plan catalogue", () => {
  it("orders plans from free to most expensive with growing caps", () => {
    for (let i = 1; i < PLAN_ORDER.length; i += 1) {
      const lower = PLANS[PLAN_ORDER[i - 1]];
      const higher = PLANS[PLAN_ORDER[i]];
      expect(higher.monthlyPrice).toBeGreaterThan(lower.monthlyPrice);
      expect(higher.limits.products ?? Infinity).toBeGreaterThanOrEqual(lower.limits.products ?? Infinity);
      expect(higher.limits.stores ?? Infinity).toBeGreaterThanOrEqual(lower.limits.stores ?? Infinity);
    }
    expect(PAID_PLANS).toEqual(["ADVANCED", "PRO", "ENTERPRISE"]);
  });

  it("recognises a subscription by the display name Shopify echoes back", () => {
    expect(planFromSubscriptionName("Advanced")).toBe("ADVANCED");
    expect(planFromSubscriptionName("  pro ")).toBe("PRO");
    expect(planFromSubscriptionName("ENTERPRISE")).toBe("ENTERPRISE");
    expect(planFromSubscriptionName("Gold")).toBeNull();
    expect(planFromSubscriptionName(null)).toBeNull();
  });
});

describe("checkLimit", () => {
  it("allows growth inside the cap and reports what is left", () => {
    const check = checkLimit("FREE", "products", 2990, 5);
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(10);
    expect(check.upgradeTo).toBeNull();
  });

  it("refuses the request that would cross the cap and names the cheapest fix", () => {
    const check = checkLimit("FREE", "products", 2999, 2);
    expect(check.allowed).toBe(false);
    expect(check.limit).toBe(3000);
    expect(check.upgradeTo).toBe("ADVANCED");

    // A total that only the top tier fits skips straight past the middle ones.
    expect(checkLimit("ADVANCED", "products", 80000, 1).upgradeTo).toBe("ENTERPRISE");
  });

  it("treats a null cap as unlimited", () => {
    const check = checkLimit("ENTERPRISE", "staff", 500, 100);
    expect(check.allowed).toBe(true);
    expect(check.limit).toBeNull();
    expect(check.remaining).toBeNull();
  });

  it("reports nothing to upgrade to when no plan fits", () => {
    const check = checkLimit("ENTERPRISE", "products", 100000, 1);
    expect(check.allowed).toBe(false);
    expect(check.upgradeTo).toBeNull();
  });

  it("never counts negative usage", () => {
    expect(checkLimit("FREE", "stores", -3, 1).current).toBe(0);
  });
});

describe("features and entitlement", () => {
  it("gates AI mapping behind a paid plan", () => {
    expect(planAllows("FREE", "aiMapping")).toBe(false);
    expect(planAllows("ADVANCED", "aiMapping")).toBe(true);
    expect(cheapestPlanWith("aiMapping")).toBe("ADVANCED");
    expect(cheapestPlanWith("supplierOptimizer")).toBe("FREE");
  });

  it("only an active or accepted subscription earns the paid plan", () => {
    expect(entitledPlan(null)).toBe("FREE");
    expect(entitledPlan({ name: "Pro", status: "ACTIVE" })).toBe("PRO");
    expect(entitledPlan({ name: "Pro", status: "accepted" })).toBe("PRO");
    expect(entitledPlan({ name: "Pro", status: "FROZEN" })).toBe("FREE");
    expect(entitledPlan({ name: "Pro", status: "CANCELLED" })).toBe("FREE");
    expect(entitledPlan({ name: "Something else", status: "ACTIVE" })).toBe("FREE");
  });

  it("gives a usage fraction for meters", () => {
    expect(usageFraction("FREE", "products", 1500)).toBe(0.5);
    expect(usageFraction("FREE", "products", 9000)).toBe(1);
    expect(usageFraction("ENTERPRISE", "staff", 40)).toBe(0);
  });
});

describe("AI rewrite allowance", () => {
  it("grows with the plan and keeps the free tier to a trial", () => {
    for (let i = 1; i < PLAN_ORDER.length; i += 1) {
      expect(PLANS[PLAN_ORDER[i]].limits.aiRewritesPerMonth).toBeGreaterThan(PLANS[PLAN_ORDER[i - 1]].limits.aiRewritesPerMonth);
    }
    expect(PLANS.FREE.limits.aiRewritesPerMonth).toBeLessThanOrEqual(5);
  });

  it("keeps a month of typical spend under half of each paid plan's price", () => {
    // US$0.40 is the typical Opus-class cost of one rewrite; see PlanLimits.
    for (const id of PAID_PLANS) {
      expect(PLANS[id].limits.aiRewritesPerMonth * 0.4).toBeLessThanOrEqual(PLANS[id].monthlyPrice * 0.5);
    }
  });

  it("reports what is left and the cheapest plan with more", () => {
    expect(aiRewriteAllowance("FREE", 1)).toEqual({ plan: "FREE", limit: 3, used: 1, remaining: 2, upgradeTo: "ADVANCED" });
    expect(aiRewriteAllowance("ADVANCED", 50).remaining).toBe(0);
    expect(aiRewriteAllowance("ENTERPRISE", 0).upgradeTo).toBeNull();
  });

  it("refuses an empty, oversized or unaffordable batch, in that order", () => {
    const fresh = aiRewriteAllowance("PRO", 0);
    expect(checkAiRewriteRequest(fresh, 0)).toBe("none-selected");
    expect(checkAiRewriteRequest(fresh, MAX_AI_REWRITE_BATCH + 1)).toBe("batch-too-large");
    expect(checkAiRewriteRequest(aiRewriteAllowance("FREE", 3), 1)).toBe("quota-exhausted");
    expect(checkAiRewriteRequest(aiRewriteAllowance("FREE", 1), 3)).toBe("quota-short");
    expect(checkAiRewriteRequest(aiRewriteAllowance("FREE", 1), 2)).toBeNull();
  });

  it("counts by UTC calendar month and resets on the first", () => {
    expect(aiUsagePeriod(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(aiUsagePeriod(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
    expect(aiUsageResetsAt(new Date("2026-12-15T12:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
