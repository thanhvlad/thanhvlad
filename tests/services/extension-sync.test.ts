/**
 * The extension's checkout-total quote, the orders-page sync and the
 * tracking-page sync: the server side of "land on the checkout with
 * everything filled in, press Pay now, and the order status syncs itself".
 *
 * Everything fulfillment.server.ts talks to is replaced with a stub, so these
 * run without a database or Shopify and assert what would have been written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseShopSettings } from "~/domain/settings/shop-settings";
import { resetRateLimits } from "~/lib/rate-limit.server";
import type { ShopWithSettings } from "~/services/shop.server";

const mocks = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      $transaction: fn(),
      order: { findUnique: fn(), update: fn() },
      purchaseOrder: { findFirst: fn(), findMany: fn(), create: fn(), update: fn(), updateMany: fn(), count: fn() },
      activityLog: { findFirst: fn() },
      purchaseOrderItem: { findMany: fn() },
      trackingNumber: { findMany: fn(), findFirst: fn(), updateMany: fn(), update: fn(), upsert: fn() },
      orderLineItem: { findMany: fn(), update: fn() },
      shop: { findUnique: fn() },
    },
    logActivity: fn(),
    notify: fn(),
    evaluateAndStoreOrder: fn(),
    addOrderTags: fn(),
    offlineClient: fn(),
    getKnownRate: fn(),
  };
});

vi.mock("~/db.server", () => ({ default: mocks.prisma }));
vi.mock("~/services/activity.server", () => ({ logActivity: mocks.logActivity }));
vi.mock("~/services/notifications.server", () => ({ notify: mocks.notify }));
vi.mock("~/services/currency.server", () => ({ getKnownRate: mocks.getKnownRate }));
vi.mock("~/services/orders.server", () => ({
  evaluateAndStoreOrder: mocks.evaluateAndStoreOrder,
  lineResolution: vi.fn(),
  orderIssues: vi.fn(() => []),
  supplierAddressFor: (order: { shippingAddress: unknown }) => order.shippingAddress,
}));
vi.mock("~/services/shipping.server", () => ({ chooseShippingForShop: vi.fn() }));
vi.mock("~/services/shop.server", () => ({ withSettings: (shop: object) => ({ ...shop, parsedSettings: parseShopSettings({}) }) }));
vi.mock("~/services/shopify/graphql.server", () => ({ offlineClient: mocks.offlineClient, gql: vi.fn() }));
vi.mock("~/services/shopify/orders.server", () => ({ addOrderTags: mocks.addOrderTags, createFulfillmentWithTracking: vi.fn(), updateFulfillmentTracking: vi.fn() }));
vi.mock("~/services/supplier-accounts.server", () => ({ touchSupplierAccount: vi.fn() }));
vi.mock("~/services/suppliers/catalog.server", () => ({ getShippingOptions: vi.fn() }));
vi.mock("~/services/suppliers/index.server", () => ({
  EXTENSION_PLACEMENT_STEPS: "(extension steps)",
  adapterForShop: vi.fn(),
  placementModeForShop: vi.fn(async () => "extension"),
  supplierProductUrl: (platform: string, id: string | null) => (platform === "ALIEXPRESS" && id ? `https://www.aliexpress.com/item/${id}.html` : null),
  unavailableReason: (platform: string) => `${platform} cannot be reached from DropshipHub yet.`,
}));

const fulfillment = await import("~/services/fulfillment.server");

function makeShop(overrides: Partial<ShopWithSettings> = {}): ShopWithSettings {
  return {
    id: "shop1",
    domain: "real-store.myshopify.com",
    currency: "USD",
    isDevelopmentStore: false,
    isActive: true,
    apiToken: "dsh_abcdefghijklmnopqrstuvwxyz012345",
    parsedSettings: parseShopSettings({}),
    ...overrides,
  } as ShopWithSettings;
}

const orderRef = { id: "order1", name: "#21047", shopifyOrderId: "gid://shopify/Order/1", canceledAt: null };

/** A purchase order priced in VND from the Vietnamese product page, waiting for the extension. */
const waiting = {
  id: "po_waiting01",
  orderId: "order1",
  status: "AWAITING_PLACEMENT",
  platform: "ALIEXPRESS",
  currency: "VND",
  itemsCost: "1724188",
  shippingCost: "0",
  totalCost: "1724188",
  shopCurrency: "USD",
  shopItemsCost: "66.10",
  shopShippingCost: "0",
  externalOrderId: null,
  paymentUrl: null,
  paidAt: null,
  shippedAt: null,
  placedAt: null,
  raw: { placementMode: "extension" },
  createdAt: new Date(),
  order: orderRef,
  items: [{ externalProductId: "1005010026778896", externalSkuAttr: "14:691#Play blue light;200007763:201441035", supplierVariant: { attributes: [{ name: "Color", value: "Play blue light" }] }, orderLineItem: { variantTitle: "Play blue light" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Queued once-values survive clearAllMocks; a test that did not consume its
  // queue must not feed the next one.
  for (const mock of [mocks.prisma.purchaseOrder.findFirst, mocks.prisma.purchaseOrder.findMany, mocks.prisma.purchaseOrder.update, mocks.prisma.purchaseOrder.updateMany, mocks.prisma.trackingNumber.findFirst]) mock.mockReset();
  resetRateLimits();
  mocks.prisma.purchaseOrder.findMany.mockResolvedValue([]);
  mocks.prisma.purchaseOrder.update.mockResolvedValue({});
  mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.order.findUnique.mockResolvedValue({ currency: "USD" });
  mocks.prisma.order.update.mockResolvedValue({});
  mocks.prisma.trackingNumber.findMany.mockResolvedValue([]);
  mocks.prisma.trackingNumber.findFirst.mockResolvedValue(null);
  mocks.evaluateAndStoreOrder.mockResolvedValue({});
  mocks.offlineClient.mockResolvedValue({});
  mocks.getKnownRate.mockResolvedValue(1);
});

describe("listAwaitingPlacement carries the shop-currency estimate", () => {
  const row = {
    id: "po1",
    platform: "ALIEXPRESS",
    currency: "VND",
    totalCost: "1724188",
    shopCurrency: "USD",
    shopItemsCost: "66.10",
    shopShippingCost: "0",
    supplierNote: null,
    createdAt: new Date("2026-09-15T10:00:00Z"),
    order: { name: "#21047", shippingAddress: { name: "Test Customer", countryCode: "US" } },
    items: [],
  };

  it("adds shopCurrency and the summed shopTotalCost when both parts are on record", async () => {
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([row]);
    const [order] = await fulfillment.listAwaitingPlacement(makeShop());
    expect(order).toMatchObject({ currency: "VND", totalCost: "1724188.00", shopCurrency: "USD", shopTotalCost: "66.10" });
  });

  it("gives null when the conversion is missing or for another currency", async () => {
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([{ ...row, shopItemsCost: null }, { ...row, shopCurrency: "EUR" }]);
    const orders = await fulfillment.listAwaitingPlacement(makeShop());
    expect(orders.map((o) => o.shopTotalCost)).toEqual([null, null]);
    expect(orders.map((o) => o.shopCurrency)).toEqual(["USD", "USD"]);
  });
});

describe("the quote body", () => {
  it("accepts what the checkout panel sends and refuses anything else", () => {
    const body = fulfillment.ExtensionQuoteBody;
    expect(body.safeParse({ currency: "USD", total: "93.62", subtotal: "85.89", shipping: "2.99", charges: "4.74", source: "confirm" }).success).toBe(true);
    expect(body.safeParse({ currency: "USD", total: "0", source: "confirm" }).success).toBe(true);
    expect(body.safeParse({ currency: "usd", total: "1", source: "confirm" }).success).toBe(false);
    expect(body.safeParse({ currency: "USD", total: "-1", source: "confirm" }).success).toBe(false);
    expect(body.safeParse({ currency: "USD", total: "1e3", source: "confirm" }).success).toBe(false);
    expect(body.safeParse({ currency: "USD", total: "1", source: "cart" }).success).toBe(false);
    expect(body.safeParse({ currency: "USD", total: "1", source: "confirm", extra: 1 }).success).toBe(false);
    expect(body.safeParse({ currency: "USD", source: "confirm" }).success).toBe(false);
  });
});

describe("recordSupplierQuote", () => {
  const quote = { currency: "USD", total: "93.62", subtotal: "85.89", shipping: "2.99", charges: "4.74", source: "confirm" as const };

  it("is scoped to the token's shop", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const answer = await fulfillment.recordSupplierQuote(makeShop(), "po_other_shop", quote);
    expect(answer.status).toBe(404);
    expect(mocks.prisma.purchaseOrder.findFirst.mock.calls[0][0].where).toEqual({ id: "po_other_shop", order: { shopId: "shop1" } });
  });

  it("replaces the captured estimate with the page's total, converts it, logs it and re-evaluates", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(waiting);
    mocks.getKnownRate.mockResolvedValue(1);

    const answer = await fulfillment.recordSupplierQuote(makeShop(), waiting.id, quote);

    expect(answer).toMatchObject({ status: 200, body: { ok: true, currency: "USD", totalCost: "93.62", itemsCost: "85.89", shippingCost: "7.73" } });
    const { data } = mocks.prisma.purchaseOrder.update.mock.calls[0][0];
    expect(data).toMatchObject({ currency: "USD", itemsCost: "85.89", shippingCost: "7.73", totalCost: "93.62", shopCurrency: "USD", shopItemsCost: "85.89", shopShippingCost: "7.73" });
    expect(data.raw).toMatchObject({ placementMode: "extension", quote: { source: "confirm" } });
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ action: "order.supplier_quote", message: "#21047: AliExpress shows 93.62 USD at checkout (the estimate was 1724188.00 VND)." }));
    expect(mocks.prisma.order.update).toHaveBeenCalled();
    expect(mocks.evaluateAndStoreOrder).toHaveBeenCalledWith(expect.objectContaining({ id: "shop1" }), "order1");
  });

  it("takes the goods as total less shipping and charges when the page's rows do not add up, never below zero", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(waiting);
    await fulfillment.recordSupplierQuote(makeShop(), waiting.id, { currency: "USD", total: "83.62", shipping: "2.99", charges: "4.74", source: "confirm" });
    expect(mocks.prisma.purchaseOrder.update.mock.calls[0][0].data).toMatchObject({ itemsCost: "75.89", shippingCost: "7.73", totalCost: "83.62" });

    mocks.prisma.purchaseOrder.update.mockClear();
    await fulfillment.recordSupplierQuote(makeShop(), waiting.id, { currency: "USD", total: "1.00", shipping: "5.00", source: "confirm" });
    expect(mocks.prisma.purchaseOrder.update.mock.calls[0][0].data).toMatchObject({ itemsCost: "0.00", shippingCost: "5.00", totalCost: "1.00" });
  });

  it("clears the shop-currency amounts rather than keep the old currency's when no rate is on record", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(waiting);
    mocks.getKnownRate.mockResolvedValue(null);
    await fulfillment.recordSupplierQuote(makeShop({ currency: "GBP" }), waiting.id, quote);
    expect(mocks.prisma.purchaseOrder.update.mock.calls[0][0].data).toMatchObject({ shopCurrency: null, shopItemsCost: null, shopShippingCost: null, fxRate: null });
  });

  it("changes nothing when the same total is sent again", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...waiting, currency: "USD", itemsCost: "85.89", shippingCost: "7.73", totalCost: "93.62" });
    const answer = await fulfillment.recordSupplierQuote(makeShop(), waiting.id, quote);
    expect(answer).toMatchObject({ status: 200, body: { ok: true, unchanged: true } });
    expect(mocks.prisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("is refused once the purchase order is paid, shipped or cancelled", async () => {
    for (const status of ["PAID", "SHIPPED", "DELIVERED", "CANCELED", "FAILED"]) {
      mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...waiting, status });
      const answer = await fulfillment.recordSupplierQuote(makeShop(), waiting.id, quote);
      expect(answer.status, status).toBe(409);
    }
    for (const status of ["AWAITING_PAYMENT", "PLACED"]) {
      mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...waiting, status });
      expect((await fulfillment.recordSupplierQuote(makeShop(), waiting.id, quote)).status, status).toBe(200);
    }
    expect(mocks.prisma.purchaseOrder.update).toHaveBeenCalledTimes(2);
  });
});

