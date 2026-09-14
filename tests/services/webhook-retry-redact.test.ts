/**
 * Round-2 lifecycle rules: how long a stored webhook is retried and what
 * happens when it is given up on, how shop/redact decides between a lost
 * uninstall and a reinstall, how a server clock running fast is kept from
 * cancelling a real uninstall, and what an order cancellation does to purchase
 * orders waiting for the Chrome extension.
 *
 * Where a rule is a database query, the exact where clause is asserted rather
 * than run through a fake: a wrong column or a NOT that silently drops NULL
 * rows would pass a forgiving fake and fail in Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "~/lib/logger.server";
import { markShopUninstalled, REAUTH_MARGIN_MS, reauthenticatedSince } from "~/services/shop.server";
import {
  abandonExpiredWebhooks,
  clockLeadFromSamples,
  COMPLIANCE_TOPICS,
  expiredWebhookFilter,
  pendingWebhookFilter,
  processWebhookEvent,
  SHOP_REDACT_DELAY_MS,
  SHOP_REDACT_MARGIN_MS,
  shopRedactDecision,
  sweepPendingWebhooks,
  WEBHOOK_ABANDONED_PREFIX,
  webhookRetryDelayMs,
  webhookRetryDue,
} from "~/services/webhooks.server";

const db = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    shop: { findUnique: fn(), update: fn(), updateMany: fn(), count: fn() },
    session: { deleteMany: fn() },
    account: { findUnique: fn(), update: fn(), updateMany: fn() },
    webhookEvent: { create: fn(), findUnique: fn(), findMany: fn(), update: fn(), updateMany: fn() },
    activityLog: { create: fn() },
    purchaseOrder: { findMany: fn() },
  };
});

const services = vi.hoisted(() => ({
  redactShop: vi.fn(),
  cancelPurchaseOrder: vi.fn(),
  refreshOrderFromShopify: vi.fn(),
}));

vi.mock("~/db.server", () => ({ default: db, prisma: db }));
vi.mock("~/shopify.server", () => ({ authenticate: {}, unauthenticated: { admin: vi.fn() }, default: {} }));
vi.mock("~/services/jobs/index.server", () => ({ bootJobs: vi.fn(), enqueue: vi.fn(async () => "job") }));
vi.mock("~/services/compliance.server", () => ({
  redactShop: services.redactShop,
  redactCustomer: vi.fn(),
  handleCustomerDataRequest: vi.fn(),
}));
vi.mock("~/services/fulfillment.server", () => ({ cancelPurchaseOrder: services.cancelPurchaseOrder }));
vi.mock("~/services/orders.server", () => ({ refreshOrderFromShopify: services.refreshOrderFromShopify }));
vi.mock("~/services/shopify/graphql.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/services/shopify/graphql.server")>()),
  offlineClient: vi.fn(async () => vi.fn()),
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeEach(() => {
  for (const model of Object.values(db)) for (const mock of Object.values(model)) (mock as ReturnType<typeof vi.fn>).mockReset();
  for (const mock of Object.values(services)) mock.mockReset();
  vi.restoreAllMocks();
});

/** A stored event as findUnique returns it after a successful claim. */
function storedEvent(topic: string, extra: Record<string, unknown> = {}) {
  return { id: "evt", topic, shopId: "s1", shop: { domain: "a.myshopify.com" }, shopDomain: "a.myshopify.com", payload: {}, createdAt: new Date(), triggeredAt: null, attempts: 1, processedAt: null, ...extra };
}

function claimed(event: ReturnType<typeof storedEvent>, shop: Record<string, unknown>) {
  db.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
  db.webhookEvent.findUnique.mockResolvedValue(event);
  db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", accountId: "a1", settings: {}, isActive: true, lastAuthAt: null, ...shop });
  db.webhookEvent.update.mockResolvedValue({});
}

