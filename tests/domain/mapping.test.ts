import { describe, expect, it } from "vitest";
import { resolveMapping } from "~/domain/mapping/resolve";
import type { SupplierVariantSnapshot, VariantMappingRow } from "~/domain/mapping/types";

const sv = (id: string, overrides: Partial<SupplierVariantSnapshot> = {}): SupplierVariantSnapshot => ({
  id,
  supplierProductId: "sp1",
  externalProductId: "1005001",
  externalSkuId: `sku-${id}`,
  platform: "ALIEXPRESS",
  title: `Supplier ${id}`,
  price: "4.50",
  currency: "USD",
  stock: 100,
  isAvailable: true,
  ...overrides,
});

const row = (id: string, overrides: Partial<VariantMappingRow> = {}): VariantMappingRow => ({
  id,
  productVariantId: "pv1",
  supplierVariantId: id,
  quantity: 1,
  priority: 0,
  shipToCountry: "*",
  isDefault: false,
  isEnabled: true,
  ...overrides,
});

describe("resolveMapping — BASIC", () => {
  it("orders quantity x mapping quantity", () => {
    const result = resolveMapping({
      type: "BASIC",
      rows: [row("a", { quantity: 2 })],
      supplierVariants: { a: sv("a") },
      shipToCountry: "US",
      orderedQuantity: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.lines[0].quantity).toBe(6);
    expect(result.totalCost).toBe("27.00");
  });

  it("fails with NO_MAPPING when nothing is mapped", () => {
    const result = resolveMapping({
      type: "BASIC",
      rows: [],
      supplierVariants: {},
      shipToCountry: "US",
      orderedQuantity: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("NO_MAPPING");
  });

  it("fails with OUT_OF_STOCK and honours ignoreStock", () => {
    const ctx = {
      type: "BASIC" as const,
      rows: [row("a")],
      supplierVariants: { a: sv("a", { stock: 1 }) },
      shipToCountry: "US",
      orderedQuantity: 2,
    };
    expect(resolveMapping(ctx).failure).toBe("OUT_OF_STOCK");
    expect(resolveMapping({ ...ctx, ignoreStock: true }).ok).toBe(true);
  });
});

describe("resolveMapping — ADVANCED", () => {
  const rows = [
    row("us-fast", { shipToCountry: "US", priority: 0 }),
    row("us-slow", { shipToCountry: "US", priority: 1 }),
    row("any", { shipToCountry: "*", priority: 0 }),
  ];

  it("prefers an exact country match over the wildcard", () => {
    const result = resolveMapping({
      type: "ADVANCED",
      rows,
      supplierVariants: { "us-fast": sv("us-fast"), "us-slow": sv("us-slow"), any: sv("any") },
      shipToCountry: "us",
      orderedQuantity: 1,
    });
    expect(result.lines[0].supplierVariantId).toBe("us-fast");
  });

  it("falls through to the next ranked option when out of stock", () => {
    const result = resolveMapping({
      type: "ADVANCED",
      rows,
      supplierVariants: {
        "us-fast": sv("us-fast", { stock: 0 }),
        "us-slow": sv("us-slow"),
        any: sv("any"),
      },
      shipToCountry: "US",
      orderedQuantity: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.lines[0].supplierVariantId).toBe("us-slow");
    expect(result.skipped).toEqual([
      { mappingRowId: "us-fast", reason: "out of stock (0 < 1)" },
    ]);
  });

  it("uses the wildcard for other destinations", () => {
    const result = resolveMapping({
      type: "ADVANCED",
      rows,
      supplierVariants: { "us-fast": sv("us-fast"), "us-slow": sv("us-slow"), any: sv("any") },
      shipToCountry: "DE",
      orderedQuantity: 1,
    });
    expect(result.lines[0].supplierVariantId).toBe("any");
  });

  it("reports NO_COUNTRY_MATCH when nothing covers the destination", () => {
    const result = resolveMapping({
      type: "ADVANCED",
      rows: [row("us", { shipToCountry: "US" })],
      supplierVariants: { us: sv("us") },
      shipToCountry: "FR",
      orderedQuantity: 1,
    });
    expect(result.failure).toBe("NO_COUNTRY_MATCH");
  });
});

describe("resolveMapping — BOGO", () => {
  const rows = [
    row("single", { minQuantity: 1, maxQuantity: 1, quantity: 1 }),
    row("pair", { minQuantity: 2, maxQuantity: 2, quantity: 3 }),
    row("bulk", { minQuantity: 3, maxQuantity: null, quantity: 5 }),
  ];
  const variants = { single: sv("single"), pair: sv("pair"), bulk: sv("bulk") };

  it("selects the tier by ordered quantity and buys the tier's absolute quantity", () => {
    const two = resolveMapping({ type: "BOGO", rows, supplierVariants: variants, shipToCountry: "US", orderedQuantity: 2 });
    expect(two.lines[0].supplierVariantId).toBe("pair");
    expect(two.lines[0].quantity).toBe(3);

    const ten = resolveMapping({ type: "BOGO", rows, supplierVariants: variants, shipToCountry: "US", orderedQuantity: 10 });
    expect(ten.lines[0].supplierVariantId).toBe("bulk");
    expect(ten.lines[0].quantity).toBe(5);
  });

  it("fails when no tier covers the quantity", () => {
    const result = resolveMapping({
      type: "BOGO",
      rows: [row("pair", { minQuantity: 2, maxQuantity: 2 })],
      supplierVariants: variants,
      shipToCountry: "US",
      orderedQuantity: 1,
    });
    expect(result.failure).toBe("NO_QUANTITY_TIER");
  });
});

describe("resolveMapping — BUNDLE", () => {
  it("orders every component of the bundle", () => {
    const result = resolveMapping({
      type: "BUNDLE",
      rows: [
        row("frame", { bundleGroup: "g1", quantity: 1 }),
        row("lens", { bundleGroup: "g1", quantity: 2 }),
      ],
      supplierVariants: { frame: sv("frame", { price: 10 }), lens: sv("lens", { price: 2 }) },
      shipToCountry: "US",
      orderedQuantity: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.lines.map((l) => [l.supplierVariantId, l.quantity])).toEqual([
      ["frame", 2],
      ["lens", 4],
    ]);
    expect(result.totalCost).toBe("28.00");
  });

  it("refuses a partial bundle and tries the next group", () => {
    const result = resolveMapping({
      type: "BUNDLE",
      rows: [
        row("frame", { bundleGroup: "g1", priority: 0 }),
        row("lens", { bundleGroup: "g1", priority: 0 }),
        row("alt", { bundleGroup: "g2", priority: 1 }),
      ],
      supplierVariants: { frame: sv("frame"), lens: sv("lens", { stock: 0 }), alt: sv("alt") },
      shipToCountry: "US",
      orderedQuantity: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.lines[0].supplierVariantId).toBe("alt");
    expect(result.skipped[0].mappingRowId).toBe("lens");
  });
});