describe("AliExpress status words", () => {
  it("map to the purchase order statuses, unpaid before paid, closed reported apart", () => {
    const map = fulfillment.aliExpressStatusToPurchaseOrderStatus;
    expect(map("To pay")).toBe("AWAITING_PAYMENT");
    expect(map("Awaiting payment")).toBe("AWAITING_PAYMENT");
    expect(map("Unpaid")).toBe("AWAITING_PAYMENT");
    expect(map("Awaiting shipment")).toBe("PAID");
    expect(map("Processing")).toBe("PAID");
    expect(map("Paid")).toBe("PAID");
    expect(map("Awaiting delivery")).toBe("SHIPPED");
    expect(map("Shipped")).toBe("SHIPPED");
    expect(map("Partially shipped")).toBe("SHIPPED");
    expect(map("Completed")).toBe("DELIVERED");
    expect(map("Received")).toBe("DELIVERED");
    expect(map("Closed")).toBe("CANCELED");
    expect(map("Cancelled")).toBe("CANCELED");
    expect(map("Something new")).toBeNull();
    expect(map("")).toBeNull();
    expect(map(undefined)).toBeNull();
  });
});

describe("the sync bodies", () => {
  it("accept order ids of 10 to 24 digits, digit product ids, and at most 100 orders", () => {
    const body = fulfillment.ExtensionSyncOrdersBody;
    const order = { orderId: "8190000000000001", productIds: ["3256809840464144", "1005010026778896"], skuText: "Play blue light", status: "Awaiting delivery", total: "$93.62", date: "Sep 15, 2026" };
    expect(body.safeParse({ orders: [order] }).success).toBe(true);
    expect(body.safeParse({ orders: [{ orderId: "8190000000000001" }] }).success).toBe(true);
    expect(body.safeParse({ orders: [] }).success).toBe(false);
    expect(body.safeParse({ orders: [{ ...order, orderId: "123" }] }).success).toBe(false);
    expect(body.safeParse({ orders: [{ ...order, orderId: "8190000000000001x" }] }).success).toBe(false);
    expect(body.safeParse({ orders: [{ ...order, productIds: ["abc"] }] }).success).toBe(false);
    expect(body.safeParse({ orders: [{ ...order, address: "1 Main St" }] }).success).toBe(false);
    expect(body.safeParse({ orders: Array.from({ length: 101 }, () => order) }).success).toBe(false);
    expect(body.safeParse({ orders: [{ ...order, skuText: "x".repeat(301) }] }).success).toBe(false);

    const tracking = fulfillment.ExtensionSyncTrackingBody;
    expect(tracking.safeParse({ tradeOrderId: "8190000000000001", trackingNumber: "SWX000000000000000001", carrier: "AliExpress Selection Standard" }).success).toBe(true);
    expect(tracking.safeParse({ tradeOrderId: "8190000000000001", trackingNumber: "SWX000000000000000001" }).success).toBe(true);
    expect(tracking.safeParse({ tradeOrderId: "12", trackingNumber: "SWX000000000000000001" }).success).toBe(false);
    expect(tracking.safeParse({ tradeOrderId: "8190000000000001", trackingNumber: "a b" }).success).toBe(false);
    expect(tracking.safeParse({ tradeOrderId: "8190000000000001", trackingNumber: "SWX1", street: "x" }).success).toBe(false);
  });
});

