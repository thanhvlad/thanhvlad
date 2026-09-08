/**
 * One test per bug found in the pre-launch audit, written from the failure
 * scenario rather than from the fix, so a regression is caught by behaviour and
 * not by implementation detail.
 */
import { describe, expect, it } from "vitest";
import { applySuggestions, validateAddress } from "~/domain/orders/address";
import { toCountryCode } from "~/domain/orders/countries";
import { evaluateOrder, type PipelineInput } from "~/domain/orders/pipeline";
import { DEFAULT_INVENTORY_POLICY, planVariantSync } from "~/domain/inventory/rules";
import { selectShipping } from "~/domain/shipping/select";
import { computePrice } from "~/domain/pricing/engine";
import { resolveMapping } from "~/domain/mapping/resolve";
import { mergeShopSettings, parseShopSettings } from "~/domain/settings/shop-settings";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

describe("address: country names are resolved to ISO codes", () => {
  const usAddress = {
    firstName: "Jane",
    lastName: "Doe",
    address1: "123 Main St",
    city: "Austin",
    zip: "not-a-zip",
    phone: "+15125550100",
  };

  it("applies US rules when only the display name is present", () => {
    const named = validateAddress({ ...usAddress, country: "United States" });
    const coded = validateAddress({ ...usAddress, countryCode: "US" });

    expect(named.normalized.countryCode).toBe("US");
    expect(named.issues.map((i) => i.code).sort()).toEqual(coded.issues.map((i) => i.code).sort());
    expect(named.issues.map((i) => i.code)).toContain("MISSING_PROVINCE");
  });

  it("never lets free text through as a country code", () => {
    const result = validateAddress({ ...usAddress, country: "Freedonia" });
    expect(result.normalized.countryCode).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("MISSING_COUNTRY");
  });

  it("resolves the aliases Shopify and merchants actually type", () => {
    expect(toCountryCode(null, "USA")).toBe("US");
    expect(toCountryCode(null, "United Kingdom")).toBe("GB");
    expect(toCountryCode(null, "Viet Nam")).toBe("VN");
    expect(toCountryCode(null, "Việt Nam")).toBe("VN");
    expect(toCountryCode(null, "South Korea")).toBe("KR");
    expect(toCountryCode(null, "Czech Republic")).toBe("CZ");
    expect(toCountryCode("us", null)).toBe("US");
    expect(toCountryCode("", "")).toBeNull();
  });
});

describe("address: postal codes", () => {
  const base = {
    firstName: "A",
    lastName: "B",
    address1: "1 Long St",
    city: "Cape Town",
    phone: "+27821234567",
  };

  it("requires a postal code for South Africa", () => {
    const result = validateAddress({ ...base, countryCode: "ZA", taxNumber: "1234567890123" });
    expect(result.issues.map((i) => i.code)).toContain("MISSING_ZIP");
  });

  it("requires an Eircode for Ireland", () => {
    const result = validateAddress({
      ...base,
      city: "Dublin",
      province: "Dublin",
      countryCode: "IE",
      phone: "+353871234567",
    });
    expect(result.issues.map((i) => i.code)).toContain("MISSING_ZIP");
  });

  it("accepts a well-formed Eircode", () => {
    const result = validateAddress({
      ...base,
      city: "Dublin",
      province: "Dublin",
      countryCode: "IE",
      zip: "D02 AF30",
      phone: "+353871234567",
    });
    expect(result.issues.map((i) => i.code)).not.toContain("INVALID_ZIP");
  });
});

