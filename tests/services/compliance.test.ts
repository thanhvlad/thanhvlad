/**
 * Customer data erasure, data-request exports, retention and minimisation,
 * against an in-memory Prisma so every table that can hold a copy of a person's
 * data is seeded and checked without a database.
 *
 * The failure these guard against is the one the privacy audit found: the
 * Order columns were cleared while the same name, phone and address stayed in
 * the order's issues, the supplier's order response, log lines, notifications,
 * an earlier export and the raw webhook payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePrisma } from "./fake-prisma";

const db = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy({}, { get: (_t, prop) => (db.current as Record<string | symbol, unknown>)[prop] });
  return { default: proxy, prisma: proxy };
});

vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: {},
  login: undefined,
  apiVersion: "2026-07",
  addDocumentResponseHeaders: () => undefined,
  registerWebhooks: async () => undefined,
  sessionStorage: {},
  default: {},
}));

vi.mock("~/services/mapping.server", () => ({
  resolveForVariant: async () => ({ ok: true, lines: [], totalCost: "1.00", skipped: [] }),
}));

const requireShopCalls: Array<{ minRole?: string }> = [];
vi.mock("~/lib/auth.server", () => ({
  requireShop: async (_request: Request, options: { minRole?: string } = {}) => {
    requireShopCalls.push(options);
    return { shop: { id: "shop1", domain: "tea.myshopify.com" }, actor: "admin@tea.test", role: "ADMIN" };
  },
}));

const compliance = await import("~/services/compliance.server");
const { __setEmailSenderForTests } = await import("~/services/email.server");

const DAY = 86_400_000;
const ADA = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+44 20 7123 4567",
  address1: "12 Analytical Engine Rd",
  zip: "N1 9GU",
  taxNumber: "52998224725",
};
/** Fragments of Ada's data that must not survive anywhere once she is erased. */
const ADA_TRACES = ["Ada", "Lovelace", "ada@example.com", "7123 4567", "442071234567", "Analytical", "N1 9GU", "52998224725"];
const GRACE = { name: "Grace Hopper", email: "grace@example.com", address1: "1 Cobol Way" };

let prisma: FakePrisma;
let sent: Array<{ to: string; subject: string; text: string }>;

const SHOP = { id: "shop1", domain: "tea.myshopify.com", accountId: null };

function seedShop() {
  prisma.seed("shop", [{ id: "shop1", domain: SHOP.domain, accountId: null, isActive: true, settings: {}, email: "owner@tea.test", name: "Tea" }]);
}

function adaAddress() {
  return { firstName: "Ada", lastName: "Lovelace", name: ADA.name, company: null, address1: ADA.address1, address2: null, city: "London", zip: ADA.zip, countryCode: "GB", phone: ADA.phone, taxNumber: ADA.taxNumber };
}

