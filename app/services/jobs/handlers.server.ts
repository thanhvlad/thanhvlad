import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { refreshRates } from "../currency.server";
import { EXTENSION_PLACEMENT_STEPS, fetchFulfillmentRouting, fulfillmentServiceRouting, placeSupplierOrders, syncOpenPurchaseOrders, syncPendingTracking } from "../fulfillment.server";
import { reconcileFulfillmentRequests, type ReconcileResult } from "../fulfillment-service.server";
import { getAiRewriteAllowance, landingExamples, rewriteImportedProduct, type RewriteOutcome } from "../landing-rewrite.server";
import { addToImportList, pushImportedProduct } from "../import.server";
import { runInventorySync } from "../inventory-sync.server";
import { runJob } from "../jobs.server";
import { hasFeature } from "../billing.server";
import { applyRetention } from "../compliance.server";
import { notify, sendDigest } from "../notifications.server";
import { checkPayments, sendPaymentReminders } from "../payments.server";
import { syncOrdersFromShopify } from "../orders.server";
import { rollupRange } from "../reports.server";
import { getShopById } from "../shop.server";
import { offlineClient, type GraphqlClient } from "../shopify/graphql.server";
import { processWebhookEvent } from "../webhooks.server";
import { enqueue, registerHandler } from "./queue.server";

/**
 * Whether a failed rewrite means the month's allowance is gone, so the rest of
 * the batch would only fail the same way.
 *
 * The refusal's wording is checked first because it costs nothing; the stored
 * allowance is the authority, so a reworded message still stops the batch.
 * Exported for the test.
 */
export async function rewriteAllowanceUsedUp(shop: { id: string; accountId: string | null }, outcome: RewriteOutcome): Promise<boolean> {
  if (outcome.ok) return false;
  if (/allowance is used up/i.test(outcome.error ?? "")) return true;
  try {
    const allowance = await getAiRewriteAllowance(shop);
    // An unmetered shop (AI_UNMETERED_SHOP_DOMAINS) is never out of rewrites,
    // however its allowance chooses to spell "no limit".
    if ((allowance as { unlimited?: unknown }).unlimited === true) return false;
    return allowance.remaining === 0;
  } catch {
    return false;
  }
}

/**
 * The notice at the end of a bulk "send to supplier" job. Orders that went to
 * the extension queue are counted apart from orders placed with a supplier, in
 * the same words the order screens use. Exported for the test.
 */
