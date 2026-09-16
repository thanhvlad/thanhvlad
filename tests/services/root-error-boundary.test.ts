/**
 * The root error boundary: the page shown for a public route that fails or a
 * URL that matches nothing.
 *
 * Without it Remix rendered its unstyled "Application Error" page, which can
 * include a stack trace. It must explain the error in both languages, never
 * print server text for a 5xx or a thrown Error, and still hand the Shopify
 * library's own responses to the library so a sign-in can finish.
 */
import type * as RemixReact from "@remix-run/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("@remix-run/react", async (importOriginal) => {
  const actual = await importOriginal<typeof RemixReact>();
  return {
    ...actual,
    useRouteError: () => state.error,
    useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  };
});

const { ErrorBoundary, meta } = await import("~/root");

/** The shape Remix gives an error boundary for a thrown Response. */
class ErrorResponseImpl {
  internal = false;
  statusText = "";
  status: number;
  data: unknown;
  constructor(status: number, data: unknown) {
    this.status = status;
    this.data = data;
  }
}

function render(error: unknown): string {
  state.error = error;
  return renderToString(createElement(ErrorBoundary));
}

beforeEach(() => {
  state.error = null;
});

describe("root ErrorBoundary", () => {
  it("names a missing page in English and Vietnamese and links back to the public page", () => {
    const html = render(new ErrorResponseImpl(404, "Not Found"));
    expect(html).toContain("This page does not exist");
    expect(html).toContain("Trang này không tồn tại");
    expect(html).toContain('href="/"');
    expect(html).toContain("Error 404");
    // The app's not-found body talks about its own lists; it does not belong on a public page.
    expect(html).not.toContain("open it from the list");
  });

  it("explains an unexpected failure in both languages without printing the error itself", () => {
    const html = render(new Error("connect ECONNREFUSED 10.0.0.5:5432 at PrismaClient"));
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Không tải được trang này");
    expect(html).toContain("Try again");
    expect(html).not.toContain("ECONNREFUSED");
    expect(html).not.toContain("PrismaClient");
  });

  it("never shows the body of a 5xx response", () => {
    const html = render(new ErrorResponseImpl(500, "relation \"Shop\" does not exist"));
    expect(html).toContain("Error 500");
    expect(html).not.toContain("does not exist\"");
    expect(html).not.toContain("relation");
  });

  it("hands the App Bridge bounce page to Shopify's boundary so sign-in can finish", () => {
    const bounce = `<script data-api-key="abc" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
    const html = render(new ErrorResponseImpl(200, bounce));
    expect(html).toContain('data-api-key="abc"');
    expect(html).not.toContain("Something went wrong");
  });

  it("describes the app without claiming it places or syncs orders by itself", () => {
    const description = (meta({} as Parameters<typeof meta>[0]) as Array<{ name?: string; content?: string }>).find((m) => m.name === "description");
    expect(description?.content).toContain("Chrome extension");
    expect(description?.content).not.toMatch(/in bulk|automatic|sync tracking/i);
  });
});
