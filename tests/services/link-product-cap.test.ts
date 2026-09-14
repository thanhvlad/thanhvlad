import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopWithSettings } from "~/services/shop.server";

/**
 * Linking an existing Shopify product creates a Product row, and the plan's
 * product cap counts those rows - but only the push path used to check it.
 * These pin that a new link is checked before anything is fetched or written,
 * and that refreshing a product already managed is not.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  upsert: vi.fn(),
  assertWithinPlan: vi.fn(),
  fetchProduct: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: { product: { findUnique: mocks.findUnique, count: mocks.count, upsert: mocks.upsert } },
  chunkedTransaction: vi.fn(),
}));
vi.mock("~/services/billing.server", () => ({ assertWithinPlan: mocks.assertWithinPlan }));
vi.mock("~/services/activity.server", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("~/services/pricing.server", () => ({ resolvePricingRule: vi.fn() }));
vi.mock("~/services/shopify/products.server", () => ({ fetchProduct: mocks.fetchProduct, deleteProduct: vi.fn(), updateVariantPrices: vi.fn() }));

const { countUnmanagedShopifyProducts, importExistingShopifyProduct } = await import("~/services/products.server");

const shop = { id: "s1", accountId: "acc1" } as unknown as ShopWithSettings;
const client = vi.fn();

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe("importExistingShopifyProduct", () => {
  it("refuses a new link past the cap before touching Shopify or the database", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.assertWithinPlan.mockRejectedValue(Object.assign(new Error("Your Basic plan allows 3000 products."), { code: "PLAN_LIMIT" }));
    await expect(importExistingShopifyProduct(shop, client, "gid://shopify/Product/1")).rejects.toMatchObject({ code: "PLAN_LIMIT" });
    expect(mocks.assertWithinPlan).toHaveBeenCalledWith(shop, "products", 1);
    expect(mocks.fetchProduct).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not count a product that is already managed", async () => {
    mocks.findUnique.mockResolvedValue({ id: "p1" });
    mocks.fetchProduct.mockResolvedValue(null);
    await expect(importExistingShopifyProduct(shop, client, "gid://shopify/Product/1")).rejects.toThrow("Product not found");
    expect(mocks.assertWithinPlan).not.toHaveBeenCalled();
  });
});

describe("countUnmanagedShopifyProducts", () => {
  it("counts only the picked products the app does not manage yet", async () => {
    mocks.count.mockResolvedValue(1);
    expect(await countUnmanagedShopifyProducts("s1", ["a", "b", "b", "c"])).toBe(2);
    expect(await countUnmanagedShopifyProducts("s1", [])).toBe(0);
  });
});