export function placeOrdersNotice(counts: { placed: number; waiting: number; failed: number }) {
  const parts: string[] = [];
  if (counts.placed || (!counts.waiting && !counts.failed)) parts.push(`Placed ${counts.placed} supplier order(s)`);
  if (counts.waiting) parts.push(`${counts.waiting} waiting to be placed with the Chrome extension`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return {
    type: "job.finished" as const,
    severity: counts.failed ? ("warning" as const) : ("info" as const),
    title: parts.join(", "),
    body: counts.waiting ? `Nothing has been ordered for ${counts.waiting} order(s) yet. ${EXTENSION_PLACEMENT_STEPS}` : undefined,
    link: counts.failed ? "/app/orders?stage=FAILED" : counts.waiting ? "/app/orders?stage=AWAITING_ORDER" : "/app/orders?stage=AWAITING_PAYMENT",
  };
}

/**
 * Orders the auto-place tick may send. An order whose supplier order is already
 * waiting for the extension also reads as Awaiting order, and would otherwise
 * be re-evaluated for nothing every ten minutes and take places in the batch
 * of 50 from orders that really are unsent. An order split so that one part
 * waits for the extension and another is still unsent is left to the merchant,
 * whose order page offers "Send to supplier" for the rest. Exported for the test.
 */
export function autoPlaceCandidatesWhere(shopId: string, cutoff: Date) {
  return {
    shopId,
    stage: "AWAITING_ORDER" as const,
    shopifyCreatedAt: { lte: cutoff },
    isTest: false,
    purchaseOrders: { none: { status: "AWAITING_PLACEMENT" as const } },
  };
}

/**
 * Job handlers. Each is idempotent where it matters (purchase orders are
 * keyed on their own id; product pushes skip already-pushed rows) so BullMQ
 * retries are safe.
 */
export function registerAllHandlers() {
  registerHandler("rewrite-landing", async ({ shopId, importedProductIds, jobRunId, actor, pushAfter }) => {
    const shop = await getShopById(shopId);
    if (!shop) return;
    const client = await offlineClient(shop.domain);
    return runJob(jobRunId, async ({ progress }) => {
      // Fetched once for the batch: the same worked examples serve every
      // product, and they cost tokens on each call.
      const examples = await landingExamples(shop.id);
      let ok = 0;
      let failed = 0;
      const results: Array<{ id: string; ok: boolean; title?: string; error?: string }> = [];
      let allowanceUsedUp = false;
      for (const [index, id] of importedProductIds.entries()) {
        const rewrite = await rewriteImportedProduct(shop, id, { actor, examples });
        let error = rewrite.error;
        let succeeded = rewrite.ok;
        // Only a page that passed the contract check is allowed near the store.
        if (succeeded && pushAfter) {
          const pushed = await pushImportedProduct(shop, client, id, actor);
          succeeded = pushed.ok;
          if (!pushed.ok) error = pushed.error;
        }
        results.push({ id, ok: succeeded, title: rewrite.title, error });
        if (succeeded) ok += 1;
        else failed += 1;
        await progress({ processed: 1, succeeded: succeeded ? 1 : 0, failed: succeeded ? 0 : 1 });

        // Once the allowance is gone every later product is refused the same
        // way, after its brand lookup and examples were prepared for nothing.
        // The rest are recorded as not attempted, so the job still accounts
        // for every product it was given.
        if (!rewrite.ok && (await rewriteAllowanceUsedUp(shop, rewrite))) {
          allowanceUsedUp = true;
          const rest = importedProductIds.slice(index + 1);
          for (const skipped of rest) {
            results.push({ id: skipped, ok: false, error: "Not attempted: this month's AI rewrite allowance is used up." });
          }
          failed += rest.length;
          if (rest.length) await progress({ processed: rest.length, failed: rest.length });
          break;
        }
      }
      await notify(shopId, {
        type: "job.finished",
        severity: failed ? "warning" : "info",
        title: `Rewrote ${ok} landing page(s)${failed ? `, ${failed} failed` : ""}`,
        body: allowanceUsedUp
          ? "This month's AI rewrite allowance is used up, so the rest of the batch was not rewritten. Upgrade under Settings → Plan or wait for next month."
          : failed
            ? "Open the import list to see which rule each rejected page broke."
            : undefined,
        link: failed ? "/app/import" : "/app/products",
      });
      return { ok, failed, results };
    });
  });

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
      let waiting = 0;
      let failed = 0;
      const results: Array<{ orderId: string; ok: boolean; awaitingPlacement?: number; error?: string }> = [];
      for (const orderId of orderIds) {
        try {
          const outcome = await placeSupplierOrders(shop, orderId, { actor });
          const awaitingPlacement = outcome.awaitingPlacementIds?.length ?? 0;
          results.push({ orderId, ok: outcome.ok, awaitingPlacement, error: outcome.error });
          // An order only priced for the extension was not placed with anyone,
          // and a notice saying "Placed" would send the merchant to pay for
          // something that does not exist at the supplier yet.
          if (outcome.ok && awaitingPlacement > 0) waiting += 1;
          else if (outcome.ok) ok += 1;
          else failed += 1;
          await progress({ processed: 1, succeeded: outcome.ok ? 1 : 0, failed: outcome.ok ? 0 : 1 });
        } catch (error) {
          failed += 1;
          results.push({ orderId, ok: false, error: errorMessage(error) });
          await progress({ processed: 1, failed: 1 });
        }
      }
      await notify(shopId, placeOrdersNotice({ placed: ok, waiting, failed }));
      return { ok, awaitingPlacement: waiting, failed, results };
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

  registerHandler("inventory-sync", async ({ shopId, productIds, jobRunId, actor }, ctx) => {
    const shop = await getShopById(shopId);
    if (!shop || !shop.isActive) return;
    const client = await offlineClient(shop.domain);
    const work = async (progress?: (n: number) => Promise<unknown>) => {
      // The operation id goes into each stock write's idempotency key: the run
      // record when there is one, otherwise the queue's own job id, which a
      // retry of the same scheduled run keeps.
      const { plannedActions: _planned, ...summary } = await runInventorySync(shop, client, { productIds, actor, onProgress: progress, operationId: jobRunId ?? ctx.jobId });
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

    // Fulfilment requests are settled first and whatever the auto-place setting
    // says: this tick is what declines a request nobody approved before
    // Shopify's response window closes, and what picks up a request whose
    // webhook was lost. It is the only schedule every installed shop runs on.
    let requests: ReconcileResult | null = null;
    if (shop.fulfillmentLocationId) {
      requests = await reconcileFulfillmentRequests(shop).catch((error) => {
        logger.error("Fulfilment request reconciliation failed", { shopId, error });
        return null;
      });
    }

    const settings = shop.parsedSettings.orders;
    if (!settings.autoPlaceOrders) return { requests };
    // A downgrade after the setting was switched on must not keep placing.
    if (!(await hasFeature(shop, "autoPlaceOrders"))) {
      logger.info("Auto-place skipped: not included in the plan", { shopId });
      return { requests };
    }
    const cutoff = new Date(Date.now() - settings.autoPlaceDelayMinutes * 60_000);
    const ready = await prisma.order.findMany({
      where: autoPlaceCandidatesWhere(shopId, cutoff),
      select: { id: true, shopifyOrderId: true, lineItems: { select: { shopifyLineItemId: true } } },
      take: 50,
    });

    // Lines Shopify routed to the app's fulfilment-service location are the
    // merchant's to request. Auto-place ordered them upstream anyway, so the
    // supplier was paid for goods the merchant had never asked the app to
    // fulfil, and the request that did come later found them already placed.
    // Without a client the routing cannot be checked, so nothing is placed
    // rather than everything; a failed routing read skips just that order.
    let client: GraphqlClient | null = null;
    if (shop.fulfillmentLocationId && ready.length > 0) {
      try {
        client = await offlineClient(shop.domain);
      } catch (error) {
        logger.warn("Auto-place skipped: fulfilment routing cannot be checked", { shopId, error });
        return { placed: 0, requests };
      }
    }
    let placed = 0;
    let heldForRequest = 0;
    for (const order of ready) {
      try {
        let scope: string[] | undefined;
        if (client) {
          const routing = fulfillmentServiceRouting(await fetchFulfillmentRouting(client, order.shopifyOrderId), shop.fulfillmentLocationId);
          if (routing.serviceLineItemIds.size > 0) {
            scope = order.lineItems.map((li) => li.shopifyLineItemId).filter((id) => !routing.serviceLineItemIds.has(id));
            // An empty scope means "every line" to placement, the opposite of
            // what is wanted here.
            if (scope.length === 0) {
              heldForRequest += 1;
              continue;
            }
          }
        }
        await placeSupplierOrders(shop, order.id, { actor: "auto-place", shopifyLineItemIds: scope });
        placed += 1;
      } catch (error) {
        logger.error("Auto-place failed", { orderId: order.id, error });
      }
    }
    return { placed, heldForRequest, requests };
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

  // The daily retention run: uninstalled stores past their window, and the
  // customer data, exports and webhook payloads that have outlived their
  // purpose. Purging uninstalled stores alone left every live store's old
  // customer data in place for good.
  registerHandler("purge-uninstalled", async () => {
    const result = await applyRetention(new Date());
    if (result.purged.length > 0) logger.info("Purged uninstalled stores", { shops: result.purged });
    return result;
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