describe("shop/redact against a reinstall", () => {
  const uninstalledAt = new Date("2026-09-12T10:00:00Z");
  const redactTriggeredAt = new Date(uninstalledAt.getTime() + SHOP_REDACT_DELAY_MS);

  it("erases a store still marked active whose uninstall was lost", async () => {
    // The app/uninstalled never arrived, so the store is still active, and its
    // last sign-in was two days before the uninstall. The Shopify probe this
    // replaced read the expired token as "unknown" and retried until it gave
    // up, so the store was never erased.
    claimed(storedEvent("SHOP_REDACT", { triggeredAt: redactTriggeredAt, createdAt: new Date(redactTriggeredAt.getTime() + 1_000) }), {
      isActive: true,
      lastAuthAt: new Date("2026-09-10T09:00:00Z"),
    });
    db.webhookEvent.findMany.mockResolvedValue([{ createdAt: new Date(redactTriggeredAt.getTime() + 1_000), triggeredAt: redactTriggeredAt }]);
    await processWebhookEvent("evt");
    expect(services.redactShop).toHaveBeenCalledTimes(1);
    expect(db.webhookEvent.update).not.toHaveBeenCalled();
  });

  it("skips a late redact for a store that reinstalled after the uninstall it refers to", async () => {
    // Uninstalled at 10:00, reinstalled at 10:30, and the redact was only
    // processed a day after it was triggered, on a retry.
    claimed(storedEvent("SHOP_REDACT", { triggeredAt: redactTriggeredAt, createdAt: new Date(redactTriggeredAt.getTime() + DAY) }), {
      isActive: true,
      lastAuthAt: new Date(uninstalledAt.getTime() + 30 * MIN),
    });
    db.webhookEvent.findMany.mockResolvedValue([{ createdAt: new Date(redactTriggeredAt.getTime() + 500), triggeredAt: redactTriggeredAt }]);
    await processWebhookEvent("evt");
    expect(services.redactShop).not.toHaveBeenCalled();
    expect(db.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "evt" },
      data: expect.objectContaining({ error: "skipped: store reinstalled", payload: { redacted: true }, processedAt: expect.any(Date) }),
    });
  });

  it("decides from the sign-in, the trigger time, the margin and the clock lead", () => {
    const estimate = uninstalledAt.getTime();
    expect(shopRedactDecision(null, redactTriggeredAt)).toBe("erase");
    // A sign-in just before the uninstall, or inside the margin, erases.
    expect(shopRedactDecision(new Date(estimate - MIN), redactTriggeredAt)).toBe("erase");
    expect(shopRedactDecision(new Date(estimate + SHOP_REDACT_MARGIN_MS - MIN), redactTriggeredAt)).toBe("erase");
    expect(shopRedactDecision(new Date(estimate + SHOP_REDACT_MARGIN_MS + MIN), redactTriggeredAt)).toBe("skip");
    // Our clock 20 minutes fast: a sign-in stamped 19 minutes after the
    // uninstall really happened a minute before it.
    expect(shopRedactDecision(new Date(estimate + 19 * MIN), redactTriggeredAt, 20 * MIN)).toBe("erase");
    expect(shopRedactDecision(new Date(estimate + 19 * MIN), redactTriggeredAt, 0)).toBe("skip");
  });
});

