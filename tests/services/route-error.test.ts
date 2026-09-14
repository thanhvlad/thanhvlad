/**
 * Which errors the app's error screen explains, and which it must hand to
 * Shopify's own boundary so the admin can finish signing the merchant in.
 */
import { describe, expect, it } from "vitest";
import { isShopifyAuthResponse, summarizeRouteError } from "~/components/route-error";

/** The shape Remix gives an error boundary for a thrown Response. */
function thrown(status: number, data: unknown) {
  return { status, statusText: "", internal: false, data };
}

describe("isShopifyAuthResponse", () => {
  it("recognises the App Bridge bounce page authenticate.admin throws", () => {
    const bounce = `\n      <script data-api-key="abc" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>\n    `;
    expect(isShopifyAuthResponse(thrown(200, bounce))).toBe(true);
  });

  it("recognises the 401 that carries the reauthorize header", () => {
    expect(isShopifyAuthResponse(thrown(401, null))).toBe(true);
  });

  it("leaves the app's own responses and plain errors to the error screen", () => {
    expect(isShopifyAuthResponse(thrown(404, "Not found"))).toBe(false);
    expect(isShopifyAuthResponse(thrown(403, "Your account has read-only access"))).toBe(false);
    expect(isShopifyAuthResponse(new Error("boom"))).toBe(false);
  });
});

describe("summarizeRouteError", () => {
  it("names a missing record", () => {
    expect(summarizeRouteError(thrown(404, "Not found"))).toEqual({ kind: "notFound", status: 404, detail: null });
  });

  it("passes the role message of a 403 through, since it says which role the person has", () => {
    const message = "Your account has read-only access on this store, which does not allow this.";
    expect(summarizeRouteError(thrown(403, message))).toEqual({ kind: "forbidden", status: 403, detail: message });
  });

  it("never shows a thrown Error's message or a 5xx body, which can carry internals", () => {
    expect(summarizeRouteError(new Error("PrismaClientKnownRequestError: relation does not exist"))).toEqual({ kind: "unexpected", status: null, detail: null });
    expect(summarizeRouteError(thrown(500, "stack trace here"))).toEqual({ kind: "unexpected", status: 500, detail: null });
  });

  it("does not echo markup or long bodies", () => {
    expect(summarizeRouteError(thrown(400, "<b>bad</b>")).detail).toBeNull();
    expect(summarizeRouteError(thrown(400, "x".repeat(301))).detail).toBeNull();
  });
});