/** Ada's order with a copy of her data in every place the app can keep one. */
function seedAdaEverywhere() {
  prisma.seed("order", [
    {
      id: "o1",
      shopId: "shop1",
      shopifyOrderId: "gid://shopify/Order/70011",
      name: "#7001",
      stage: "FAILED",
      customerName: ADA.name,
      customerEmail: ADA.email,
      phone: ADA.phone,
      note: "Leave with the porter",
      countryCode: "GB",
      totalPrice: "10.00",
      shippingAddress: adaAddress(),
      issues: [
        { code: "INVALID_PHONE", field: "phone", severity: "warning", message: `"${ADA.phone}" has 12 digits; a valid number has 6-15.` },
        { code: "NAME_TOO_LONG", field: "name", severity: "error", message: "The recipient name is 60 characters.", suggestion: "Ada Lovelace of the Analyt" },
        { code: "UNMAPPED", lineItemId: "li1", severity: "error", message: '"Tea cup" has not been matched to a supplier yet.' },
      ],
    },
    {
      id: "o2",
      shopId: "shop1",
      shopifyOrderId: "gid://shopify/Order/70012",
      name: "#7002",
      customerName: GRACE.name,
      customerEmail: GRACE.email,
      countryCode: "US",
      shippingAddress: { name: GRACE.name, address1: GRACE.address1, countryCode: "US" },
    },
  ]);
  prisma.seed("orderLineItem", [{ id: "li1", orderId: "o1", title: "Tea cup", quantity: 1, price: "10.00" }]);
  prisma.seed("purchaseOrder", [
    {
      id: "po1",
      orderId: "o1",
      platform: "ALIEXPRESS",
      status: "FAILED",
      raw: {
        shippingReason: "Cheapest tracked option.",
        externalOrderIds: ["AE-1"],
        response: { receiver: { name: ADA.name, phone: "442071234567", address: ADA.address1, zip: ADA.zip } },
        lastStatus: { buyer_email: ADA.email },
      },
      errorMessage: "Receiver phone 442071234567 is invalid",
      supplierNote: `Deliver to ${ADA.name} before noon`,
    },
  ]);
  prisma.seed("purchaseOrderItem", [{ id: "poi1", purchaseOrderId: "po1", orderLineItemId: "li1", title: "Tea cup", quantity: 1 }]);
  prisma.seed("trackingNumber", [{ id: "t1", purchaseOrderId: "po1", number: "LP123", syncError: `Shopify refused tracking for ${ADA.name}` }]);
  prisma.seed("fulfillmentRequest", [
    {
      id: "fr1",
      orderId: "o1",
      shopifyFulfillmentOrderId: "gid://shopify/FulfillmentOrder/1",
      requestMessage: "Gift wrap please, it is for Ada",
      responseMessage: `Not fulfillable yet: "${ADA.phone}" has 12 digits`,
      quote: { groups: [{ note: `to ${ADA.zip}` }] },
    },
  ]);
  prisma.seed("activityLog", [
    { id: "a1", shopId: "shop1", action: "order.place_failed", entity: "Order", entityId: "o1", message: `#7001: AliExpress rejected the order - receiver ${ADA.name}, ${ADA.address1}` },
    { id: "a2", shopId: "shop1", action: "gdpr.customer_redact", message: `Redacted 0 order(s) for customer ${ADA.email}.` },
    { id: "a3", shopId: "shop1", action: "order.place_failed", entity: "Order", entityId: "o2", message: `#7002: rejected - receiver ${GRACE.name}` },
  ]);
  prisma.seed("notification", [
    { id: "n1", shopId: "shop1", type: "order.failed", title: "Order #7001 failed at ALIEXPRESS", body: `Phone ${ADA.phone} rejected`, link: "/app/orders/o1" },
    {
      id: "n2",
      shopId: "shop1",
      type: "system",
      title: "Customer data request #9",
      body: `Shopify relayed a request from ${ADA.email} for their personal data.`,
      meta: { dataRequest: { customer: { id: 42, email: ADA.email }, orders: [{ shopifyOrderId: "gid://shopify/Order/70011", customerName: ADA.name }] } },
    },
    {
      id: "n3",
      shopId: "shop1",
      type: "system",
      title: "Customer data request #10",
      body: "Shopify relayed a personal data request for customer 77.",
      meta: { dataRequest: { customer: { id: 77, email: GRACE.email }, orders: [{ shopifyOrderId: "gid://shopify/Order/70012", customerName: GRACE.name }] } },
    },
  ]);
  prisma.seed("jobRun", [
    { id: "j1", shopId: "shop1", type: "place-orders", payload: { orderIds: ["o1", "o2"] }, result: { results: [{ orderId: "o1", ok: false, error: `receiver ${ADA.name} rejected` }] }, error: null },
  ]);
  prisma.seed("webhookEvent", [
    {
      id: "w1",
      shopId: "shop1",
      topic: "ORDERS_CREATE",
      webhookId: "wh-1",
      processedAt: new Date(),
      payload: { id: 70011, admin_graphql_api_id: "gid://shopify/Order/70011", email: ADA.email, shipping_address: { name: ADA.name, address1: ADA.address1, zip: ADA.zip } },
    },
    { id: "w2", shopId: "shop1", topic: "CUSTOMERS_REDACT", webhookId: "wh-2", payload: { customer: { id: 42, email: ADA.email, phone: ADA.phone }, orders_to_redact: [70011] } },
    { id: "w3", shopId: "shop1", topic: "ORDERS_UPDATED", webhookId: "wh-3", payload: { id: 70012, email: GRACE.email, shipping_address: { name: GRACE.name } } },
  ]);
}

