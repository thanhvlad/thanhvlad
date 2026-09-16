/**
 * Route-level platform behaviour: what the public health check reveals, when
 * the app layout re-runs its count queries, and where a reports recalculation
 * runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
const enqueue = vi.hoisted(() => vi.fn(async () => "job-1"));
const rollupRange = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("~/db.server", () => ({ default: db, prisma: db }));
vi.mock("~/lib/logger.server", () => ({ logger }));
vi.mock("~/shopify.server", () => ({ default: {}, unauthenticated: {}, authenticate: {} }));
vi.mock("~/lib/auth.server", () => ({
  requireShop: vi.fn(async () => ({ shop: { id: "shop1", domain: "demo.myshopify.com", currency: "USD", parsedSettings: { ui: { locale: "en", localeChosen: true } } }, role: "OWNER" })),
  readForm: async (request: Request) => {
    const form = await request.formData();
    return { get: (key: string) => String(form.get(key) ?? "") };
  },
}));
vi.mock("~/services/jobs/index.server", () => ({ enqueue, queueStats: vi.fn(), bootJobs: vi.fn() }));
vi.mock("~/services/reports.server", () => ({ getReport: vi.fn(), rollupRange }));
vi.mock("~/services/notifications.server", () => ({ countUnread: vi.fn(async () => 0) }));
vi.mock("~/services/payments.server", () => ({ countUnpaid: vi.fn(async () => 0) }));
vi.mock("~/services/shop.server", () => ({ updateShopSettings: vi.fn() }));
vi.mock("~/lib/env.server", () => ({
  env: () => ({ SUPPORT_EMAIL: null, SHOPIFY_APP_URL: "https://app.test", SUPPLIER_DRIVER: "mock", SHOPIFY_API_KEY: "key" }),
}));
vi.mock("~/services/email.server", () => ({ emailProvider: () => "none" }));
vi.mock("~/services/ai-landing.server", () => ({
  aiEndpointStatus: () => ({ configured: true, host: "gateway.example.net", direct: false }),
}));

const healthz = await import("~/routes/healthz");
const support = await import("~/routes/app.settings.support");
const reports = await import("~/routes/app.reports");
const { layoutShouldRevalidate } = await import("~/routes/app");

beforeEach(() => vi.clearAllMocks());

const args = (request: Request) => ({ request, params: {}, context: {} });

describe("/healthz", () => {
  it("answers with exactly ok, service, uptime and the database check", async () => {
    db.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const response = await healthz.loader(args(new Request("https://app.test/healthz")));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["checks", "ok", "service", "uptimeSeconds"]);
    expect(body).toMatchObject({ ok: true, service: "dropship-hub", checks: { database: { ok: true } } });
    expect(body.checks).toEqual({ database: { ok: true } });
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("returns 503 without the database error text, which goes to the log instead", async () => {
    db.$queryRaw.mockRejectedValue(new Error('password authentication failed for user "dropship"'));
    const response = await healthz.loader(args(new Request("https://app.test/healthz")));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toMatch(/password|dropship"|supplier|queue|email|inline|mock/i);
    expect(JSON.parse(text)).toEqual({ ok: false, service: "dropship-hub", uptimeSeconds: expect.any(Number), checks: { database: { ok: false } } });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("Settings > Support", () => {
  it("shows the operational detail /healthz no longer prints, behind the admin session", async () => {
    const { queueStats } = await import("~/services/jobs/index.server");
    vi.mocked(queueStats).mockResolvedValue({ mode: "inline" } as Awaited<ReturnType<typeof queueStats>>);
    const data = await support.loader(args(new Request("https://app.test/app/settings/support")));
    expect(data).toMatchObject({
      supplierDriver: "mock",
      queueMode: "inline",
      email: "none",
      ai: { configured: true, host: "gateway.example.net", direct: false },
    });
  });
});

describe("reports Recalculate", () => {
  it("enqueues the rollup job for the selected range instead of computing in the request", async () => {
    const request = new Request("https://app.test/app/reports", { method: "POST", body: new URLSearchParams({ range: "365d" }) });
    const result = await reports.action(args(request));
    expect(rollupRange).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith("rollup-metrics", { shopId: "shop1", days: 365 }, { dedupeKey: "metrics-recalculate-shop1-365" });
    expect(result).toEqual({ ok: true, messageKey: "reports.recalculate.queued", messageVars: { n: 365 } });
  });

  it("falls back to 30 days for an unknown range", async () => {
    const request = new Request("https://app.test/app/reports", { method: "POST", body: new URLSearchParams({ range: "all" }) });
    await reports.action(args(request));
    expect(enqueue).toHaveBeenCalledWith("rollup-metrics", { shopId: "shop1", days: 30 }, { dedupeKey: "metrics-recalculate-shop1-30" });
  });
});

describe("app layout revalidation", () => {
  const url = (path: string) => new URL(`https://app.test${path}`);
  const after = (formAction: string, from = "/app/products") =>
    layoutShouldRevalidate({ formMethod: "POST", formAction, currentUrl: url(from), nextUrl: url(from), defaultShouldRevalidate: true });

  it("skips the count queries after actions that cannot change them", () => {
    expect(after("/app/products")).toBe(false);
    expect(after("/app/products/abc?index")).toBe(false);
    expect(after("/app/import")).toBe(false);
    expect(after("/app/reports")).toBe(false);
    expect(after("/app/notificationsX")).toBe(false);
  });

  it("reloads after actions on notifications, payments, orders and settings", () => {
    expect(after("/app/notifications")).toBe(true);
    expect(after("/app/payments?index")).toBe(true);
    expect(after("/app/orders/abc")).toBe(true);
    expect(after("/app/settings/staff")).toBe(true);
  });

  it("does not reload when a screen only changes its own search parameters", () => {
    expect(
      layoutShouldRevalidate({ currentUrl: url("/app/orders?tab=all"), nextUrl: url("/app/orders?tab=failed"), defaultShouldRevalidate: true }),
    ).toBe(false);
    expect(layoutShouldRevalidate({ currentUrl: url("/app/orders"), nextUrl: url("/app/products"), defaultShouldRevalidate: true })).toBe(true);
  });

  it("never reloads when Remix itself would not", () => {
    expect(
      layoutShouldRevalidate({ formMethod: "POST", formAction: "/app/payments", currentUrl: url("/app/payments"), nextUrl: url("/app/payments"), defaultShouldRevalidate: false }),
    ).toBe(false);
  });
});
