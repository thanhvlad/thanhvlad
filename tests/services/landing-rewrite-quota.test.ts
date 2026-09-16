import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AiLanding from "~/services/ai-landing.server";
import type { ShopWithSettings } from "~/services/shop.server";

/**
 * The monthly allowance and the store brand around one rewrite, with the
 * database, Shopify and the model replaced. What is under test is the order of
 * things: the allowance is taken before any model call, given back only when
 * no completion can have been produced, and the page is written for this
 * store's brand with pages signed by another brand kept out of the examples.
 *
 * The raw SQL only ever runs against Postgres in production, so these tests
 * assert the statement text and its bound limit rather than trusting a fake
 * that would accept any query.
 */

const db = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  update: vi.fn(),
}));
const model = vi.hoisted(() => ({ rewrite: vi.fn() }));
const shopify = vi.hoisted(() => ({ gql: vi.fn() }));
const appEnv = vi.hoisted(() => ({ AI_UNMETERED_SHOP_DOMAINS: "", AI_MAPPING_MODEL: "claude-opus-5" }));

vi.mock("~/db.server", () => ({
  default: {
    $executeRaw: db.executeRaw,
    importedProduct: { update: db.update, findMany: vi.fn(async () => []) },
    aiRewriteUsage: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("~/lib/env.server", () => ({ env: () => appEnv }));
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
  const actual = await importOriginal<typeof AiLanding>();
  return { ...actual, aiLandingAvailable: () => true, rewriteLandingPage: model.rewrite };
});

const { getAiRewriteAllowance, rewriteImportedProduct } = await import("~/services/landing-rewrite.server");

const shop = { id: "s1", accountId: "acc1", domain: "harbor.myshopify.com", name: "Harbor & Pine", currency: "USD" } as unknown as ShopWithSettings;

const lumoraPage = '<div style="max-width:1080px"><p>x</p><div style="text-align:center;padding:26px 0 6px"><p>Lumora Loves</p><p>Home &amp; lifestyle pieces.</p></div></div>';
const ownPage = '<div style="max-width:1080px"><p>y</p><div style="text-align:center;padding:26px 0 6px"><p>Harbor &amp; Pine</p></div></div>';

const apiError = (status: number) => new Anthropic.APIError(status, undefined, `status ${status}`, new Headers());

/** The SQL text of the nth $executeRaw call, with each bound value shown as "?". */
function sqlOf(call: number): string {
  return (db.executeRaw.mock.calls[call][0] as TemplateStringsArray).join("?").replace(/\s+/g, " ");
}

const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;

beforeEach(() => {
  db.executeRaw.mockReset();
  db.update.mockReset();
  model.rewrite.mockReset();
  shopify.gql.mockReset();
  shopify.gql.mockResolvedValue({ shop: { name: "Harbor & Pine", contactEmail: "hello@harborpine.com" } });
});

afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
  appEnv.AI_UNMETERED_SHOP_DOMAINS = "";
});

