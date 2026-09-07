import { d, money, percentChange } from "~/lib/money";
import { computePrice } from "../pricing/engine";
import type { PricingRuleInput } from "../pricing/types";

export type PriceChangeAction = "DO_NOTHING" | "UPDATE_PRICE" | "NOTIFY_ONLY";
export type StockChangeAction =
  | "DO_NOTHING"
  | "UPDATE_QUANTITY"
  | "SET_ZERO_WHEN_OUT"
  | "UNPUBLISH_WHEN_OUT"
  | "NOTIFY_ONLY";

export interface InventoryPolicyInput {
  priceAction: PriceChangeAction;
  priceThresholdPercent: string | number;
  stockAction: StockChangeAction;
  lowStockThreshold: number;
  maxInventoryPushed: number;
  onProductRemoved: StockChangeAction;
}

export interface VariantSyncInput {
  productVariantId: string;
  shopifyVariantId: string;
  inventoryItemId?: string | null;
  currentPrice: string | number;
  currentCompareAtPrice?: string | number | null;
  currentInventory: number;
  currentCost?: string | number | null;
  /** Cost the price was originally derived from, for change detection. */
  previousSupplierCost?: string | number | null;

  supplier:
    | {
        found: true;
        price: string | number;
        stock: number;
        isAvailable: boolean;
        shippingCost?: string | number;
      }
    | { found: false };
}

export type SyncActionType =
  | "UPDATE_PRICE"
  | "UPDATE_INVENTORY"
  | "UNPUBLISH_PRODUCT"
  | "UPDATE_COST"
  | "NOTIFY";

export interface SyncAction {
  type: SyncActionType;
  productVariantId: string;
  shopifyVariantId: string;
  inventoryItemId?: string | null;
  /** New price / compare-at / cost, present on price actions. */
  price?: string;
  compareAtPrice?: string | null;
  cost?: string;
  /** New available quantity, present on inventory actions. */
  quantity?: number;
  reason: string;
  severity?: "info" | "warning";
}

export interface VariantSyncResult {
  actions: SyncAction[];
  /** Percentage the supplier cost moved, for the activity log. */
  costChangePercent: string;
}

/**
 * Decide what to do about one variant after re-reading its supplier SKU.
 *
 * Kept pure so the sync job, the "preview changes" screen and the tests all run
 * the same decision table.
 */
