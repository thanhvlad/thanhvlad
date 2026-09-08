import { d, money } from "~/lib/money";

/**
 * Supplier scoring for the optimizer.
 *
 * Merchants do not choose a supplier on item price alone — a cheap item with
 * $9 shipping and a 45-day window is worse than a slightly dearer one that
 * arrives in two weeks from a seller with 20,000 orders behind them. The score
 * combines landed cost, speed, rating and volume, each normalised across the
 * candidates actually on the table so the numbers stay comparable.
 */

export interface ScoreInput {
  id: string;
  /** Cost of the cheapest matching SKU, in the shop's currency. */
  itemCost: string | number;
  /** Shipping to the shop's main destination, in the shop's currency. */
  shippingCost: string | number;
  deliveryDays: number | null;
  /** 0-5. */
  rating: number | null;
  orderCount: number | null;
  isAvailable: boolean;
  /** The supplier the product is mapped to today. */
  isCurrent?: boolean;
  /** How many of the product's variants this supplier can actually cover, 0-1. */
  coverage?: number;
}

export interface ScoreWeights {
  cost: number;
  speed: number;
  rating: number;
  volume: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  cost: 0.45,
  speed: 0.2,
  rating: 0.2,
  volume: 0.15,
};

export interface ScoredCandidate extends ScoreInput {
  landedCost: string;
  score: number;
  breakdown: {
    cost: number;
    speed: number;
    rating: number;
    volume: number;
    coverage: number;
  };
  /** Positive when cheaper than the current supplier. */
  savingsVsCurrent: string | null;
  savingsPercent: number | null;
  isBest: boolean;
}

/** Normalise to 0-1 where a LOWER raw value is better. */
function invertedScale(value: number | null, min: number, max: number): number {
  if (value === null || !Number.isFinite(value)) return 0.5;
  if (max <= min) return 1;
  return Math.max(0, Math.min(1, (max - value) / (max - min)));
}

/** Normalise to 0-1 where a HIGHER raw value is better. */
function scale(value: number | null, min: number, max: number): number {
  if (value === null || !Number.isFinite(value)) return 0.5;
  if (max <= min) return 1;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * Score every candidate against the others. Unavailable suppliers stay in the
 * list — the merchant should see that the cheap one is out of stock — but score
 * zero so they never win.
 */
export function scoreCandidates(candidates: ScoreInput[], weights: ScoreWeights = DEFAULT_WEIGHTS): ScoredCandidate[] {
  if (candidates.length === 0) return [];

  const landed = new Map<string, number>();
  for (const c of candidates) {
    landed.set(c.id, d(c.itemCost).plus(d(c.shippingCost)).toNumber());
  }
  const usable = candidates.filter((c) => c.isAvailable);
  const pool = usable.length > 0 ? usable : candidates;

  const costs = pool.map((c) => landed.get(c.id)!);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const days = pool.map((c) => c.deliveryDays).filter((v): v is number => v !== null && Number.isFinite(v));
  const minDays = days.length ? Math.min(...days) : 0;
  const maxDays = days.length ? Math.max(...days) : 0;

  const ratings = pool.map((c) => c.rating).filter((v): v is number => v !== null);
  const minRating = ratings.length ? Math.min(...ratings) : 0;
  const maxRating = ratings.length ? Math.max(...ratings) : 5;

  // Order counts span orders of magnitude; compare their logs.
  const volumes = pool.map((c) => Math.log10(Math.max(1, c.orderCount ?? 1)));
  const minVolume = Math.min(...volumes);
  const maxVolume = Math.max(...volumes);

  const current = candidates.find((c) => c.isCurrent);
  const currentLanded = current ? landed.get(current.id)! : null;

  const scored = candidates.map((c) => {
    const breakdown = {
      cost: invertedScale(landed.get(c.id)!, minCost, maxCost),
      speed: invertedScale(c.deliveryDays, minDays, maxDays),
      rating: scale(c.rating, minRating, maxRating),
      volume: scale(Math.log10(Math.max(1, c.orderCount ?? 1)), minVolume, maxVolume),
      coverage: c.coverage ?? 1,
    };
    const raw =
      breakdown.cost * weights.cost +
      breakdown.speed * weights.speed +
      breakdown.rating * weights.rating +
      breakdown.volume * weights.volume;
    const total = weights.cost + weights.speed + weights.rating + weights.volume;
    // Coverage multiplies rather than adds: a supplier that can only serve a
    // third of the variants is worth a third of the deal, however cheap it is.
    const score = c.isAvailable ? Math.round((raw / total) * breakdown.coverage * 1000) / 10 : 0;

    const landedCost = landed.get(c.id)!;
    const savings = currentLanded !== null && !c.isCurrent ? currentLanded - landedCost : null;
    return {
      ...c,
      landedCost: money(landedCost),
      score,
      breakdown: {
        cost: round3(breakdown.cost),
        speed: round3(breakdown.speed),
        rating: round3(breakdown.rating),
        volume: round3(breakdown.volume),
        coverage: round3(breakdown.coverage),
      },
      savingsVsCurrent: savings === null ? null : money(savings),
      savingsPercent: savings === null || currentLanded === 0 ? null : Math.round((savings / currentLanded!) * 1000) / 10,
      isBest: false,
    };
  });

  const bestScore = Math.max(...scored.map((s) => s.score));
  for (const s of scored) s.isBest = s.score === bestScore && s.score > 0;

  return scored.sort((a, b) => b.score - a.score || d(a.landedCost).comparedTo(d(b.landedCost)));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Is the best alternative worth telling the merchant about? Only when it beats
 * the current supplier meaningfully — a 12-cent saving is noise.
 */
export function isWorthSwitching(
  scored: ScoredCandidate[],
  options: { minSavings?: number; minSavingsPercent?: number } = {},
): ScoredCandidate | null {
  const minSavings = options.minSavings ?? 0.5;
  const minPercent = options.minSavingsPercent ?? 8;
  const current = scored.find((s) => s.isCurrent);
  if (!current) return null;
  const best = scored.find((s) => !s.isCurrent && s.isAvailable);
  if (!best) return null;
  const savings = d(best.savingsVsCurrent ?? 0).toNumber();
  if (savings < minSavings) return null;
  if ((best.savingsPercent ?? 0) < minPercent) return null;
  if (best.score <= current.score) return null;
  return best;
}