describe("app/uninstalled with a server clock running fast", () => {
  const triggeredAt = new Date("2026-09-14T10:00:00Z");

  it("applies a real uninstall when the last sign-in only looks later because our clock is ahead", async () => {
    // The merchant opened the app at 09:59:30 Shopify time and uninstalled at
    // 10:00. Our clock is five minutes fast, so the sign-in was stamped 10:04:30
    // and the old fixed 30-second margin ignored the uninstall.
    const lead = 5 * MIN;
    const lastAuthAt = new Date(triggeredAt.getTime() - 30_000 + lead);
    claimed(storedEvent("APP_UNINSTALLED", { triggeredAt, createdAt: new Date(triggeredAt.getTime() + lead + 800) }), { lastAuthAt });
    db.webhookEvent.findMany.mockResolvedValue([
      { createdAt: new Date(triggeredAt.getTime() + lead + 800), triggeredAt },
      { createdAt: new Date("2026-09-14T09:10:03Z"), triggeredAt: new Date(new Date("2026-09-14T09:10:03Z").getTime() - lead - 2_000) },
    ]);
    db.shop.updateMany.mockResolvedValue({ count: 1 });
    db.account.findUnique.mockResolvedValue({ id: "a1", plan: "FREE", subscriptionId: null, billingShopId: null });
    const info = vi.spyOn(logger, "info");

    expect(reauthenticatedSince(lastAuthAt, triggeredAt)).toBe(true);
    await processWebhookEvent("evt");

    expect(db.webhookEvent.findMany).toHaveBeenCalledWith({
      where: { triggeredAt: { not: null }, createdAt: { gt: expect.any(Date) } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { createdAt: true, triggeredAt: true },
    });
    expect(db.shop.updateMany).toHaveBeenCalledWith({ where: { id: "s1", lastAuthAt }, data: expect.objectContaining({ isActive: false }) });
    expect(db.session.deleteMany).toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("app/uninstalled decision", expect.objectContaining({ decision: "applied", clockLeadMs: lead + 800, marginMs: REAUTH_MARGIN_MS }));
  });

  it("still ignores an uninstall for a store that really reinstalled", async () => {
    db.shop.findUnique.mockResolvedValue({ id: "s1", domain: "a.myshopify.com", accountId: "a1", lastAuthAt: new Date(triggeredAt.getTime() + 5 * MIN) });
    db.shop.update.mockResolvedValue({});
    const info = vi.spyOn(logger, "info");
    expect(await markShopUninstalled("a.myshopify.com", { triggeredAt, clockLeadMs: 1_000 })).toBe(false);
    expect(db.session.deleteMany).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("app/uninstalled decision", expect.objectContaining({ decision: expect.stringContaining("ignored") }));
  });

  it("bounds the lead by the fastest recent delivery and never lets a slow clock count", () => {
    const t = new Date("2026-09-14T10:00:00Z");
    const at = (ms: number) => new Date(t.getTime() + ms);
    expect(clockLeadFromSamples([])).toBe(0);
    expect(clockLeadFromSamples([{ createdAt: at(90_000), triggeredAt: t }, { createdAt: at(61_000), triggeredAt: t }, { createdAt: at(5_000), triggeredAt: null }])).toBe(61_000);
    // Our clock behind Shopify's: the difference is negative and reads as no lead.
    expect(clockLeadFromSamples([{ createdAt: at(-40_000), triggeredAt: t }])).toBe(0);
    expect(reauthenticatedSince(at(REAUTH_MARGIN_MS + 61_000 + 1_000), t, 61_000)).toBe(true);
    expect(reauthenticatedSince(at(REAUTH_MARGIN_MS + 61_000 - 1_000), t, 61_000)).toBe(false);
  });
});

describe("orders/cancelled and purchase orders awaiting placement", () => {
  const order = { id: "o1" };

  it("cancels purchase orders awaiting placement even when upstream cancellation is off", async () => {
    claimed(storedEvent("ORDERS_CANCELLED", { payload: { admin_graphql_api_id: "gid://shopify/Order/1" } }), { settings: { orders: { cancelSupplierOnCancel: false } } });
    services.refreshOrderFromShopify.mockResolvedValue(order);
    db.purchaseOrder.findMany.mockResolvedValue([{ id: "po1", status: "AWAITING_PLACEMENT" }]);
    services.cancelPurchaseOrder.mockResolvedValue({ upstream: false });
    await processWebhookEvent("evt");
    expect(db.purchaseOrder.findMany).toHaveBeenCalledWith({ where: { orderId: "o1", status: { in: ["AWAITING_PLACEMENT"] } }, select: { id: true, status: true } });
    expect(services.cancelPurchaseOrder).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "po1", "Shopify order cancelled", "webhook");
    expect(db.webhookEvent.update).toHaveBeenCalledWith({ where: { id: "evt" }, data: expect.objectContaining({ processedAt: expect.any(Date) }) });
  });

  it("adds supplier-side purchase orders when the merchant asked for upstream cancellation", async () => {
    claimed(storedEvent("ORDERS_CANCELLED", { payload: { id: 1 } }), { settings: { orders: { cancelSupplierOnCancel: true } } });
    services.refreshOrderFromShopify.mockResolvedValue(order);
    db.purchaseOrder.findMany.mockResolvedValue([
      { id: "po1", status: "AWAITING_PLACEMENT" },
      { id: "po2", status: "PLACED" },
    ]);
    // A supplier refusing is logged, not retried.
    services.cancelPurchaseOrder.mockImplementation(async (_shop: unknown, id: string) => {
      if (id === "po2") throw new Error("supplier refused");
      return { upstream: false };
    });
    await processWebhookEvent("evt");
    expect(db.purchaseOrder.findMany).toHaveBeenCalledWith({ where: { orderId: "o1", status: { in: ["AWAITING_PLACEMENT", "PLACED", "AWAITING_PAYMENT", "PAID"] } }, select: { id: true, status: true } });
    expect(services.cancelPurchaseOrder).toHaveBeenCalledTimes(2);
    expect(db.webhookEvent.update).toHaveBeenCalled();
  });

  it("fails the event, so it is retried, when a purchase order awaiting placement cannot be cancelled", async () => {
    // Left open, the extension would keep offering it for placement and the
    // merchant could pay AliExpress for a cancelled order.
    claimed(storedEvent("ORDERS_CANCELLED", { payload: { id: 1 } }), {});
    services.refreshOrderFromShopify.mockResolvedValue(order);
    db.purchaseOrder.findMany.mockResolvedValue([{ id: "po1", status: "AWAITING_PLACEMENT" }]);
    services.cancelPurchaseOrder.mockRejectedValue(new Error("database unavailable"));
    await expect(processWebhookEvent("evt")).rejects.toThrow(/awaiting placement/);
    expect(db.webhookEvent.update).not.toHaveBeenCalled();
    expect(db.webhookEvent.updateMany).toHaveBeenLastCalledWith({ where: { id: "evt" }, data: expect.objectContaining({ lockedUntil: null }) });
  });
});

