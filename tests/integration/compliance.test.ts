/**
 * The mandatory privacy webhooks and the retention purge, against a real
 * database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ShopWithSettings } from "~/services/shop.server";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.SUPPLIER_DRIVER = "mock";
process.env.REDIS_URL = "";

vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: { admin: async () => ({ admin: { graphql: async () => new Response("{}") }, session: {} }) },
  login: undefined,
  apiVersion: "2026-07",
  addDocumentResponseHeaders: () => undefined,
  registerWebhooks: async () => undefined,
  sessionStorage: {},
  default: {},
}));

function snapshot(id: string, name: string, email: string) {
  return {
    id,
    name,
    orderNumber: Number(name.replace("#", "")),
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    email,
    phone: null,
    note: "Leave at the back door",
    tags: [],
    test: false,
    riskLevel: "LOW",
    currencyCode: "USD",
    totalPrice: "10.00",
    totalShipping: "0.00",
    totalTax: "0.00",
    totalDiscounts: "0.00",
    customer: { firstName: "Ada", lastName: "Lovelace", email, phone: null },
    customAttributes: [],
    shippingAddress: {
      firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace", company: null,
      address1: "12 Analytical Engine Rd", address2: null, city: "London", province: null,
      provinceCode: null, zip: "N1 9GU", country: "United Kingdom", countryCodeV2: "GB",
      phone: "+442071234567",
    },
    lineItems: [
      { id: `${id}-line`, title: "Unmanaged tea", variantTitle: null, sku: null, quantity: 1, unfulfilledQuantity: 1, productId: null, variantId: null, image: null, price: "10.00", totalDiscount: "0", requiresShipping: true },
    ],
  };
}

describe.skipIf(!TEST_DB)("privacy compliance (postgres)", () => {
  let prisma: PrismaClient;
  let shop: ShopWithSettings;
  const stamp = Date.now();
  const email = `ada-${stamp}@example.com`;

  beforeAll(async () => {
    prisma = (await import("~/db.server")).default;
    const { getOrCreateShop } = await import("~/services/shop.server");
    shop = await getOrCreateShop(`gdpr-${stamp}.myshopify.com`);
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    await upsertOrderFromSnapshot(shop, snapshot(`gid://shopify/Order/${stamp}1`, "#7001", email));
    await upsertOrderFromSnapshot(shop, snapshot(`gid://shopify/Order/${stamp}2`, "#7002", email));
    await upsertOrderFromSnapshot(shop, snapshot(`gid://shopify/Order/${stamp}3`, "#7003", `someone-else-${stamp}@example.com`));
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: shop.id } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("answers a data request with an export the merchant can download", async () => {
    const { handleCustomerDataRequest } = await import("~/services/compliance.server");
    const result = await handleCustomerDataRequest(shop, {
      shop_domain: shop.domain,
      customer: { id: 42, email, phone: null },
      orders_requested: [`${stamp}1`],
      data_request: { id: 9 },
    });
    // The named order plus the other one that carries the same email.
    expect(result.orders).toBe(2);

    const row = await prisma.notification.findFirst({ where: { shopId: shop.id, type: "system" }, orderBy: { createdAt: "desc" } });
    expect(row?.title).toBe("Customer data request #9");
    const exported = (row?.meta as { dataRequest: { orders: Array<{ name: string; shippingAddress: { address1?: string } }> } }).dataRequest;
    expect(exported.orders.map((o) => o.name).sort()).toEqual(["#7001", "#7002"]);
    expect(exported.orders[0].shippingAddress.address1).toBe("12 Analytical Engine Rd");
  });

  it("erases personal data on the named orders and nothing else", async () => {
    const { redactCustomer } = await import("~/services/compliance.server");
    const result = await redactCustomer(shop, { customer: { id: 42, email }, orders_to_redact: [`${stamp}1`, `${stamp}2`] });
    expect(result.orders).toBe(2);

    const redacted = await prisma.order.findMany({ where: { shopId: shop.id, name: { in: ["#7001", "#7002"] } } });
    for (const order of redacted) {
      expect(order.customerName).toBeNull();
      expect(order.customerEmail).toBeNull();
      expect(order.phone).toBeNull();
      expect(order.note).toBeNull();
      expect(order.shippingAddress).toEqual({ countryCode: "GB" });
    }
    const untouched = await prisma.order.findFirstOrThrow({ where: { shopId: shop.id, name: "#7003" } });
    expect(untouched.customerName).toBe("Ada Lovelace");
  });

  it("purges stores uninstalled longer than the retention window, sessions included", async () => {
    const { getOrCreateShop, markShopUninstalled } = await import("~/services/shop.server");
    const { purgeUninstalledShops } = await import("~/services/compliance.server");
    const old = await getOrCreateShop(`gdpr-old-${stamp}.myshopify.com`);
    const recent = await getOrCreateShop(`gdpr-recent-${stamp}.myshopify.com`);
    await prisma.session.create({ data: { id: `offline_${old.domain}`, shop: old.domain, state: "", isOnline: false, accessToken: "shpat_x" } });
    await markShopUninstalled(old.domain);
    await markShopUninstalled(recent.domain);
    await prisma.shop.update({ where: { id: old.id }, data: { uninstalledAt: new Date(Date.now() - 40 * 86_400_000) } });
    await prisma.shop.update({ where: { id: recent.id }, data: { uninstalledAt: new Date(Date.now() - 10 * 86_400_000) } });

    const result = await purgeUninstalledShops();
    expect(result.purged).toEqual([old.domain]);
    expect(await prisma.shop.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.session.count({ where: { shop: old.domain } })).toBe(0);
    expect(await prisma.account.findUnique({ where: { id: old.accountId! } })).toBeNull();
    // Inside the window: still there, ready for a reinstall.
    expect(await prisma.shop.findUnique({ where: { id: recent.id } })).not.toBeNull();
    await prisma.shop.delete({ where: { id: recent.id } });
    // The active shop of this test was never uninstalled and is untouched.
    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).not.toBeNull();
  });
});
