/**
 * End-to-end demo of the whole merchant flow, against your own database.
 *
 *   SUPPLIER_DRIVER=mock DATABASE_URL=postgresql://... npm run demo
 *
 * It drives the real services — the same code the admin UI calls — with the
 * Demo supplier and a stand-in Shopify Admin API, and prints what happened at
 * each step: connect a supplier, import a product, push it, map its variants,
 * take an order, place it with the supplier, watch it get paid and shipped,
 * sync the tracking number into a Shopify fulfilment, run the auto-update
 * policy and roll up the reports.
 *
 * Use it to check a fresh deployment, to see the pipeline without installing on
 * a store, or as the scripted walkthrough for an App Store reviewer.
 *
 * Flags:
 *   --quick   enter the tracking number by hand instead of waiting the ~3
 *             minutes the Demo supplier takes to "ship" the parcel
 *   --keep    leave the demo shop and its rows in the database afterwards
 *
 * Development-only: it imports the test's Shopify stand-in, so it needs a full
 * checkout (not the pruned production image), and it refuses to run against a
 * live supplier driver — the orders it places would be real ones.
 */
import type { PrismaClient } from "@prisma/client";
import { createFakeShopify } from "../tests/integration/fake-shopify";
import type { ShopWithSettings } from "../app/services/shop.server";

const QUICK = process.argv.includes("--quick");
const KEEP = process.argv.includes("--keep");
const SHIP_TIMEOUT_MS = 5 * 60_000;

const fake = createFakeShopify();

let step = 0;
function say(title: string, ...lines: string[]) {
  step += 1;
  console.log(`\n${String(step).padStart(2, "0")}. ${title}`);
  for (const line of lines) console.log(`    ${line}`);
}
function detail(...lines: string[]) {
  for (const line of lines) console.log(`    ${line}`);
}

