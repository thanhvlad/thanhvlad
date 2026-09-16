/**
 * Notification emails against a real database, with the wire stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

async function eventually(check: () => Promise<boolean>, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!TEST_DB)("notification emails (postgres)", () => {
  let prisma: PrismaClient;
  let shop: ShopWithSettings;
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  let failNext = false;

  beforeAll(async () => {
    prisma = (await import("~/db.server")).default;
    const { getOrCreateShop, updateShopSettings, getShopById } = await import("~/services/shop.server");
    const { mergeShopSettings } = await import("~/domain/settings/shop-settings");
    const { __setEmailSenderForTests } = await import("~/services/email.server");
    __setEmailSenderForTests(async (message) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: "relay down" };
      }
      sent.push({ to: message.to, subject: message.subject, text: message.text });
      return { ok: true, id: `m${sent.length}` };
    });
    shop = await getOrCreateShop(`email-${Date.now()}.myshopify.com`);
    await prisma.shop.update({ where: { id: shop.id }, data: { name: "Email Demo", timezone: "Asia/Ho_Chi_Minh" } });
    await updateShopSettings(shop.id, mergeShopSettings(shop.settings, { notifications: { email: "owner@example.com", onOrderFailed: true, onPriceChange: false, digest: false } }));
    shop = (await getShopById(shop.id))!;
  });

  afterEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    const { __setEmailSenderForTests } = await import("~/services/email.server");
    __setEmailSenderForTests(null);
    await prisma.shop.delete({ where: { id: shop.id } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("emails an instant notification the merchant opted into, and only that", async () => {
    const { notify } = await import("~/services/notifications.server");
    const failed = await notify(shop.id, { type: "order.failed", severity: "warning", title: "#2001 could not be placed", body: "Out of stock", link: "/app/orders/x" });
    const price = await notify(shop.id, { type: "price.changed", title: "Watch: 1 price updated" });
    expect(await eventually(async () => Boolean((await prisma.notification.findUnique({ where: { id: failed!.id } }))?.emailedAt))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "owner@example.com", subject: "[Email Demo] #2001 could not be placed" });
    expect(sent[0].text).toContain("/app/orders/x");
    // Price changes are switched off, so that one stays in the feed only.
    expect((await prisma.notification.findUnique({ where: { id: price!.id } }))?.emailedAt).toBeNull();
  });

  it("hands a failed send back to the next run", async () => {
    const { notify } = await import("~/services/notifications.server");
    failNext = true;
    const row = await notify(shop.id, { type: "order.failed", severity: "warning", title: "#2002 could not be placed" });
    // The stamp is applied first, then cleared when the relay refuses.
    await new Promise((r) => setTimeout(r, 300));
    expect((await prisma.notification.findUnique({ where: { id: row!.id } }))?.emailedAt).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("collects a day's notifications into one digest at the shop's morning hour", async () => {
    const { updateShopSettings, getShopById } = await import("~/services/shop.server");
    const { mergeShopSettings } = await import("~/domain/settings/shop-settings");
    await updateShopSettings(shop.id, mergeShopSettings(shop.settings, { notifications: { digest: true } }));
    shop = (await getShopById(shop.id))!;
    const { notify, sendDigest } = await import("~/services/notifications.server");
    await notify(shop.id, { type: "order.failed", severity: "warning", title: "#2003 could not be placed" });
    await notify(shop.id, { type: "supplier.auth", severity: "critical", title: "Reconnect AliExpress" });
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(0);

    const digestShop = { id: shop.id, name: shop.name, domain: shop.domain, settings: shop.settings, timezone: "Asia/Ho_Chi_Minh" };
    // 01:00 UTC is 08:00 in Ho Chi Minh City.
    const notYet = await sendDigest(digestShop, new Date("2026-09-08T00:00:00Z"));
    expect(notYet).toEqual({ sent: false, count: 0 });
    const result = await sendDigest(digestShop, new Date("2026-09-08T01:00:00Z"));
    expect(result.sent).toBe(true);
    // #2002 (whose send failed earlier) rides along; the price change does not.
    expect(result.count).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("[Email Demo] Daily digest: 3 notification(s)");
    expect(sent[0].text).toContain("Reconnect AliExpress");

    // Nothing left for the next morning.
    expect(await sendDigest(digestShop, new Date("2026-09-09T01:00:00Z"))).toEqual({ sent: false, count: 0 });
  });
});
