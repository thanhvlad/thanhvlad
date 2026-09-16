/**
 * The AliExpress OAuth return URL.
 *
 * The callback route moved out of the /app layout to /suppliers/callback/:platform,
 * because under /app the layout's Shopify authentication answered AliExpress's
 * session-less redirect with the login page. The adapter's default must point at
 * the route that exists, or switching OAuth on without ALIEXPRESS_REDIRECT_URI
 * sends every merchant to a 404.
 */
import { describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  values: {
    SHOPIFY_APP_URL: "https://dropship.example.com/",
    ALIEXPRESS_APP_KEY: "12345",
    ALIEXPRESS_APP_SECRET: "secret",
    ALIEXPRESS_API_BASE: "https://api-sg.aliexpress.com/sync",
    ALIEXPRESS_AUTH_BASE: "https://api-sg.aliexpress.com/oauth",
  } as Record<string, string | undefined>,
}));

vi.mock("~/lib/env.server", () => ({ env: () => config.values, isProduction: () => false, isTest: () => true }));

const { AliExpressAdapter } = await import("~/services/suppliers/aliexpress.server");

function redirectUri(): string | null {
  return new URL(new AliExpressAdapter().getAuthorizationUrl("signed-state")).searchParams.get("redirect_uri");
}

describe("AliExpress OAuth redirect URI", () => {
  it("defaults to the callback route outside the /app layout, without a doubled slash", () => {
    config.values.ALIEXPRESS_REDIRECT_URI = undefined;
    expect(redirectUri()).toBe("https://dropship.example.com/suppliers/callback/aliexpress");
  });

  it("uses ALIEXPRESS_REDIRECT_URI exactly when the operator sets it", () => {
    config.values.ALIEXPRESS_REDIRECT_URI = "https://other.example.com/suppliers/callback/aliexpress";
    expect(redirectUri()).toBe("https://other.example.com/suppliers/callback/aliexpress");
  });
});