async function main() {
  const driver = process.env.SUPPLIER_DRIVER ?? "mock";
  if (driver !== "mock") {
    console.error(
      `Refusing to run: SUPPLIER_DRIVER is "${driver}". The demo places orders, and against a live driver those would be real supplier orders.\nRun it with SUPPLIER_DRIVER=mock.`,
    );
    process.exit(1);
  }

  const prisma: PrismaClient = (await import("../app/db.server")).default;
  const { getOrCreateShop, getShopById } = await import("../app/services/shop.server");
  const domain = `demo-run-${Date.now()}.myshopify.com`;

  console.log("DropshipHub — end-to-end demo");
  console.log(`Database: ${(process.env.DATABASE_URL ?? "").replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`Store:    ${domain}${QUICK ? "  (--quick)" : ""}`);

  let shop: ShopWithSettings = await getOrCreateShop(domain);
  await prisma.shop.update({
    where: { id: shop.id },
    data: { name: "Demo Store", country: "US", currency: "USD", primaryLocationId: "gid://shopify/Location/1" },
  });
  shop = (await getShopById(shop.id))!;
  const reload = async () => {
    shop = (await getShopById(shop.id))!;
    return shop;
  };

  // ---- 1. Connect a supplier ------------------------------------------------
  const { createCredentiallessAccount, listSupplierAccounts } = await import("../app/services/supplier-accounts.server");
  await createCredentiallessAccount(shop.id, "MOCK", "Demo supplier");
  const accounts = await listSupplierAccounts(shop.id);
  say("Connected a supplier", `${accounts.length} account: ${accounts.map((a) => `${a.label} (${a.platform})`).join(", ")}`);

  // ---- 2. Pricing rule ------------------------------------------------------
  const { createPricingRule } = await import("../app/services/pricing.server");
  const rule = await createPricingRule(shop.id, {
    name: "Demo markup",
    isDefault: true,
    basePriceOp: "MULTIPLY",
    basePriceValue: "2.2",
    compareAtOp: "MULTIPLY",
    compareAtValue: "1.4",
    centsEnding: 99,
  });
  say("Created the default pricing rule", `${rule.name}: cost x 2.2, compare-at x 1.4, prices ending .99`);

  // ---- 3. Import ------------------------------------------------------------
  const { addToImportList } = await import("../app/services/import.server");
  const imported = await addToImportList(shop, "https://www.aliexpress.com/item/1005006002.html", { actor: "demo" });
  const cheapest = imported.variants.reduce((a, b) => (Number(a.price) < Number(b.price) ? a : b));
  say(
    "Imported a product into the import list",
    `"${imported.title}"`,
    `${imported.variants.length} variants, ${imported.images.length} images`,
    `cheapest variant: cost ${cheapest.cost} → price ${cheapest.price} (compare-at ${cheapest.compareAtPrice ?? "—"})`,
  );

  // ---- 4. Push to Shopify ---------------------------------------------------
  const { pushImportedProduct } = await import("../app/services/import.server");
  const pushed = await pushImportedProduct(shop, fake.client, imported.id, "demo");
  if (!pushed.ok) throw new Error(`Push failed: ${pushed.error}`);
  const productId = pushed.productId!;
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: true } });
  say(
    "Pushed it to Shopify",
    `Shopify product ${product.shopifyProductId}, status ${product.status}`,
    `${product.variants.length} variants created`,
  );

  // ---- 5. Mapping -----------------------------------------------------------
  const { getMapping, resolveForVariant } = await import("../app/services/mapping.server");
  const mapping = await prisma.productMapping.findUniqueOrThrow({ where: { productId }, include: { variants: true } });
  const sample = product.variants[1] ?? product.variants[0];
  const resolved = await resolveForVariant(sample.id, "US", 1);
  say(
    "Mapped every variant to a supplier SKU",
    `mapping type ${mapping.type}, ${mapping.variants.length} rows, all auto-created on push`,
    `test resolve "${sample.title}" → ${resolved.ok ? `supplier SKU ${resolved.lines[0]?.externalSkuId} x${resolved.lines[0]?.quantity} at ${resolved.totalCost} ${resolved.lines[0]?.currency}` : `blocked: ${resolved.reason ?? resolved.failure}`}`,
  );
  void getMapping;

  // ---- 6. Shipping preference ----------------------------------------------
  const { upsertShippingPreference, listShippingPreferences } = await import("../app/services/shipping.server");
  await upsertShippingPreference(shop.id, { countryCode: "*", carrierCode: "EPACKET", carrierName: "ePacket", priority: 0, maxCost: "12", requireTracking: true });
  await upsertShippingPreference(shop.id, { countryCode: "*", carrierCode: "STANDARD", carrierName: "Standard", priority: 1, maxCost: "12" });
  const prefs = await listShippingPreferences(shop.id);
  say("Set the shipping rules", `${prefs.length} rule(s) for any country: ${prefs.map((p) => p.carrierName ?? p.carrierCode).join(" then ")}, max $12, tracking required`);

  // ---- 7. An order arrives --------------------------------------------------
  const { upsertOrderFromSnapshot } = await import("../app/services/orders.server");
  const variant = product.variants[1] ?? product.variants[0];
  const order = await upsertOrderFromSnapshot(shop, {
    id: "gid://shopify/Order/900001",
    name: "#1001",
    orderNumber: 1001,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    email: "buyer@example.com",
    phone: null,
    note: null,
    tags: [],
    test: false,
    riskLevel: "LOW",
    currencyCode: "USD",
    totalPrice: String(variant.price),
    totalShipping: "0.00",
    totalTax: "0.00",
    totalDiscounts: "0.00",
    customer: { firstName: "Mai", lastName: "Nguyen", email: "buyer@example.com", phone: "+15125550100" },
    customAttributes: [],
    shippingAddress: {
      firstName: "Mai", lastName: "Nguyen", name: "Mai Nguyen", company: null,
      address1: "123 Main St", address2: null, city: "Austin", province: "Texas",
      provinceCode: "TX", zip: "78701", country: "United States", countryCodeV2: "US",
      phone: "+15125550100",
    },
    lineItems: [
      {
        id: "gid://shopify/LineItem/900001", title: product.title, variantTitle: variant.title, sku: variant.sku,
        quantity: 1, unfulfilledQuantity: 1, productId: product.shopifyProductId, variantId: variant.shopifyVariantId,
        image: null, price: String(variant.price), totalDiscount: "0", requiresShipping: true,
      },
    ],
  });
  fake.fulfillmentLineItems = [{ lineItemId: "gid://shopify/LineItem/900001", quantity: 1 }];
  say(
    "A paid Shopify order arrived",
    `${order.name} to ${order.customerName}, ${order.countryCode}`,
    `stage: ${order.stage}${(order.issues as string[] | null)?.length ? ` — issues: ${(order.issues as string[]).join(", ")}` : " — no issues"}`,
  );

  // ---- 8. Place with the supplier ------------------------------------------
  const { placeSupplierOrders } = await import("../app/services/fulfillment.server");
  const outcome = await placeSupplierOrders(shop, order.id, { actor: "demo" });
  if (!outcome.ok) throw new Error(`Placement failed: ${outcome.error ?? outcome.issues?.join("; ") ?? "unknown"}`);
  const poId = outcome.purchaseOrderIds[0];
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { items: true } });
  say(
    "Placed it with the supplier",
    `supplier order ${po.externalOrderId} — status ${po.status}`,
    `items ${po.itemsCost} + shipping ${po.shippingCost} = ${po.totalCost} ${po.currency}`,
    `carrier chosen: ${po.items[0]?.carrierName ?? po.items[0]?.carrierCode ?? "—"}, ~${po.items[0]?.estimatedDeliveryDays ?? "?"} days`,
    `idempotency key ${po.idempotencyKey}`,
  );

  // Placing again must not create a second supplier order.
  const again = await placeSupplierOrders(shop, order.id, { actor: "demo" });
  detail(`placing again returns the same order: ${again.purchaseOrderIds[0] === poId ? "yes" : "NO — that is a bug"}`);

  // ---- 9. Payment -----------------------------------------------------------
  const { getPaymentQueue, checkPayments } = await import("../app/services/payments.server");
  const queue = await getPaymentQueue(shop.id);
  say(
    "It is waiting for payment on the supplier's site",
    `${queue.items.length} unpaid order(s), ${queue.totals.map((t) => `${t.amount} ${t.currency}`).join(", ")}`,
    `pay link: ${queue.items[0]?.paymentUrl ?? "—"}, ${queue.items[0]?.hoursLeft ?? "?"}h left before the supplier cancels it`,
    `AliExpress cancels unpaid orders after 24h; the app counts down and never charges your account itself`,
  );

  // ---- 10. The supplier pays, ships ----------------------------------------
  const { syncPurchaseOrder, syncPendingTracking, addManualTracking } = await import("../app/services/fulfillment.server");
  if (QUICK) {
    await checkPayments(shop);
    await addManualTracking(shop, poId, { number: "LP123456789CN", carrierName: "AliExpress Standard" }, "demo", fake.client);
    say("Entered a tracking number by hand (--quick)", "LP123456789CN via AliExpress Standard");
  } else {
    say("Waiting for the supplier to charge and ship it", "the Demo supplier pays after ~1 min and ships after ~3 min");
    const started = Date.now();
    let last = "";
    for (;;) {
      const result = await syncPurchaseOrder(shop, poId);
      const line = `${Math.round((Date.now() - started) / 1000)}s — status ${result.status}${result.newTracking ? `, ${result.newTracking} tracking number(s)` : ""}`;
      if (line.slice(line.indexOf("—")) !== last.slice(last.indexOf("—"))) {
        detail(line);
        last = line;
      }
      if (result.status === "SHIPPED" || result.status === "DELIVERED") break;
      if (Date.now() - started > SHIP_TIMEOUT_MS) throw new Error("The supplier did not ship inside the timeout");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // ---- 11. Tracking into a Shopify fulfilment ------------------------------
  await syncPendingTracking(shop, poId, fake.client);
  const shipped = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { trackings: true } });
  const fulfilments = fake.calls.filter((c) => c.operation === "DropshipFulfillmentCreate").length;
  say(
    "Synced the tracking number into Shopify",
    ...shipped.trackings.map((t) => `${t.number} (${t.carrierName ?? t.carrierCode ?? "?"}) → fulfilment ${t.shopifyFulfillmentId ?? "—"}${t.syncedToShopify ? "" : "  NOT SYNCED"}`),
    `fulfilmentCreate calls to Shopify: ${fulfilments}`,
  );

  const afterShip = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { lineItems: true } });
  detail(`order stage is now ${afterShip.stage}, ${afterShip.lineItems.filter((li) => li.isFulfilled).length}/${afterShip.lineItems.length} line item(s) fulfilled`);

  // ---- 12. Auto price and stock updates ------------------------------------
  const { runInventorySync, updateInventoryPolicy } = await import("../app/services/inventory-sync.server");
  await updateInventoryPolicy(shop.id, { isEnabled: true, priceAction: "UPDATE_PRICE", stockAction: "UPDATE_QUANTITY", maxInventoryPushed: 30 });
  const first = await prisma.productVariant.findFirstOrThrow({ where: { productId } });
  await prisma.productVariant.update({ where: { id: first.id }, data: { cost: "1.00", price: "2.99", inventoryQuantity: 0 } });
  const dry = await runInventorySync(shop, fake.client, { dryRun: true });
  const live = await runInventorySync(shop, fake.client, {});
  const repriced = await prisma.productVariant.findUniqueOrThrow({ where: { id: first.id } });
  say(
    "Ran the auto-update policy against the supplier",
    `dry run planned ${dry.plannedActions.length} change(s) on ${dry.productsChecked} product(s)`,
    `applied: ${live.priceUpdates} price update(s), ${live.inventoryUpdates} stock update(s)`,
    `the drifted variant went from 2.99 → ${repriced.price}, stock 0 → ${repriced.inventoryQuantity} (capped at 30)`,
  );

  // ---- 13. Reports ----------------------------------------------------------
  const { rollupDailyMetrics, getDashboardStats } = await import("../app/services/reports.server");
  await rollupDailyMetrics(shop.id, new Date());
  const stats = await getDashboardStats(shop.id);
  say(
    "Rolled up the reports",
    `7-day revenue ${stats.week.revenue}, profit ${stats.week.profit}, ${stats.week.orders} order(s)`,
    `orders by stage: ${Object.entries(stats.stages).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(", ")}`,
    `${stats.products.total} managed product(s), ${stats.products.unmapped} unmapped`,
  );

  // ---- 14. Trail ------------------------------------------------------------
  const { listActivity } = await import("../app/services/activity.server");
  const { listNotifications } = await import("../app/services/notifications.server");
  const activity = await listActivity(shop.id, { limit: 100 });
  const notifications = await listNotifications(shop.id);
  say(
    "Everything is on the record",
    `${activity.length} activity entries: ${[...new Set(activity.map((a) => a.action))].slice(0, 8).join(", ")}`,
    `${notifications.length} notification(s): ${notifications.slice(0, 3).map((n) => n.title).join(" · ")}`,
  );

  await reload();
  console.log(`\nDone. Every step ran through the same services the admin UI calls.`);
  if (KEEP) {
    console.log(`The demo store ${domain} was left in the database (--keep).`);
  } else {
    await prisma.shop.delete({ where: { id: shop.id } }).catch(() => undefined);
    if (shop.accountId) await prisma.account.delete({ where: { id: shop.accountId } }).catch(() => undefined);
    console.log(`Cleaned up the demo store. Pass --keep to leave it for browsing in the UI.`);
  }
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : error);
  console.error(error);
  process.exit(1);
});
