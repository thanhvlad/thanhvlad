import { describe, expect, it } from "vitest";
import { planVariantSync, DEFAULT_INVENTORY_POLICY } from "~/domain/inventory/rules";

const variant = {
  productVariantId: "pv1",
  shopifyVariantId: "gid://shopify/ProductVariant/1",
  inventoryItemId: "gid://shopify/InventoryItem/1",
  currentPrice: "20.00",
  currentInventory: 50,
  currentCost: "10.00",
  previousSupplierCost: "10.00",
};

const rule = { basePriceOp: "MULTIPLY" as const, basePriceValue: 2, centsEnding: 99 };

describe("planVariantSync", () => {
  it("does nothing when nothing changed", () => {
    const plan = planVariantSync(
      { ...variant, supplier: { found: true, price: "10.00", stock: 100, isAvailable: true } },
      DEFAULT_INVENTORY_POLICY,
      rule,
    );
    expect(plan.actions).toEqual([]);
  });

  it("zeroes inventory when the supplier runs out", () => {
    const plan = planVariantSync(
      { ...variant, supplier: { found: true, price: "10.00", stock: 0, isAvailable: true } },
      DEFAULT_INVENTORY_POLICY,
      rule,
    );
    expect(plan.actions[0]).toMatchObject({ type: "UPDATE_INVENTORY", quantity: 0 });
  });

  it("restocks when the supplier is back", () => {
    const plan = planVariantSync(
      { ...variant, currentInventory: 0, supplier: { found: true, price: "10.00", stock: 500, isAvailable: true } },
      DEFAULT_INVENTORY_POLICY,
      rule,
    );
    expect(plan.actions[0]).toMatchObject({ type: "UPDATE_INVENTORY", quantity: 50 });
  });

  it("reprices when the cost moves beyond the threshold", () => {
    const plan = planVariantSync(
      { ...variant, supplier: { found: true, price: "12.00", stock: 100, isAvailable: true } },
      { ...DEFAULT_INVENTORY_POLICY, priceAction: "UPDATE_PRICE", priceThresholdPercent: 10 },
      rule,
    );
    expect(plan.costChangePercent).toBe("20.00");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: "UPDATE_PRICE", price: "24.99", cost: "12.00" });
  });

  it("only updates the cost when the move is below the threshold", () => {
    const plan = planVariantSync(
      { ...variant, supplier: { found: true, price: "10.50", stock: 100, isAvailable: true } },
      { ...DEFAULT_INVENTORY_POLICY, priceAction: "UPDATE_PRICE", priceThresholdPercent: 10 },
      rule,
    );
    expect(plan.actions).toEqual([
      expect.objectContaining({ type: "UPDATE_COST", cost: "10.50" }),
    ]);
  });

  it("notifies instead of repricing when configured", () => {
    const plan = planVariantSync(
      { ...variant, supplier: { found: true, price: "15.00", stock: 100, isAvailable: true } },
      { ...DEFAULT_INVENTORY_POLICY, priceAction: "NOTIFY_ONLY" },
      rule,
    );
    expect(plan.actions.map((a) => a.type)).toEqual(["NOTIFY", "UPDATE_COST"]);
  });

  it("unpublishes when the supplier product disappears", () => {
    const plan = planVariantSync({ ...variant, supplier: { found: false } }, DEFAULT_INVENTORY_POLICY, rule);
    expect(plan.actions.map((a) => a.type)).toEqual(["UNPUBLISH_PRODUCT", "NOTIFY"]);
  });

  it("caps the pushed quantity", () => {
    const plan = planVariantSync(
      { ...variant, currentInventory: 3, supplier: { found: true, price: "10.00", stock: 9999, isAvailable: true } },
      { ...DEFAULT_INVENTORY_POLICY, stockAction: "UPDATE_QUANTITY", maxInventoryPushed: 25 },
      rule,
    );
    expect(plan.actions[0]).toMatchObject({ type: "UPDATE_INVENTORY", quantity: 25 });
  });
});
