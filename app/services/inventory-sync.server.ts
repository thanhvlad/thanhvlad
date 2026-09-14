import type { Prisma } from "@prisma/client";
import prisma, { chunkedTransaction } from "~/db.server";
import { planVariantSync, type InventoryPolicyInput, type SyncAction } from "~/domain/inventory/rules";
import { AppError, errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { convertToShopCurrency } from "./currency.server";
import { notify } from "./notifications.server";
import { resolvePricingRule } from "./pricing.server";
import type { ShopWithSettings } from "./shop.server";
import type { GraphqlClient } from "./shopify/graphql.server";
import { setInventoryQuantities, setProductStatus, updateVariantPrices } from "./shopify/products.server";
import { refreshSupplierProduct } from "./suppliers/catalog.server";
import { SUPPLIER_API_UNAVAILABLE } from "./suppliers/index.server";
import { findAlternativeSuppliers } from "./supplier-comparison.server";

export interface InventorySyncSummary {
  productsChecked: number;
  suppliersRefreshed: number;
  suppliersFailed: number;
  /**
   * Supplier products that were not refreshed because this server has no API
   * for them, which is the normal state of a product captured with the Chrome
   * extension. Not a failure: nothing is wrong, there is simply nothing to ask.
   */
  suppliersSkipped: number;
  priceUpdates: number;
  inventoryUpdates: number;
  unpublished: number;
  costUpdates: number;
  notifications: number;
  errors: string[];
  /** Why each skipped supplier product was left alone, in words a merchant can act on. */
  skipped: string[];
}

/** Error codes meaning "no supplier API to ask", as opposed to "the supplier API failed". */
const NO_SUPPLIER_API_CODES = new Set([SUPPLIER_API_UNAVAILABLE, "SUPPLIER_NOT_CONFIGURED"]);

export const REFRESH_BY_RECAPTURE_REASON = "refresh by re-capturing with the extension";

/**
 * Whether a refresh error only says the server cannot reach this supplier.
 *
 * With SUPPLIER_DRIVER=mock or no AliExpress keys - the production setup while
 * orders go through the extension - every captured product threw here. Each
 * one was counted as a supplier failure and shown as a critical figure on the
 * inventory screen every hour, for products that were fine.
 */
export function isNoSupplierApiError(error: unknown): boolean {
  return error instanceof AppError && NO_SUPPLIER_API_CODES.has(error.code);
}

export async function getInventoryPolicy(shopId: string) {
  return prisma.inventoryPolicy.upsert({ where: { shopId }, create: { shopId }, update: {} });
}

export async function updateInventoryPolicy(shopId: string, data: Omit<Prisma.InventoryPolicyUncheckedUpdateInput, "shopId" | "id">) {
  const row = await prisma.inventoryPolicy.upsert({
    where: { shopId },
    create: { ...(data as Omit<Prisma.InventoryPolicyUncheckedCreateInput, "shopId">), shopId },
    update: data,
  });
  await logActivity(shopId, { action: "inventory.policy_updated", message: "Auto-update policy saved." });
  return row;
}

function toPolicyInput(row: Awaited<ReturnType<typeof getInventoryPolicy>>): InventoryPolicyInput {
  return {
    priceAction: row.priceAction,
    priceThresholdPercent: row.priceThresholdPercent.toString(),
    stockAction: row.stockAction,
    lowStockThreshold: row.lowStockThreshold,
    maxInventoryPushed: row.maxInventoryPushed,
    onProductRemoved: row.onProductRemoved,
  };
}

/**
 * The supplier price in the currency the variant's cost was stored in.
 *
 * Import converts the supplier price into the shop's currency before storing
 * the cost; the sync compared the raw supplier price against that cost. A
 * capture from a page priced in another currency then looked like a large price
 * move and produced cost and price actions from nothing. A variant with no
 * currency recorded is taken as already in the shop's currency. Exported for the test.
 */
export async function supplierPriceInShopCurrency(shop: ShopWithSettings, sv: { price: Prisma.Decimal | string | number; currency?: string | null }) {
  const from = sv.currency || shop.currency;
  if (!from || !shop.currency || from.toUpperCase() === shop.currency.toUpperCase()) return sv.price;
  return convertToShopCurrency(sv.price as never, from, shop.currency, shop.parsedSettings.currency);
}

/**
 * Whether an extension capture is news for a product. A product with no sync
 * stamp is treated as already holding its capture: pushing a product stamps it,
 * so a missing stamp means a row this rule cannot date, and the safe reading of
 * an undatable capture is "not new".
 */
export function captureIsNewerThanSync(capturedAt: Date | null | undefined, lastSyncedAt: Date | null | undefined): boolean {
  if (!capturedAt || !lastSyncedAt) return false;
  return capturedAt.getTime() > lastSyncedAt.getTime();
}

/**
 * The auto-update job: refresh every supplier product referenced by a managed
 * product, run the policy over each variant and apply the resulting actions to
 * Shopify. Runs per shop; safe to call from a cron or the "Sync now" button.
 */
export async function runInventorySync(
  shop: ShopWithSettings,
  client: GraphqlClient,
  options: {
    productIds?: string[];
    dryRun?: boolean;
    onProgress?: (n: number) => Promise<unknown>;
    actor?: string;
    /**
     * Stable across attempts of the same run (the job id). It goes into the
     * Shopify idempotency key of each stock write, so a retried attempt that
     * computes the same quantities is recognised as the same write, while the
     * next scheduled run is a new one even when the numbers match.
     */
    operationId?: string;
  } = {},
): Promise<InventorySyncSummary & { plannedActions: SyncAction[] }> {
  const policyRow = await getInventoryPolicy(shop.id);
  const policy = toPolicyInput(policyRow);
  const pricingRule = await resolvePricingRule(shop.id, null);
  const summary: InventorySyncSummary = { productsChecked: 0, suppliersRefreshed: 0, suppliersFailed: 0, suppliersSkipped: 0, priceUpdates: 0, inventoryUpdates: 0, unpublished: 0, costUpdates: 0, notifications: 0, errors: [], skipped: [] };
  const planned: SyncAction[] = [];

  if (!policyRow.isEnabled && !options.productIds) {
    return { ...summary, plannedActions: planned };
  }

  const products = await prisma.product.findMany({
    where: { shopId: shop.id, ...(options.productIds ? { id: { in: options.productIds } } : { autoUpdateEnabled: true }), mapping: { variants: { some: {} } } },
    include: {
      variants: { include: { variantMappings: { where: { isEnabled: true }, orderBy: [{ isDefault: "desc" }, { priority: "asc" }], include: { supplierVariant: true } } } },
    },
  });

  // Refresh each supplier product once, even when several Shopify products share it.
  const supplierProductIds = new Set<string>();
  for (const p of products) for (const v of p.variants) for (const m of v.variantMappings) supplierProductIds.add(m.supplierVariant.supplierProductId);
  const removed = new Set<string>();
  const notRefreshable = new Set<string>();
  for (const id of supplierProductIds) {
    try {
      const refreshed = await refreshSupplierProduct(shop.id, id);
      if (refreshed) summary.suppliersRefreshed += 1;
      else removed.add(id);
    } catch (error) {
      if (isNoSupplierApiError(error)) {
        notRefreshable.add(id);
        summary.suppliersSkipped += 1;
        continue;
      }
      summary.suppliersFailed += 1;
      summary.errors.push(`Supplier ${id}: ${errorMessage(error)}`);
    }
  }

  const fresh = await prisma.supplierVariant.findMany({ where: { supplierProductId: { in: [...supplierProductIds] } } });
  const freshById = new Map(fresh.map((v) => [v.id, v]));

  for (const product of products) {
    summary.productsChecked += 1;
    const actions: SyncAction[] = [];
    let skippedVariants = 0;
    let plannedFromCapture = false;
    for (const variant of product.variants) {
      const mapping = variant.variantMappings[0];
      if (!mapping) continue;
      if (notRefreshable.has(mapping.supplierVariant.supplierProductId)) {
        // No supplier API, so the only supplier numbers are the extension's last
        // capture. Acting on them every run would be wrong both ways it can go:
        // planning each hour from a capture taken days ago resets Shopify stock
        // to what the supplier had then, silently undoing every sale since, and
        // never planning means a fresh re-capture never reaches the store. So a
        // capture is acted on once - when it is newer than this product's last
        // sync - and skipped otherwise.
        if (!captureIsNewerThanSync(mapping.supplierVariant.updatedAt, product.lastSyncedAt)) {
          skippedVariants += 1;
          continue;
        }
        plannedFromCapture = true;
      }
      const sv = freshById.get(mapping.supplierVariantId);
      const supplierProductRemoved = removed.has(mapping.supplierVariant.supplierProductId);
      const plan = planVariantSync(
        {
          productVariantId: variant.id,
          shopifyVariantId: variant.shopifyVariantId,
          inventoryItemId: variant.inventoryItemId,
          currentPrice: variant.price.toString(),
          currentCompareAtPrice: variant.compareAtPrice?.toString() ?? null,
          currentInventory: variant.inventoryQuantity,
          currentCost: variant.cost?.toString() ?? null,
          previousSupplierCost: variant.cost?.toString() ?? null,
          supplier: supplierProductRemoved || !sv
            ? { found: false }
            : { found: true, price: (await supplierPriceInShopCurrency(shop, sv)).toString(), stock: sv.stock, isAvailable: sv.isAvailable },
        },
        policy,
        pricingRule,
      );
      actions.push(...plan.actions);
    }
    if (skippedVariants > 0) summary.skipped.push(`${product.title}: ${REFRESH_BY_RECAPTURE_REASON}`);
    planned.push(...actions);
    if (options.onProgress) await options.onProgress(1);
    if (options.dryRun) continue;
    if (actions.length === 0) {
      // Comparing a fresh capture and finding nothing to change is still a sync
      // of that capture. Without the stamp the same capture would stay "newer
      // than the last sync" and be planned again every run, which is how an old
      // capture comes to overwrite the stock of a product that has sold since.
      if (plannedFromCapture) await prisma.product.update({ where: { id: product.id }, data: { lastSyncedAt: new Date() } });
      continue;
    }

    try {
      await applyActions(shop, client, product.id, product.shopifyProductId, product.title, actions, summary, options.operationId);
      await prisma.product.update({ where: { id: product.id }, data: { lastSyncedAt: new Date() } });
    } catch (error) {
      summary.errors.push(`${product.title}: ${errorMessage(error)}`);
      logger.error("Inventory sync apply failed", { productId: product.id, error });
    }
  }

  if (!options.dryRun) {
    await prisma.inventoryPolicy.update({ where: { shopId: shop.id }, data: { lastRunAt: new Date() } });
    await logActivity(shop.id, {
      actor: options.actor,
      action: "inventory.synced",
      message:
        `Auto-update checked ${summary.productsChecked} product(s): ${summary.priceUpdates} price, ${summary.inventoryUpdates} stock, ${summary.unpublished} unpublished, ${summary.costUpdates} cost updates.` +
        (summary.skipped.length > 0 ? ` ${summary.skipped.length} skipped (${REFRESH_BY_RECAPTURE_REASON}).` : ""),
      meta: { ...summary },
    });
  }
  return { ...summary, plannedActions: planned };
}

async function applyActions(shop: ShopWithSettings, client: GraphqlClient, productId: string, shopifyProductId: string, title: string, actions: SyncAction[], summary: InventorySyncSummary, operationId?: string) {
  const priceUpdates = actions.filter((a) => a.type === "UPDATE_PRICE");
  const costUpdates = actions.filter((a) => a.type === "UPDATE_COST");
  const inventoryUpdates = actions.filter((a) => a.type === "UPDATE_INVENTORY");
  const unpublish = actions.find((a) => a.type === "UNPUBLISH_PRODUCT");
  const notifications = actions.filter((a) => a.type === "NOTIFY");

  if (priceUpdates.length || costUpdates.length) {
    await updateVariantPrices(client, shopifyProductId, [
      ...priceUpdates.map((a) => ({ id: a.shopifyVariantId, price: a.price!, compareAtPrice: a.compareAtPrice ?? null, cost: a.cost ?? null })),
      ...costUpdates.map((a) => ({ id: a.shopifyVariantId, cost: a.cost ?? null })),
    ]);
    await chunkedTransaction([
      ...priceUpdates.map((a) => prisma.productVariant.update({ where: { id: a.productVariantId }, data: { price: a.price!, compareAtPrice: a.compareAtPrice ?? null, cost: a.cost ?? undefined } })),
      ...costUpdates.map((a) => prisma.productVariant.update({ where: { id: a.productVariantId }, data: { cost: a.cost ?? undefined } })),
    ]);
    summary.priceUpdates += priceUpdates.length;
    summary.costUpdates += costUpdates.length;
    for (const a of priceUpdates) {
      await logActivity(shop.id, { action: "inventory.price_updated", entity: "Product", entityId: productId, message: `${title}: ${a.reason}` });
    }
    if (priceUpdates.length && shop.parsedSettings.notifications.onPriceChange) {
      await notify(shop.id, { type: "price.changed", title: `${title}: ${priceUpdates.length} price(s) updated`, body: priceUpdates[0].reason, link: `/app/products/${productId}`, dedupeKey: `price:${productId}`, dedupeMinutes: 360 });
      summary.notifications += 1;
    }
  }

  if (inventoryUpdates.length) {
    // Once the app is registered as a fulfilment service, stock lives at ITS
    // location, not the merchant's primary one. Writing to primary regardless
    // meant a variant stocked at both was zeroed where nobody sells from while
    // staying sellable from the app's location - and after the primary link is
    // dropped, every push would land on a location the item no longer has.
    const locationId = shop.fulfillmentLocationId ?? shop.primaryLocationId;
    if (!locationId) {
      summary.errors.push(`${title}: no fulfilment or primary location configured; cannot update inventory.`);
    } else {
      const withItems = inventoryUpdates.filter((a) => a.inventoryItemId);
      await setInventoryQuantities(
        client,
        locationId,
        withItems.map((a) => ({ inventoryItemId: a.inventoryItemId!, quantity: a.quantity ?? 0 })),
        // Without an operation id each call gets a fresh key. A key derived from
        // the payload alone made the next hour's identical "set to 10" come back
        // from Shopify's 24-hour idempotency cache, unwritten.
        { operationId: operationId ? `${operationId}:${productId}` : null },
      );
      await chunkedTransaction(withItems.map((a) => prisma.productVariant.update({ where: { id: a.productVariantId }, data: { inventoryQuantity: a.quantity ?? 0 } })));
      summary.inventoryUpdates += withItems.length;
      const outOfStock = withItems.filter((a) => (a.quantity ?? 0) === 0);
      if (outOfStock.length && shop.parsedSettings.notifications.onOutOfStock) {
        // Look for a replacement before telling the merchant. The comparison
        // engine and its screen both existed already; nothing ever ran them on
        // a stock-out, so the merchant was told the product had died and left
        // to go looking for an alternative by hand.
        let body: string | undefined;
        try {
          const comparison = await findAlternativeSuppliers(shop, productId, { limit: 4, actor: "inventory-sync" });
          if (comparison.betterOption) {
            const alt = comparison.betterOption;
            body = `A cheaper supplier is available: ${alt.storeName ?? alt.title} at ${alt.landedCost} ${alt.currency ?? ""}`.trim();
          }
        } catch (error) {
          // A failed search must not cost the merchant the stock-out warning.
          logger.warn("Could not look for an alternative supplier on stock-out", { productId, error });
        }
        await notify(shop.id, { type: "stock.out", severity: "warning", title: `${title}: ${outOfStock.length} variant(s) out of stock at supplier`, body, link: `/app/products/${productId}`, dedupeKey: `stock:${productId}`, dedupeMinutes: 360 });
        summary.notifications += 1;
      }
      for (const a of withItems) {
        await logActivity(shop.id, { action: "inventory.stock_updated", entity: "Product", entityId: productId, message: `${title}: ${a.reason}`, level: a.severity === "warning" ? "warn" : "info" });
      }
    }
  }

  if (unpublish) {
    await setProductStatus(client, shopifyProductId, "DRAFT");
    await prisma.product.update({ where: { id: productId }, data: { status: "DRAFT" } });
    summary.unpublished += 1;
    await logActivity(shop.id, { action: "inventory.unpublished", entity: "Product", entityId: productId, level: "warn", message: `${title}: set to draft — ${unpublish.reason}` });
    if (shop.parsedSettings.notifications.onProductRemoved) {
      await notify(shop.id, { type: "product.removed", severity: "warning", title: `${title} unpublished`, body: unpublish.reason, link: `/app/products/${productId}`, dedupeKey: `unpublish:${productId}`, dedupeMinutes: 1440 });
      summary.notifications += 1;
    }
  }

  for (const n of notifications) {
    await notify(shop.id, { type: n.reason.includes("cost") ? "price.changed" : "stock.out", severity: "warning", title: `${title}`, body: n.reason, link: `/app/products/${productId}`, dedupeKey: `notify:${n.productVariantId}:${n.reason.slice(0, 40)}`, dedupeMinutes: 360 });
    summary.notifications += 1;
  }
}
