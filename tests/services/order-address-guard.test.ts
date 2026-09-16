import { describe, expect, it } from "vitest";
import { addressIsCompleteForShopify } from "~/domain/orders/address";

describe("addressIsCompleteForShopify", () => {
  it("accepts a real address", () => {
    expect(addressIsCompleteForShopify({ address1: "12 Hill St", city: "Leeds", countryCode: "GB" } as never)).toBe(true);
  });

  it("refuses the country-only address a minimised order keeps", () => {
    // Pushing this replaced the live Shopify order's address with blanks.
    expect(addressIsCompleteForShopify({ countryCode: "US" } as never)).toBe(false);
  });

  it("refuses blanks that are present but empty", () => {
    expect(addressIsCompleteForShopify({ address1: "  ", city: "Leeds", countryCode: "GB" } as never)).toBe(false);
    expect(addressIsCompleteForShopify(null)).toBe(false);
  });
});
