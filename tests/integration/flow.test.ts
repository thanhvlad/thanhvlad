/**
 * End-to-end flow against a real PostgreSQL database and the mock supplier:
 *
 *   import → push to Shopify (fake Admin API) → mapping → order ingest →
 *   evaluation → supplier order placement → status sync → tracking →
 *   fulfilment → inventory sync → reports.
 *
 * Run with:  TEST_DATABASE_URL=postgresql://... npm test -- tests/integration
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ShopWithSettings } from "~/services/shop.server";
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

describe.skipIf(!TEST_DB)("full dropshipping flow (postgres + mock supplier)", () => {
  let prisma: PrismaClient;
  let shop: ShopWithSettings;
  const domain = `flow-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    prisma = (await import("~/db.server")).default;
    const { getOrCreateShop } = await import("~/services/shop.server");
    shop = await getOrCreateShop(domain);
    await prisma.shop.update({ where: { id: shop.id }, data: { currency: "USD", country: "US", primaryLocationId: "gid://shopify/Location/1" } });
    shop = (await (await import("~/services/shop.server")).getShopById(shop.id))!;
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: shop.id } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  let importedId = "";
  let productId = "";
  let orderId = "";
  let purchaseOrderId = "";

  it("adds a supplier product to the import list with prices from the default rule", async () => {
    const { addToImportList } = await import("~/services/import.server");
    const imported = await addToImportList(shop, "https://www.aliexpress.com/item/1005006002.html");
    importedId = imported.id;
    expect(imported.title).toContain("Watch");
    expect(imported.variants).toHaveLength(6);
    expect(imported.supplierProduct?.platform).toBe("ALIEXPRESS");
    // 2x markup + .99 ending
    expect(imported.variants[0].price.toString()).toMatch(/\.99/);
    expect(Number(imported.variants[0].price)).toBeGreaterThan(Number(imported.variants[0].cost));

    // Idempotent: adding again returns the same row.
    const again = await addToImportList(shop, "1005006002");
    expect(again.id).toBe(importedId);
  });

  it("pushes the product to Shopify and auto-creates a BASIC mapping", async () => {
    const { pushImportedProduct } = await import("~/services/import.server");
    const result = await pushImportedProduct(shop, fake.client, importedId);
    expect(result.ok).toBe(true);
    productId = result.productId!;
    expect(fake.calls.map((c) => c.operation)).toContain("DropshipProductSet");
    expect(fake.calls.map((c) => c.operation)).toContain("DropshipPublish");

    const { getProduct } = await import("~/services/products.server");
    const product = await getProduct(shop.id, productId);
    expect(product?.variants).toHaveLength(6);
    expect(product?.mapping?.type).toBe("BASIC");
    expect(product?.variants.every((v) => v.variantMappings.length === 1)).toBe(true);
    const imported = await prisma.importedProduct.findUnique({ where: { id: importedId } });
    expect(imported?.status).toBe("PUSHED");
  });

  it("switches to ADVANCED mapping with a per-country option and auto-maps by options", async () => {
    const { autoMapByOptions, saveMapping, getMapping, resolveForVariant } = await import("~/services/mapping.server");
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: true } });
    const supplierProduct = await prisma.supplierProduct.findFirstOrThrow({ where: { externalId: "1005006002" } });
    const rows = await autoMapByOptions(productId, supplierProduct.id);
    expect(rows).toHaveLength(6);

    await saveMapping(shop.id, productId, { type: "ADVANCED", rows: rows.map((r, i) => ({ ...r, priority: 0, shipToCountry: i === 0 ? "US" : "*" })) });
    const mapping = await getMapping(productId);
    expect(mapping?.type).toBe("ADVANCED");
    expect(mapping?.variants).toHaveLength(6);

    const resolved = await resolveForVariant(product.variants[0].id, "US", 2);
    expect(resolved.ok).toBe(true);
    expect(resolved.lines[0].quantity).toBe(2);
  });

  it("ingests a Shopify order, validates the address and moves it to AWAITING_ORDER", async () => {
    const { upsertOrderFromSnapshot, orderIssues } = await import("~/services/orders.server");
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: true } });
    const variant = product.variants[1];
    const snapshot = {
      id: "gid://shopify/Order/9001",
      name: "#1001",
      orderNumber: 1001,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      email: "jane@example.com",
      phone: null,
      note: null,
      tags: [],
      test: false,
      riskLevel: "LOW",
      currencyCode: "USD",
      totalPrice: "45.98",
      totalShipping: "0.00",
      totalTax: "0.00",
      totalDiscounts: "0.00",
      customer: { firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: null },
      customAttributes: [],
      shippingAddress: { firstName: "Jane", lastName: "Doe", name: "Jane Doe", company: null, address1: "123 Main St", address2: null, city: "Austin", province: "Texas", provinceCode: "TX", zip: "78701", country: "United States", countryCodeV2: "US", phone: "+1 512 555 0100" },
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: product.title, variantTitle: variant.title, sku: variant.sku, quantity: 2, unfulfilledQuantity: 2, productId: product.shopifyProductId, variantId: variant.shopifyVariantId, image: null, price: "22.99", totalDiscount: "0", requiresShipping: true },
        { id: "gid://shopify/LineItem/2", title: "Gift card", variantTitle: null, sku: null, quantity: 1, unfulfilledQuantity: 1, productId: null, variantId: null, image: null, price: "10.00", totalDiscount: "0", requiresShipping: false },
      ],
    };
    const order = await upsertOrderFromSnapshot(shop, snapshot);
    orderId = order.id;
    expect(order.stage).toBe("AWAITING_ORDER");
    expect(orderIssues(order).filter((i) => i.severity === "error")).toEqual([]);
    fake.fulfillmentLineItems = [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }];
  });

  it("holds an order with a missing phone and releases it after the address is fixed", async () => {
    const { upsertOrderFromSnapshot, updateOrderAddress, orderIssues } = await import("~/services/orders.server");
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: true } });
    const held = await upsertOrderFromSnapshot(shop, {
      id: "gid://shopify/Order/9002", name: "#1002", orderNumber: 1002, createdAt: new Date().toISOString(), cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED",
      email: "b@example.com", phone: null, note: null, tags: [], test: false, riskLevel: null, currencyCode: "USD", totalPrice: "22.99", totalShipping: "0", totalTax: "0", totalDiscounts: "0",
      customer: null, customAttributes: [],
      shippingAddress: { firstName: "Bob", lastName: "Silva", name: "Bob Silva", company: null, address1: "Rua A 1", address2: null, city: "São Paulo", province: "SP", provinceCode: "SP", zip: "01310-100", country: "Brazil", countryCodeV2: "BR", phone: null },
      lineItems: [{ id: "gid://shopify/LineItem/3", title: product.title, variantTitle: null, sku: null, quantity: 1, unfulfilledQuantity: 1, productId: product.shopifyProductId, variantId: product.variants[2].shopifyVariantId, image: null, price: "22.99", totalDiscount: "0", requiresShipping: true }],
    });
    expect(held.stage).toBe("PENDING");
    const codes = orderIssues(held).map((i) => i.code);
    expect(codes).toContain("ADDRESS_MISSING_PHONE");
    expect(codes).toContain("ADDRESS_MISSING_TAX_ID");

    const fixed = await updateOrderAddress(shop, null, held.id, { phone: "+55 11 99999 0000", taxNumber: "123.456.789-09" }, { pushToShopify: false });
    expect(fixed.stage).toBe("AWAITING_ORDER");
  });

  it("places the supplier order, tags Shopify and records costs", async () => {
    const { placeSupplierOrders } = await import("~/services/fulfillment.server");
    const outcome = await placeSupplierOrders(shop, orderId, { actor: "test" });
    expect(outcome.ok).toBe(true);
    expect(outcome.purchaseOrderIds).toHaveLength(1);
    purchaseOrderId = outcome.purchaseOrderIds[0];

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { items: true } });
    expect(po.status).toBe("AWAITING_PAYMENT");
    expect(po.externalOrderId).toMatch(/^MOCK-/);
    expect(po.items).toHaveLength(1);
    expect(po.items[0].quantity).toBe(2);
    expect(Number(po.totalCost)).toBeGreaterThan(0);
    expect(po.carrierCode).toBeTruthy();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.stage).toBe("AWAITING_PAYMENT");
    expect(Number(order.supplierCost)).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.operation === "DropshipTagsAdd")).toBe(true);

    // Placing again is a no-op (no duplicate purchase orders).
    const again = await placeSupplierOrders(shop, orderId);
    expect(again.purchaseOrderIds).toEqual([purchaseOrderId]);
    expect(await prisma.purchaseOrder.count({ where: { orderId } })).toBe(1);
  });

  it("syncs supplier status without regressing and captures tracking into a Shopify fulfilment", async () => {
    const { syncPurchaseOrder, addManualTracking } = await import("~/services/fulfillment.server");
    const first = await syncPurchaseOrder(shop, purchaseOrderId);
    expect(["AWAITING_PAYMENT", "PAID"]).toContain(first.status);

    // Tracking arrives (manual entry stands in for the supplier shipping later).
    await addManualTracking(shop, purchaseOrderId, { number: "LP123456789CN", carrierName: "AliExpress Standard" });
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { trackings: true } });
    expect(po.status).toBe("SHIPPED");
    expect(po.trackings[0].syncedToShopify).toBe(true);
    expect(po.trackings[0].shopifyFulfillmentId).toMatch(/Fulfillment/);
    expect(fake.calls.some((c) => c.operation === "DropshipFulfillmentCreate")).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lineItems: true } });
    expect(order.stage).toBe("AWAITING_DELIVERY");
    expect(order.lineItems.find((li) => li.shopifyLineItemId === "gid://shopify/LineItem/1")?.isFulfilled).toBe(true);

    // A later "PAID" read from upstream must not undo SHIPPED.
    const second = await syncPurchaseOrder(shop, purchaseOrderId);
    expect(second.status).toBe("SHIPPED");
  });

  it("runs the inventory sync policy and applies changes through the Admin API", async () => {
    const { runInventorySync, updateInventoryPolicy } = await import("~/services/inventory-sync.server");
    await updateInventoryPolicy(shop.id, { priceAction: "UPDATE_PRICE", stockAction: "UPDATE_QUANTITY", maxInventoryPushed: 30 });
    // Force a visible cost drift on one variant so the policy has work to do.
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId } });
    await prisma.productVariant.update({ where: { id: variant.id }, data: { cost: "1.00", price: "2.99", inventoryQuantity: 0 } });

    const dry = await runInventorySync(shop, fake.client, { dryRun: true });
    expect(dry.productsChecked).toBe(1);
    expect(dry.plannedActions.some((a) => a.type === "UPDATE_PRICE")).toBe(true);
    expect(dry.plannedActions.some((a) => a.type === "UPDATE_INVENTORY")).toBe(true);

    const live = await runInventorySync(shop, fake.client, {});
    expect(live.priceUpdates).toBeGreaterThan(0);
    expect(live.inventoryUpdates).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.operation === "DropshipInventorySet")).toBe(true);
    const updated = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(Number(updated.price)).toBeGreaterThan(2.99);
    expect(updated.inventoryQuantity).toBeGreaterThan(0);
    expect(updated.inventoryQuantity).toBeLessThanOrEqual(30);
  });

  it("rolls up daily metrics and answers the dashboard", async () => {
    const { rollupDailyMetrics, getDashboardStats, getReport } = await import("~/services/reports.server");
    const metric = await rollupDailyMetrics(shop.id, new Date());
    expect(metric.orders).toBe(2);
    expect(Number(metric.revenue)).toBeCloseTo(45.98 + 22.99, 2);
    expect(Number(metric.productCost)).toBeGreaterThan(0);

    const stats = await getDashboardStats(shop.id);
    expect(stats.products.total).toBe(1);
    expect(stats.stages.AWAITING_DELIVERY).toBe(1);
    expect(stats.stages.AWAITING_ORDER).toBe(1);

    const report = await getReport(shop.id, { from: new Date(Date.now() - 86_400_000), to: new Date() });
    expect(report.totals.orders).toBe(2);
    expect(report.topProducts[0]?.units).toBe(3);
  });

  it("records activity and notifications along the way", async () => {
    const { listActivity } = await import("~/services/activity.server");
    const activity = await listActivity(shop.id, { limit: 100 });
    const actions = activity.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["import.added", "product.pushed", "mapping.saved", "order.placed", "tracking.added", "tracking.synced", "inventory.synced"]));
    const { listNotifications } = await import("~/services/notifications.server");
    const notifications = await listNotifications(shop.id);
    expect(notifications.length).toBeGreaterThan(0);
  });
});
