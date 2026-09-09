/**
 * Production boot validation.
 *
 * `env()` memoises, so each case runs the schema through a fresh module
 * registry with its own process.env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = { ...process.env };

function withEnv(values: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
  // process.env stringifies whatever it is given, so `undefined` must be a
  // deletion rather than an assignment or it becomes the string "undefined".
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("env() in production", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  const complete = {
    NODE_ENV: "production",
    SHOPIFY_API_KEY: "key",
    SHOPIFY_API_SECRET: "secret",
    SHOPIFY_APP_URL: "https://app.example.com",
    DATABASE_URL: "postgresql://x",
    ENCRYPTION_KEY: "c2VjcmV0",
    SUPPLIER_DRIVER: "mock",
  };

  it("boots with the essentials present", async () => {
    withEnv(complete);
    const { env } = await import("~/lib/env.server");
    expect(env().SHOPIFY_APP_URL).toBe("https://app.example.com");
  });

  it("refuses to boot without an encryption key, naming it", async () => {
    withEnv({ ...complete, ENCRYPTION_KEY: undefined });
    const { env } = await import("~/lib/env.server");
    expect(() => env()).toThrow(/ENCRYPTION_KEY: required in production/);
  });

  it("refuses a non-https app URL and a live driver with no supplier keys", async () => {
    withEnv({ ...complete, SHOPIFY_APP_URL: "http://localhost:3000", SUPPLIER_DRIVER: "live" });
    const { env } = await import("~/lib/env.server");
    expect(() => env()).toThrow(/SHOPIFY_APP_URL: must be the public https URL/);
    expect(() => env()).toThrow(/SUPPLIER_DRIVER: live driver needs/);
  });

  it("keeps development permissive", async () => {
    withEnv({ NODE_ENV: "development", DATABASE_URL: "" });
    const { env } = await import("~/lib/env.server");
    expect(env().SHOPIFY_API_KEY).toBe("");
  });
});
