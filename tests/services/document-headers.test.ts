/**
 * Security headers on HTML documents.
 *
 * The Shopify helper only restricts framing when a request carries `?shop=`, so
 * the public pages and the login form could be framed by anyone. The opposite
 * mistake is worse: `frame-ancestors 'none'` on an embedded page blanks the app
 * inside the admin. Both directions are tested.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { addPublicDocumentHeaders } from "~/entry.server";

vi.mock("~/shopify.server", () => ({ addDocumentResponseHeaders: vi.fn() }));
vi.mock("~/services/jobs/index.server", () => ({ bootJobs: vi.fn() }));
vi.mock("~/lib/logger.server", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function headersFor(url: string, init: { headers?: Record<string, string>; existing?: Record<string, string> } = {}) {
  const headers = new Headers(init.existing);
  addPublicDocumentHeaders(new Request(url, { headers: init.headers }), headers);
  return headers;
}

afterEach(() => vi.unstubAllEnvs());

describe("addPublicDocumentHeaders", () => {
  it("refuses framing of public pages and the login form", () => {
    for (const path of ["/", "/privacy", "/terms", "/support", "/auth/login"]) {
      expect(headersFor(`https://app.test${path}`).get("Content-Security-Policy")).toBe("frame-ancestors 'none';");
    }
  });

  it("keeps the frame-ancestors the Shopify helper set for an embedded request", () => {
    const shopPolicy = "frame-ancestors https://s.myshopify.com https://admin.shopify.com;";
    const headers = headersFor("https://app.test/app?shop=s.myshopify.com", { existing: { "Content-Security-Policy": shopPolicy } });
    expect(headers.get("Content-Security-Policy")).toBe(shopPolicy);
  });

  it("never blocks framing of embedded app and OAuth paths, even without a shop", () => {
    for (const path of ["/app", "/app/orders", "/auth/session-token", "/auth/callback"]) {
      expect(headersFor(`https://app.test${path}`).get("Content-Security-Policy")).toBeNull();
    }
  });

  it("sets nosniff everywhere", () => {
    expect(headersFor("https://app.test/app").get("X-Content-Type-Options")).toBe("nosniff");
    expect(headersFor("https://app.test/privacy").get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sends HSTS only in production over HTTPS, including behind a TLS proxy", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(headersFor("https://app.test/").get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(headersFor("http://app.test/", { headers: { "x-forwarded-proto": "https" } }).get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(headersFor("http://app.test/").get("Strict-Transport-Security")).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    expect(headersFor("https://app.test/").get("Strict-Transport-Security")).toBeNull();
  });
});
