import { describe, expect, it } from "vitest";
import { Decimal } from "~/lib/money";
import { computePrice, selectTier, DEFAULT_PRICING_RULE } from "~/domain/pricing/engine";
import type { PricingRuleInput } from "~/domain/pricing/types";

describe("pricing engine", () => {
  it("multiplies cost with the base rule", () => {
    const result = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 2 },
      { cost: "10.00" },
    );
    expect(result.price).toBe("20.00");
    expect(result.compareAtPrice).toBeNull();
    expect(result.profit).toBe("10.00");
    expect(result.marginPercent).toBe("50.00");
  });

  it("applies cents ending after rounding to a multiple", () => {
    const result = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 2, roundToMultiple: 5, centsEnding: 99 },
      { cost: "10.70" },
    );
    // 21.40 -> 25.00 -> 25.99
    expect(result.price).toBe("25.99");
  });

  it("picks the matching cost tier", () => {
    const rule: PricingRuleInput = {
      basePriceOp: "MULTIPLY",
      basePriceValue: 2,
      tiers: [
        { id: "t1", minCost: 0, maxCost: 5, priceOp: "MULTIPLY", priceValue: 3 },
        { id: "t2", minCost: 5, maxCost: 20, priceOp: "ADD", priceValue: 10 },
        { id: "t3", minCost: 20, maxCost: null, priceOp: "MARGIN", priceValue: 40 },
      ],
    };
    expect(computePrice(rule, { cost: 3 }).price).toBe("9.00");
    expect(computePrice(rule, { cost: 3 }).appliedTierId).toBe("t1");
    expect(computePrice(rule, { cost: 5 }).price).toBe("15.00");
    expect(computePrice(rule, { cost: 5 }).appliedTierId).toBe("t2");
    // margin 40%: 30 / 0.6 = 50
    expect(computePrice(rule, { cost: 30 }).price).toBe("50.00");
    expect(computePrice(rule, { cost: 30 }).appliedTierId).toBe("t3");
  });

  it("treats tier bounds as [min, max)", () => {
    const tiers = [
      { id: "a", minCost: 0, maxCost: 10, priceOp: "MULTIPLY" as const, priceValue: 2 },
      { id: "b", minCost: 10, maxCost: null, priceOp: "MULTIPLY" as const, priceValue: 1.5 },
    ];
    expect(selectTier(new Decimal(9.99), tiers)?.id).toBe("a");
    expect(selectTier(new Decimal(10), tiers)?.id).toBe("b");
  });

  it("folds shipping into cost when configured", () => {
    const withShipping = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 2, includeShipping: true },
      { cost: 10, shippingCost: 3 },
    );
    const withoutShipping = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 2, includeShipping: false },
      { cost: 10, shippingCost: 3 },
    );
    expect(withShipping.price).toBe("26.00");
    expect(withShipping.effectiveCost).toBe("13.00");
    expect(withoutShipping.price).toBe("20.00");
  });

  it("clamps to min and max and reports it", () => {
    const min = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 1.1, minPrice: 9.99 },
      { cost: 2 },
    );
    expect(min.price).toBe("9.99");
    expect(min.clampedBy).toBe("min");

    const max = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 10, maxPrice: 49 },
      { cost: 20 },
    );
    expect(max.price).toBe("49.00");
    expect(max.clampedBy).toBe("max");
  });

  it("derives compare-at from the price and drops it when not higher", () => {
    const ok = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 2, compareAtOp: "MULTIPLY", compareAtValue: 1.5 },
      { cost: 10 },
    );
    expect(ok.compareAtPrice).toBe("30.00");

    const lower = computePrice(
      { basePriceOp: "MULTIPLY", basePriceValue: 2, compareAtOp: "MULTIPLY", compareAtValue: 0.5 },
      { cost: 10 },
    );
    expect(lower.compareAtPrice).toBeNull();
  });

  it("never divides by zero for a 100% margin", () => {
    const result = computePrice({ basePriceOp: "MARGIN", basePriceValue: 100 }, { cost: 10 });
    expect(result.price).toBe("10.00");
  });

  it("ships a sensible default rule", () => {
    const result = computePrice(DEFAULT_PRICING_RULE, { cost: "7.35" });
    expect(result.price).toBe("14.99");
    expect(result.compareAtPrice).toBe("20.99");
  });
});
