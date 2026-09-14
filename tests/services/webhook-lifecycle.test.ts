/**
 * Install, uninstall, reinstall and webhook durability.
 *
 * Every case is written from a failure that reached (or would reach) a real
 * store: an uninstall lost to a restart, a late uninstall switching off a store
 * that had reinstalled, a shop/redact erasing a live store, a paid plan
 * surviving an uninstall, a second free trial. The database and Shopify are
 * replaced by in-memory fakes so the rules run without either.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingReturnUrl, paysForAccountPlan, remainingTrialDays } from "~/services/billing.server";
import { generateInviteCode, markShopUninstalled, normalizeInviteCode, reauthenticatedSince, webhookCheckDue } from "~/services/shop.server";
import { failedTopics, pointsAtHost } from "~/services/shopify/webhooks.server";
import { HttpResponseError } from "@shopify/shopify-api";
import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import { classifyInstallProbeError, parseTriggeredAt, processWebhookEvent, sweepPendingWebhooks } from "~/services/webhooks.server";
import { handleWebhookRequest, verifyWebhookDelivery } from "~/lib/webhook-route.server";

// vi.hoisted and vi.mock run before the imports above, so the modules load against these fakes.
const db = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    shop: { findUnique: fn(), update: fn(), updateMany: fn(), count: fn() },
    session: { deleteMany: fn() },
    account: { findUnique: fn(), update: fn(), updateMany: fn() },
    webhookEvent: { create: fn(), findUnique: fn(), findMany: fn(), update: fn(), updateMany: fn() },
    activityLog: { create: fn() },
  };
});

const shopifyMock = vi.hoisted(() => ({
  webhook: vi.fn(),
  unauthenticatedAdmin: vi.fn(),
}));

vi.mock("~/db.server", () => ({ default: db, prisma: db }));
vi.mock("~/shopify.server", () => ({
  authenticate: { webhook: shopifyMock.webhook },
  unauthenticated: { admin: shopifyMock.unauthenticatedAdmin },
  default: {},
}));
vi.mock("~/services/jobs/index.server", () => ({ bootJobs: vi.fn(), enqueue: vi.fn(async () => "job") }));

const DAY = 86_400_000;

beforeEach(() => {
  for (const model of Object.values(db)) for (const mock of Object.values(model)) (mock as ReturnType<typeof vi.fn>).mockReset();
  shopifyMock.webhook.mockReset();
  shopifyMock.unauthenticatedAdmin.mockReset();
});

describe("app/uninstalled against a reinstall", () => {
  const triggeredAt = new Date("2026-09-14T10:00:00Z");

  it("ignores an uninstall triggered before the store's latest token exchange", async () => {
    // The merchant uninstalled at 10:00 and reinstalled at 10:05; the uninstall
    // was only processed at 10:20. It used to delete the fresh sessions and
    // switch the reinstalled store off.
    db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", accountId: "a1", lastAuthAt: new Date("2026-09-14T10:05:00Z") });
    db.shop.update.mockResolvedValue({});
    const done = await markShopUninstalled("a.myshopify.com", { triggeredAt, now: new Date("2026-09-14T10:20:00Z") });
    expect(done).toBe(false);
    expect(db.session.deleteMany).not.toHaveBeenCalled();
    expect(db.shop.updateMany).not.toHaveBeenCalled();
    // Shopify dropped the shop-level subscriptions with the uninstall.
    expect(db.shop.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { webhooksCheckedAt: null } });
  });

  it("uninstalls, drops the sessions and releases the plan the store was paying for", async () => {
    const lastAuthAt = new Date("2026-09-13T08:00:00Z");
    db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", accountId: "a1", lastAuthAt });
    db.shop.updateMany.mockResolvedValue({ count: 1 });
    db.account.findUnique.mockResolvedValue({ id: "a1", plan: "PRO", subscriptionId: "gid://shopify/AppSubscription/1", billingShopId: "s1" });
    db.account.update.mockResolvedValue({});
    const done = await markShopUninstalled("a.myshopify.com", { triggeredAt, now: new Date("2026-09-14T10:00:01Z") });
    expect(done).toBe(true);
    // Conditional on the auth stamp that was read, so a concurrent reinstall wins.
    expect(db.shop.updateMany).toHaveBeenCalledWith({ where: { id: "s1", lastAuthAt }, data: { isActive: false, uninstalledAt: new Date("2026-09-14T10:00:01Z") } });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: "a.myshopify.com" } });
    expect(db.account.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a1" }, data: expect.objectContaining({ plan: "FREE", subscriptionId: null, billingShopId: null }) }),
    );
  });

  it("keeps a sister store's plan when the uninstalled store was not the payer", async () => {
    db.shop.findUnique.mockResolvedValue({ id: "s2", domain: "b.myshopify.com", accountId: "a1", lastAuthAt: null });
    db.shop.updateMany.mockResolvedValue({ count: 1 });
    db.account.findUnique.mockResolvedValue({ id: "a1", plan: "PRO", subscriptionId: "gid://shopify/AppSubscription/1", billingShopId: "s1" });
    await markShopUninstalled("b.myshopify.com", { triggeredAt });
    expect(db.account.update).not.toHaveBeenCalled();
  });

  it("backs off when a token exchange lands while the uninstall is being applied", async () => {
    db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", accountId: "a1", lastAuthAt: null });
    db.shop.updateMany.mockResolvedValue({ count: 0 });
    expect(await markShopUninstalled("a.myshopify.com", { triggeredAt })).toBe(false);
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });

  it("allows for clock skew but not for a real reinstall", () => {
    expect(reauthenticatedSince(null, triggeredAt)).toBe(false);
    expect(reauthenticatedSince(new Date(triggeredAt.getTime() + 5_000), triggeredAt)).toBe(false);
    expect(reauthenticatedSince(new Date(triggeredAt.getTime() + 5 * 60_000), triggeredAt)).toBe(true);
    expect(reauthenticatedSince(new Date(triggeredAt.getTime() - 60_000), triggeredAt)).toBe(false);
  });
});

describe("webhook route durability", () => {
  const args = () => ({ request: new Request("https://app.test/webhooks/orders", { method: "POST", body: "{}" }), params: {}, context: {} });

  it("asks Shopify to redeliver when the event cannot be stored", async () => {
    // It answered 200 here, and Shopify never retries a 200: the event was gone.
    shopifyMock.webhook.mockResolvedValue({ shop: "a.myshopify.com", topic: "CUSTOMERS_REDACT", webhookId: "w1", eventId: "e1", payload: {} });
    db.shop.findUnique.mockResolvedValue(null);
    db.webhookEvent.create.mockRejectedValue(new Error("connection refused"));
    const response = await handleWebhookRequest(args());
    expect(response.status).toBe(500);
  });

  it("stores the event id and trigger time, and acknowledges a duplicate event quietly", async () => {
    shopifyMock.webhook.mockResolvedValue({ shop: "a.myshopify.com", topic: "ORDERS_CANCELLED", webhookId: "w2", eventId: "e2", triggeredAt: "2026-09-14T10:00:00Z", payload: { id: 1 } });
    db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", settings: {} });
    db.webhookEvent.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const response = await handleWebhookRequest(args());
    expect(response.status).toBe(200);
    expect(db.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ shopDomain: "a.myshopify.com", eventId: "e2", triggeredAt: new Date("2026-09-14T10:00:00Z"), webhookId: "w2" }),
    });
  });

  it("does not let a rejected signature through the fallback", async () => {
    shopifyMock.webhook.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(handleWebhookRequest(args())).rejects.toBeInstanceOf(Response);
    expect(db.webhookEvent.create).not.toHaveBeenCalled();
  });
});

describe("independent webhook verification", () => {
  const secret = "shpss_test";
  const body = JSON.stringify({ id: 548380009, name: "Super Toys" });
  const headers = (hmac: string) =>
    new Headers({
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": "app/uninstalled",
      "x-shopify-shop-domain": "a.myshopify.com",
      "x-shopify-webhook-id": "w1",
      "x-shopify-event-id": "e1",
      "x-shopify-triggered-at": "2026-09-14T10:00:00Z",
    });

  it("accepts a correctly signed delivery and names the topic the way the library does", () => {
    const hmac = createHmac("sha256", secret).update(body, "utf8").digest("base64");
    expect(verifyWebhookDelivery(body, headers(hmac), secret)).toEqual({
      shop: "a.myshopify.com",
      topic: "APP_UNINSTALLED",
      webhookId: "w1",
      eventId: "e1",
      triggeredAt: "2026-09-14T10:00:00Z",
      payload: { id: 548380009, name: "Super Toys" },
    });
  });

  it("rejects a tampered body, a wrong secret and a missing signature", () => {
    const hmac = createHmac("sha256", secret).update(body, "utf8").digest("base64");
    expect(verifyWebhookDelivery(`${body} `, headers(hmac), secret)).toBeNull();
    expect(verifyWebhookDelivery(body, headers(hmac), "other")).toBeNull();
    expect(verifyWebhookDelivery(body, headers(""), secret)).toBeNull();
  });
});

describe("processing claim", () => {
  it("does nothing when another attempt holds the event", async () => {
    db.webhookEvent.updateMany.mockResolvedValue({ count: 0 });
    await processWebhookEvent("evt1");
    expect(db.webhookEvent.findUnique).not.toHaveBeenCalled();
  });

  it("finds the store by domain when the event was stored before the Shop row existed", async () => {
    db.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    db.webhookEvent.findUnique.mockResolvedValue({ id: "evt2", topic: "APP_SCOPES_UPDATE", shopId: null, shop: null, shopDomain: "a.myshopify.com", payload: { current: ["read_orders"] }, createdAt: new Date(), attempts: 1 });
    db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", settings: {}, isActive: true });
    db.webhookEvent.update.mockResolvedValue({});
    await processWebhookEvent("evt2");
    expect(db.webhookEvent.updateMany).toHaveBeenCalledWith({ where: { id: "evt2" }, data: { shopId: "s1" } });
    expect(db.webhookEvent.update).toHaveBeenCalledWith({ where: { id: "evt2" }, data: expect.objectContaining({ error: null, lockedUntil: null }) });
  });

  it("reads a missing session, a revoked token or a dead grant as uninstalled, and anything else as unknown", () => {
    // The real classes: the library's SessionNotFoundError never sets `name`,
    // so the name check this replaced matched only a hand-made fake.
    expect(classifyInstallProbeError(new SessionNotFoundError("no session"))).toBe("uninstalled");
    expect(classifyInstallProbeError(Object.assign(new Error("x"), { name: "SessionNotFoundError" }))).toBe("unknown");
    const http = (code: number, body: Record<string, unknown> = {}) => new HttpResponseError({ message: "x", code, statusText: "x", body });
    expect(classifyInstallProbeError(http(401))).toBe("uninstalled");
    expect(classifyInstallProbeError(http(400, { error: "invalid_subject_token" }))).toBe("uninstalled");
    expect(classifyInstallProbeError(http(502))).toBe("unknown");
    // A refused refresh and a network failure both reach us as this.
    expect(classifyInstallProbeError(new Response(null, { status: 500 }))).toBe("unknown");
    expect(classifyInstallProbeError(new Error("ECONNRESET"))).toBe("unknown");
  });
});

describe("recovery sweep", () => {
  it("re-queues unfinished events and survives one that cannot be queued", async () => {
    // The first read is the abandonment pass (nothing expired), the second the candidates.
    db.webhookEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "a", topic: "ORDERS_CREATE", attempts: 0, lastAttemptAt: null },
      { id: "b", topic: "SHOP_REDACT", attempts: 0, lastAttemptAt: null },
      { id: "c", topic: "ORDERS_PAID", attempts: 0, lastAttemptAt: null },
    ]);
    const seen: string[] = [];
    const queued = await sweepPendingWebhooks(async (id) => {
      if (id === "b") throw new Error("queue down");
      seen.push(id);
    });
    expect(queued).toBe(2);
    expect(seen).toEqual(["a", "c"]);
  });

  it("parses the trigger header and ignores garbage", () => {
    expect(parseTriggeredAt("2026-09-14T10:00:00.123Z")?.toISOString()).toBe("2026-09-14T10:00:00.123Z");
    expect(parseTriggeredAt("not a date")).toBeNull();
    expect(parseTriggeredAt(undefined)).toBeNull();
  });
});

describe("billing lifecycle", () => {
  it("counts the trial from the first one the store ever started", () => {
    const now = new Date("2026-09-14T00:00:00Z");
    expect(remainingTrialDays(14, null, now)).toBe(14);
    expect(remainingTrialDays(14, new Date(now.getTime() - 5 * DAY), now)).toBe(9);
    // A reinstall a month later gets no second trial.
    expect(remainingTrialDays(14, new Date(now.getTime() - 30 * DAY), now)).toBe(0);
    expect(remainingTrialDays(0, null, now)).toBe(0);
  });

  it("returns the merchant to the plan page through the API key, not a guessed handle", () => {
    expect(billingReturnUrl("cool-store.myshopify.com", "abc123")).toBe("https://admin.shopify.com/store/cool-store/apps/abc123/app/settings/plan?billing=return");
  });

  it("knows which store is paying", () => {
    expect(paysForAccountPlan({ plan: "PRO", subscriptionId: "sub", billingShopId: "s1" }, "s1")).toBe(true);
    expect(paysForAccountPlan({ plan: "PRO", subscriptionId: "sub", billingShopId: "s1" }, "s2")).toBe(false);
    expect(paysForAccountPlan({ plan: "FREE", subscriptionId: null, billingShopId: null }, "s1")).toBe(false);
  });
});

describe("account invites", () => {
  it("generates codes that survive being retyped", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeInviteCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
    expect(generateInviteCode()).not.toBe(code);
  });

  it("refuses anything that cannot be a code, including an old account id", () => {
    expect(normalizeInviteCode("clx0abc123def456ghi789jk")).toBeNull();
    expect(normalizeInviteCode("ABCD-EFGH-IJK0")).toBeNull();
    expect(normalizeInviteCode("")).toBeNull();
  });
});

describe("afterAuth housekeeping", () => {
  const now = new Date("2026-09-14T12:00:00Z");

  it("verifies webhooks on a new store, after a reinstall and once a day, not on every token exchange", () => {
    expect(webhookCheckDue(null, false, now)).toBe(true);
    expect(webhookCheckDue(new Date(now.getTime() - 60_000), true, now)).toBe(true);
    expect(webhookCheckDue(new Date(now.getTime() - 60_000), false, now)).toBe(false);
    expect(webhookCheckDue(new Date(now.getTime() - 2 * DAY), false, now)).toBe(true);
  });

  it("only counts a topic as registered when every subscription for it succeeded", () => {
    expect(failedTopics({ ORDERS_CREATE: [{ success: true }], ORDERS_PAID: [{ success: false }] })).toEqual(["ORDERS_PAID"]);
    expect(failedTopics(undefined)).toEqual([]);
  });

  it("matches shop-level duplicates by the subscription uri's host", () => {
    expect(pointsAtHost("https://app.example.com/webhooks/orders", "app.example.com")).toBe(true);
    expect(pointsAtHost("https://other.example.com/webhooks", "app.example.com")).toBe(false);
    expect(pointsAtHost(null, "app.example.com")).toBe(false);
    expect(pointsAtHost("pubsub://project:topic", "app.example.com")).toBe(false);
  });
});
