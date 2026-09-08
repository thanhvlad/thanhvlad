import { describe, expect, it } from "vitest";
import { evaluateOrder, type PipelineInput } from "~/domain/orders/pipeline";
import { planVariantSync, DEFAULT_INVENTORY_POLICY } from "~/domain/inventory/rules";
import { validateAddress, applySuggestions } from "~/domain/orders/address";
import { resolveMapping } from "~/domain/mapping/resolve";
import { selectShipping } from "~/domain/shipping/select";
import { mergeShopSettings } from "~/domain/settings/shop-settings";
import { computePrice } from "~/domain/pricing/engine";

const okRes = { ok: true, lines: [], totalCost: "0.00", skipped: [] };
const base: PipelineInput = {
  financialStatus: "paid",
  fulfillmentStatus: null,
  lineItems: [
    { id: "li1", title: "Hat", quantity: 1, fulfillableQuantity: 1, isCanceled: false, isFulfilled: false, isManaged: true, resolution: okRes },
  ],
  addressIssues: [],
  purchaseOrders: [],
  settings: { requirePaidOrder: true, blockHighRisk: true, blockPartiallyPaid: true },
};

describe("audit", () => {
  it("P1 SUBMITTING po does not block re-placing", () => {
    const r = evaluateOrder({ ...base, purchaseOrders: [{ status: "SUBMITTING", hasTracking: false }] });
    console.log("P1", r.stage, r.canPlaceOrder);
    const r2 = evaluateOrder({ ...base, purchaseOrders: [{ status: "DRAFT", hasTracking: false }] });
    console.log("P1b", r2.stage, r2.canPlaceOrder);
  });

  it("P2 failed+shipped swallows failure", () => {
    const r = evaluateOrder({ ...base, purchaseOrders: [{ status: "SHIPPED", hasTracking: true }, { status: "FAILED", hasTracking: false }] });
    console.log("P2", r.stage, JSON.stringify(r.issues));
  });

  it("P3 all managed fulfilled, partial order, no POs", () => {
    const r = evaluateOrder({
      ...base,
      fulfillmentStatus: "partial",
      lineItems: [
        { id: "li1", title: "Hat", quantity: 1, fulfillableQuantity: 0, isCanceled: false, isFulfilled: true, isManaged: true, resolution: okRes },
        { id: "li2", title: "Gift", quantity: 1, fulfillableQuantity: 1, isCanceled: false, isFulfilled: false, isManaged: false },
      ],
    });
    console.log("P3", r.stage, r.canPlaceOrder, JSON.stringify(r.issues));
  });

  it("I1 UPDATE_QUANTITY ignores isAvailable=false", () => {
    const p = planVariantSync(
      { productVariantId: "pv", shopifyVariantId: "sv", currentPrice: "20.00", currentInventory: 0, currentCost: "10.00", previousSupplierCost: "10.00",
        supplier: { found: true, price: "10.00", stock: 100, isAvailable: false } },
      { ...DEFAULT_INVENTORY_POLICY, stockAction: "UPDATE_QUANTITY", maxInventoryPushed: 50 },
      null,
    );
    console.log("I1", JSON.stringify(p.actions));
  });

  it("I2 restock ignores maxInventoryPushed=0", () => {
    const p = planVariantSync(
      { productVariantId: "pv", shopifyVariantId: "sv", currentPrice: "20.00", currentInventory: 0, currentCost: "10.00", previousSupplierCost: "10.00",
        supplier: { found: true, price: "10.00", stock: 100, isAvailable: true } },
      { ...DEFAULT_INVENTORY_POLICY, stockAction: "SET_ZERO_WHEN_OUT", maxInventoryPushed: 0 },
      null,
    );
    console.log("I2", JSON.stringify(p.actions));
  });

  it("I3 UPDATE_COST vs effectiveCost inconsistency w/ includeShipping", () => {
    const rule = { basePriceOp: "MULTIPLY" as const, basePriceValue: 2, includeShipping: true };
    // price changes -> UPDATE_PRICE carries cost = effectiveCost (item+shipping)
    const a = planVariantSync(
      { productVariantId: "pv", shopifyVariantId: "sv", currentPrice: "26.00", currentInventory: 5, currentCost: "13.00", previousSupplierCost: "10.00",
        supplier: { found: true, price: "12.00", stock: 100, isAvailable: true, shippingCost: "3.00" } },
      { ...DEFAULT_INVENTORY_POLICY, priceAction: "UPDATE_PRICE", stockAction: "DO_NOTHING", priceThresholdPercent: 0 },
      rule,
    );
    console.log("I3a", JSON.stringify(a.actions));
    // price unchanged -> UPDATE_COST carries item cost only
    const b = planVariantSync(
      { productVariantId: "pv", shopifyVariantId: "sv", currentPrice: "30.00", currentInventory: 5, currentCost: "13.00", previousSupplierCost: "12.00",
        supplier: { found: true, price: "12.00", stock: 100, isAvailable: true, shippingCost: "3.00" } },
      { ...DEFAULT_INVENTORY_POLICY, priceAction: "UPDATE_PRICE", stockAction: "DO_NOTHING", priceThresholdPercent: 0 },
      rule,
    );
    console.log("I3b", JSON.stringify(b.actions));
  });

  it("A1 ZA / IE skip zip", () => {
    const za = validateAddress({ firstName: "A", lastName: "B", address1: "1 Long St", city: "Cape Town", countryCode: "ZA", phone: "+27821234567", taxNumber: "1234567890123" });
    console.log("A1 ZA", JSON.stringify(za.issues.map(i => i.code)), za.ok);
    const ie = validateAddress({ firstName: "A", lastName: "B", address1: "1 Long St", city: "Dublin", countryCode: "IE", province: "Dublin", phone: "+353851234567" });
    console.log("A1 IE", JSON.stringify(ie.issues.map(i => i.code)), ie.ok);
  });

  it("A2 full country name bypasses all country rules", () => {
    const r = validateAddress({ firstName: "Jane", lastName: "Doe", address1: "123 Main St", city: "Austin", country: "United States", phone: "+15125550100" });
    console.log("A2", JSON.stringify(r.issues.map(i => i.code)), r.ok, r.normalized.countryCode);
  });

  it("A3 very long address1 silently truncated by applySuggestions", () => {
    const long = "Building number seventeen apartment block delta staircase four floor twelve unit twelve zero four ".repeat(4).trim();
    console.log("len", long.length);
    const v = validateAddress({ firstName: "Jane", lastName: "Doe", address1: long, city: "Austin", province: "TX", zip: "78701", countryCode: "US", phone: "+15125550100" });
    const fixed = applySuggestions(v.normalized, v.issues);
    const rv = validateAddress(fixed, {});
    const recombined = `${fixed.address1} ${fixed.address2}`;
    console.log("A3 ok?", rv.ok, "a1len", fixed.address1?.length, "a2len", fixed.address2?.length,
      "lost chars:", long.length - (fixed.address1!.length + (fixed.address2 ?? "").length),
      "tail kept?", recombined.includes("unit twelve zero four"));
  });

  it("A4 BR company name -> INVALID_TAX_ID", () => {
    const r = validateAddress({ firstName: "A", lastName: "B", address1: "R. X 1", city: "SP", province: "SP", zip: "01310-100", countryCode: "BR", company: "Acme Comercio Ltda", phone: "+5511999999999" });
    console.log("A4", JSON.stringify(r.issues.map(i => i.code)));
  });

  it("A5 IT/ES require tax id by default", () => {
    const r = validateAddress({ firstName: "A", lastName: "B", address1: "Via X 1", city: "Roma", province: "RM", zip: "00100", countryCode: "IT", phone: "+390612345678" });
    console.log("A5", JSON.stringify(r.issues.map(i => i.code)), r.ok);
  });

  it("A6 decomposed latin flagged non-latin", () => {
    const r = validateAddress({ firstName: "José", lastName: "Doe", address1: "123 Main St", city: "Austin", province: "TX", zip: "78701", countryCode: "US", phone: "+15125550100" }, { requireLatin: true });
    console.log("A6", JSON.stringify(r.issues.map(i => i.code)));
  });

  it("M1 BASIC tie order-dependent", () => {
    const sv = (id: string, price: string) => ({ id, supplierProductId: "sp", externalSkuId: id, externalProductId: "ep", platform: "ae", title: id, price, currency: "USD", stock: 10, isAvailable: true });
    const row = (id: string, svid: string) => ({ id, productVariantId: "pv", supplierVariantId: svid, quantity: 1, priority: 0, shipToCountry: "*", isDefault: false, isEnabled: true });
    const rowsA = [row("rowB", "svB"), row("rowA", "svA")];
    const rowsB = [row("rowA", "svA"), row("rowB", "svB")];
    const vs = { svA: sv("svA", "5.00"), svB: sv("svB", "9.00") };
    const r1 = resolveMapping({ type: "BASIC", rows: rowsA, supplierVariants: vs, shipToCountry: "US", orderedQuantity: 1 });
    const r2 = resolveMapping({ type: "BASIC", rows: rowsB, supplierVariants: vs, shipToCountry: "US", orderedQuantity: 1 });
    console.log("M1", r1.lines[0].supplierVariantId, r1.totalCost, "|", r2.lines[0].supplierVariantId, r2.totalCost);
  });

  it("M2 BUNDLE double-counts shared supplier variant stock", () => {
    const vs = { svX: { id: "svX", supplierProductId: "sp", externalSkuId: "x", externalProductId: "ep", platform: "ae", title: "X", price: "5.00", currency: "USD", stock: 1, isAvailable: true } };
    const rows = [
      { id: "r1", productVariantId: "pv", supplierVariantId: "svX", quantity: 1, priority: 0, shipToCountry: "*", bundleGroup: "g1", isDefault: false, isEnabled: true },
      { id: "r2", productVariantId: "pv", supplierVariantId: "svX", quantity: 1, priority: 0, shipToCountry: "*", bundleGroup: "g1", isDefault: false, isEnabled: true },
    ];
    const r = resolveMapping({ type: "BUNDLE", rows, supplierVariants: vs, shipToCountry: "US", orderedQuantity: 1 });
    console.log("M2", r.ok, JSON.stringify(r.lines.map(l => [l.supplierVariantId, l.quantity])), r.totalCost);
  });

  it("M3 BOGO ignores ordered qty for high orders", () => {
    const vs = { svX: { id: "svX", supplierProductId: "sp", externalSkuId: "x", externalProductId: "ep", platform: "ae", title: "X", price: "5.00", currency: "USD", stock: 100, isAvailable: true } };
    const rows = [
      { id: "t1", productVariantId: "pv", supplierVariantId: "svX", quantity: 3, priority: 0, shipToCountry: "*", minQuantity: 2, maxQuantity: null, isDefault: false, isEnabled: true },
    ];
    const r = resolveMapping({ type: "BOGO", rows, supplierVariants: vs, shipToCountry: "US", orderedQuantity: 50 });
    console.log("M3", r.ok, r.lines[0]?.quantity, r.totalCost, r.reason);
  });

  it("S1 fallback overrides preference cap + duplicate rejects", () => {
    const opt = (c: string, cost: string) => ({ carrierCode: c, carrierName: c, cost, currency: "USD", shipToCountry: "US", hasTracking: true, maxDeliveryDays: 10 });
    const r = selectShipping({
      options: [opt("EPACKET", "18.00")],
      preferences: [{ id: "p1", countryCode: "US", carrierCode: "EPACKET", priority: 0, maxCost: 5, requireTracking: true, isEnabled: true }],
      shipToCountry: "US",
      fallback: "CHEAPEST",
    });
    console.log("S1", r.ok, r.strategy, r.option?.carrierCode, r.option?.cost, JSON.stringify(r.rejected));
  });

  it("ST1 merge with explicit undefined resets to default", () => {
    const current = mergeShopSettings({}, { orders: { requirePaidOrder: false, autoPlaceDelayMinutes: 5 } });
    console.log("ST1 before", current.orders.requirePaidOrder, current.orders.autoPlaceDelayMinutes);
    const after = mergeShopSettings(current, { orders: { requirePaidOrder: undefined, autoPlaceOrders: true } } as never);
    console.log("ST1 after", after.orders.requirePaidOrder, after.orders.autoPlaceOrders, after.orders.autoPlaceDelayMinutes);
  });

  it("PR1 cents ending drops price / max clamp interplay", () => {
    console.log("PR1a", computePrice({ basePriceOp: "MULTIPLY", basePriceValue: 2, centsEnding: 95 }, { cost: "11.00" }).price);
    console.log("PR1b", computePrice({ basePriceOp: "MULTIPLY", basePriceValue: 2, roundToMultiple: 5, centsEnding: 95 }, { cost: "12.50" }).price);
    const m = computePrice({ basePriceOp: "MULTIPLY", basePriceValue: 3, maxPrice: 30, compareAtOp: "MULTIPLY", compareAtValue: 1.5 }, { cost: "20.00" });
    console.log("PR1c max-clamped", m.price, m.compareAtPrice, m.clampedBy);
    const z = computePrice({ basePriceOp: "MULTIPLY", basePriceValue: 2, centsEnding: 99 }, { cost: "0" });
    console.log("PR1d zero cost", z.price, z.profit, z.marginPercent);
    const neg = computePrice({ basePriceOp: "MARGIN", basePriceValue: 120 }, { cost: "10" });
    console.log("PR1e margin120", neg.price);
    const ce0 = computePrice({ basePriceOp: "MULTIPLY", basePriceValue: 2, centsEnding: 0, compareAtOp: "MULTIPLY", compareAtValue: 1.02 }, { cost: "10" });
    console.log("PR1f centsEnding0 compareAt", ce0.price, ce0.compareAtPrice);
  });
});
