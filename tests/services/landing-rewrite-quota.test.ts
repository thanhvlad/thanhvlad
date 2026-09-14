import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopWithSettings } from "~/services/shop.server";

/**
 * The monthly allowance and the store brand around one rewrite, with the
 * database, Shopify and the model replaced. What is under test is the order of
 * things: the allowance is taken before any model call, given back only when
 * the endpoint refused the request, and the page is written for this store's
 * brand with pages signed by another brand kept out of the examples.
 */

const db = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  update: vi.fn(),
}));
const model = vi.hoisted(() => ({ rewrite: vi.fn() }));
const shopify = vi.hoisted(() => ({ gql: vi.fn() }));

vi.mock("~/db.server", () => ({
  default: {
    $executeRaw: db.executeRaw,
    importedProduct: { update: db.update, findMany: vi.fn(async () => []) },
    aiRewriteUsage: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("~/services/activity.server", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("~/services/billing.server", () => ({ currentPlan: vi.fn(async () => "FREE") }));
vi.mock("~/services/shopify/graphql.server", () => ({ offlineClient: vi.fn(async () => ({})), gql: shopify.gql }));
vi.mock("~/services/import.server", () => ({
  getImportedProduct: vi.fn(async () => ({
    id: "ip1",
    title: "Supplier title",
    description: "<p>raw</p>",
    images: ["https://cdn.shopify.com/a.jpg"],
    options: ["Color"],
    supplierProduct: { title: "Supplier title", currency: "USD", storeName: "Factory Store", images: [], variants: [{ attributes: [{ name: "Color", value: "Red" }], price: "3.00", stock: 10 }] },
  })),
}));
vi.mock("~/services/ai-landing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/ai-landing.server")>();
  return { ...actual, aiLandingAvailable: () => true, rewriteLandingPage: model.rewrite };
});

const { rewriteImportedProduct } = await import("~/services/landing-rewrite.server");

const shop = { id: "s1", accountId: "acc1", domain: "harbor.myshopify.com", name: "Harbor & Pine", currency: "USD" } as unknown as ShopWithSettings;

const lumoraPage = '<div style="max-width:1080px"><p>x</p><div style="text-align:center;padding:26px 0 6px"><p>Lumora Loves</p><p>Home &amp; lifestyle pieces.</p></div></div>';
const ownPage = '<div style="max-width:1080px"><p>y</p><div style="text-align:center;padding:26px 0 6px"><p>Harbor &amp; Pine</p></div></div>';

beforeEach(() => {
  db.executeRaw.mockReset();
  db.update.mockReset();
  model.rewrite.mockReset();
  shopify.gql.mockReset();
  shopify.gql.mockResolvedValue({ shop: { name: "Harbor & Pine", contactEmail: "hello@harborpine.com" } });
});

describe("rewriteImportedProduct allowance", () => {
  it("makes no model call once the month's allowance is used", async () => {
    db.executeRaw.mockResolvedValueOnce(0);
    const outcome = await rewriteImportedProduct(shop, "ip1", { examples: [] });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/allowance is used up/);
    expect(model.rewrite).not.toHaveBeenCalled();
  });

  it("gives the rewrite back when the endpoint refused the request", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Anthropic.APIError(429, undefined, "rate limited", new Headers()));
    await rewriteImportedProduct(shop, "ip1", { examples: [] });
    // One reservation, one release.
    expect(db.executeRaw).toHaveBeenCalledTimes(2);
    expect(String(db.executeRaw.mock.calls[1][0].join("?"))).toContain("GREATEST");
  });

  it("keeps the rewrite counted when the model answered and the answer was unusable", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("The endpoint returned no JSON object."));
    await rewriteImportedProduct(shop, "ip1", { examples: [] });
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("rewriteImportedProduct brand", () => {
  it("writes for this store and keeps another brand's pages out of the examples", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("stop here"));
    await rewriteImportedProduct(shop, "ip1", {
      examples: [
        { title: "Lumora page", descriptionHtml: lumoraPage },
        { title: "Own page", descriptionHtml: ownPage },
      ],
    });
    const input = model.rewrite.mock.calls[0][0];
    expect(input.brand).toEqual({ name: "Harbor & Pine", supportEmail: "hello@harborpine.com", signOffTagline: null });
    expect(input.examples.map((e: { title: string }) => e.title)).toEqual(["Own page"]);
  });
});
