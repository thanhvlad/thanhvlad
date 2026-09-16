/**
 * The auto-update job for products this server cannot refresh.
 *
 * In production orders go through the Chrome extension and there is no supplier
 * API (SUPPLIER_DRIVER=mock, no AliExpress keys), so every captured product's
 * refresh throws "no API". That is the expected state, not a supplier failure:
 * it must not count as one, must not raise the critical figure on the inventory
 * screen, and must not be acted on as if the stored capture were fresh news.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupplierError } from "~/lib/errors";

const db = vi.hoisted(() => ({
  inventoryPolicy: { upsert: vi.fn(), update: vi.fn() },
  product: { findMany: vi.fn(), update: vi.fn() },
  supplierVariant: { findMany: vi.fn() },
  productVariant: { update: vi.fn() },
}));
const refreshSupplierProduct = vi.hoisted(() => vi.fn());
const logActivity = vi.hoisted(() => vi.fn());
const setInventoryQuantities = vi.hoisted(() => vi.fn());

vi.mock("~/db.server", () => ({ default: db, prisma: db, chunkedTransaction: vi.fn(async () => undefined) }));
vi.mock("~/lib/logger.server", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("~/services/activity.server", () => ({ logActivity }));
vi.mock("~/services/notifications.server", () => ({ notify: vi.fn() }));
vi.mock("~/services/pricing.server", () => ({ resolvePricingRule: vi.fn(async () => null) }));
vi.mock("~/services/supplier-comparison.server", () => ({ findAlternativeSuppliers: vi.fn() }));
vi.mock("~/services/suppliers/catalog.server", () => ({ refreshSupplierProduct }));
vi.mock("~/services/suppliers/index.server", () => ({ SUPPLIER_API_UNAVAILABLE: "SUPPLIER_API_UNAVAILABLE" }));
vi.mock("~/services/shopify/products.server", () => ({ setInventoryQuantities, setProductStatus: vi.fn(), updateVariantPrices: vi.fn() }));

const { captureIsNewerThanSync, isNoSupplierApiError, runInventorySync, supplierPriceInShopCurrency, REFRESH_BY_RECAPTURE_REASON } = await import("~/services/inventory-sync.server");

const shop = { id: "shop1", primaryLocationId: "gid://shopify/Location/1", fulfillmentLocationId: null, parsedSettings: { notifications: {} } } as never;
const client = vi.fn() as never;

function product(id: string, title: string, supplierProductId: string) {
  return {
    id,
    title,
    shopifyProductId: `gid://shopify/Product/${id}`,
    variants: [
      {
        id: `${id}-v1`,
        shopifyVariantId: `gid://shopify/ProductVariant/${id}`,
        inventoryItemId: `gid://shopify/InventoryItem/${id}`,
        price: { toString: () => "10.00" },
        compareAtPrice: null,
        cost: { toString: () => "4.00" },
        inventoryQuantity: 5,
        variantMappings: [{ supplierVariantId: `${supplierProductId}-sv`, supplierVariant: { supplierProductId } }],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.inventoryPolicy.upsert.mockResolvedValue({
    isEnabled: true,
    priceAction: "DO_NOTHING",
    priceThresholdPercent: { toString: () => "0" },
    stockAction: "UPDATE_QUANTITY",
    lowStockThreshold: 0,
    maxInventoryPushed: 50,
    onProductRemoved: "UNPUBLISH_WHEN_OUT",
  });
  db.supplierVariant.findMany.mockResolvedValue(
    ["captured", "live", "broken"].map((sp) => ({ id: `${sp}-sv`, supplierProductId: sp, price: { toString: () => "4.00" }, stock: 20, isAvailable: true })),
  );
  refreshSupplierProduct.mockImplementation(async (_shopId: string, id: string) => {
    if (id === "captured") throw new SupplierError("SUPPLIER_API_UNAVAILABLE", "AliExpress is not connected through an API on this server.");
    if (id === "broken") throw new Error("upstream 500");
    return { product: {}, detail: {} };
  });
});

describe("runInventorySync with a product the extension captured", () => {
  it("skips it with a neutral reason instead of counting a supplier failure", async () => {
    db.product.findMany.mockResolvedValue([product("p1", "Lamp", "captured"), product("p2", "Mug", "live"), product("p3", "Rug", "broken")]);
    const result = await runInventorySync(shop, client, { dryRun: true });

    expect(result.suppliersSkipped).toBe(1);
    expect(result.suppliersRefreshed).toBe(1);
    // A real upstream failure still counts as one.
    expect(result.suppliersFailed).toBe(1);
    expect(result.errors).toEqual(["Supplier broken: upstream 500"]);
    expect(result.skipped).toEqual([`Lamp: ${REFRESH_BY_RECAPTURE_REASON}`]);
    // Nothing is planned from the stored capture of the skipped product.
    expect(result.plannedActions.map((a) => a.productVariantId)).not.toContain("p1-v1");
    expect(result.plannedActions.map((a) => a.productVariantId)).toContain("p2-v1");
  });

  it("writes nothing to Shopify and says why in the run log when every product is skipped", async () => {
    db.product.findMany.mockResolvedValue([product("p1", "Lamp", "captured")]);
    const result = await runInventorySync(shop, client, {});

    expect(result.suppliersFailed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(setInventoryQuantities).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ action: "inventory.synced", message: expect.stringContaining(`1 skipped (${REFRESH_BY_RECAPTURE_REASON})`) }));
  });

  it("recognises only the no-API codes as a skip", () => {
    expect(isNoSupplierApiError(new SupplierError("SUPPLIER_API_UNAVAILABLE", "x"))).toBe(true);
    expect(isNoSupplierApiError(new SupplierError("SUPPLIER_NOT_CONFIGURED", "x"))).toBe(true);
    expect(isNoSupplierApiError(new SupplierError("SUPPLIER_RATE_LIMITED", "x"))).toBe(false);
    expect(isNoSupplierApiError(new Error("SUPPLIER_API_UNAVAILABLE"))).toBe(false);
  });
});

describe("an extension capture newer than the product's last sync", () => {
  const synced = new Date("2026-09-14T10:05:00Z");

  function capturedProduct(capturedAt: Date, inventoryQuantity: number) {
    const p = product("p1", "Lamp", "captured");
    return {
      ...p,
      lastSyncedAt: synced,
      variants: p.variants.map((v) => ({
        ...v,
        inventoryQuantity,
        variantMappings: v.variantMappings.map((m) => ({ ...m, supplierVariant: { ...m.supplierVariant, updatedAt: capturedAt } })),
      })),
    };
  }

  it("is acted on: a re-capture reaches the store", async () => {
    db.product.findMany.mockResolvedValue([capturedProduct(new Date("2026-09-14T12:00:00Z"), 5)]);
    const result = await runInventorySync(shop, client, { dryRun: true });
    expect(result.skipped).toEqual([]);
    expect(result.plannedActions.map((a) => a.productVariantId)).toContain("p1-v1");
  });

  it("is not acted on when it predates the last sync, so sales since are never undone", async () => {
    // Captured at 10:00 with stock 20, pushed and synced at 10:05, sold down to 5.
    db.product.findMany.mockResolvedValue([capturedProduct(new Date("2026-09-14T10:00:00Z"), 5)]);
    const result = await runInventorySync(shop, client, {});
    expect(result.plannedActions).toEqual([]);
    expect(setInventoryQuantities).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([`Lamp: ${REFRESH_BY_RECAPTURE_REASON}`]);
  });

  it("stamps the sync even when the fresh capture changes nothing, so it is not replayed next run", async () => {
    // Shopify already shows the captured stock of 20: no action, but the capture is now consumed.
    db.product.findMany.mockResolvedValue([capturedProduct(new Date("2026-09-14T12:00:00Z"), 20)]);
    await runInventorySync(shop, client, {});
    expect(db.product.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { lastSyncedAt: expect.any(Date) } });
  });

  it("treats an undatable capture as not new", () => {
    expect(captureIsNewerThanSync(new Date(), null)).toBe(false);
    expect(captureIsNewerThanSync(null, new Date())).toBe(false);
    expect(captureIsNewerThanSync(new Date("2026-09-14T12:00:00Z"), synced)).toBe(true);
    expect(captureIsNewerThanSync(synced, synced)).toBe(false);
  });
});

describe("supplierPriceInShopCurrency", () => {
  const usdShop = { currency: "USD", parsedSettings: { currency: { manualRate: 0.14, bufferPercent: 0 } } } as never;

  it("converts a capture priced in another currency before it is compared with the stored cost", async () => {
    // 20 CNY at 0.14 is 2.80 USD. Compared raw, "20" against a 2.80 cost looked
    // like a sevenfold price rise.
    expect(String(await supplierPriceInShopCurrency(usdShop, { price: "20", currency: "CNY" }))).toBe("2.8");
  });

  it("leaves a price already in the shop's currency alone", async () => {
    expect(String(await supplierPriceInShopCurrency(usdShop, { price: "4.00", currency: "usd" }))).toBe("4.00");
  });

  it("treats a variant with no recorded currency as the shop's", async () => {
    expect(String(await supplierPriceInShopCurrency(usdShop, { price: "4.00", currency: null }))).toBe("4.00");
  });
});
