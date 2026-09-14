/**
 * The supplier OAuth return (/suppliers/callback/:platform).
 *
 * It is a top-level redirect from AliExpress with no Shopify session. Nested
 * under /app it ran the layout's authenticate.admin and dropped the merchant on
 * the shop-domain login form. Every exit must now be an absolute URL into the
 * shop's admin or a static page, and a state that fails verification must never
 * choose a shop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyOAuthState: vi.fn(),
  connectSupplierAccount: vi.fn(),
  findShop: vi.fn(),
}));

vi.mock("~/services/supplier-accounts.server", () => ({
  verifyOAuthState: mocks.verifyOAuthState,
  connectSupplierAccount: mocks.connectSupplierAccount,
}));
vi.mock("~/db.server", () => ({ default: { shop: { findUnique: mocks.findShop } } }));
vi.mock("~/lib/env.server", () => ({ env: () => ({ SHOPIFY_API_KEY: "key123" }) }));
vi.mock("~/lib/logger.server", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { loader } = await import("~/routes/suppliers.callback.$platform");

const SHOP = { id: "shop_1", domain: "demo.myshopify.com" };
const ADMIN = "https://demo.myshopify.com/admin/apps/key123/app/suppliers?";

function call(query: string, platform = "aliexpress") {
  const request = new Request(`https://app.example.com/suppliers/callback/${platform}?${query}`);
  return loader({ request, params: { platform }, context: {} }) as Promise<Response>;
}

function expectNeverLogin(response: Response) {
  const location = response.headers.get("Location") ?? "";
  expect(location).not.toMatch(/^\/(app|auth)/);
  expect(location).not.toContain("/auth/login");
}

beforeEach(() => {
  mocks.verifyOAuthState.mockReset();
  mocks.connectSupplierAccount.mockReset();
  mocks.findShop.mockReset();
});

describe("supplier OAuth callback", () => {
  it("stores the connection and returns the merchant to Suppliers inside their admin", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "valid", payload: { shopId: SHOP.id, platform: "ALIEXPRESS", nonce: "n", ts: Date.now() } });
    mocks.findShop.mockResolvedValue(SHOP);
    const response = await call("code=abc&state=signed");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ADMIN}connected=1`);
    expect(mocks.connectSupplierAccount).toHaveBeenCalledWith({ shopId: SHOP.id, platform: "ALIEXPRESS", code: "abc", shareAcrossStores: true, oauthNonce: "n" });
  });

  it("does not pick a shop for a state that fails verification, and shows a page without any input", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "invalid" });
    const response = await call("code=abc&state=forged");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: "invalid-state" });
    expect(mocks.findShop).not.toHaveBeenCalled();
    expect(mocks.connectSupplierAccount).not.toHaveBeenCalled();
    expectNeverLogin(response);
  });

  it("sends an expired but authentic state back to that shop's Suppliers page without connecting", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "expired", payload: { shopId: SHOP.id, platform: "ALIEXPRESS", nonce: "n", ts: Date.now() - 3_600_000 } });
    mocks.findShop.mockResolvedValue(SHOP);
    const response = await call("code=abc&state=signed-but-old");
    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location.startsWith(ADMIN)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toMatch(/expired/);
    expect(mocks.findShop).toHaveBeenCalledWith({ where: { id: SHOP.id } });
    expect(mocks.connectSupplierAccount).not.toHaveBeenCalled();
    expectNeverLogin(response);
  });

  it("shows the static page for an expired state whose shop has since been removed", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "expired", payload: { shopId: "gone", platform: "ALIEXPRESS", nonce: "n", ts: 0 } });
    mocks.findShop.mockResolvedValue(null);
    const response = await call("code=abc&state=signed-but-old");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: "shop-not-found" });
  });

  it("shows the static page when the shop has since been removed", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "valid", payload: { shopId: "gone", platform: "ALIEXPRESS", nonce: "n", ts: Date.now() } });
    mocks.findShop.mockResolvedValue(null);
    const response = await call("code=abc&state=signed");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: "shop-not-found" });
  });

  it("sends a declined authorization back to the admin with the supplier's reason", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "valid", payload: { shopId: SHOP.id, platform: "ALIEXPRESS", nonce: "n", ts: Date.now() } });
    mocks.findShop.mockResolvedValue(SHOP);
    const response = await call("error=access_denied&state=signed");
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(ADMIN)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toContain("access_denied");
    expect(mocks.connectSupplierAccount).not.toHaveBeenCalled();
  });

  it("takes the platform from the signed state and refuses a path that disagrees with it", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "valid", payload: { shopId: SHOP.id, platform: "ALIEXPRESS", nonce: "n", ts: Date.now() } });
    mocks.findShop.mockResolvedValue(SHOP);
    const response = await call("code=abc&state=signed", "cj");
    expect(response.headers.get("Location")?.startsWith(ADMIN)).toBe(true);
    expect(mocks.connectSupplierAccount).not.toHaveBeenCalled();
  });

  it("reports a failed token exchange inside the admin, never on a relative /app url", async () => {
    mocks.verifyOAuthState.mockReturnValue({ status: "valid", payload: { shopId: SHOP.id, platform: "ALIEXPRESS", nonce: "n", ts: Date.now() } });
    mocks.findShop.mockResolvedValue(SHOP);
    mocks.connectSupplierAccount.mockRejectedValue(new Error("AliExpress rejected the code"));
    const response = await call("code=abc&state=signed");
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(ADMIN)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toBe("AliExpress rejected the code");
    expectNeverLogin(response);
  });
});
