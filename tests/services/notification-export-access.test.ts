/**
 * A customer data request's export lives on its notification. The download
 * route is admin-only and logged, so no other way to the export may exist: the
 * notification list and the dashboard's "needs attention" card are loaded for
 * every role, and anything a loader returns reaches the browser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePrisma } from "./fake-prisma";

const db = vi.hoisted(() => ({ current: null as unknown, role: "READ_ONLY" as string }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy({}, { get: (_t, prop) => (db.current as Record<string | symbol, unknown>)[prop] });
  return { default: proxy, prisma: proxy };
});

vi.mock("~/shopify.server", () => ({ authenticate: {}, unauthenticated: {}, apiVersion: "2026-07", default: {} }));

vi.mock("~/lib/auth.server", () => ({
  requireShop: async () => ({
    shop: { id: "shop1", domain: "tea.myshopify.com", name: "Tea", currency: "GBP", fulfillmentServiceId: null, settings: {}, parsedSettings: { ui: { dismissedTips: [] } } },
    actor: "someone@tea.test",
    role: db.role,
  }),
  readForm: async () => ({ intent: "", get: () => "" }),
}));

vi.mock("~/services/reports.server", () => ({
  getDashboardStats: async () => ({ products: { total: 0, unmapped: 0 }, stages: {}, week: { revenue: "0", profit: "0", orders: 0 }, importCount: 0, recentFailures: 0, unread: 1, activeJobs: 0 }),
}));
vi.mock("~/services/supplier-accounts.server", () => ({ listSupplierAccounts: async () => [] }));
vi.mock("~/services/pricing.server", () => ({ listPricingRules: async () => [] }));
vi.mock("~/services/billing.server", () => ({ getAccountBilling: async () => ({ plan: "FREE", usage: { products: 0 } }) }));
vi.mock("~/services/shipping.server", () => ({ listShippingPreferences: async () => [] }));
vi.mock("~/services/shop.server", () => ({ updateShopSettings: async () => undefined }));
vi.mock("~/services/jobs.server", () => ({ findOrCreateJobRun: async () => ({ job: { id: "j" }, reused: false }) }));
vi.mock("~/services/jobs/index.server", () => ({ enqueue: async () => undefined }));

const { listNotifications, withoutExport, dedupeWhere } = await import("~/services/notifications.server");
// Loaded once up front: the route modules pull in Polaris, which takes longer
// to import than a single test is allowed to run.
const notificationsRoute = await import("~/routes/app.notifications");
const dashboardRoute = await import("~/routes/app._index");

const EXPORT = { customer: { id: 42, email: "ada@example.com" }, orders: [{ customerName: "Ada Lovelace", shippingAddress: { address1: "12 Analytical Engine Rd" } }] };

let prisma: FakePrisma;

beforeEach(() => {
  prisma = new FakePrisma();
  db.current = prisma;
  prisma.seed("notification", [
    { id: "n1", shopId: "shop1", type: "system", severity: "warning", title: "Customer data request #11", meta: { dataRequest: EXPORT, dedupeKey: null } },
    { id: "n2", shopId: "shop1", type: "order.failed", title: "#1001 failed", meta: { reason: "stock" } },
  ]);
});

describe("notification rows", () => {
  it("never carry the export, only whether there is one", async () => {
    const rows = await listNotifications("shop1");
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.n1.hasExport).toBe(true);
    expect(byId.n1.meta).toEqual({ dedupeKey: null });
    expect(byId.n2).toMatchObject({ hasExport: false, meta: { reason: "stock" } });
    expect(JSON.stringify(rows)).not.toContain("Lovelace");
    // The stored row is untouched; the download route still finds it.
    expect(prisma.rows("notification")[0].meta).toHaveProperty("dataRequest");
  });

  it("treat a missing or non-object meta as no export", () => {
    const base = { id: "x", shopId: "shop1", type: "system", severity: "info", title: "t", body: null, link: null, readAt: null, archivedAt: null, emailedAt: null, createdAt: new Date() };
    expect(withoutExport({ ...base, meta: null } as never).hasExport).toBe(false);
    expect(withoutExport({ ...base, meta: [1] } as never).hasExport).toBe(false);
    expect(withoutExport({ ...base, meta: { dataRequest: null } } as never).hasExport).toBe(false);
  });
});

describe("screens", () => {
  it("the notifications loader sends no export to a read-only member and offers no download", async () => {
    db.role = "READ_ONLY";
    const { loader } = notificationsRoute;
    const data = await loader({ request: new Request("https://app.test/app/notifications"), params: {}, context: {} });
    expect(JSON.stringify(data)).not.toContain("Lovelace");
    expect(JSON.stringify(data)).not.toContain("dataRequest");
    expect(data.canDownloadExports).toBe(false);
    expect(data.notifications.find((n) => n.id === "n1")?.hasExport).toBe(true);
  });

  it("offers the download to staff only at admin and above", async () => {
    const { loader } = notificationsRoute;
    const load = async (role: string) => {
      db.role = role;
      return (await loader({ request: new Request("https://app.test/app/notifications"), params: {}, context: {} })).canDownloadExports;
    };
    expect(await load("STAFF")).toBe(false);
    expect(await load("ADMIN")).toBe(true);
    expect(await load("OWNER")).toBe(true);
  });

  it("the dashboard loader sends no export either", async () => {
    db.role = "OWNER";
    const { loader } = dashboardRoute;
    const data = await loader({ request: new Request("https://app.test/app"), params: {}, context: {} });
    expect(data.notifications).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain("Lovelace");
    expect(JSON.stringify(data)).not.toContain("dataRequest");
  });
});

describe("notification dedupe", () => {
  it("looks back a window by default and without limit when asked to raise a notice once per shop", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    expect(dedupeWhere("shop1", { type: "system", dedupeKey: "k" }, now)).toEqual({
      shopId: "shop1",
      type: "system",
      createdAt: { gte: new Date("2026-09-14T11:00:00Z") },
      meta: { path: ["dedupeKey"], equals: "k" },
    });
    expect(dedupeWhere("shop1", { type: "system", dedupeKey: "k", dedupeMinutes: "forever" }, now)).toEqual({
      shopId: "shop1",
      type: "system",
      meta: { path: ["dedupeKey"], equals: "k" },
    });
  });
});