function dump(): string {
  return JSON.stringify(prisma.tables);
}

beforeEach(() => {
  prisma = new FakePrisma();
  db.current = prisma;
  sent = [];
  __setEmailSenderForTests(async (message) => {
    sent.push({ to: message.to, subject: message.subject, text: message.text ?? "" });
    return { ok: true };
  });
  seedShop();
});

// ---------------------------------------------------------------------------

describe("scrubbing helpers", () => {
  it("replaces a value where it stands as a word, not inside another word", () => {
    expect(compliance.scrubText("Ship to Ada in Canada", ["Ada"])).toBe("Ship to [redacted] in Canada");
    expect(compliance.scrubText("mail ADA@EXAMPLE.COM now", ["ada@example.com"])).toBe("mail [redacted] now");
  });

  it("collects the person's values, with bare phone digits, and skips fragments too short to identify anyone", () => {
    const values = compliance.personalValues({ customerName: "Li Wu", phone: "+44 20 7123 4567", shippingAddress: { firstName: "Li", zip: "N1 9GU" } });
    expect(values).toContain("Li Wu");
    expect(values).toContain("+44 20 7123 4567");
    expect(values).toContain("442071234567");
    expect(values).toContain("N1 9GU");
    expect(values).not.toContain("Li");
  });

  it("scrubs nested JSON without touching keys or non-strings", () => {
    expect(compliance.scrubJson({ name: "Ada Lovelace", n: 3, list: ["x Ada Lovelace y"] }, ["Ada Lovelace"])).toEqual({ name: "[redacted]", n: 3, list: ["x [redacted] y"] });
  });

  it("strips quoted values and suggestions from address issues but keeps product issues readable", () => {
    const issues = compliance.redactIssues(
      [
        { code: "INVALID_PHONE", field: "phone", severity: "warning", message: '"+1 555" has 4 digits.' },
        { code: "NAME_TOO_LONG", field: "name", severity: "error", message: "Too long.", suggestion: "Ada Lovel" },
        { code: "UNMAPPED", lineItemId: "li1", severity: "error", message: '"Tea cup" has not been matched.' },
      ],
      [],
    ) as Array<Record<string, unknown>>;
    expect(issues[0].message).toBe('"[redacted]" has 4 digits.');
    expect(issues[1]).not.toHaveProperty("suggestion");
    expect(issues[2]).toEqual({ code: "UNMAPPED", severity: "error", message: '"Tea cup" has not been matched.', lineItemId: "li1" });
  });

  it("keeps only the parts of a supplier order response the app reads back", () => {
    expect(compliance.minimalPurchaseOrderRaw({ externalOrderIds: ["A"], shippingReason: "r", capturedByExtension: true, response: { name: "Ada" }, lastStatus: {} })).toEqual({
      externalOrderIds: ["A"],
      shippingReason: "r",
      capturedByExtension: true,
    });
  });

  it("cuts a webhook payload down to the ids its handler needs", () => {
    expect(compliance.minimalWebhookPayload("ORDERS_UPDATED", { id: 5, admin_graphql_api_id: "gid://shopify/Order/5", email: "a@b.c" })).toEqual({ redacted: true, id: 5, admin_graphql_api_id: "gid://shopify/Order/5" });
    expect(compliance.minimalWebhookPayload("CUSTOMERS_REDACT", { customer: { email: "a@b.c" } })).toEqual({ redacted: true });
  });

  it("recognises the customer's webhooks by order id, email or customer id, and ignores a product with the same number", () => {
    const match = { orderIds: ["gid://shopify/Order/70011"], customerId: "42", emails: ["ada@example.com"] };
    expect(compliance.webhookPayloadMatches("ORDERS_CREATE", { id: 70011 }, match)).toBe(true);
    expect(compliance.webhookPayloadMatches("FULFILLMENTS_CREATE", { order_id: 70011 }, match)).toBe(true);
    expect(compliance.webhookPayloadMatches("ORDERS_CREATE", { id: 1, email: "ADA@example.com" }, match)).toBe(true);
    expect(compliance.webhookPayloadMatches("CUSTOMERS_REDACT", { customer: { id: 42 } }, match)).toBe(true);
    expect(compliance.webhookPayloadMatches("PRODUCTS_UPDATE", { id: 70011 }, match)).toBe(false);
    expect(compliance.webhookPayloadMatches("ORDERS_CREATE", { redacted: true, id: 70011 }, match)).toBe(false);
  });

  it("only orders the app can act on keep customer details", () => {
    expect(compliance.orderNeedsCustomerData({ managedLines: 0, purchaseOrders: 0, fulfillmentRequests: 0 })).toBe(false);
    expect(compliance.orderNeedsCustomerData({ managedLines: 1, purchaseOrders: 0, fulfillmentRequests: 0 })).toBe(true);
    expect(compliance.orderNeedsCustomerData({ managedLines: 0, purchaseOrders: 1, fulfillmentRequests: 0 })).toBe(true);
    expect(compliance.orderNeedsCustomerData({ managedLines: 0, purchaseOrders: 0, fulfillmentRequests: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("customers/redact", () => {
  it("leaves no trace of the customer in any table, and nothing of anyone else is touched", async () => {
    seedAdaEverywhere();
    expect(ADA_TRACES.every((trace) => dump().includes(trace))).toBe(true);

    const result = await compliance.redactCustomer(SHOP, { customer: { id: 42, email: ADA.email, phone: ADA.phone }, orders_to_redact: [70011] });
    expect(result.orders).toBe(1);

    const everything = dump();
    for (const trace of ADA_TRACES) expect(everything, `"${trace}" survived redaction`).not.toContain(trace);

    const o1 = prisma.rows("order").find((o) => o.id === "o1")!;
    expect(o1).toMatchObject({ customerName: null, customerEmail: null, phone: null, note: null, shippingAddress: { countryCode: "GB" }, totalPrice: "10.00", stage: "FAILED" });
    expect((o1.issues as unknown[]).length).toBe(3);

    const po = prisma.rows("purchaseOrder")[0];
    expect(po.raw).toEqual({ externalOrderIds: ["AE-1"], shippingReason: "Cheapest tracked option." });
    expect(prisma.rows("purchaseOrderItem")[0].title).toBe("Tea cup");
    expect(prisma.rows("trackingNumber")[0].number).toBe("LP123");
    expect(prisma.rows("fulfillmentRequest")[0].requestMessage).toBeNull();

    // The earlier export for Ada is gone; the notification that it happened stays.
    const n2 = prisma.rows("notification").find((n) => n.id === "n2")!;
    expect(n2.meta).not.toHaveProperty("dataRequest");
    // Webhooks: the processed order copy and the redaction request itself.
    const hooks = Object.fromEntries(prisma.rows("webhookEvent").map((w) => [w.id, w.payload]));
    expect(hooks.w1).toEqual({ redacted: true, id: 70011, admin_graphql_api_id: "gid://shopify/Order/70011" });
    expect(hooks.w2).toEqual({ redacted: true });

    // Grace is another customer and keeps everything.
    expect(everything).toContain(GRACE.name);
    expect(prisma.rows("order").find((o) => o.id === "o2")).toMatchObject({ customerName: GRACE.name, customerEmail: GRACE.email });
    expect(prisma.rows("activityLog").find((a) => a.id === "a3")!.message).toContain(GRACE.name);
    expect(prisma.rows("notification").find((n) => n.id === "n3")!.meta).toHaveProperty("dataRequest");
    expect(hooks.w3).toMatchObject({ email: GRACE.email });
  });

  it("finds the customer's orders by email when Shopify names no order ids", async () => {
    seedAdaEverywhere();
    const result = await compliance.redactCustomer(SHOP, { customer: { id: 42, email: "ADA@example.com" } });
    expect(result.orders).toBe(1);
    expect(dump()).not.toContain("Lovelace");
  });
});

describe("customers/data_request", () => {
  it("exports every stored copy of the customer's data, and the email carries none of it", async () => {
    seedAdaEverywhere();
    prisma.tables.notification = [];
    const result = await compliance.handleCustomerDataRequest(SHOP, { customer: { id: 42, email: ADA.email, phone: null }, orders_requested: [70011], data_request: { id: 11 } });
    expect(result.orders).toBe(1);

    const row = prisma.rows("notification").find((n) => n.title === "Customer data request #11")!;
    expect(row.body).not.toContain(ADA.email);
    const exported = (row.meta as { dataRequest: Record<string, any> }).dataRequest;
    const order = exported.orders[0];
    expect(order.shippingAddress.address1).toBe(ADA.address1);
    expect(order.issues[0].message).toContain(ADA.phone);
    expect(order.supplierOrders[0].supplierResponse.response.receiver.name).toBe(ADA.name);
    expect(order.supplierOrders[0].errorMessage).toContain("442071234567");
    expect(order.fulfillmentRequests[0].requestMessage).toContain("Ada");
    expect(exported.webhookCopies.map((w: { topic: string }) => w.topic)).toEqual(["ORDERS_CREATE"]);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@tea.test");
    for (const trace of ADA_TRACES) expect(sent[0].text).not.toContain(trace);
    expect(sent[0].text).toContain("/app/notifications");
  });
});

describe("export download", () => {
  it("is limited to admins and every download is logged", async () => {
    prisma.seed("notification", [{ id: "n9", shopId: "shop1", type: "system", title: "Customer data request #9", meta: { dataRequest: { customer: { id: 42 } } } }]);
    const { loader } = await import("~/routes/app.notifications_.$id.export");
    const response = (await loader({ request: new Request("https://app.test/app/notifications/n9/export"), params: { id: "n9" }, context: {} })) as Response;
    expect(response.status).toBe(200);
    expect(requireShopCalls.at(-1)).toEqual({ minRole: "ADMIN" });
    const log = prisma.rows("activityLog").find((a) => a.action === "gdpr.export_downloaded")!;
    expect(log).toMatchObject({ actor: "admin@tea.test", entity: "Notification", entityId: "n9" });
  });
});

// ---------------------------------------------------------------------------

describe("retention", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  function personal(id: string, extra: Record<string, unknown>) {
    return { id, shopId: "shop1", shopifyOrderId: `gid://shopify/Order/${id}`, name: `#${id}`, customerName: `Person ${id}`, customerEmail: `${id}@example.com`, phone: "+1 555 0100", countryCode: "US", shippingAddress: { name: `Person ${id}`, address1: `${id} Main St`, countryCode: "US" }, createdAt: ago(30 * DAY), shopifyCreatedAt: ago(30 * DAY), updatedAt: ago(30 * DAY), ...extra };
  }

  it("removes customer data from closed, stale and never-ours orders only", async () => {
    prisma.seed("order", [
      personal("closedOld", { stage: "FULFILLED", updatedAt: ago(100 * DAY) }),
      personal("closedRecent", { stage: "FULFILLED", updatedAt: ago(10 * DAY) }),
      personal("stale", { stage: "AWAITING_DELIVERY", shopifyCreatedAt: ago(400 * DAY) }),
      personal("unmanaged", { stage: "IGNORED", createdAt: ago(2 * 3_600_000), updatedAt: ago(2 * 3_600_000) }),
      personal("justSynced", { stage: "IGNORED", createdAt: ago(10 * 60_000), updatedAt: ago(10 * 60_000) }),
      personal("open", { stage: "AWAITING_SHIPMENT" }),
    ]);
    prisma.seed("orderLineItem", [
      { orderId: "closedOld", title: "x", productVariantId: "v1" },
      { orderId: "closedRecent", title: "x", productVariantId: "v1" },
      { orderId: "stale", title: "x", productVariantId: "v1" },
      { orderId: "unmanaged", title: "x", productVariantId: null },
      { orderId: "open", title: "x", productVariantId: "v1" },
    ]);
    prisma.seed("purchaseOrder", [{ orderId: "closedOld", platform: "CJ_DROPSHIPPING", status: "DELIVERED", raw: { externalOrderIds: ["CJ1"], response: { consignee: "Person closedOld" } } }]);

    const result = await compliance.applyRetention(now);
    expect(result.ordersRedacted).toBe(3);

    const byId = Object.fromEntries(prisma.rows("order").map((o) => [o.id, o]));
    for (const id of ["closedOld", "stale", "unmanaged"]) {
      expect(byId[id], id).toMatchObject({ customerName: null, customerEmail: null, phone: null, shippingAddress: { countryCode: "US" } });
    }
    for (const id of ["closedRecent", "justSynced", "open"]) {
      expect(byId[id].customerName, id).toBe(`Person ${id}`);
    }
    expect(prisma.rows("purchaseOrder")[0].raw).toEqual({ externalOrderIds: ["CJ1"] });

    // A second run finds nothing left to do.
    expect((await compliance.applyRetention(now)).ordersRedacted).toBe(0);
  });

  it("deletes old data-request exports and cuts down or deletes webhook payloads", async () => {
    prisma.seed("notification", [
      { id: "old", shopId: "shop1", type: "system", title: "Customer data request #1", meta: { dataRequest: { customer: { email: "a@example.com" } } }, createdAt: ago(40 * DAY) },
      { id: "recent", shopId: "shop1", type: "system", title: "Customer data request #2", meta: { dataRequest: { customer: { email: "b@example.com" } } }, createdAt: ago(5 * DAY) },
    ]);
    prisma.seed("webhookEvent", [
      { id: "processed", shopId: "shop1", topic: "ORDERS_CREATE", webhookId: "1", processedAt: ago(3_600_000), createdAt: ago(2 * 3_600_000), payload: { id: 1, email: "a@example.com" } },
      { id: "stuck", shopId: null, topic: "ORDERS_UPDATED", webhookId: "2", createdAt: ago(2 * DAY), payload: { id: 2, admin_graphql_api_id: "gid://shopify/Order/2", email: "b@example.com" } },
      { id: "pending", shopId: "shop1", topic: "ORDERS_PAID", webhookId: "3", createdAt: ago(60_000), payload: { id: 3, email: "c@example.com" } },
      { id: "ancient", shopId: "shop1", topic: "ORDERS_PAID", webhookId: "4", processedAt: ago(40 * DAY), createdAt: ago(40 * DAY), payload: { id: 4 } },
    ]);

    const result = await compliance.applyRetention(now);
    expect(result.exportsRemoved).toBe(1);
    const notes = Object.fromEntries(prisma.rows("notification").map((n) => [n.id, n.meta]));
    expect(notes.old).not.toHaveProperty("dataRequest");
    expect(notes.recent).toHaveProperty("dataRequest");

    const hooks = Object.fromEntries(prisma.rows("webhookEvent").map((w) => [w.id, w.payload]));
    expect(hooks.processed).toEqual({ redacted: true });
    expect(hooks.stuck).toEqual({ redacted: true, id: 2, admin_graphql_api_id: "gid://shopify/Order/2" });
    expect(hooks.pending).toEqual({ id: 3, email: "c@example.com" });
    expect(hooks).not.toHaveProperty("ancient");
    expect(result.webhookEventsDeleted).toBe(1);
  });
});

describe("shop/redact", () => {
  it("also deletes webhooks stored before the shop row existed", async () => {
    prisma.seed("webhookEvent", [
      { id: "orphan", shopId: null, topic: "SHOP_REDACT", webhookId: "o", payload: { shop_domain: SHOP.domain } },
      { id: "other", shopId: null, topic: "SHOP_REDACT", webhookId: "p", payload: { shop_domain: "other.myshopify.com" } },
    ]);
    await compliance.redactShop(SHOP, "test");
    expect(prisma.rows("webhookEvent").map((w) => w.id)).toEqual(["other"]);
    expect(prisma.rows("shop")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("order ingest minimisation", () => {
  function snapshot(id: string, variantId: string | null) {
    return {
      id: `gid://shopify/Order/${id}`,
      name: `#${id}`,
      orderNumber: Number(id),
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      email: ADA.email,
      phone: null,
      note: "Leave with the porter",
      tags: [],
      test: false,
      riskLevel: "LOW",
      currencyCode: "GBP",
      totalPrice: "10.00",
      totalShipping: "0.00",
      totalTax: "0.00",
      totalDiscounts: "0.00",
      customer: { firstName: "Ada", lastName: "Lovelace", email: ADA.email, phone: null },
      customAttributes: [],
      shippingAddress: { firstName: "Ada", lastName: "Lovelace", name: ADA.name, company: null, address1: ADA.address1, address2: null, city: "London", province: null, provinceCode: null, zip: ADA.zip, country: "United Kingdom", countryCodeV2: "GB", phone: ADA.phone },
      lineItems: [{ id: `${id}-line`, title: "Tea cup", variantTitle: null, sku: null, quantity: 1, unfulfilledQuantity: 1, productId: null, variantId, image: null, price: "10.00", totalDiscount: "0", requiresShipping: true }],
    };
  }

  async function shopWithSettings() {
    const { parseShopSettings } = await import("~/domain/settings/shop-settings");
    return { ...prisma.rows("shop")[0], parsedSettings: parseShopSettings({}) } as never;
  }

  beforeEach(() => {
    prisma.seed("product", [{ id: "p1", shopId: "shop1", title: "Tea cup" }]);
    prisma.seed("productVariant", [{ id: "v1", productId: "p1", shopifyVariantId: "gid://shopify/ProductVariant/1" }]);
  });

  it("keeps no name, email, phone, note or street address for an order with nothing the app manages", async () => {
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    const order = await upsertOrderFromSnapshot(await shopWithSettings(), snapshot("8001", "gid://shopify/ProductVariant/999"));
    expect(order.stage).toBe("IGNORED");
    expect(order.countryCode).toBe("GB");
    const stored = JSON.stringify(prisma.rows("order"));
    for (const trace of ["Lovelace", ADA.email, "7123", "Analytical", "N1 9GU", "porter"]) expect(stored).not.toContain(trace);
  });

  it("keeps the customer's details for an order with a managed line", async () => {
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    const order = await upsertOrderFromSnapshot(await shopWithSettings(), snapshot("8002", "gid://shopify/ProductVariant/1"));
    expect(order).toMatchObject({ customerName: ADA.name, customerEmail: ADA.email, phone: ADA.phone, note: "Leave with the porter" });
    expect((order.shippingAddress as { address1: string }).address1).toBe(ADA.address1);
  });

  it("keeps them for an already stored order with a supplier order, even after its product was unlinked", async () => {
    prisma.seed("order", [{ id: "o9", shopId: "shop1", shopifyOrderId: "gid://shopify/Order/8003", name: "#8003", customerName: ADA.name }]);
    prisma.seed("purchaseOrder", [{ orderId: "o9", platform: "CJ_DROPSHIPPING", status: "SHIPPED" }]);
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    const order = await upsertOrderFromSnapshot(await shopWithSettings(), snapshot("8003", null));
    expect(order.customerEmail).toBe(ADA.email);
  });

  it("clears them from a stored order that no longer needs them", async () => {
    prisma.seed("order", [{ id: "o8", shopId: "shop1", shopifyOrderId: "gid://shopify/Order/8004", name: "#8004", customerName: ADA.name, customerEmail: ADA.email, phone: ADA.phone, shippingAddress: adaAddress() }]);
    const { upsertOrderFromSnapshot } = await import("~/services/orders.server");
    const order = await upsertOrderFromSnapshot(await shopWithSettings(), snapshot("8004", null));
    expect(order).toMatchObject({ customerName: null, customerEmail: null, phone: null });
    expect(JSON.stringify(order.shippingAddress)).not.toContain("Analytical");
  });
});
