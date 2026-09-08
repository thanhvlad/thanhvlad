import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { refreshRates } from "../currency.server";
import { placeSupplierOrders, syncOpenPurchaseOrders, syncPendingTracking } from "../fulfillment.server";
import { addToImportList, pushImportedProduct } from "../import.server";
import { runInventorySync } from "../inventory-sync.server";
import { runJob } from "../jobs.server";
import { hasFeature } from "../billing.server";
import { notify, sendDigest } from "../notifications.server";
import { checkPayments, sendPaymentReminders } from "../payments.server";
import { syncOrdersFromShopify } from "../orders.server";
import { rollupRange } from "../reports.server";
import { getShopById } from "../shop.server";
import { offlineClient } from "../shopify/graphql.server";
import { processWebhookEvent } from "../webhooks.server";
import { enqueue, registerHandler } from "./queue.server";

/**
 * Job handlers. Each is idempotent where it matters (purchase orders are
 * keyed on their own id; product pushes skip already-pushed rows) so BullMQ
 * retries are safe.
 */
export function registerAllHandlers() {
  registerHandler("push-products", async ({ shopId, importedProductIds, jobRunId, actor }) => {
    const shop = await getShopById(shopId);
    if (!shop) return;
    const client = await offlineClient(shop.domain);
    return runJob(jobRunId, async ({ progress }) => {
      let ok = 0;
      let failed = 0;
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const id of importedProductIds) {
        const result = await pushImportedProduct(shop, client, id, actor);
        results.push({ id, ok: result.ok, error: result.error });
        if (result.ok) ok += 1;
        else failed += 1;
        await progress({ processed: 1, succeeded: result.ok ? 1 : 0, failed: result.ok ? 0 : 1 });
      }
      await notify(shopId, {
        type: "job.finished",
        severity: failed ? "warning" : "info",
        title: `Pushed ${ok} product(s) to Shopify${failed ? `, ${failed} failed` : ""}`,
        link: failed ? "/app/import?status=FAILED" : "/app/products",
      });
      return { ok, failed, results };
    });
  });

  registerHandler("import-references", async ({ shopId, references, jobRunId, actor }) => {
    const shop = await getShopById(shopId);
    if (!shop) return;
    return runJob(jobRunId, async ({ progress }) => {
      let ok = 0;
      const errors: string[] = [];
      for (const reference of references) {
        try {
          await addToImportList(shop, reference, { actor });
          ok += 1;
          await progress({ processed: 1, succeeded: 1 });
        } catch (error) {
          errors.push(`${reference}: ${errorMessage(error)}`);
          await progress({ processed: 1, failed: 1 });
        }
      }
      await notify(shopId, {
        type: "job.finished",
        severity: errors.length ? "warning" : "info",
        title: `Imported ${ok} product(s)${errors.length ? `, ${errors.length} failed` : ""}`,
        link: "/app/import",
      });
      return { ok, failed: errors.length, errors: errors.slice(0, 50) };
    });
  });

  registerHandler("place-orders", async ({ shopId, orderIds, jobRunId, actor }) => {
    const shop = await getShopById(shopId);
    if (!shop) return;
    return runJob(jobRunId, async ({ progress }) => {
      let ok = 0;
      let failed = 0;
      const results: Array<{ orderId: string; ok: boolean; error?: string }> = [];
      for (const orderId of orderIds) {
        try {
          const outcome = await placeSupplierOrders(shop, orderId, { actor });
          results.push({ orderId, ok: outcome.ok, error: outcome.error });
          if (outcome.ok) ok += 1;
          else failed += 1;
          await progress({ processed: 1, succeeded: outcome.ok ? 1 : 0, failed: outcome.ok ? 0 : 1 });
        } catch (error) {
          failed += 1;
          results.push({ orderId, ok: false, error: errorMessage(error) });
          await progress({ processed: 1, failed: 1 });
        }
      }
      await notify(shopId, {
        type: "job.finished",
        severity: failed ? "warning" : "info",
        title: `Placed ${ok} supplier order(s)${failed ? `, ${failed} failed` : ""}`,
        link: failed ? "/app/orders?stage=FAILED" : "/app/orders?stage=AWAITING_PAYMENT",
      });
      return { ok, failed, results };
    });
  });

  registerHandler("sync-orders", async ({ shopId, days, jobRunId }) => {
    const shop = await getShopById(shopId);
    if (!shop) return;
    const client = await offlineClient(shop.domain);
    return runJob(jobRunId, async ({ progress }) => {
      const count = await syncOrdersFromShopify(shop, client, { days, onProgress: () => progress({ processed: 1, succeeded: 1 }) });
      return { count };
    });
  });

  registerHandler("sync-purchase-orders", async ({ shopId, jobRunId }) => {
    const shop = await getShopById(shopId);
    if (!shop || !shop.isActive) return;
    const work = async () => syncOpenPurchaseOrders(shop);
    if (jobRunId) return runJob(jobRunId, async () => ({ ...(await work()) }));
    return work();
  });

  registerHandler("sync-tracking", async ({ shopId, purchaseOrderId }) => {
    const shop = await getShopById(shopId);
    if (!shop || !shop.isActive) return;
    return syncPendingTracking(shop, purchaseOrderId);
  });

  registerHandler("inventory-sync", async ({ shopId, productIds, jobRunId, actor }) => {
    const shop = await getShopById(shopId);
    if (!shop || !shop.isActive) return;
    const client = await offlineClient(shop.domain);
    const work = async (progress?: (n: number) => Promise<unknown>) => {
      const { plannedActions: _planned, ...summary } = await runInventorySync(shop, client, { productIds, actor, onProgress: progress });
      void _planned;
      return summary as unknown as Record<string, unknown>;
    };
    if (jobRunId) return runJob(jobRunId, async ({ progress }) => work(() => progress({ processed: 1, succeeded: 1 })));
    return work();
  });

  registerHandler("process-webhook", async ({ webhookEventId }) => {
    await processWebhookEvent(webhookEventId);
  });

  registerHandler("auto-place-orders", async ({ shopId }) => {
    const shop = await getShopById(shopId);
    if (!shop || !shop.isActive) return;
    const settings = shop.parsedSettings.orders;
    if (!settings.autoPlaceOrders) return;
    // A downgrade after the setting was switched on must not keep placing.
    if (!(await hasFeature(shop, "autoPlaceOrders"))) {
      logger.info("Auto-place skipped: not included in the plan", { shopId });
      return;
    }
    const cutoff = new Date(Date.now() - settings.autoPlaceDelayMinutes * 60_000);
    const ready = await prisma.order.findMany({
      where: { shopId, stage: "AWAITING_ORDER", shopifyCreatedAt: { lte: cutoff }, isTest: false },
      select: { id: true },
      take: 50,
    });
    for (const order of ready) {
      try {
        await placeSupplierOrders(shop, order.id, { actor: "auto-place" });
      } catch (error) {
        logger.error("Auto-place failed", { orderId: order.id, error });
      }
    }
    return { placed: ready.length };
  });

  registerHandler("payment-reminders", async ({ shopId }) => {
    const shop = await getShopById(shopId);
    if (!shop || !shop.isActive) return;
    // Pick up payments made on the supplier site, then warn about what is left.
    const checked = await checkPayments(shop);
    const reminded = await sendPaymentReminders(shop);
    return { ...checked, ...reminded };
  });

  registerHandler("email-digest", async ({ shopId }) => {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, domain: true, settings: true, timezone: true, isActive: true } });
    if (!shop || !shop.isActive) return;
    return sendDigest(shop);
  });

  registerHandler("refresh-rates", async ({ base }) => {
    const count = await refreshRates(base);
    return { count };
  });

  registerHandler("rollup-metrics", async ({ shopId, days }) => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const rolled = await rollupRange(shopId, from, to);
    return { days: rolled };
  });

  registerHandler("scheduler-tick", async ({ kind }) => {
    // Only shops with an offline Shopify session can be worked on; a Shop row
    // without one (seeded demo data, half-finished install) would just fail.
    const installed = new Set((await prisma.session.findMany({ select: { shop: true }, distinct: ["shop"] })).map((s) => s.shop));
    const shops = (
      await prisma.shop.findMany({ where: { isActive: true }, select: { id: true, domain: true, inventoryPolicy: { select: { isEnabled: true, syncIntervalMinutes: true, lastRunAt: true } }, settings: true } })
    ).filter((shop) => installed.has(shop.domain));
    for (const shop of shops) {
      switch (kind) {
        case "purchase-orders":
          await enqueue("sync-purchase-orders", { shopId: shop.id }, { dedupeKey: `sync-po-${shop.id}` });
          break;
        case "tracking":
          await enqueue("sync-tracking", { shopId: shop.id }, { dedupeKey: `sync-tracking-${shop.id}` });
          break;
        case "inventory": {
          const policy = shop.inventoryPolicy;
          if (!policy?.isEnabled) break;
          const due = !policy.lastRunAt || Date.now() - policy.lastRunAt.getTime() >= policy.syncIntervalMinutes * 60_000;
          if (due) await enqueue("inventory-sync", { shopId: shop.id }, { dedupeKey: `inventory-${shop.id}` });
          break;
        }
        case "auto-place":
          await enqueue("auto-place-orders", { shopId: shop.id }, { dedupeKey: `auto-place-${shop.id}` });
          break;
        case "payments":
          await enqueue("payment-reminders", { shopId: shop.id }, { dedupeKey: `payments-${shop.id}` });
          break;
        case "metrics":
          await enqueue("rollup-metrics", { shopId: shop.id, days: 2 }, { dedupeKey: `metrics-${shop.id}` });
          break;
        case "email-digest":
          await enqueue("email-digest", { shopId: shop.id }, { dedupeKey: `digest-${shop.id}` });
          break;
      }
    }
    return { shops: shops.length };
  });
}
