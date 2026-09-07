export interface ShippingOption {
  id?: string;
  carrierCode: string;
  carrierName: string;
  cost: string | number;
  currency: string;
  shipFromCountry?: string;
  shipToCountry: string;
  minDeliveryDays?: number | null;
  maxDeliveryDays?: number | null;
  hasTracking: boolean;
  isFreeShipping?: boolean;
}

export interface ShippingPreferenceRow {
  id?: string;
  /** ISO-3166 alpha-2, or "*" for the global fallback. */
  countryCode: string;
  carrierCode: string;
  priority: number;
  maxCost?: string | number | null;
  maxDeliveryDays?: number | null;
  requireTracking: boolean;
  isEnabled: boolean;
}

export type ShippingFallback = "CHEAPEST" | "FASTEST" | "NONE";

export interface SelectShippingInput {
  options: ShippingOption[];
  preferences: ShippingPreferenceRow[];
  shipToCountry: string;
  /** What to do when no preference matches. */
  fallback?: ShippingFallback;
  /** Hard ceiling applied to the fallback too. */
  maxCost?: string | number | null;
  requireTracking?: boolean;
}

export interface SelectShippingResult {
  ok: boolean;
  option: ShippingOption | null;
  /** Which preference row picked it, when applicable. */
  matchedPreferenceId?: string | null;
  strategy: "PREFERENCE" | "FALLBACK" | "NONE";
  reason: string;
  rejected: Array<{ carrierCode: string; reason: string }>;
}
