export type PriceOp = "MULTIPLY" | "ADD" | "MARGIN" | "FIXED" | "NONE";

export interface PricingTier {
  id?: string;
  /** Inclusive lower bound on the item cost. */
  minCost: string | number;
  /** Exclusive upper bound. `null` means "and above". */
  maxCost?: string | number | null;
  priceOp: PriceOp;
  priceValue: string | number;
  compareAtOp?: PriceOp;
  compareAtValue?: string | number | null;
}

export interface PricingRuleInput {
  id?: string;
  name?: string;
  basePriceOp: PriceOp;
  basePriceValue: string | number;
  compareAtOp?: PriceOp;
  compareAtValue?: string | number | null;
  centsEnding?: number | null;
  roundToMultiple?: string | number | null;
  includeShipping?: boolean;
  minPrice?: string | number | null;
  maxPrice?: string | number | null;
  tiers?: PricingTier[];
}

export interface PriceComputationInput {
  /** Supplier item cost, in the shop's currency. */
  cost: string | number;
  /** Supplier shipping cost, in the shop's currency. */
  shippingCost?: string | number;
}

export interface PriceComputationResult {
  /** The cost the markup was applied to (item, plus shipping when folded in). */
  effectiveCost: string;
  price: string;
  compareAtPrice: string | null;
  /** Margin as a percentage of the sale price. */
  marginPercent: string;
  profit: string;
  appliedTierId: string | null;
  /** Set when a min/max guard rail changed the computed price. */
  clampedBy: "min" | "max" | null;
}
