import { d } from "~/lib/money";
import type {
  SelectShippingInput,
  SelectShippingResult,
  ShippingOption,
  ShippingPreferenceRow,
} from "./types";

function deliveryDays(option: ShippingOption): number {
  return option.maxDeliveryDays ?? option.minDeliveryDays ?? Number.MAX_SAFE_INTEGER;
}

function violates(
  option: ShippingOption,
  constraints: {
    maxCost?: string | number | null;
    maxDeliveryDays?: number | null;
    requireTracking?: boolean;
  },
): string | null {
  if (constraints.requireTracking && !option.hasTracking) return "no tracking";
  if (constraints.maxCost !== null && constraints.maxCost !== undefined) {
    const cap = d(constraints.maxCost);
    if (cap.greaterThan(0) && d(option.cost).greaterThan(cap)) {
      return `cost ${option.cost} exceeds cap ${cap.toFixed(2)}`;
    }
  }
  if (constraints.maxDeliveryDays !== null && constraints.maxDeliveryDays !== undefined) {
    if (deliveryDays(option) > constraints.maxDeliveryDays) {
      return `delivery ${deliveryDays(option)}d exceeds ${constraints.maxDeliveryDays}d`;
    }
  }
  return null;
}

/** Exact-country preferences first, then wildcard, each ordered by priority. */
function rankPreferences(
  preferences: ShippingPreferenceRow[],
  shipToCountry: string,
): ShippingPreferenceRow[] {
  const country = shipToCountry.toUpperCase();
  return preferences
    .filter((p) => p.isEnabled)
    .filter((p) => p.countryCode === "*" || p.countryCode.toUpperCase() === country)
    .sort((a, b) => {
      const aExact = a.countryCode !== "*" ? 0 : 1;
      const bExact = b.countryCode !== "*" ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.priority - b.priority;
    });
}

/**
 * Choose the shipping method for a supplier order.
 *
 * Merchants configure a ranked carrier list per destination ("ePacket first,
 * then AliExpress Standard, never Seller's Shipping Method"). When nothing in
 * that list is offered for the order we fall back to the cheapest or fastest
 * remaining option, still honouring the global cost/tracking guard rails.
 */
export function selectShipping(input: SelectShippingInput): SelectShippingResult {
  const country = input.shipToCountry.toUpperCase();
  const rejected: SelectShippingResult["rejected"] = [];

  const available = input.options.filter(
    (o) => o.shipToCountry === "*" || o.shipToCountry.toUpperCase() === country,
  );

  if (available.length === 0) {
    return {
      ok: false,
      option: null,
      strategy: "NONE",
      reason: `The supplier offers no shipping method to ${country}.`,
      rejected,
    };
  }

  for (const preference of rankPreferences(input.preferences, country)) {
    const matches = available.filter(
      (o) => o.carrierCode.toUpperCase() === preference.carrierCode.toUpperCase(),
    );
    if (matches.length === 0) continue;

    const affordable = matches
      .map((option) => ({
        option,
        problem:
          violates(option, preference) ??
          violates(option, {
            maxCost: input.maxCost,
            requireTracking: input.requireTracking,
          }),
      }))
      .filter((entry) => {
        if (entry.problem) {
          rejected.push({ carrierCode: entry.option.carrierCode, reason: entry.problem });
          return false;
        }
        return true;
      })
      .map((entry) => entry.option)
      .sort((a, b) => d(a.cost).comparedTo(d(b.cost)));

    if (affordable.length > 0) {
      return {
        ok: true,
        option: affordable[0],
        matchedPreferenceId: preference.id ?? null,
        strategy: "PREFERENCE",
        reason: `Matched preferred carrier ${preference.carrierCode} for ${preference.countryCode}.`,
        rejected,
      };
    }
  }

  const fallback = input.fallback ?? "CHEAPEST";
  if (fallback === "NONE") {
    return {
      ok: false,
      option: null,
      strategy: "NONE",
      reason: "No preferred shipping method is available and fallback is disabled.",
      rejected,
    };
  }

  const eligible = available.filter((option) => {
    const problem = violates(option, {
      maxCost: input.maxCost,
      requireTracking: input.requireTracking,
    });
    if (problem) {
      rejected.push({ carrierCode: option.carrierCode, reason: problem });
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return {
      ok: false,
      option: null,
      strategy: "NONE",
      reason: "Every available shipping method breaks the configured limits.",
      rejected,
    };
  }

  const sorted =
    fallback === "FASTEST"
      ? [...eligible].sort((a, b) => deliveryDays(a) - deliveryDays(b))
      : [...eligible].sort((a, b) => d(a.cost).comparedTo(d(b.cost)));

  return {
    ok: true,
    option: sorted[0],
    matchedPreferenceId: null,
    strategy: "FALLBACK",
    reason: `No preferred carrier available; picked the ${fallback.toLowerCase()} option.`,
    rejected,
  };
}
