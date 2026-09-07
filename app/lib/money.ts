import Decimal from "decimal.js";

// Money is stored as Prisma Decimal(18,4) and manipulated with decimal.js so
// markup chains (cost -> markup -> rounding -> cents ending) never drift.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal | { toString(): string } | null | undefined;

export function d(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Decimal(value) : new Decimal(0);
  }
  const asString = typeof value === "string" ? value : value.toString();
  try {
    return new Decimal(asString);
  } catch {
    return new Decimal(0);
  }
}

/** Round to the currency's minor unit. Everything we deal with is 2dp. */
export function round2(value: MoneyInput): Decimal {
  return d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Canonical string form for the database and Shopify's API ("12.30"). */
export function money(value: MoneyInput): string {
  return round2(value).toFixed(2);
}

export function toNumber(value: MoneyInput): number {
  return d(value).toNumber();
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(d(v)), new Decimal(0));
}

export function isZero(value: MoneyInput): boolean {
  return d(value).isZero();
}

export function max(a: MoneyInput, b: MoneyInput): Decimal {
  const da = d(a);
  const db = d(b);
  return da.greaterThan(db) ? da : db;
}

export function min(a: MoneyInput, b: MoneyInput): Decimal {
  const da = d(a);
  const db = d(b);
  return da.lessThan(db) ? da : db;
}

/**
 * Force the fractional part to a fixed number of cents while keeping the price
 * in the same "psychological" band: 19.42 with ending 99 becomes 19.99, but
 * 19.99 with ending 95 becomes 19.95 (never jumps a whole unit downward).
 */
export function applyCentsEnding(value: MoneyInput, cents: number | null | undefined): Decimal {
  if (cents === null || cents === undefined) return round2(value);
  const normalized = Math.min(99, Math.max(0, Math.trunc(cents)));
  const price = round2(value);
  const whole = price.floor();
  return whole.plus(new Decimal(normalized).dividedBy(100));
}

/**
 * Round the price up to the next multiple of `step` (e.g. step 5: 21.40 -> 25).
 * A price already on a multiple is left alone.
 */
export function roundUpToMultiple(value: MoneyInput, step: MoneyInput): Decimal {
  const s = d(step);
  if (s.lessThanOrEqualTo(0)) return round2(value);
  const price = d(value);
  const multiples = price.dividedBy(s).toDecimalPlaces(0, Decimal.ROUND_CEIL);
  return round2(multiples.times(s));
}

/** Percentage change from `from` to `to`, as a positive-or-negative Decimal. */
export function percentChange(from: MoneyInput, to: MoneyInput): Decimal {
  const a = d(from);
  const b = d(to);
  if (a.isZero()) return b.isZero() ? new Decimal(0) : new Decimal(100);
  return b.minus(a).dividedBy(a).times(100);
}

export function convert(value: MoneyInput, rate: MoneyInput): Decimal {
  return round2(d(value).times(d(rate)));
}

export { Decimal };