describe("address: over-long street addresses", () => {
  const long = (n: number) =>
    "Building number seventeen apartment block delta staircase four floor twelve unit ".repeat(n).trim();

  const base = {
    firstName: "Jane",
    lastName: "Doe",
    city: "Austin",
    province: "TX",
    zip: "78701",
    countryCode: "US",
    phone: "+15125550100",
  };

  it("splits into line 2 without losing characters", () => {
    const address1 = long(2);
    const result = validateAddress({ ...base, address1 });
    const issue = result.issues.find((i) => i.code === "ADDRESS1_TOO_LONG");
    expect(issue).toBeDefined();
    expect(issue?.suggestion).toBeDefined();

    const fixed = applySuggestions(result.normalized, result.issues);
    const rejoined = [fixed.address1, fixed.address2].filter(Boolean).join(" ");
    // Every word survives the split.
    for (const word of address1.split(" ")) {
      expect(rejoined).toContain(word);
    }
    expect(validateAddress({ ...base, ...fixed }).ok).toBe(true);
  });

  it("refuses to silently truncate when the overflow does not fit either", () => {
    const address1 = long(6);
    const result = validateAddress({ ...base, address1 });
    const issue = result.issues.find((i) => i.code === "ADDRESS1_TOO_LONG");
    expect(issue?.suggestion).toBeUndefined();

    const fixed = applySuggestions(result.normalized, result.issues);
    expect(fixed.address1).toBe(result.normalized.address1);
    // Still blocked, so the merchant is asked to shorten it rather than shipping
    // to half an address.
    expect(validateAddress({ ...base, ...fixed }).ok).toBe(false);
  });
});

describe("address: Latin script check", () => {
  const base = {
    lastName: "Doe",
    address1: "123 Main St",
    city: "Austin",
    province: "TX",
    zip: "78701",
    countryCode: "US",
    phone: "+15125550100",
  };

  it("accepts NFD-decomposed accented Latin names", () => {
    const nfd = "José".normalize("NFD");
    expect(nfd).not.toBe("José".normalize("NFC"));
    const result = validateAddress({ ...base, firstName: nfd }, { requireLatin: true });
    expect(result.issues.map((i) => i.code)).not.toContain("NON_LATIN_CHARACTERS");
  });

  it("still flags genuinely non-Latin text", () => {
    const result = validateAddress({ ...base, firstName: "李" }, { requireLatin: true });
    expect(result.issues.map((i) => i.code)).toContain("NON_LATIN_CHARACTERS");
  });
});

// ---------------------------------------------------------------------------
// Order pipeline
// ---------------------------------------------------------------------------

const okResolution = { ok: true as const, lines: [], totalCost: "0.00", skipped: [] };

function line(id: string, over: Partial<PipelineInput["lineItems"][number]> = {}) {
  return {
    id,
    title: id,
    quantity: 1,
    fulfillableQuantity: 1,
    isCanceled: false,
    isFulfilled: false,
    isManaged: true,
    resolution: okResolution,
    ...over,
  };
}

const pipelineBase: PipelineInput = {
  financialStatus: "paid",
  fulfillmentStatus: null,
  lineItems: [line("li1")],
  addressIssues: [],
  purchaseOrders: [],
  settings: { requirePaidOrder: true, blockHighRisk: true, blockPartiallyPaid: true },
};

describe("pipeline: partially ordered orders", () => {
  it("does not report supplier progress for a line no purchase order covers", () => {
    const result = evaluateOrder({
      ...pipelineBase,
      lineItems: [line("li1"), line("li2")],
      purchaseOrders: [{ status: "PLACED", hasTracking: false }],
      coveredLineItemIds: ["li1"],
    });

    expect(result.stage).toBe("AWAITING_ORDER");
    expect(result.canPlaceOrder).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("LINES_NOT_ORDERED");
  });

  it("reports supplier progress once every line is covered", () => {
    const result = evaluateOrder({
      ...pipelineBase,
      lineItems: [line("li1"), line("li2")],
      purchaseOrders: [{ status: "PLACED", hasTracking: false }],
      coveredLineItemIds: ["li1", "li2"],
    });
    expect(result.stage).toBe("AWAITING_PAYMENT");
    expect(result.canPlaceOrder).toBe(false);
  });
});

describe("pipeline: failures are never swallowed", () => {
  it("surfaces a failed purchase order even when a sibling shipped", () => {
    const result = evaluateOrder({
      ...pipelineBase,
      purchaseOrders: [
        { status: "SHIPPED", hasTracking: true },
        { status: "FAILED", hasTracking: false },
      ],
      coveredLineItemIds: ["li1"],
    });
    expect(result.stage).toBe("AWAITING_DELIVERY");
    expect(result.issues.map((i) => i.code)).toContain("SUPPLIER_ORDER_FAILED");
  });
});