describe("processed payloads", () => {
  it("replaces the payload in the same write that marks the event processed", async () => {
    claimed(storedEvent("APP_SCOPES_UPDATE", { payload: { current: ["read_orders"], customer: { email: "x@example.com" } } }), {});
    await processWebhookEvent("evt");
    expect(db.webhookEvent.update).toHaveBeenCalledTimes(1);
    expect(db.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "evt" },
      data: { processedAt: expect.any(Date), error: null, lockedUntil: null, payload: { redacted: true } },
    });
  });

  it("drops the payload of an event given up on because its store never appeared", async () => {
    db.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    db.webhookEvent.findUnique.mockResolvedValue(storedEvent("CUSTOMERS_REDACT", { shopId: null, shop: null, createdAt: new Date(Date.now() - 2 * HOUR), payload: { customer: { email: "x@example.com" } } }));
    db.shop.findUnique.mockResolvedValue(null);
    db.webhookEvent.update.mockResolvedValue({});
    await processWebhookEvent("evt");
    expect(db.webhookEvent.update).toHaveBeenCalledWith({ where: { id: "evt" }, data: expect.objectContaining({ error: "shop not found; gave up", payload: { redacted: true } }) });
  });

  it("keeps the payload of an event that failed, for its retry", async () => {
    claimed(storedEvent("ORDERS_CREATE", { payload: { id: 7 } }), {});
    services.refreshOrderFromShopify.mockRejectedValue(new Error("Shopify down"));
    await expect(processWebhookEvent("evt")).rejects.toThrow("Shopify down");
    expect(db.webhookEvent.update).not.toHaveBeenCalled();
    const lastWrite = db.webhookEvent.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastWrite.data).not.toHaveProperty("payload");
  });
});