describe("syncOrdersFromExtension", () => {
  const card = { orderId: "8190000000000001", productIds: ["3256809840464144", "1005010026778896"], skuText: "Play blue light", status: "Awaiting shipment", total: "$93.62", date: "Sep 15, 2026" };

  it("records an AliExpress order on the one purchase order waiting for its product, through the placed path, paid", async () => {
    // Unknown by id, then found again after the record for the status step.
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...waiting, order: { ...orderRef } })
      .mockResolvedValueOnce({ ...waiting, status: "PAID", externalOrderId: card.orderId, raw: { externalOrderIds: [card.orderId] } });
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([waiting]);

    const results = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [card] });

    expect(results).toEqual([{ orderId: card.orderId, result: "recorded", purchaseOrderId: waiting.id, orderName: "#21047", status: "PAID" }]);
    // Matched by the global product id the .us id maps to, within the window, waiting for the extension only.
    const where = mocks.prisma.purchaseOrder.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ order: { shopId: "shop1", canceledAt: null }, status: "AWAITING_PLACEMENT", platform: "ALIEXPRESS" });
    expect(where.items.some.externalProductId.in).toEqual(["3256809840464144", "1005010026778896"]);
    expect(where.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 15 * 24 * 3_600_000);
    // The placed path: conditional write, payment link, the placed tag, the roll-up.
    const write = mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(write.where).toEqual({ id: waiting.id, status: "AWAITING_PLACEMENT" });
    expect(write.data).toMatchObject({ status: "PAID", externalOrderId: card.orderId, paymentUrl: `https://www.aliexpress.com/p/order/detail.html?orderId=${card.orderId}` });
    expect(write.data.raw).toMatchObject({ externalOrderIds: [card.orderId], placedBy: "extension" });
    expect(mocks.addOrderTags).toHaveBeenCalled();
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ action: "order.placed", actor: "extension" }));
  });

  it("records an order still To pay as awaiting payment, and one already shipped moves on at once", async () => {
    // Unknown by id; the placed path reads the waiting row; the status step reads the recorded row.
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...waiting, order: { ...orderRef } })
      .mockResolvedValueOnce({ ...waiting, status: "AWAITING_PAYMENT", externalOrderId: card.orderId });
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([waiting]);
    const [toPay] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, status: "To pay" }] });
    expect(toPay).toMatchObject({ result: "recorded", status: "AWAITING_PAYMENT" });
    expect(mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0].data.status).toBe("AWAITING_PAYMENT");
    expect(mocks.prisma.purchaseOrder.update).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.prisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...waiting, order: { ...orderRef } })
      .mockResolvedValueOnce({ ...waiting, status: "PAID", externalOrderId: card.orderId, paidAt: new Date(), raw: { externalOrderIds: [card.orderId] } });
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([waiting]);
    const [shipped] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, status: "Awaiting delivery" }] });
    expect(shipped).toMatchObject({ result: "recorded", status: "SHIPPED" });
    expect(mocks.prisma.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: waiting.id }, data: expect.objectContaining({ status: "SHIPPED", shippedAt: expect.any(Date) }) }));
  });

  it("advances a known purchase order from the AliExpress status, never backwards, and reports a closed one without touching it", async () => {
    const known = { ...waiting, status: "AWAITING_PAYMENT", externalOrderId: card.orderId, raw: { externalOrderIds: [card.orderId] } };
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(known);

    const [advanced] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, status: "Awaiting delivery" }] });
    expect(advanced).toEqual({ orderId: card.orderId, result: "advanced", purchaseOrderId: waiting.id, orderName: "#21047", status: "SHIPPED" });
    const { data } = mocks.prisma.purchaseOrder.update.mock.calls[0][0];
    expect(data).toMatchObject({ status: "SHIPPED", paymentDueAt: null });
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(data.shippedAt).toBeInstanceOf(Date);
    expect(mocks.logActivity).toHaveBeenCalledWith("shop1", expect.objectContaining({ action: "order.supplier_status", message: expect.stringMatching(/is now SHIPPED/) }));
    // The lookup also covers ids kept in raw.externalOrderIds.
    expect(mocks.prisma.purchaseOrder.findFirst.mock.calls[0][0].where.OR).toEqual([{ externalOrderId: card.orderId }, { raw: { path: ["externalOrderIds"], array_contains: [card.orderId] } }]);

    mocks.prisma.purchaseOrder.update.mockClear();
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue({ ...known, status: "SHIPPED" });
    const [same] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, status: "To pay" }] });
    expect(same).toMatchObject({ result: "already", status: "SHIPPED" });
    const [unknownStatus] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, status: "Something new" }] });
    expect(unknownStatus).toMatchObject({ result: "already" });
    const [closed] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, status: "Closed" }] });
    expect(closed).toMatchObject({ result: "already", closed: true, status: "SHIPPED" });
    expect(mocks.prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it("narrows several waiting purchase orders by the card's SKU text, else reports them as ambiguous", async () => {
    const other = { ...waiting, id: "po_waiting02", order: { ...orderRef, id: "order2", name: "#21048" }, items: [{ externalProductId: "1005010026778896", externalSkuAttr: "14:173#Sunglasses;200007763:201441035", supplierVariant: null, orderLineItem: null }] };
    mocks.prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...other })
      .mockResolvedValueOnce({ ...other, status: "PAID", externalOrderId: card.orderId });
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([waiting, other]);

    const [narrowed] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, skuText: "Sunglasses CN" }] });
    expect(narrowed).toMatchObject({ result: "recorded", purchaseOrderId: "po_waiting02", orderName: "#21048" });
    expect(mocks.prisma.purchaseOrder.updateMany.mock.calls[0][0].where.id).toBe("po_waiting02");

    vi.clearAllMocks();
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([waiting, other]);
    const [ambiguous] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [{ ...card, skuText: "" }] });
    expect(ambiguous).toEqual({ orderId: card.orderId, result: "ambiguous", candidates: [{ purchaseOrderId: waiting.id, orderName: "#21047" }, { purchaseOrderId: "po_waiting02", orderName: "#21048" }] });
    expect(mocks.prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("reports unmatched orders, leaves API-placed purchase orders alone, and de-duplicates the list", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([{ ...waiting, raw: { placementMode: "api" } }]);
    const results = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [card, card, { ...card, orderId: "8190000000000002", productIds: [] }] });
    expect(results).toEqual([
      { orderId: card.orderId, result: "unmatched" },
      { orderId: "8190000000000002", result: "unmatched" },
    ]);
    // No product ids: no candidate query at all.
    expect(mocks.prisma.purchaseOrder.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("does not record against a cancelled Shopify order, and says why", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...waiting, order: { ...orderRef, canceledAt: new Date() } });
    mocks.prisma.purchaseOrder.findMany.mockResolvedValue([waiting]);
    const [result] = await fulfillment.syncOrdersFromExtension(makeShop(), { orders: [card] });
    expect(result).toMatchObject({ result: "unmatched", error: expect.stringMatching(/cancelled in Shopify/) });
    expect(mocks.prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });
});

