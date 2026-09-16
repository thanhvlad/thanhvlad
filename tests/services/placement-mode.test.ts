/**
 * Which way a supplier order gets placed, and what a real platform is served
 * with when no API connection exists.
 *
 * The bug this guards: with SUPPLIER_DRIVER=mock, every platform was served by
 * the mock. A real Shopify order for a real AliExpress product was "placed"
 * through it - MOCK- order id, fake payment link, PLACED - and invented
 * tracking later reached the buyer. Nothing ever reached AliExpress.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplierError } from "~/lib/errors";
import type { SupplierPlatform } from "~/services/suppliers/types";
import {
  SUPPLIER_API_UNAVAILABLE,
  UnavailableSupplierAdapter,
  decidePlacementMode,
  getAdapter,
  supplierProductUrl,
} from "~/services/suppliers/index.server";

describe("decidePlacementMode", () => {
  const every = { driver: "live" as const, apiConfigured: true, hasConnectedAccount: true };

  it("uses the API only with the live driver, server keys and a connected account together", () => {
    expect(decidePlacementMode({ platform: "ALIEXPRESS", ...every })).toBe("api");
    expect(decidePlacementMode({ platform: "CJ_DROPSHIPPING", ...every })).toBe("api");

    // Any one missing, and AliExpress goes to the extension instead.
    expect(decidePlacementMode({ platform: "ALIEXPRESS", ...every, driver: "mock" })).toBe("extension");
    expect(decidePlacementMode({ platform: "ALIEXPRESS", ...every, apiConfigured: false })).toBe("extension");
    expect(decidePlacementMode({ platform: "ALIEXPRESS", ...every, hasConnectedAccount: false })).toBe("extension");
  });

  it("is the production setup today: mock driver, no keys, no account means the extension", () => {
    expect(decidePlacementMode({ platform: "ALIEXPRESS", driver: "mock", apiConfigured: false, hasConnectedAccount: false })).toBe("extension");
  });

  it("refuses platforms the extension cannot place on, rather than simulating them", () => {
    const platforms: SupplierPlatform[] = ["CJ_DROPSHIPPING", "TEMU", "MANUAL"];
    for (const platform of platforms) {
      expect(decidePlacementMode({ platform, driver: "mock", apiConfigured: false, hasConnectedAccount: false })).toBe("unavailable");
    }
    // TEMU and MANUAL have no API integration, so even a "complete" setup cannot place them.
    expect(decidePlacementMode({ platform: "TEMU", ...every })).toBe("unavailable");
    expect(decidePlacementMode({ platform: "MANUAL", ...every })).toBe("unavailable");
  });

  it("keeps the Demo supplier as demo under any driver", () => {
    expect(decidePlacementMode({ platform: "MOCK", driver: "mock", apiConfigured: false, hasConnectedAccount: false })).toBe("demo");
    expect(decidePlacementMode({ platform: "MOCK", ...every })).toBe("demo");
  });
});

describe("getAdapter without an API connection", () => {
  it("answers AliExpress search and link import with the extension, not invented products", async () => {
    const adapter = getAdapter("ALIEXPRESS");
    expect(adapter).toBeInstanceOf(UnavailableSupplierAdapter);
    expect(adapter.isConfigured()).toBe(false);

    const search = adapter.searchProducts({ query: "watch" });
    await expect(search).rejects.toBeInstanceOf(SupplierError);
    await expect(adapter.searchProducts({ query: "watch" })).rejects.toMatchObject({ code: SUPPLIER_API_UNAVAILABLE });
    await expect(adapter.getProduct("1005006001")).rejects.toThrow(/Chrome extension/);
  });

  it("refuses to place, sync or track, so nothing downstream can mistake silence for success", async () => {
    const adapter = getAdapter("ALIEXPRESS");
    await expect(
      adapter.placeOrder({
        reference: "dh-x",
        items: [{ externalProductId: "1005006001", externalSkuId: "1", quantity: 1 }],
        address: { name: "x", phone: "1", address1: "a", city: "b", countryCode: "US" },
      }),
    ).rejects.toMatchObject({ code: SUPPLIER_API_UNAVAILABLE });
    await expect(adapter.getOrder("8190000000000000")).rejects.toMatchObject({ code: SUPPLIER_API_UNAVAILABLE });
    await expect(adapter.getTracking("8190000000000000")).rejects.toMatchObject({ code: SUPPLIER_API_UNAVAILABLE });
    // No cancel: a local cancel is the honest outcome for an order the app never placed.
    expect(adapter.cancelOrder).toBeUndefined();
  });

  it("still recognises a product link, which the extension's capture route depends on", () => {
    expect(getAdapter("ALIEXPRESS").parseProductReference("https://www.aliexpress.com/item/1005012312204978.html")).toBe("1005012312204978");
  });

  it("serves the Demo supplier only as itself", async () => {
    const demo = getAdapter("MOCK");
    expect(demo.platform).toBe("MOCK");
    expect(demo.simulated).toBe(true);
    const page = await demo.searchProducts({ query: "watch" });
    expect(page.items.length).toBeGreaterThan(0);
  });
});

describe("getAdapter under the live driver", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("no longer falls back to the mock for TEMU or MANUAL", async () => {
    vi.resetModules();
    vi.stubEnv("SUPPLIER_DRIVER", "live");
    const registry = await import("~/services/suppliers/index.server");
    for (const platform of ["TEMU", "MANUAL"] as const) {
      const adapter = registry.getAdapter(platform);
      expect(adapter.platform).toBe(platform);
      expect(adapter.simulated).toBeFalsy();
      await expect(adapter.placeOrder({ reference: "r", items: [], address: { name: "", phone: "", address1: "", city: "", countryCode: "US" } })).rejects.toThrow(
        /Place this order on the supplier's own site/,
      );
    }
    expect(registry.getAdapter("ALIEXPRESS").constructor.name).toBe("AliExpressAdapter");
  });
});

describe("supplierProductUrl", () => {
  it("links an AliExpress item by id when nothing better is stored", () => {
    expect(supplierProductUrl("ALIEXPRESS", "1005006001")).toBe("https://www.aliexpress.com/item/1005006001.html");
    expect(supplierProductUrl("ALIEXPRESS", "1005006001", "https://www.aliexpress.us/item/1005006001.html")).toBe("https://www.aliexpress.us/item/1005006001.html");
  });

  it("never builds a supplier link for demo data or a malformed id", () => {
    expect(supplierProductUrl("MOCK", "1005006001", "https://example.com/x")).toBeNull();
    expect(supplierProductUrl("ALIEXPRESS", "javascript:alert(1)")).toBeNull();
    expect(supplierProductUrl("ALIEXPRESS", null, "javascript:alert(1)")).toBeNull();
  });
});