describe("retry backoff", () => {
  it("doubles with each hand-off's attempts, from five minutes to a six-hour ceiling", () => {
    expect(webhookRetryDelayMs(0)).toBe(5 * MIN);
    expect(webhookRetryDelayMs(2)).toBe(5 * MIN);
    expect(webhookRetryDelayMs(3)).toBe(10 * MIN);
    expect(webhookRetryDelayMs(6)).toBe(20 * MIN);
    expect(webhookRetryDelayMs(18)).toBe(320 * MIN);
    expect(webhookRetryDelayMs(21)).toBe(6 * HOUR);
    expect(webhookRetryDelayMs(10_000)).toBe(6 * HOUR);
  });

  it("is due when never attempted or when the gap for its attempts has passed", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    expect(webhookRetryDue({ attempts: 0, lastAttemptAt: null }, now)).toBe(true);
    expect(webhookRetryDue({ attempts: 6, lastAttemptAt: new Date(now.getTime() - 19 * MIN) }, now)).toBe(false);
    expect(webhookRetryDue({ attempts: 6, lastAttemptAt: new Date(now.getTime() - 20 * MIN) }, now)).toBe(true);
  });

  it("selects unfinished, unheld, unflagged events with no attempt cap, privacy topics for 30 days less an hour", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const at = now.getTime();
    expect(pendingWebhookFilter(now)).toEqual({
      processedAt: null,
      createdAt: { lt: new Date(at - 2 * MIN), gt: new Date(at - 30 * DAY + HOUR) },
      AND: [
        { OR: [{ error: null }, { NOT: { error: { startsWith: WEBHOOK_ABANDONED_PREFIX } } }] },
        { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(at - 5 * MIN) } }] },
        { OR: [{ topic: { in: COMPLIANCE_TOPICS } }, { createdAt: { gt: new Date(at - 2 * DAY) } }] },
      ],
    });
    expect(COMPLIANCE_TOPICS).toEqual(["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"]);
  });

  it("re-queues only the events whose backoff is over, including a privacy request on day 29", async () => {
    const now = new Date("2026-09-14T12:00:00Z");
    db.webhookEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "fresh-fail", topic: "ORDERS_PAID", attempts: 9, lastAttemptAt: new Date(now.getTime() - 30 * MIN) },
      { id: "old-redact", topic: "CUSTOMERS_REDACT", attempts: 400, lastAttemptAt: new Date(now.getTime() - 6 * HOUR - MIN) },
      { id: "never", topic: "ORDERS_CREATE", attempts: 0, lastAttemptAt: null },
    ]);
    const queued: string[] = [];
    await sweepPendingWebhooks(async (id) => void queued.push(id), now);
    expect(queued).toEqual(["old-redact", "never"]);
    expect(db.webhookEvent.findMany).toHaveBeenLastCalledWith({
      where: pendingWebhookFilter(now),
      orderBy: [{ lastAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: 200,
      select: { id: true, topic: true, attempts: true, lastAttemptAt: true },
    });
  });
});

describe("abandoned events", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const at = now.getTime();

  it("flags ordinary events after two days and privacy events after 30 days less an hour", () => {
    expect(expiredWebhookFilter(now)).toEqual({
      processedAt: null,
      AND: [
        { OR: [{ error: null }, { NOT: { error: { startsWith: WEBHOOK_ABANDONED_PREFIX } } }] },
        { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        {
          OR: [
            { topic: { in: COMPLIANCE_TOPICS }, createdAt: { lt: new Date(at - 30 * DAY + HOUR) } },
            { topic: { notIn: COMPLIANCE_TOPICS }, createdAt: { lt: new Date(at - 2 * DAY) } },
          ],
        },
      ],
    });
  });

  it("logs at error level, writes the activity log and leaves a flag Settings → Advanced can list", async () => {
    const createdAt = new Date(at - 3 * DAY);
    db.webhookEvent.findMany.mockResolvedValue([{ id: "e1", topic: "ORDERS_PAID", shopId: "s1", shopDomain: "a.myshopify.com", attempts: 14, error: "Shopify down", createdAt }]);
    db.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    const error = vi.spyOn(logger, "error");
    expect(await abandonExpiredWebhooks(now)).toBe(1);
    expect(db.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "e1", processedAt: null, AND: [{ OR: [{ error: null }, { NOT: { error: { startsWith: WEBHOOK_ABANDONED_PREFIX } } }] }] },
      data: { error: `${WEBHOOK_ABANDONED_PREFIX}gave up after 14 attempt(s); last error: Shopify down`, lockedUntil: null },
    });
    expect(error).toHaveBeenCalledWith("Webhook abandoned after its retry window", expect.objectContaining({ id: "e1", topic: "ORDERS_PAID", attempts: 14 }));
    expect(db.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ shopId: "s1", action: "webhook.abandoned", level: "error" }) });
  });

  it("stays quiet about an event that finished at the same moment", async () => {
    db.webhookEvent.findMany.mockResolvedValue([{ id: "e1", topic: "SHOP_REDACT", shopId: "s1", shopDomain: "a.myshopify.com", attempts: 300, error: null, createdAt: new Date(at - 31 * DAY) }]);
    db.webhookEvent.updateMany.mockResolvedValue({ count: 0 });
    const error = vi.spyOn(logger, "error");
    expect(await abandonExpiredWebhooks(now)).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(db.activityLog.create).not.toHaveBeenCalled();
  });
});
