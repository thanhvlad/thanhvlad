import { describe, expect, it } from "vitest";
import { MockSupplierAdapter, MOCK_CATALOG_IDS } from "~/services/suppliers/mock.server";
import { readFileSync } from "node:fs";
import { EXTENSION_PLACEMENT_STEPS, detectPlatform, getAdapter, listPlatforms } from "~/services/suppliers/index.server";

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

  it("reports an order it did not place as unknown, never as shipped", async () => {
    // A restart or a separate worker process used to see every MOCK- id as
    // SHIPPED at once, skipping payment and pushing invented tracking.
    expect(await adapter.getOrder("MOCK-FROM-ANOTHER-PROCESS-1")).toBeNull();
    expect(await adapter.getTracking("MOCK-FROM-ANOTHER-PROCESS-1")).toEqual([]);
  });

  it("keeps its sample data from passing for a real listing", async () => {
    const product = await adapter.getProduct(MOCK_CATALOG_IDS[0]);
    expect(product!.url).not.toMatch(/aliexpress/i);
    expect(product!.storeUrl ?? "").not.toMatch(/aliexpress/i);
    expect(product!.descriptionHtml).not.toMatch(/buyer protection|within 48 hours|example\.com\/store/i);
    const page = await adapter.searchProducts({ query: "" });
    expect(page.items.every((i) => !/aliexpress/i.test(i.url))).toBe(true);
    // The parse still works on the demo link, so "Add to import list" does too.
    expect(adapter.parseProductReference(page.items[0].url)).toBe(page.items[0].externalId);
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
  it("marks a product it invented, so a refresh can refuse to store it", async () => {
    const mock = getAdapter("MOCK");
    // A seeded catalogue product is legitimate mock data.
    const seeded = await mock.getProduct("1005006001");
    expect(seeded).not.toBeNull();
    expect((seeded!.raw as { mockSynthetic?: boolean } | undefined)?.mockSynthetic).toBeUndefined();

    // An id the catalogue does not know is invented on the spot. Unmarked, this
    // is what silently replaced real extension-captured products with
    // "Sample product <id>" on every inventory sync.
    const invented = await mock.getProduct("1005012312204978");
    expect(invented).not.toBeNull();
    expect(invented!.title).toContain("Sample product");
    expect((invented!.raw as { mockSynthetic?: boolean } | undefined)?.mockSynthetic).toBe(true);
  });

  it("never serves the mock for a real platform, whatever the driver", () => {
    // Under SUPPLIER_DRIVER=mock every platform used to get the mock, so a real
    // AliExpress order was "placed" with a MOCK- id and invented tracking.
    expect(getAdapter("ALIEXPRESS").platform).toBe("ALIEXPRESS");
    expect(getAdapter("ALIEXPRESS").simulated).toBeFalsy();
    expect(getAdapter("CJ_DROPSHIPPING").platform).toBe("CJ_DROPSHIPPING");
    expect(getAdapter("CJ_DROPSHIPPING").simulated).toBeFalsy();
    expect(getAdapter("MOCK").simulated).toBe(true);
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

describe("how the supplier platforms describe themselves", () => {
  it("uses the agreed words for extension ordering, never the extension buying anything", () => {
    expect(EXTENSION_PLACEMENT_STEPS).toBe(
      "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.",
    );
  });

  it("does not promise the AliExpress API on a server running the mock driver with no keys", () => {
    // Production today: SUPPLIER_DRIVER=mock and no AliExpress keys.
    const ali = listPlatforms({ driver: "mock", aliexpressConfigured: false }).find((p) => p.platform === "ALIEXPRESS")!;
    expect(ali.description).not.toMatch(/Official|API\. Search/);
    expect(ali.description).toContain("Chrome extension");
    expect(ali.description).toContain(EXTENSION_PLACEMENT_STEPS);
    expect(ali.configured).toBe(false);
    expect(ali.capabilities).toMatchObject({ search: false, placeOrder: false, tracking: false });
  });

  it("still does not promise it with keys but the mock driver, since nothing would call it", () => {
    const ali = listPlatforms({ driver: "mock", aliexpressConfigured: true }).find((p) => p.platform === "ALIEXPRESS")!;
    expect(ali.description).toContain("Chrome extension");
    expect(ali.configured).toBe(false);
  });

  it("describes the API once the live driver and the keys are both there", () => {
    const platforms = listPlatforms({ driver: "live", aliexpressConfigured: true, cjConfigured: false });
    const ali = platforms.find((p) => p.platform === "ALIEXPRESS")!;
    expect(ali.description).toMatch(/Official AliExpress Dropshipping API/);
    expect(ali.configured).toBe(true);
    expect(ali.capabilities.placeOrder).toBe(true);
    const cj = platforms.find((p) => p.platform === "CJ_DROPSHIPPING")!;
    expect(cj.description).toMatch(/Not connected/);
    expect(cj.capabilities.placeOrder).toBe(false);
  });
});

describe("demo data", () => {
  // The registry never serves invented data for a real platform, so demo data
  // filed under ALIEXPRESS fails on its first refresh or order.
  it("seeds the demo catalogue under the Demo supplier", () => {
    const seed = readFileSync("prisma/seed.ts", "utf8");
    expect(seed).toContain('platform: "MOCK"');
    expect(seed).not.toContain('platform: "ALIEXPRESS"');
    expect(seed).not.toContain("aliexpress.com/item");
  });

  it("imports the demo product from the Demo supplier, on a test order", () => {
    const demo = readFileSync("scripts/demo.ts", "utf8");
    expect(demo).toMatch(/addToImportList\(shop, "\d+", \{ platform: "MOCK"/);
    expect(demo).toContain("test: true,");
    expect(demo).not.toContain("aliexpress.com/item");
  });
});
