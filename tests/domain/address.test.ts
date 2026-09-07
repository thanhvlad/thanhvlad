import { describe, expect, it } from "vitest";
import { applySuggestions, validateAddress } from "~/domain/orders/address";

const good = {
  firstName: "Jane",
  lastName: "Doe",
  address1: "123 Main St",
  city: "Austin",
  province: "Texas",
  provinceCode: "TX",
  zip: "78701",
  countryCode: "US",
  phone: "+1 512 555 0100",
};

describe("validateAddress", () => {
  it("accepts a complete US address", () => {
    const result = validateAddress(good);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.normalized.name).toBe("Jane Doe");
  });

  it("requires phone, zip and province where applicable", () => {
    const result = validateAddress({ ...good, phone: "", zip: "", province: null, provinceCode: null });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("MISSING_PHONE");
    expect(codes).toContain("MISSING_ZIP");
    expect(codes).toContain("MISSING_PROVINCE");
    expect(result.ok).toBe(false);
  });

  it("does not require a zip for countries without postal codes", () => {
    const result = validateAddress({ ...good, countryCode: "AE", zip: "", province: null, provinceCode: null });
    expect(result.issues.map((i) => i.code)).not.toContain("MISSING_ZIP");
  });

  it("splits an over-long address line into line 2", () => {
    const long = "Apartment complex building B floor 12 unit 1204 ".repeat(4).trim();
    const result = validateAddress({ ...good, address1: long });
    const issue = result.issues.find((i) => i.code === "ADDRESS1_TOO_LONG");
    expect(issue).toBeDefined();
    const fixed = applySuggestions(result.normalized, result.issues);
    expect((fixed.address1 ?? "").length).toBeLessThanOrEqual(128);
    expect(fixed.address2).toBeTruthy();
    expect(`${fixed.address1} ${fixed.address2}`.replace(/,/g, "")).toContain("unit 1204");
  });

  it("validates Brazilian CPF from the company field", () => {
    const missing = validateAddress({ ...good, countryCode: "BR", zip: "01310-100", province: "SP", company: "" });
    expect(missing.issues.map((i) => i.code)).toContain("MISSING_TAX_ID");

    const bad = validateAddress({ ...good, countryCode: "BR", zip: "01310-100", province: "SP", company: "12345" });
    expect(bad.issues.map((i) => i.code)).toContain("INVALID_TAX_ID");

    const ok = validateAddress({ ...good, countryCode: "BR", zip: "01310-100", province: "SP", company: "123.456.789-09" });
    expect(ok.issues.map((i) => i.code)).not.toContain("INVALID_TAX_ID");
    expect(ok.normalized.taxNumber).toBe("12345678909");
  });

  it("warns on non-Latin characters when required", () => {
    const result = validateAddress({ ...good, address1: "ул. Ленина 1" }, { requireLatin: true });
    expect(result.issues.map((i) => i.code)).toContain("NON_LATIN_CHARACTERS");
    // warnings don't block
    expect(result.ok).toBe(true);
  });
});