export function planVariantSync(
  input: VariantSyncInput,
  policy: InventoryPolicyInput,
  pricingRule: PricingRuleInput | null,
): VariantSyncResult {
  const actions: SyncAction[] = [];
  const base = {
    productVariantId: input.productVariantId,
    shopifyVariantId: input.shopifyVariantId,
    inventoryItemId: input.inventoryItemId ?? null,
  };

  // ---- The supplier product is gone ----------------------------------------
  if (!input.supplier.found) {
    const action = policy.onProductRemoved;
    if (action === "UNPUBLISH_WHEN_OUT") {
      actions.push({
        ...base,
        type: "UNPUBLISH_PRODUCT",
        reason: "The supplier product is no longer listed.",
        severity: "warning",
      });
    } else if (action === "SET_ZERO_WHEN_OUT" || action === "UPDATE_QUANTITY") {
      actions.push({
        ...base,
        type: "UPDATE_INVENTORY",
        quantity: 0,
        reason: "The supplier product is no longer listed.",
        severity: "warning",
      });
    }
    if (action !== "DO_NOTHING") {
      actions.push({
        ...base,
        type: "NOTIFY",
        reason: "Supplier product removed.",
        severity: "warning",
      });
    }
    return { actions, costChangePercent: "0.00" };
  }

  const supplier = input.supplier;
  const newCost = d(supplier.price);
  const oldCost = d(input.previousSupplierCost ?? input.currentCost ?? 0);
  const changePercent = percentChange(oldCost, newCost);

  // ---- Stock ---------------------------------------------------------------
  const outOfStock = !supplier.isAvailable || supplier.stock <= policy.lowStockThreshold;
  switch (policy.stockAction) {
    case "UPDATE_QUANTITY": {
      const quantity = Math.max(0, Math.min(supplier.stock, policy.maxInventoryPushed));
      if (quantity !== input.currentInventory) {
        actions.push({
          ...base,
          type: "UPDATE_INVENTORY",
          quantity,
          reason: `Supplier stock is ${supplier.stock}; syncing ${quantity} (cap ${policy.maxInventoryPushed}).`,
        });
      }
      break;
    }
    case "SET_ZERO_WHEN_OUT": {
      if (outOfStock && input.currentInventory !== 0) {
        actions.push({
          ...base,
          type: "UPDATE_INVENTORY",
          quantity: 0,
          reason: "The supplier SKU is out of stock.",
          severity: "warning",
        });
      } else if (!outOfStock && input.currentInventory === 0) {
        // Restock: put the variant back on sale.
        const quantity = Math.max(1, Math.min(supplier.stock, policy.maxInventoryPushed));
        actions.push({
          ...base,
          type: "UPDATE_INVENTORY",
          quantity,
          reason: "The supplier SKU is back in stock.",
        });
      }
      break;
    }
    case "UNPUBLISH_WHEN_OUT": {
      if (outOfStock) {
        actions.push({
          ...base,
          type: "UNPUBLISH_PRODUCT",
          reason: "The supplier SKU is out of stock.",
          severity: "warning",
        });
      }
      break;
    }
    case "NOTIFY_ONLY": {
      if (outOfStock) {
        actions.push({
          ...base,
          type: "NOTIFY",
          reason: `The supplier SKU is out of stock (${supplier.stock} left).`,
          severity: "warning",
        });
      }
      break;
    }
    case "DO_NOTHING":
    default:
      break;
  }

  // ---- Price ---------------------------------------------------------------
  const threshold = d(policy.priceThresholdPercent);
  const movedEnough = changePercent.abs().greaterThanOrEqualTo(threshold) && !newCost.equals(oldCost);

  if (movedEnough && policy.priceAction !== "DO_NOTHING") {
    if (policy.priceAction === "NOTIFY_ONLY") {
      actions.push({
        ...base,
        type: "NOTIFY",
        reason: `Supplier cost moved ${changePercent.toFixed(2)}% (${money(oldCost)} → ${money(newCost)}).`,
        severity: "warning",
      });
    } else if (policy.priceAction === "UPDATE_PRICE" && pricingRule) {
      const computed = computePrice(pricingRule, {
        cost: newCost.toString(),
        shippingCost: supplier.shippingCost ?? 0,
      });
      const priceChanged = !d(computed.price).equals(d(input.currentPrice));
      if (priceChanged) {
        actions.push({
          ...base,
          type: "UPDATE_PRICE",
          price: computed.price,
          compareAtPrice: computed.compareAtPrice,
          cost: computed.effectiveCost,
          reason: `Supplier cost moved ${changePercent.toFixed(2)}%; repriced to ${computed.price}.`,
        });
      }
    }
  }

  // Keep Shopify's "Cost per item" honest even when the sell price is frozen.
  const costChanged = !newCost.equals(d(input.currentCost ?? 0));
  const alreadyRepricing = actions.some((a) => a.type === "UPDATE_PRICE");
  if (costChanged && !alreadyRepricing) {
    actions.push({
      ...base,
      type: "UPDATE_COST",
      cost: money(newCost),
      reason: `Supplier cost is now ${money(newCost)}.`,
    });
  }

  return { actions, costChangePercent: changePercent.toFixed(2) };
}

export const DEFAULT_INVENTORY_POLICY: InventoryPolicyInput = {
  priceAction: "NOTIFY_ONLY",
  priceThresholdPercent: 0,
  stockAction: "SET_ZERO_WHEN_OUT",
  lowStockThreshold: 0,
  maxInventoryPushed: 50,
  onProductRemoved: "UNPUBLISH_WHEN_OUT",
};