describe("pipeline: terminal states", () => {
  it("is FULFILLED when every managed line is done, whatever Shopify calls the order", () => {
    const result = evaluateOrder({
      ...pipelineBase,
      fulfillmentStatus: "partial",
      lineItems: [
        line("li1", { isFulfilled: true, fulfillableQuantity: 0 }),
        line("li2", { isManaged: false, fulfillableQuantity: 1 }),
      ],
    });
    expect(result.stage).toBe("FULFILLED");
  });

  it("gives an order with nothing of ours its own stage, not Pending", () => {
    const result = evaluateOrder({
      ...pipelineBase,
      lineItems: [line("li1", { isManaged: false })],
    });
    expect(result.stage).toBe("IGNORED");
    expect(result.canPlaceOrder).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inventory rules
// ---------------------------------------------------------------------------

const variantBase = {
  productVariantId: "pv1",
  shopifyVariantId: "gid://shopify/ProductVariant/1",
  currentPrice: "20.00",
  currentInventory: 0,
  currentCost: "10.00",
};

describe("inventory: stock", () => {
  it("does not push stock for a SKU the supplier flagged unavailable", () => {
    const result = planVariantSync(
      {
        ...variantBase,
        supplier: { found: true, price: "10.00", stock: 100, isAvailable: false },
      },
      { ...DEFAULT_INVENTORY_POLICY, stockAction: "UPDATE_QUANTITY", maxInventoryPushed: 50 },
      null,
    );
    const inventory = result.actions.find((a) => a.type === "UPDATE_INVENTORY");
    expect(inventory?.quantity ?? 0).toBe(0);
  });

  it("honours a cap of zero on the restock path", () => {
    const result = planVariantSync(
      {
        ...variantBase,
        supplier: { found: true, price: "10.00", stock: 100, isAvailable: true },
      },
      { ...DEFAULT_INVENTORY_POLICY, stockAction: "SET_ZERO_WHEN_OUT", maxInventoryPushed: 0 },
      null,
    );
    expect(result.actions.some((a) => a.type === "UPDATE_INVENTORY")).toBe(false);
  });
});

describe("inventory: cost pushed to Shopify", () => {
  const rule = {
    name: "2x incl. shipping",
    basePriceOp: "MULTIPLY" as const,
    basePriceValue: 2,
    compareAtOp: "NONE" as const,
    compareAtValue: null,
    centsEnding: null,
    roundToMultiple: null,
    includeShipping: true,
    minPrice: null,
    maxPrice: null,
    tiers: [],
  };
  const supplier = { found: true as const, price: "12.00", stock: 10, isAvailable: true, shippingCost: "3.00" };
  const policy = {
    ...DEFAULT_INVENTORY_POLICY,
    priceAction: "UPDATE_PRICE" as const,
    priceThresholdPercent: 0,
    stockAction: "DO_NOTHING" as const,
  };

  it("is the same number whether the price moved or not", () => {
    const repriced = planVariantSync(
      { ...variantBase, currentPrice: "26.00", currentCost: "0", supplier },
      policy,
      rule,
    );
    const costOnly = planVariantSync(
      { ...variantBase, currentPrice: "30.00", currentCost: "0", supplier },
      policy,
      rule,
    );

    const a = repriced.actions.find((x) => x.type === "UPDATE_PRICE")?.cost;
    const b = costOnly.actions.find((x) => x.type === "UPDATE_COST")?.cost;
    expect(a).toBe("15.00");
    expect(b).toBe("15.00");
  });
});

// ---------------------------------------------------------------------------
// Shipping selection
// ---------------------------------------------------------------------------

describe("shipping: a per-carrier cap is not undone by the fallback", () => {
  it("does not re-select the option the preference just rejected on cost", () => {
    const result = selectShipping({
      options: [
        { carrierCode: "EPACKET", carrierName: "Epacket", currency: "USD", cost: "18.00", shipToCountry: "US", hasTracking: true, maxDeliveryDays: 10 },
      ],
      preferences: [
        { countryCode: "US", carrierCode: "EPACKET", priority: 0, maxCost: 5, requireTracking: true, isEnabled: true },
      ],
      shipToCountry: "US",
      fallback: "CHEAPEST",
    });
    expect(result.ok).toBe(false);
    expect(result.option).toBeNull();
  });

  it("does not re-select an option the preference rejected on delivery time", () => {
    const result = selectShipping({
      options: [
        { carrierCode: "SLOW", carrierName: "Slow", currency: "USD", cost: "1.00", shipToCountry: "US", hasTracking: true, maxDeliveryDays: 90 },
      ],
      preferences: [
        { countryCode: "US", carrierCode: "SLOW", priority: 0, maxDeliveryDays: 15, requireTracking: false, isEnabled: true },
      ],
      shipToCountry: "US",
      fallback: "FASTEST",
    });
    expect(result.ok).toBe(false);
  });

  it("still falls back to a carrier no preference rejected", () => {
    const result = selectShipping({
      options: [
        { carrierCode: "EPACKET", carrierName: "Epacket", currency: "USD", cost: "18.00", shipToCountry: "US", hasTracking: true, maxDeliveryDays: 10 },
        { carrierCode: "STANDARD", carrierName: "Standard", currency: "USD", cost: "3.00", shipToCountry: "US", hasTracking: true, maxDeliveryDays: 25 },
      ],
      preferences: [
        { countryCode: "US", carrierCode: "EPACKET", priority: 0, maxCost: 5, requireTracking: false, isEnabled: true },
      ],
      shipToCountry: "US",
      fallback: "CHEAPEST",
    });
    expect(result.ok).toBe(true);
    expect(result.option?.carrierCode).toBe("STANDARD");
  });

  it("reports each rejection once", () => {
    const result = selectShipping({
      options: [
        { carrierCode: "EPACKET", carrierName: "Epacket", currency: "USD", cost: "18.00", shipToCountry: "US", hasTracking: true, maxDeliveryDays: 10 },
      ],
      preferences: [
        { countryCode: "US", carrierCode: "EPACKET", priority: 0, maxCost: 5, requireTracking: false, isEnabled: true },
        { countryCode: "*", carrierCode: "EPACKET", priority: 1, maxCost: 5, requireTracking: false, isEnabled: true },
      ],
      shipToCountry: "US",
      fallback: "CHEAPEST",
    });
    expect(result.rejected).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("pricing: the cents ending does not eat the compare-at price", () => {
  const rule = {
    name: "t",
    basePriceOp: "MULTIPLY" as const,
    basePriceValue: 2,
    compareAtOp: "MULTIPLY" as const,
    compareAtValue: 1.02,
    centsEnding: 0,
    roundToMultiple: null,
    includeShipping: false,
    minPrice: null,
    maxPrice: null,
    tiers: [],
  };

  it("keeps a compare-at the merchant configured, even for a small markup", () => {
    const result = computePrice(rule, { cost: "10" });
    expect(result.price).toBe("20.00");
    expect(result.compareAtPrice).not.toBeNull();
    expect(Number(result.compareAtPrice)).toBeGreaterThan(Number(result.price));
  });

  it("works with a non-zero ending too", () => {
    const result = computePrice({ ...rule, centsEnding: 50 }, { cost: "10" });
    expect(result.price).toBe("20.50");
    expect(Number(result.compareAtPrice)).toBeGreaterThan(20.5);
  });

  it("works for an ADD compare-at", () => {
    const result = computePrice(
      { ...rule, centsEnding: 49, compareAtOp: "ADD", compareAtValue: 0.4 },
      { cost: "12.25" },
    );
    expect(result.price).toBe("24.49");
    expect(Number(result.compareAtPrice)).toBeGreaterThan(24.49);
  });

  it("still drops a compare-at that is genuinely at or below the price", () => {
    const result = computePrice({ ...rule, compareAtValue: 1 }, { cost: "10" });
    expect(result.compareAtPrice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe("mapping: BASIC ties are resolved the same way every time", () => {
  const supplierVariants = {
    svA: { id: "svA", supplierProductId: "sp1", externalSkuId: "svA-sku", externalProductId: "sp1", platform: "MOCK", title: "svA", stock: 10, isAvailable: true, price: "5.00", currency: "USD" },
    svB: { id: "svB", supplierProductId: "sp1", externalSkuId: "svB-sku", externalProductId: "sp1", platform: "MOCK", title: "svB", stock: 10, isAvailable: true, price: "9.00", currency: "USD" },
  };
  const rowA = { id: "rowA", productVariantId: "pv1", shipToCountry: "*", supplierVariantId: "svA", quantity: 1, priority: 0, isEnabled: true, isDefault: false };
  const rowB = { id: "rowB", productVariantId: "pv1", shipToCountry: "*", supplierVariantId: "svB", quantity: 1, priority: 0, isEnabled: true, isDefault: false };

  it("does not depend on the order the rows came back from the database", () => {
    const forwards = resolveMapping({ type: "BASIC", rows: [rowA, rowB], supplierVariants, orderedQuantity: 1, shipToCountry: "US" });
    const backwards = resolveMapping({ type: "BASIC", rows: [rowB, rowA], supplierVariants, orderedQuantity: 1, shipToCountry: "US" });
    expect(forwards.totalCost).toBe(backwards.totalCost);
    expect(forwards.lines[0]?.supplierVariantId).toBe(backwards.lines[0]?.supplierVariantId);
  });
});

describe("mapping: a bundle cannot claim the same SKU twice", () => {
  it("rejects a group that needs more units than the SKU has", () => {
    const result = resolveMapping({
      type: "BUNDLE",
      rows: [
        { id: "r1", productVariantId: "pv1", shipToCountry: "*", supplierVariantId: "svX", quantity: 1, priority: 0, isEnabled: true, isDefault: false, bundleGroup: "g1" },
        { id: "r2", productVariantId: "pv1", shipToCountry: "*", supplierVariantId: "svX", quantity: 1, priority: 0, isEnabled: true, isDefault: false, bundleGroup: "g1" },
      ],
      supplierVariants: { svX: { id: "svX", supplierProductId: "sp1", externalSkuId: "svX-sku", externalProductId: "sp1", platform: "MOCK", title: "svX", stock: 1, isAvailable: true, price: "5.00", currency: "USD" } },
      orderedQuantity: 1,
      shipToCountry: "US",
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("INCOMPLETE_BUNDLE");
  });

  it("still accepts one when the SKU has enough", () => {
    const result = resolveMapping({
      type: "BUNDLE",
      rows: [
        { id: "r1", productVariantId: "pv1", shipToCountry: "*", supplierVariantId: "svX", quantity: 1, priority: 0, isEnabled: true, isDefault: false, bundleGroup: "g1" },
        { id: "r2", productVariantId: "pv1", shipToCountry: "*", supplierVariantId: "svX", quantity: 1, priority: 0, isEnabled: true, isDefault: false, bundleGroup: "g1" },
      ],
      supplierVariants: { svX: { id: "svX", supplierProductId: "sp1", externalSkuId: "svX-sku", externalProductId: "sp1", platform: "MOCK", title: "svX", stock: 5, isAvailable: true, price: "5.00", currency: "USD" } },
      orderedQuantity: 1,
      shipToCountry: "US",
    });
    expect(result.ok).toBe(true);
    expect(result.totalCost).toBe("10.00");
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("settings: an undefined leaf never resets a stored choice", () => {
  it("keeps requirePaidOrder off when the patch carries an explicit undefined", () => {
    const current = parseShopSettings({ orders: { requirePaidOrder: false } });
    expect(current.orders.requirePaidOrder).toBe(false);

    const merged = mergeShopSettings(current, {
      orders: { requirePaidOrder: undefined, autoPlaceOrders: true },
    });
    expect(merged.orders.requirePaidOrder).toBe(false);
    expect(merged.orders.autoPlaceOrders).toBe(true);
  });
});