describe("syncTrackingFromExtension", () => {
  const input = { tradeOrderId: "8190000000000001", trackingNumber: "SWX000000000000000001", carrier: "AliExpress Selection Standard" };
  const placed = { ...waiting, status: "PAID", externalOrderId: input.tradeOrderId, order: orderRef };

  it("adds a new number through the manual tracking path and names the order", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValueOnce(placed).mockResolvedValueOnce({ id: placed.id, status: "PAID" }).mockResolvedValueOnce({ id: placed.id, orderId: "order1", status: "PAID" });
    mocks.prisma.trackingNumber.findFirst.mockResolvedValue(null);
    mocks.prisma.trackingNumber.upsert.mockResolvedValue({ id: "t1", number: input.trackingNumber });

    const answer = await fulfillment.syncTrackingFromExtension(makeShop(), input);

    expect(answer).toMatchObject({ status: 200, body: { ok: true, result: "added", orderName: "#21047", number: input.trackingNumber } });
    expect(mocks.prisma.trackingNumber.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ number: input.trackingNumber, carrierName: input.carrier }) }));
    expect(mocks.prisma.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SHIPPED" }) }));
  });

  it("reports a number already on record without writing, and an unknown AliExpress order as unmatched", async () => {
    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(placed);
    mocks.prisma.trackingNumber.findFirst.mockResolvedValue({ id: "t1" });
    expect(await fulfillment.syncTrackingFromExtension(makeShop(), input)).toMatchObject({ status: 200, body: { ok: true, result: "known" } });
    expect(mocks.prisma.trackingNumber.upsert).not.toHaveBeenCalled();

    mocks.prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    expect(await fulfillment.syncTrackingFromExtension(makeShop(), input)).toMatchObject({ status: 200, body: { ok: true, result: "unmatched" } });
  });
});
