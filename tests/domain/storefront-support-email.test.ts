import { describe, expect, it } from "vitest";
import { mergeShopSettings, parseShopSettings, supportEmailProblem } from "~/domain/settings/shop-settings";

/**
 * The support address a merchant sets for AI-written pages ends up as the only
 * mailto link on a live product page, so the settings screen refuses anything
 * that is not one plain address. The stored value itself stays a loose string:
 * a strict schema would let one bad value reset every other setting.
 */

describe("storefront support email setting", () => {
  it("defaults to empty for a shop that never set it", () => {
    expect(parseShopSettings({}).products.storefrontSupportEmail).toBe("");
    expect(parseShopSettings({ products: { defaultVendor: "Harbor & Pine" } }).products.storefrontSupportEmail).toBe("");
  });

  it("merges without disturbing the rest of the products section", () => {
    const merged = mergeShopSettings({ products: { defaultVendor: "Harbor & Pine", maxImages: 12 } }, { products: { storefrontSupportEmail: "care@harborpine.com" } });
    expect(merged.products).toMatchObject({ defaultVendor: "Harbor & Pine", maxImages: 12, storefrontSupportEmail: "care@harborpine.com" });
  });

  it("does not let a stored bad value reset every other setting", () => {
    const parsed = parseShopSettings({ products: { storefrontSupportEmail: "not an address", maxImages: 12 } });
    expect(parsed.products.maxImages).toBe(12);
  });

  it("accepts empty or one plain address", () => {
    expect(supportEmailProblem("")).toBeNull();
    expect(supportEmailProblem("   ")).toBeNull();
    expect(supportEmailProblem(undefined)).toBeNull();
    expect(supportEmailProblem(" care@harborpine.com ")).toBeNull();
  });

  it("refuses anything that would not be one working mailto link", () => {
    for (const value of [
      "care",
      "care@harborpine",
      "Harbor <care@harborpine.com>",
      "care@harborpine.com, owner@harborpine.com",
      'care@harborpine.com" onclick="x',
      `${"a".repeat(250)}@harborpine.com`,
    ]) {
      expect(supportEmailProblem(value), value).toBe("invalid");
    }
  });
});
