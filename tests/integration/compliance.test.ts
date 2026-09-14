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
    // Seeded directly rather than through upsertOrderFromSnapshot: the tea line
    // is not managed by the app, and such orders no longer keep customer data
    // at all (asserted separately below).
    for (const [suffix, name, mail] of [["1", "#7001", email], ["2", "#7002", email], ["3", "#7003", `someone-else-${stamp}@example.com`]] as const) {
      const s = snapshot(`gid://shopify/Order/${stamp}${suffix}`, name, mail);
      await prisma.order.create({
        data: {
          shopId: shop.id,
          shopifyOrderId: s.id,
          name,
          customerName: "Ada Lovelace",
          customerEmail: mail,
          phone: s.shippingAddress.phone,
          note: s.note,
          countryCode: "GB",
          shippingAddress: { name: "Ada Lovelace", address1: s.shippingAddress.address1, zip: s.shippingAddress.zip, countryCode: "GB", phone: s.shippingAddress.phone },
          issues: [{ code: "INVALID_PHONE", field: "phone", severity: "warning", message: `"${s.shippingAddress.phone}" has 12 digits.` }],
          shopifyCreatedAt: new Date(),
        },
      });
    }
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

  it("erases personal data on the named orders, in every table that holds a copy, and nothing else", async () => {
    const o1 = await prisma.order.findFirstOrThrow({ where: { shopId: shop.id, name: "#7001" } });
    const po = await prisma.purchaseOrder.create({
      data: {
        orderId: o1.id,
        platform: "CJ_DROPSHIPPING",
        status: "FAILED",
        raw: { externalOrderIds: ["CJ-1"], response: { consignee: "Ada Lovelace", phone: "442071234567" } },
        errorMessage: "Consignee Ada Lovelace rejected",
        items: { create: [{ title: "Unmanaged tea", quantity: 1 }] },
        trackings: { create: [{ number: `LP${stamp}`, syncError: "Refused for Ada Lovelace" }] },
      },
    });
    await prisma.fulfillmentRequest.create({ data: { orderId: o1.id, shopifyFulfillmentOrderId: `gid://shopify/FulfillmentOrder/${stamp}`, requestMessage: "Gift for Ada", responseMessage: "Not fulfillable yet: \"+442071234567\" has 12 digits" } });
    await prisma.activityLog.create({ data: { shopId: shop.id, action: "order.place_failed", entity: "Order", entityId: o1.id, message: "#7001: receiver Ada Lovelace, 12 Analytical Engine Rd" } });
    await prisma.notification.create({ data: { shopId: shop.id, type: "order.failed", title: "#7001 failed", body: "Phone +442071234567 rejected", link: `/app/orders/${o1.id}` } });
    await prisma.webhookEvent.create({ data: { shopId: shop.id, topic: "ORDERS_CREATE", webhookId: `gdpr-${stamp}-1`, processedAt: new Date(), payload: { id: Number(`${stamp}1`), email, shipping_address: { name: "Ada Lovelace", address1: "12 Analytical Engine Rd" } } } });

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
      expect(JSON.stringify(order.issues)).not.toContain("2071234567");
    }
    const copies = JSON.stringify([
      await prisma.purchaseOrder.findUnique({ where: { id: po.id }, include: { items: true, trackings: true } }),
      await prisma.fulfillmentRequest.findMany({ where: { orderId: o1.id } }),
      await prisma.activityLog.findMany({ where: { shopId: shop.id } }),
      await prisma.notification.findMany({ where: { shopId: shop.id } }),
      await prisma.webhookEvent.findMany({ where: { shopId: shop.id } }),
    ]);
    for (const trace of ["Ada", "Lovelace", "Analytical", "2071234567", email]) expect(copies).not.toContain(trace);
    const untouched = await prisma.order.findFirstOrThrow({ where: { shopId: shop.id, name: "#7003" } });
    expect(untouched.customerName).toBe("Ada Lovelace");
  });

  it("stores no customer data for an order with nothing the app manages", async () => {
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    const order = await upsertOrderFromSnapshot(shop, snapshot(`gid://shopify/Order/${stamp}4`, "#7004", email));
    expect(order.stage).toBe("IGNORED");
    expect(order.customerName).toBeNull();
    expect(order.customerEmail).toBeNull();
    expect(JSON.stringify(order.shippingAddress)).not.toContain("Analytical");
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
