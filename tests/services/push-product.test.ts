/**
 * Pushing an imported product to Shopify: how a Demo supplier product is
 * listed, and how images Shopify could not download reach the merchant.
 *
 * The database and the Shopify calls are stubs; what is under test is what
 * would have been sent to Shopify and written to the activity log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseShopSettings } from "~/domain/settings/shop-settings";
import type { ShopWithSettings } from "~/services/shop.server";

const mocks = vi.hoisted(() => ({
  db: {
    importedProduct: { findFirst: vi.fn(), update: vi.fn() },
    product: { upsert: vi.fn() },
    productMapping: { upsert: vi.fn(), findUnique: vi.fn() },
    productVariant: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    variantMapping: { deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
  createProduct: vi.fn(),
  publishProduct: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("~/shopify.server", () => ({ authenticate: {}, unauthenticated: {}, login: undefined, apiVersion: "2026-07", default: {} }));
vi.mock("~/db.server", () => ({ default: mocks.db, chunkedTransaction: vi.fn() }));
vi.mock("~/services/activity.server", () => ({ logActivity: mocks.logActivity }));
vi.mock("~/services/billing.server", () => ({ assertWithinPlan: vi.fn(async () => undefined), PlanLimitError: class extends Error {} }));
vi.mock("~/services/shopify/products.server", () => ({ createProduct: mocks.createProduct, publishProduct: mocks.publishProduct }));
vi.mock("~/services/shopify/fulfillment-service.server", () => ({ assignVariantToLocation: vi.fn() }));
vi.mock("~/services/suppliers/catalog.server", () => ({ cacheSupplierProduct: vi.fn(), fetchAndCacheByReference: vi.fn() }));
vi.mock("~/services/pricing.server", () => ({ resolvePricingRule: vi.fn() }));
vi.mock("~/services/currency.server", () => ({ convertToShopCurrency: vi.fn() }));

const { DEMO_PRODUCT_TAG, listingForPush, pushImportedProduct } = await import("~/services/import.server");

function shop(products: Record<string, unknown> = {}): ShopWithSettings {
  return {
    id: "shop1",
    domain: "store.myshopify.com",
    primaryLocationId: "gid://shopify/Location/1",
    fulfillmentLocationId: null,
    parsedSettings: { ...parseShopSettings({}), products: { ...parseShopSettings({}).products, defaultStatus: "ACTIVE", publishOnPush: true, ...products } },
  } as unknown as ShopWithSettings;
}

function imported(platform: string) {
  return {
    id: "ip1",
    shopId: "shop1",
    status: "DRAFT",
    title: "Minimalist watch",
    description: "<p>Watch</p>",
    vendor: "Lumora Loves",
    productType: null,
    tags: ["new"],
    handle: null,
    images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
    options: ["Color"],
    excludedValues: {},
    collections: [],
    shopifyProductId: null,
    pushedProductId: null,
    variants: [
      { id: "iv1", isEnabled: true, optionValues: ["Silver"], sku: "W-S", price: "19.99", compareAtPrice: null, cost: "6.40", weightGrams: 100, inventory: 10, image: null, supplierVariantId: "sv1", supplierVariant: null },
    ],
    supplierProduct: { platform, variants: [] },
  };
}

function pushedProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Product/1",
    handle: "minimalist-watch",
    title: "Minimalist watch",
    status: "DRAFT",
    featuredImage: null,
    failedMedia: [],
    processingMediaCount: 0,
    variants: [{ id: "gid://shopify/ProductVariant/1", title: "Silver", sku: "W-S", price: "19.99", compareAtPrice: null, inventoryItemId: "gid://shopify/InventoryItem/1", optionValues: ["Silver"], position: 1 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const { db } = mocks;
  db.importedProduct.update.mockResolvedValue({});
  db.$transaction.mockImplementation(async (work: (tx: typeof db) => unknown) => work(db));
  db.product.upsert.mockResolvedValue({ id: "p1" });
  db.productMapping.upsert.mockResolvedValue({ id: "pm1" });
  db.productMapping.findUnique.mockResolvedValue({ id: "pm1" });
  db.productVariant.upsert.mockResolvedValue({ id: "v1" });
  db.variantMapping.deleteMany.mockResolvedValue({ count: 0 });
  db.variantMapping.create.mockResolvedValue({});
  mocks.publishProduct.mockResolvedValue(undefined);
});

describe("listingForPush", () => {
  it("keeps a Demo supplier product a tagged draft whatever the settings say", () => {
    expect(listingForPush("MOCK", { defaultStatus: "ACTIVE", publishOnPush: true }, ["new", DEMO_PRODUCT_TAG])).toEqual({
      status: "DRAFT",
      publish: false,
      tags: ["new", "dropshiphub-demo"],
      demo: true,
    });
  });

  it("follows the settings for a real supplier", () => {
    expect(listingForPush("ALIEXPRESS", { defaultStatus: "ACTIVE", publishOnPush: true }, ["new"])).toEqual({ status: "ACTIVE", publish: true, tags: ["new"], demo: false });
    expect(listingForPush("ALIEXPRESS", { defaultStatus: "DRAFT", publishOnPush: true }, [])).toMatchObject({ status: "DRAFT", publish: false });
    expect(listingForPush(null, { defaultStatus: "ACTIVE", publishOnPush: false }, [])).toMatchObject({ status: "ACTIVE", publish: false });
  });
});

describe("pushImportedProduct", () => {
  it("pushes a Demo supplier product as an unpublished draft tagged dropshiphub-demo", async () => {
    mocks.db.importedProduct.findFirst.mockResolvedValue(imported("MOCK"));
    mocks.createProduct.mockResolvedValue(pushedProduct());

    const result = await pushImportedProduct(shop(), {} as never, "ip1", "staff@example.com");

    expect(result).toMatchObject({ ok: true, demo: true });
    expect(mocks.createProduct).toHaveBeenCalledWith({}, expect.objectContaining({ status: "DRAFT", tags: ["new", "dropshiphub-demo"] }));
    expect(mocks.publishProduct).not.toHaveBeenCalled();
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ action: "product.pushed", message: expect.stringMatching(/Demo supplier product: kept as a draft/) }));
  });

  it("publishes a real supplier product as the settings ask", async () => {
    mocks.db.importedProduct.findFirst.mockResolvedValue(imported("ALIEXPRESS"));
    mocks.createProduct.mockResolvedValue(pushedProduct({ status: "ACTIVE" }));

    const result = await pushImportedProduct(shop(), {} as never, "ip1");

    expect(result).toMatchObject({ ok: true, demo: false });
    expect(mocks.createProduct).toHaveBeenCalledWith({}, expect.objectContaining({ status: "ACTIVE", tags: ["new"] }));
    expect(mocks.publishProduct).toHaveBeenCalledWith({}, "gid://shopify/Product/1");
  });

  it("tells the merchant which images Shopify could not download", async () => {
    mocks.db.importedProduct.findFirst.mockResolvedValue(imported("ALIEXPRESS"));
    mocks.createProduct.mockResolvedValue(
      pushedProduct({
        failedMedia: [{ id: "gid://shopify/MediaImage/1", alt: "Silver watch", message: "Image could not be downloaded (HTTP 403)." }],
        processingMediaCount: 1,
      }),
    );

    const result = await pushImportedProduct(shop(), {} as never, "ip1", "staff@example.com");

    expect(result.failedMedia).toEqual([{ alt: "Silver watch", message: "Image could not be downloaded (HTTP 403)." }]);
    expect(result.processingMediaCount).toBe(1);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      "shop1",
      expect.objectContaining({
        action: "product.media_failed",
        level: "warn",
        entity: "Product",
        entityId: "p1",
        message: expect.stringMatching(/could not download 1 image\(s\) for "Minimalist watch": Silver watch \(Image could not be downloaded \(HTTP 403\)\.\)/),
      }),
    );
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ action: "product.pushed", message: expect.stringMatching(/still downloading 1 image/) }));
  });

  it("writes no image warning when every image arrived", async () => {
    mocks.db.importedProduct.findFirst.mockResolvedValue(imported("ALIEXPRESS"));
    mocks.createProduct.mockResolvedValue(pushedProduct());

    const result = await pushImportedProduct(shop(), {} as never, "ip1");

    expect(result.failedMedia).toEqual([]);
    expect(mocks.logActivity.mock.calls.map((call) => call[1].action)).toEqual(["product.pushed"]);
  });
});
