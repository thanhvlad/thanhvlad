import { Decimal, applyCentsEnding, d, money, round2, roundUpToMultiple } from "~/lib/money";
import type {
  PriceComputationInput,
  PriceComputationResult,
  PriceOp,
  PricingRuleInput,
  PricingTier,
} from "./types";

/**
 * Apply a single price operation to a cost.
 *
 * MULTIPLY  price = cost x value            (value 2 => 100% markup)
 * ADD       price = cost + value
 * MARGIN    price = cost / (1 - value/100)  (value is the target gross margin %)
 * FIXED     price = value
 * NONE      price = cost
 */
export function applyOp(cost: Decimal, op: PriceOp, value: Decimal): Decimal {
  switch (op) {
    case "MULTIPLY":
      return cost.times(value);
    case "ADD":
      return cost.plus(value);
    case "MARGIN": {
      // A 100% (or higher) margin is unreachable; treat it as "no markup data"
      // rather than dividing by zero and producing Infinity.
      const denominator = new Decimal(1).minus(value.dividedBy(100));
      if (denominator.lessThanOrEqualTo(0)) return cost;
      return cost.dividedBy(denominator);
    }
    case "FIXED":
      return value;
    case "NONE":
    default:
      return cost;
  }
}

/** First tier whose [minCost, maxCost) window contains the cost. */
export function selectTier(cost: Decimal, tiers: PricingTier[] = []): PricingTier | null {
  const sorted = [...tiers].sort((a, b) => d(a.minCost).comparedTo(d(b.minCost)));
  for (const tier of sorted) {
    const min = d(tier.minCost);
    if (cost.lessThan(min)) continue;
    if (tier.maxCost === null || tier.maxCost === undefined) return tier;
    if (cost.lessThan(d(tier.maxCost))) return tier;
  }
  return null;
}

/**
 * Turn a supplier cost into a storefront price.
 *
 * Order of operations matters and mirrors DSers: pick the tier by *cost*, apply
 * the markup, then rounding, then the cents ending, and only then clamp — so a
 * min-price guard is never undone by rounding.
 */
export function computePrice(
  rule: PricingRuleInput,
  input: PriceComputationInput,
): PriceComputationResult {
  const itemCost = d(input.cost);
  const shipping = d(input.shippingCost ?? 0);
  const effectiveCost = rule.includeShipping ? itemCost.plus(shipping) : itemCost;

  const tier = selectTier(effectiveCost, rule.tiers);

  const priceOp = tier ? tier.priceOp : rule.basePriceOp;
  const priceValue = d(tier ? tier.priceValue : rule.basePriceValue);
  let price = applyOp(effectiveCost, priceOp, priceValue);

  // Rounding, then cents ending. Doing it the other way round would let the
  // multiple-rounding wipe out the ".99" the merchant asked for.
  if (rule.roundToMultiple !== null && rule.roundToMultiple !== undefined) {
    const step = d(rule.roundToMultiple);
    if (step.greaterThan(0)) price = roundUpToMultiple(price, step);
  }
  if (rule.centsEnding !== null && rule.centsEnding !== undefined) {
    price = applyCentsEnding(price, rule.centsEnding);
  }
  price = round2(price);

  let clampedBy: "min" | "max" | null = null;
  if (rule.minPrice !== null && rule.minPrice !== undefined) {
    const min = d(rule.minPrice);
    if (min.greaterThan(0) && price.lessThan(min)) {
      price = min;
      clampedBy = "min";
    }
  }
  if (rule.maxPrice !== null && rule.maxPrice !== undefined) {
    const max = d(rule.maxPrice);
    if (max.greaterThan(0) && price.greaterThan(max)) {
      price = max;
      clampedBy = "max";
    }
  }
  price = round2(price);

  // Compare-at is derived from the *price*, not the cost — merchants think of
  // it as "show this as the crossed-out was-price".
  const compareOp = (tier?.compareAtOp ?? rule.compareAtOp ?? "NONE") as PriceOp;
  const compareValueRaw = tier?.compareAtOp
    ? tier.compareAtValue
    : (rule.compareAtValue ?? null);

  let compareAtPrice: Decimal | null = null;
  if (compareOp !== "NONE" && compareValueRaw !== null && compareValueRaw !== undefined) {
    let candidate = applyOp(price, compareOp, d(compareValueRaw));
    if (rule.centsEnding !== null && rule.centsEnding !== undefined) {
      candidate = applyCentsEnding(candidate, rule.centsEnding);
    }
    candidate = round2(candidate);
    // Shopify rejects a compare-at below the price; it would also read as a
    // price *increase* to a shopper.
    compareAtPrice = candidate.greaterThan(price) ? candidate : null;
  }

  const profit = price.minus(effectiveCost);
  const marginPercent = price.isZero()
    ? new Decimal(0)
    : profit.dividedBy(price).times(100).toDecimalPlaces(2);

  return {
    effectiveCost: money(effectiveCost),
    price: money(price),
    compareAtPrice: compareAtPrice ? money(compareAtPrice) : null,
    marginPercent: marginPercent.toFixed(2),
    profit: money(profit),
    appliedTierId: tier?.id ?? null,
    clampedBy,
  };
}

/** Convenience wrapper for bulk repricing a whole product. */
export function computePrices(
  rule: PricingRuleInput,
  inputs: PriceComputationInput[],
): PriceComputationResult[] {
  return inputs.map((input) => computePrice(rule, input));
}

/** The rule used when a shop has not configured one yet: 2x cost, ending .99. */
export const DEFAULT_PRICING_RULE: PricingRuleInput = {
  name: "Default (2x cost)",
  basePriceOp: "MULTIPLY",
  basePriceValue: 2,
  compareAtOp: "MULTIPLY",
  compareAtValue: 1.4,
  centsEnding: 99,
  roundToMultiple: null,
  includeShipping: false,
  minPrice: null,
  maxPrice: null,
  tiers: [],
};
