import { describe, expect, it } from "vitest";
import { selectShipping } from "~/domain/shipping/select";
import type { ShippingOption, ShippingPreferenceRow } from "~/domain/shipping/types";

const opt = (carrierCode: string, cost: number, extra: Partial<ShippingOption> = {}): ShippingOption => ({
  carrierCode,
  carrierName: carrierCode,
  cost,
  currency: "USD",
  shipToCountry: "US",
  hasTracking: true,
  maxDeliveryDays: 20,
  ...extra,
});

const pref = (carrierCode: string, extra: Partial<ShippingPreferenceRow> = {}): ShippingPreferenceRow => ({
  id: `pref-${carrierCode}`,
  countryCode: "US",
  carrierCode,
  priority: 0,
  requireTracking: false,
  isEnabled: true,
  ...extra,
});

describe("selectShipping", () => {
  const options = [
    opt("CAINIAO_STANDARD", 1.5, { maxDeliveryDays: 35 }),
    opt("EPACKET", 3.2, { maxDeliveryDays: 15 }),
    opt("SELLER_SHIPPING", 0, { hasTracking: false, maxDeliveryDays: 60 }),
  ];

  it("picks the highest-priority preferred carrier that is offered", () => {
    const result = selectShipping({
      options,
      preferences: [pref("EPACKET", { priority: 0 }), pref("CAINIAO_STANDARD", { priority: 1 })],
      shipToCountry: "US",
    });
    expect(result.strategy).toBe("PREFERENCE");
    expect(result.option?.carrierCode).toBe("EPACKET");
    expect(result.matchedPreferenceId).toBe("pref-EPACKET");
  });

  it("skips a preference whose constraints fail and records why", () => {
    const result = selectShipping({
      options,
      preferences: [
        pref("EPACKET", { priority: 0, maxCost: 2 }),
        pref("CAINIAO_STANDARD", { priority: 1 }),
      ],
      shipToCountry: "US",
    });
    expect(result.option?.carrierCode).toBe("CAINIAO_STANDARD");
    expect(result.rejected[0]).toEqual({ carrierCode: "EPACKET", reason: "cost 3.2 exceeds cap 2.00" });
  });

  it("falls back to the cheapest tracked option", () => {
    const result = selectShipping({
      options,
      preferences: [pref("DHL")],
      shipToCountry: "US",
      requireTracking: true,
    });
    expect(result.strategy).toBe("FALLBACK");
    expect(result.option?.carrierCode).toBe("CAINIAO_STANDARD");
  });

  it("can fall back to the fastest option instead", () => {
    const result = selectShipping({
      options,
      preferences: [],
      shipToCountry: "US",
      fallback: "FASTEST",
    });
    expect(result.option?.carrierCode).toBe("EPACKET");
  });

  it("uses the wildcard preference for countries with no explicit rule", () => {
    const result = selectShipping({
      options: options.map((o) => ({ ...o, shipToCountry: "DE" })),
      preferences: [pref("EPACKET", { countryCode: "*" })],
      shipToCountry: "DE",
    });
    expect(result.option?.carrierCode).toBe("EPACKET");
  });

  it("fails cleanly when fallback is disabled", () => {
    const result = selectShipping({
      options,
      preferences: [pref("DHL")],
      shipToCountry: "US",
      fallback: "NONE",
    });
    expect(result.ok).toBe(false);
    expect(result.strategy).toBe("NONE");
  });
});
