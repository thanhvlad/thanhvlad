import { describe, expect, it } from "vitest";
import {
  PAID_PLANS,
  PLANS,
  PLAN_ORDER,
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
