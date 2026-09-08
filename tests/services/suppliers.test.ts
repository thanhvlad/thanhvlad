import { describe, expect, it } from "vitest";
import { MockSupplierAdapter, MOCK_CATALOG_IDS } from "~/services/suppliers/mock.server";
import { detectPlatform, getAdapter, listPlatforms } from "~/services/suppliers/index.server";

describe("MockSupplierAdapter", () => {
  const adapter = new MockSupplierAdapter();

  it("parses AliExpress-style urls and raw ids", () => {
    expect(adapter.parseProductReference("https://www.aliexpress.com/item/1005006001.html")).toBe("1005006001");
    expect(adapter.parseProductReference("1005006001")).toBe("1005006001");
    expect(adapter.parseProductReference("not a product")).toBeNull();
  });

  it("searches the catalog with sorting and pagination", async () => {
    const page = await adapter.searchProducts({ query: "", pageSize: 5, sort: "orders" });
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    expect(page.items[0].orderCount).toBeGreaterThanOrEqual(page.items[1].orderCount ?? 0);

    const kitchen = await adapter.searchProducts({ query: "kitchen" });
    expect(kitchen.items.every((i) => i.externalId)).toBe(true);
    expect(kitchen.total).toBeGreaterThan(0);
  });

  it("returns a full product with variants for every option combination", async () => {
    const product = await adapter.getProduct(MOCK_CATALOG_IDS[1]);
    expect(product).not.toBeNull();
    expect(product!.optionNames).toEqual(["Color", "Band"]);
    expect(product!.variants).toHaveLength(6);
    expect(product!.variants[0].attributes.map((a) => a.name)).toEqual(["Color", "Band"]);
    expect(product!.images.length).toBeGreaterThan(0);
  });

  it("quotes shipping per destination", async () => {
    const us = await adapter.getShippingQuotes({ externalId: MOCK_CATALOG_IDS[0], quantity: 1, shipToCountry: "US" });
    const br = await adapter.getShippingQuotes({ externalId: MOCK_CATALOG_IDS[0], quantity: 1, shipToCountry: "BR" });
    expect(us.some((q) => q.carrierCode === "EPACKET")).toBe(true);
    expect(br.some((q) => q.carrierCode === "EPACKET")).toBe(false);
    expect(us.every((q) => q.shipToCountry === "US")).toBe(true);
  });

  it("places an order idempotently and exposes status + tracking", async () => {
    const product = await adapter.getProduct(MOCK_CATALOG_IDS[0]);
    const input = {
      reference: "po_test_1",
      items: [{ externalProductId: product!.externalId, externalSkuId: product!.variants[0].externalSkuId, quantity: 2, carrierCode: "EPACKET" }],
      address: { name: "Jane Doe", phone: "+15125550100", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701", countryCode: "US" },
    };
    const first = await adapter.placeOrder(input);
    const second = await adapter.placeOrder(input);
    expect(second.externalOrderId).toBe(first.externalOrderId);
    expect(Number(first.totalCost)).toBeGreaterThan(Number(first.itemsCost));

    const status = await adapter.getOrder(first.externalOrderId);
    expect(status?.status).toBe("AWAITING_PAYMENT");
    expect(await adapter.getTracking(first.externalOrderId)).toEqual([]);
    expect(await adapter.cancelOrder(first.externalOrderId)).toBe(true);
    expect((await adapter.getOrder(first.externalOrderId))?.status).toBe("CANCELED");
  });

  it("rejects unknown SKUs", async () => {
    await expect(
      adapter.placeOrder({
        reference: "po_bad",
        items: [{ externalProductId: "1005006001", externalSkuId: "nope", quantity: 1 }],
        address: { name: "x", phone: "1", address1: "a", city: "b", countryCode: "US" },
      }),
    ).rejects.toThrow(/Unknown SKU/);
  });
});

describe("supplier registry", () => {
  it("serves the mock adapter for every platform in mock mode", () => {
    expect(getAdapter("ALIEXPRESS").platform).toBe("MOCK");
    expect(getAdapter("CJ_DROPSHIPPING").platform).toBe("MOCK");
  });

  it("lists platforms with configuration state", () => {
    const platforms = listPlatforms();
    expect(platforms.map((p) => p.platform)).toEqual(["ALIEXPRESS", "CJ_DROPSHIPPING", "MOCK"]);
    // In mock mode every platform is SERVED by the mock adapter, which has no
    // getAuthorizationUrl. Reporting AliExpress and CJ as configured here is
    // what made the Suppliers page render an enabled Connect button that
    // dead-ends with "ALIEXPRESS does not use OAuth." Only a platform that can
    // actually be connected may report itself configured.
    expect(platforms.find((p) => p.platform === "ALIEXPRESS")?.configured).toBe(false);
    expect(platforms.find((p) => p.platform === "CJ_DROPSHIPPING")?.configured).toBe(false);
    expect(platforms.find((p) => p.platform === "MOCK")?.configured).toBe(true);
  });

  it("detects the platform from a reference", () => {
    expect(detectPlatform("https://www.aliexpress.com/item/1005006001.html")).toEqual({ platform: "ALIEXPRESS", externalId: "1005006001" });
    expect(detectPlatform("https://cjdropshipping.com/product/foo-p-1A2B3C4D-1111-2222-3333-444455556666.html")).toEqual({
      platform: "CJ_DROPSHIPPING",
      externalId: "1A2B3C4D-1111-2222-3333-444455556666",
    });
    expect(detectPlatform("1005006001")?.externalId).toBe("1005006001");
    expect(detectPlatform("hello")).toBeNull();
  });
});
