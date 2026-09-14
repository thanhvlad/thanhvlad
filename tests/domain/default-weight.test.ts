/**
 * The first AliExpress product pushed to a real store went out at 0 kg: the
 * product page carries no package weight anywhere, and weight-based shipping
 * rates then charged nothing for it. The shop's default weight fills that gap.
 */
import { describe, expect, it } from "vitest";
import { mergeShopSettings, parseShopSettings, resolveVariantWeightGrams } from "~/domain/settings/shop-settings";

describe("default variant weight", () => {
  it("is off for existing shops, so nothing changes until the merchant sets it", () => {
    expect(parseShopSettings({}).products.defaultWeightGrams).toBe(0);
    expect(parseShopSettings({ products: { weightUnit: "KILOGRAMS" } }).products.defaultWeightGrams).toBe(0);
  });

  it("keeps the rest of a stored products section when it is saved", () => {
    const stored = { products: { defaultTags: "summer", maxImages: 8 } };
    const merged = mergeShopSettings(stored, { products: { defaultWeightGrams: 250 } });
    expect(merged.products).toMatchObject({ defaultTags: "summer", maxImages: 8, defaultWeightGrams: 250 });
  });

  it("refuses a negative weight rather than storing it", () => {
    expect(() => mergeShopSettings({}, { products: { defaultWeightGrams: -5 } })).toThrow();
  });

  it("uses the supplier's own weight whenever it gave a real one", () => {
    expect(resolveVariantWeightGrams(180, 300)).toBe(180);
    expect(resolveVariantWeightGrams(180.6, 0)).toBe(181);
  });

  it("falls back to the default when the supplier gave none, or a zero", () => {
    expect(resolveVariantWeightGrams(null, 300)).toBe(300);
    expect(resolveVariantWeightGrams(undefined, 300)).toBe(300);
    expect(resolveVariantWeightGrams(0, 300)).toBe(300);
    expect(resolveVariantWeightGrams(Number.NaN, 300)).toBe(300);
  });

  it("leaves the variant without a weight when there is no default either", () => {
    expect(resolveVariantWeightGrams(null, 0)).toBeNull();
    expect(resolveVariantWeightGrams(0, 0)).toBeNull();
  });
});
