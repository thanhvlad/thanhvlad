/**
 * What happens on install, against a real database and the fake Admin API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createFakeShopify, type FakeShopify } from "./fake-shopify";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.SUPPLIER_DRIVER = "mock";
process.env.REDIS_URL = "";

const fake: FakeShopify = createFakeShopify();

vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: { admin: async () => ({ admin: { graphql: fake.client }, session: {} }) },
  login: undefined,
  apiVersion: "2026-07",
  addDocumentResponseHeaders: () => undefined,
  registerWebhooks: async () => undefined,
  sessionStorage: {},
  default: {},
}));

describe.skipIf(!TEST_DB)("install (postgres + fake Shopify)", () => {
  let prisma: PrismaClient;
  const domain = `install-${Date.now()}.myshopify.com`;
  let shopId = "";

  beforeAll(async () => {
    prisma = (await import("~/db.server")).default;
  });

  afterAll(async () => {
    if (shopId) await prisma.shop.delete({ where: { id: shopId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("records the store profile, flags a development store and queues a 30-day order backfill", async () => {
    const { onShopInstalled } = await import("~/services/shop.server");
    const session = { shop: domain } as unknown as Parameters<typeof onShopInstalled>[0]["session"];
    const admin = { graphql: fake.client } as unknown as Parameters<typeof onShopInstalled>[0]["admin"];
    await onShopInstalled({ session, admin });

    const shop = await prisma.shop.findUniqueOrThrow({ where: { domain } });
    shopId = shop.id;
    expect(shop.name).toBe("Test Store");
    expect(shop.currency).toBe("USD");
    // The fake reports a partner development store, so billing runs in test mode.
    expect(shop.isDevelopmentStore).toBe(true);
    expect(shop.isActive).toBe(true);

    const runs = await prisma.jobRun.findMany({ where: { shopId: shop.id, type: "sync-orders" } });
    expect(runs).toHaveLength(1);
    expect(runs[0].payload).toMatchObject({ days: 30, reason: "install" });

    // A second auth (token refresh, reinstall) must not queue a second sync.
    await onShopInstalled({ session, admin });
    expect(await prisma.jobRun.count({ where: { shopId: shop.id, type: "sync-orders" } })).toBe(1);
  });

  it("only backfills a store with no orders", async () => {
    const { onShopInstalled, getShopById } = await import("~/services/shop.server");
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    const shop = (await getShopById(shopId))!;
    await prisma.jobRun.deleteMany({ where: { shopId, type: "sync-orders" } });
    await upsertOrderFromSnapshot(shop, {
      id: `gid://shopify/Order/${Date.now()}`,
      name: "#1",
      orderNumber: 1,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      email: null,
      phone: null,
      note: null,
      tags: [],
      test: false,
      riskLevel: "LOW",
      currencyCode: "USD",
      totalPrice: "1.00",
      totalShipping: "0.00",
      totalTax: "0.00",
      totalDiscounts: "0.00",
      customer: null,
      customAttributes: [],
      shippingAddress: null,
      lineItems: [],
    });
    const session = { shop: domain } as unknown as Parameters<typeof onShopInstalled>[0]["session"];
    const admin = { graphql: fake.client } as unknown as Parameters<typeof onShopInstalled>[0]["admin"];
    await onShopInstalled({ session, admin });
    expect(await prisma.jobRun.count({ where: { shopId, type: "sync-orders" } })).toBe(0);
  });
});