describe("rewriteImportedProduct allowance", () => {
  it("makes no model call once the month's allowance is used", async () => {
    db.executeRaw.mockResolvedValueOnce(0);
    const outcome = await rewriteImportedProduct(shop, "ip1", { examples: [] });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/allowance is used up/);
    expect(model.rewrite).not.toHaveBeenCalled();
  });

  it("reserves with a conditional upsert bound to the plan's limit", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("stop here"));
    await rewriteImportedProduct(shop, "ip1", { examples: [] });
    expect(sqlOf(0)).toContain(
      'ON CONFLICT ("ownerKey", "period") DO UPDATE SET "used" = "AiRewriteUsage"."used" + 1, "updatedAt" = NOW() WHERE "AiRewriteUsage"."used" < ?',
    );
    const values = db.executeRaw.mock.calls[0].slice(1);
    // id, ownerKey, period, then the limit: the free plan's three.
    expect(values[1]).toBe("acc1");
    expect(values[values.length - 1]).toBe(3);
  });

  it("gives the rewrite back when a gateway refused the request before the model ran", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.net/v1";
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      db.executeRaw.mockReset();
      db.executeRaw.mockResolvedValue(1);
      model.rewrite.mockRejectedValueOnce(apiError(status));
      await rewriteImportedProduct(shop, "ip1", { examples: [] });
      // One reservation, one release.
      expect(db.executeRaw, `gateway ${status}`).toHaveBeenCalledTimes(2);
      expect(sqlOf(1)).toContain('UPDATE "AiRewriteUsage" SET "used" = GREATEST("used" - 1, 0)');
    }
  });

  it("keeps the rewrite counted when a gateway answers with a server fault, since the model may have run", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.net/v1";
    for (const status of [500, 502, 504, 524, 529]) {
      db.executeRaw.mockReset();
      db.executeRaw.mockResolvedValue(1);
      model.rewrite.mockRejectedValueOnce(apiError(status));
      await rewriteImportedProduct(shop, "ip1", { examples: [] });
      expect(db.executeRaw, `gateway ${status}`).toHaveBeenCalledTimes(1);
    }
  });

  it("gives back Anthropic's own 500 and 529 but not its 504", async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    for (const [status, calls] of [[500, 2], [529, 2], [504, 1], [429, 2]] as const) {
      db.executeRaw.mockReset();
      db.executeRaw.mockResolvedValue(1);
      model.rewrite.mockRejectedValueOnce(apiError(status));
      await rewriteImportedProduct(shop, "ip1", { examples: [] });
      expect(db.executeRaw, `direct ${status}`).toHaveBeenCalledTimes(calls);
    }
  });

  it("keeps the rewrite counted when the model answered and the answer was unusable", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("The endpoint returned no JSON object."));
    await rewriteImportedProduct(shop, "ip1", { examples: [] });
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("unmetered shops", () => {
  it("rewrites a listed shop past its plan's limit and still records the use", async () => {
    appEnv.AI_UNMETERED_SHOP_DOMAINS = "other.myshopify.com, HARBOR.myshopify.com";
    // A conditional reservation would be refused; the unmetered one must not ask.
    db.executeRaw.mockResolvedValue(0);
    model.rewrite.mockRejectedValueOnce(new Error("stop here"));
    const outcome = await rewriteImportedProduct(shop, "ip1", { examples: [] });
    expect(model.rewrite).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBe("stop here");
    expect(sqlOf(0)).toContain('ON CONFLICT ("ownerKey", "period") DO UPDATE SET "used" = "AiRewriteUsage"."used" + 1');
    expect(sqlOf(0)).not.toContain("WHERE");
  });

  it("reports an unlimited allowance for a listed shop only", async () => {
    appEnv.AI_UNMETERED_SHOP_DOMAINS = "harbor.myshopify.com";
    expect(await getAiRewriteAllowance(shop)).toMatchObject({ limit: null, remaining: null });
    appEnv.AI_UNMETERED_SHOP_DOMAINS = "1szvp0-4u.myshopify.com";
    expect(await getAiRewriteAllowance(shop)).toMatchObject({ limit: 3, remaining: 3 });
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

  it("prints the merchant's own support address over Shopify's", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("stop here"));
    // A different shop id, so the five-minute brand cache from earlier tests does not answer.
    const withSetting = { ...shop, id: "s2", parsedSettings: { products: { storefrontSupportEmail: "care@harborpine.com" } } } as unknown as ShopWithSettings;
    await rewriteImportedProduct(withSetting, "ip1", { examples: [] });
    expect(model.rewrite.mock.calls[0][0].brand.supportEmail).toBe("care@harborpine.com");
  });

  it("uses no address when the merchant set none and Shopify has none", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("stop here"));
    shopify.gql.mockResolvedValue({ shop: { name: "Harbor & Pine", contactEmail: "" } });
    const noEmail = { ...shop, id: "s3", parsedSettings: { products: { storefrontSupportEmail: "" } } } as unknown as ShopWithSettings;
    const oldOwnPage = ownPage.replace("<p>y</p>", '<p><a href="mailto:old@harborpine.com">old</a></p>');
    await rewriteImportedProduct(noEmail, "ip1", { examples: [{ title: "Old own page", descriptionHtml: oldOwnPage }] });
    expect(model.rewrite.mock.calls[0][0].brand.supportEmail).toBeNull();
  });

  it("keeps the first two examples that fit the brand, not the first two fetched", async () => {
    db.executeRaw.mockResolvedValue(1);
    model.rewrite.mockRejectedValueOnce(new Error("stop here"));
    await rewriteImportedProduct(shop, "ip1", {
      examples: [
        { title: "Lumora 1", descriptionHtml: lumoraPage },
        { title: "Lumora 2", descriptionHtml: lumoraPage },
        { title: "Own 1", descriptionHtml: ownPage },
        { title: "Own 2", descriptionHtml: ownPage },
        { title: "Own 3", descriptionHtml: ownPage },
      ],
    });
    expect(model.rewrite.mock.calls[0][0].examples.map((e: { title: string }) => e.title)).toEqual(["Own 1", "Own 2"]);
  });
});
