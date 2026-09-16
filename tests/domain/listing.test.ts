import { describe, expect, it } from "vitest";
import { fallbackSku, storefrontVendor } from "~/domain/suppliers/listing";

describe("storefrontVendor", () => {
  it("never falls back to the supplier's store name", () => {
    // The signature has no way to pass a supplier store name at all; this pins
    // that the result comes only from the merchant's own values.
    expect(storefrontVendor("", "Lumora")).toBe("Lumora");
  });

  it("prefers the merchant's chosen default vendor", () => {
    expect(storefrontVendor("Lumora Home", "Lumora")).toBe("Lumora Home");
  });

  it("leaves the vendor empty rather than inventing one", () => {
    expect(storefrontVendor("", null)).toBeNull();
    expect(storefrontVendor("   ", "  ")).toBeNull();
  });
});

describe("fallbackSku", () => {
  it("builds a stable SKU from the supplier's own SKU id", () => {
    expect(fallbackSku("ALIEXPRESS", "12000050123456789")).toBe("AE-12000050123456789");
    expect(fallbackSku("ALIEXPRESS", "12000050123456789")).toBe(fallbackSku("ALIEXPRESS", "12000050123456789"));
  });

  it("keeps two variants of one product distinct", () => {
    expect(fallbackSku("ALIEXPRESS", "12000050123456789")).not.toBe(fallbackSku("ALIEXPRESS", "12000050123456790"));
  });

  it("marks the platform, so the same id on two suppliers cannot collide", () => {
    expect(fallbackSku("CJ_DROPSHIPPING", "123")).toBe("CJ-123");
    expect(fallbackSku("ALIEXPRESS", "123")).toBe("AE-123");
  });

  it("strips characters that break spreadsheets and barcode printers", () => {
    expect(fallbackSku("ALIEXPRESS", "12:34;56 78")).toBe("AE-12345678");
  });

  it("returns null when there is no supplier SKU id to build from", () => {
    expect(fallbackSku("ALIEXPRESS", "")).toBeNull();
    expect(fallbackSku("ALIEXPRESS", null)).toBeNull();
  });

  it("stays inside a sensible length", () => {
    expect((fallbackSku("ALIEXPRESS", "9".repeat(300)) ?? "").length).toBeLessThanOrEqual(64);
  });
});
