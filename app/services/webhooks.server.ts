import type { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { HttpResponseError } from "@shopify/shopify-api";
import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { applySubscriptionWebhook } from "./billing.server";
import { handleCustomerDataRequest, redactCustomer, redactShop } from "./compliance.server";
import { cancelPurchaseOrder } from "./fulfillment.server";
import { handleFulfillmentRequest } from "./fulfillment-service.server";
import { refreshOrderFromShopify } from "./orders.server";
import { handleProductDeleted, syncProductFromShopify } from "./products.server";
import { getShopByDomain, markShopUninstalled, type ShopWithSettings } from "./shop.server";
import { gid, gql, offlineClient } from "./shopify/graphql.server";

/** The mandatory privacy topics: retried far longer than the rest. */
export const COMPLIANCE_TOPICS = ["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"];

/**
 * What a processed event's payload becomes. The handler has read everything it
 * needed, and the payload of an order or customer webhook is customer personal
 * data that nothing reads again; the row itself stays for dedupe and for the
 * Settings → Advanced list. Same shape the retention job writes.
 */
const PROCESSED_PAYLOAD: Prisma.InputJsonObject = { redacted: true };

/**
 * Prefix of the error an event carries once the sweep has stopped retrying it.
 * It is how the sweep, the log and Settings → Advanced tell "gave up" apart
 * from "failed, will retry", without a schema change.
 */
export const WEBHOOK_ABANDONED_PREFIX = "Abandoned: ";

export interface WebhookDeliveryInput {
  shopDomain: string;
  topic: string;
  webhookId: string;
  eventId?: string | null;
  triggeredAt?: string | Date | null;
  payload: unknown;
  /** When this server received the delivery; defaults to now. */
  receivedAt?: Date;
}

/**
 * Store a webhook for asynchronous processing. Returns null when this delivery
 * was already stored.
 *
 * Two different things count as "already": the same delivery id (Shopify
 * retries at-least-once), and the same event id for the same store and topic.
 * The second is how a store holding both an app-level and a shop-level
 * subscription to a topic receives each event twice under two delivery ids;
 * with only the delivery id checked, a fulfilment request was accepted twice
 * and a cancelled order was cancelled upstream twice.
 *
 * createdAt is written from this process's clock rather than left to the
 * database default, because it is compared with Shopify's X-Shopify-Triggered-At
 * to measure how far this server's clock runs ahead (see estimateClockLeadMs),
 * and with lastAuthAt, which is also stamped here.
 */
export async function recordWebhook(input: WebhookDeliveryInput) {
  const shop = await getShopByDomain(input.shopDomain);
  try {
    return await prisma.webhookEvent.create({
      data: {
        shopId: shop?.id ?? null,
        shopDomain: input.shopDomain,
        topic: input.topic,
        webhookId: input.webhookId,
        eventId: input.eventId || null,
        triggeredAt: parseTriggeredAt(input.triggeredAt),
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        createdAt: input.receivedAt ?? new Date(),
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null;
    throw error;
  }
}

/** X-Shopify-Triggered-At as a Date; null when absent or unparseable. */
export function parseTriggeredAt(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** How long a webhook waits for its shop to appear before being given up on. */
const WEBHOOK_ORPHAN_TIMEOUT_MS = 60 * 60_000;

/**
 * How long one attempt holds an event. Long enough for the slowest handler (a
 * fulfilment request that prices a whole order upstream), short enough that a
 * process killed mid-attempt does not strand the event for long.
 */
const WEBHOOK_LEASE_MS = 10 * 60_000;

/**
 * Take the event for this attempt, atomically.
 *
 * The inline queue, a BullMQ job and the recovery sweep can all reach the same
 * row; without a claim two of them could process it at once. The attempt
 * counter rides along so the sweep can space its retries out.
 */
async function claimWebhookEvent(id: string, now: Date): Promise<boolean> {
  const { count } = await prisma.webhookEvent.updateMany({
    where: { id, processedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + WEBHOOK_LEASE_MS), lastAttemptAt: now, attempts: { increment: 1 } },
  });
  return count === 1;
}

/**
 * Purchase-order statuses a Shopify cancellation cancels only when the merchant
 * turned on "cancel the supplier order too": these exist at the supplier, and
 * cancelling one there can cost money or fail.
 */
const UPSTREAM_CANCELLABLE: PurchaseOrderStatus[] = ["PLACED", "AWAITING_PAYMENT", "PAID"];

/** Handle a stored webhook. Idempotent per event row. */
export async function processWebhookEvent(webhookEventId: string) {
  if (!(await claimWebhookEvent(webhookEventId, new Date()))) return;
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId }, include: { shop: true } });
  if (!event || event.processedAt) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  try {
    // By domain, not only through the relation: a row recorded before the Shop
    // row existed has no shopId and could never find its store on a retry.
    const domain = event.shopDomain ?? event.shop?.domain ?? null;
    const shop = domain ? await getShopByDomain(domain) : null;
    if (!shop) {
      // Not marked processed. A webhook can legitimately arrive before the
      // install finishes writing the Shop row, and permanently retiring it here
      // silently dropped the delivery — including GDPR topics, which must not
      // be lost. It is retried until the shop appears or the delivery ages out.
      const age = Date.now() - event.createdAt.getTime();
      const message = `shop not found (waiting ${Math.round(age / 60_000)} min)`;
      if (age > WEBHOOK_ORPHAN_TIMEOUT_MS) {
        // The payload goes too: nothing will ever process it, and it is
        // personal data about a store this app does not know.
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date(), error: "shop not found; gave up", lockedUntil: null, payload: PROCESSED_PAYLOAD },
        });
        logger.warn("Dropping webhook for an unknown shop", { topic: event.topic, id: event.id });
        return;
      }
      throw new Error(message);
    }
    if (!event.shopId) {
      await prisma.webhookEvent.updateMany({ where: { id: event.id }, data: { shopId: shop.id } });
    }

    switch (event.topic) {
      case "ORDERS_CREATE":
      case "ORDERS_UPDATED":
      case "ORDERS_PAID":
      case "ORDERS_FULFILLED": {
        const client = await offlineClient(shop.domain);
        const shopifyOrderId = gid("Order", String(payload.admin_graphql_api_id ?? payload.id ?? ""));
        if (shopifyOrderId.endsWith("/")) break;
        await refreshOrderFromShopify(shop, client, shopifyOrderId);
        break;
      }
      case "ORDERS_CANCELLED": {
        const client = await offlineClient(shop.domain);
        const shopifyOrderId = gid("Order", String(payload.admin_graphql_api_id ?? payload.id ?? ""));
        // Same empty-id guard the other order topics have: without an id the
        // gid is a bare prefix and the Admin API lookup errors out.
        if (shopifyOrderId.endsWith("/")) break;
        const order = await refreshOrderFromShopify(shop, client, shopifyOrderId);
        if (order) await cancelPurchaseOrdersForCancelledOrder(shop, order.id);
        break;
      }
      case "PRODUCTS_UPDATE": {
        const client = await offlineClient(shop.domain);
        await syncProductFromShopify(shop, client, gid("Product", String(payload.admin_graphql_api_id ?? payload.id ?? "")));
        break;
      }
      case "PRODUCTS_DELETE": {
        await handleProductDeleted(shop.id, gid("Product", String(payload.id ?? "")));
        break;
      }
      case "FULFILLMENTS_CREATE":
      case "FULFILLMENTS_UPDATE": {
        // Someone (or another app) fulfilled in Shopify: refresh so lines flip to fulfilled.
        const client = await offlineClient(shop.domain);
        const orderId = payload.order_id ? gid("Order", String(payload.order_id)) : null;
        if (orderId) await refreshOrderFromShopify(shop, client, orderId);
        break;
      }
      case "FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED":
      case "FULFILLMENT_ORDERS_CANCELLATION_REQUEST_SUBMITTED": {
        await handleFulfillmentRequest(shop, event.topic, payload);
        break;
      }
      case "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE": {
        // Routing finished; nothing to do until the merchant requests fulfilment.
        break;
      }
      case "APP_UNINSTALLED": {
        // The trigger time, not the time we got round to it: a delivery that
        // waited in a retry or the sweep must not uninstall a store that has
        // reinstalled since. The clock lead lets markShopUninstalled compare
        // Shopify's trigger time with our own auth stamp honestly.
        await markShopUninstalled(shop.domain, {
          triggeredAt: event.triggeredAt ?? event.createdAt,
          clockLeadMs: await estimateClockLeadMs(new Date()),
        });
        break;
      }
      case "APP_SUBSCRIPTIONS_UPDATE": {
        await applySubscriptionWebhook(shop, payload);
        break;
      }
      case "APP_SCOPES_UPDATE": {
        await logActivity(shop.id, { action: "shop.scopes_updated", message: `Access scopes updated: ${String((payload.current as string[] | undefined)?.join(", ") ?? "")}` });
        break;
      }
      case "CUSTOMERS_DATA_REQUEST": {
        await handleCustomerDataRequest(shop, payload);
        break;
      }
      case "CUSTOMERS_REDACT": {
        await redactCustomer(shop, payload);
        break;
      }
      case "SHOP_REDACT": {
        // shop/redact arrives 48 hours after an uninstall, and a retry can come
        // later still. A store that reinstalled in between is a live customer:
        // erasing it deleted its sessions and data while the app was installed.
        // Decided from what this app recorded, not by asking Shopify: the probe
        // this replaced could not tell an expired token from a network error,
        // so a store whose uninstall had been lost was retried and never erased.
        const clockLeadMs = await estimateClockLeadMs(new Date());
        const redactTriggeredAt = event.triggeredAt ?? event.createdAt;
        const decision = shopRedactDecision(shop.lastAuthAt, redactTriggeredAt, clockLeadMs);
        logger.info("shop/redact decision", {
          shop: shop.domain,
          decision,
          lastAuthAt: shop.lastAuthAt,
          redactTriggeredAt,
          uninstallEstimatedAt: new Date(redactTriggeredAt.getTime() - SHOP_REDACT_DELAY_MS),
          clockLeadMs,
          marginMs: SHOP_REDACT_MARGIN_MS,
        });
        if (decision === "skip") {
          await logActivity(shop.id, { action: "gdpr.shop_redact_skipped", level: "warn", message: `Store erase request ignored: ${shop.domain} signed in to the app again after the uninstall it refers to.` });
          await prisma.webhookEvent.update({
            where: { id: event.id },
            data: { processedAt: new Date(), error: "skipped: store reinstalled", lockedUntil: null, payload: PROCESSED_PAYLOAD },
          });
          return;
        }
        await logActivity(shop.id, { action: "gdpr.shop_redact", message: `Store ${shop.domain} redacted.` }).catch(() => undefined);
        await redactShop(shop, "shop/redact webhook");
        // The WebhookEvent row cascaded away with the Shop, so there is nothing
        // left to mark processed.
        return;
      }
      default:
        logger.info("Unhandled webhook topic", { topic: event.topic });
    }

    // Processed and redacted in one write, so there is never a moment where a
    // row is finished but still holds the customer's details.
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null, lockedUntil: null, payload: PROCESSED_PAYLOAD } });
  } catch (error) {
    logger.error("Webhook processing failed", { topic: event.topic, id: event.id, attempt: event.attempts, error });
    // The row may be gone (a redaction cascaded it away, or the shop was
    // uninstalled mid-flight); updateMany makes that a no-op instead of a
    // second, uncaught P2025 that fails the job through every retry. The lease
    // is released so the queue's own retry can take the event straight back.
    await prisma.webhookEvent.updateMany({ where: { id: event.id }, data: { error: errorMessage(error), lockedUntil: null } });
    throw error;
  }
}

/**
 * orders/cancelled: take the order's purchase orders down with it.
 *
 * A purchase order still waiting to be placed through the Chrome extension is
 * always cancelled, whatever the merchant's upstream setting says: it exists
 * only in this app, and left open the extension keeps listing it, so the
 * merchant could buy and pay for goods on AliExpress for an order the customer
 * already cancelled. Its cancellation must not be lost either, so a failure
 * fails the event and it is retried.
 *
 * Purchase orders that already exist at a supplier are cancelled only when the
 * merchant asked for that, and a supplier refusing is logged, not retried: the
 * supplier's answer will not change on a retry, and the merchant sees it on the
 * order.
 */
export async function cancelPurchaseOrdersForCancelledOrder(shop: ShopWithSettings, orderId: string) {
  const statuses: PurchaseOrderStatus[] = shop.parsedSettings.orders.cancelSupplierOnCancel ? ["AWAITING_PLACEMENT", ...UPSTREAM_CANCELLABLE] : ["AWAITING_PLACEMENT"];
  const pos = await prisma.purchaseOrder.findMany({ where: { orderId, status: { in: statuses } }, select: { id: true, status: true } });
  const failures: unknown[] = [];
  for (const po of pos) {
    try {
      await cancelPurchaseOrder(shop, po.id, "Shopify order cancelled", "webhook");
    } catch (error) {
      if (po.status === "AWAITING_PLACEMENT") {
        logger.error("Could not cancel a purchase order awaiting placement", { po: po.id, error });
        failures.push(error);
      } else {
        logger.warn("Cancel upstream failed", { po: po.id, error });
      }
    }
  }
  if (failures.length) throw new Error(`Could not cancel ${failures.length} purchase order(s) awaiting placement: ${errorMessage(failures[0])}`);
}

/** shop/redact is sent this long after the uninstall it refers to. */
export const SHOP_REDACT_DELAY_MS = 48 * 60 * 60_000;

/**
 * How much later than "48 hours before the redact" a sign-in must be to count
 * as a reinstall.
 *
 * The two ways to be wrong are not symmetric. Skipping wrongly needs a store
 * whose last sign-in came before its uninstall to look signed-in after it,
 * which can only happen if Shopify fired the redact more than this margin
 * early; Shopify's delay is a scheduled minimum, so that does not happen in
 * practice. Erasing wrongly needs a store that reinstalled within this margin
 * of uninstalling and then had no staff sign-in for the next two days (every
 * staff member's token exchange, about daily, moves lastAuthAt on). Fifteen
 * minutes keeps the second case to a merchant who reinstalls in a hurry and
 * then never opens the app, while still absorbing the residual clock error
 * after the measured lead is taken out.
 */
export const SHOP_REDACT_MARGIN_MS = 15 * 60_000;

/**
 * Whether a shop/redact should erase the store, from local evidence only.
 *
 * Skip only when the store signed in to the app after the uninstall this
 * redact refers to (estimated as its trigger time minus 48 hours): Shopify
 * refuses a token exchange for an app that is not installed, so such a sign-in
 * proves a reinstall. Everything else erases, including a store still marked
 * active because its app/uninstalled was lost. lastAuthAt is on this server's
 * clock and the trigger time on Shopify's, so the measured clock lead is taken
 * off first. Exported for the test.
 */
export function shopRedactDecision(lastAuthAt: Date | null | undefined, redactTriggeredAt: Date, clockLeadMs = 0): "erase" | "skip" {
  if (!lastAuthAt) return "erase";
  const uninstallEstimate = redactTriggeredAt.getTime() - SHOP_REDACT_DELAY_MS;
  return lastAuthAt.getTime() - Math.max(0, clockLeadMs) > uninstallEstimate + SHOP_REDACT_MARGIN_MS ? "skip" : "erase";
}

/** Deliveries sampled when measuring the clock lead. */
const CLOCK_SAMPLE_WINDOW_MS = 24 * 60 * 60_000;
const CLOCK_SAMPLE_SIZE = 200;

/**
 * An upper bound on how far this server's clock runs ahead of Shopify's, in
 * milliseconds, measured from recent deliveries.
 *
 * Each stored delivery has Shopify's trigger time and our receipt time, and
 * receipt minus trigger is the delivery delay plus the clock lead. The delay is
 * never negative, so the smallest difference over many deliveries bounds the
 * lead from above, and is close to it, because most deliveries arrive within a
 * second. A clock running behind cannot be measured this way and reads as 0,
 * which is the safe direction for both callers: it makes a sign-in look earlier,
 * so an uninstall is applied and a redact erases.
 */
export async function estimateClockLeadMs(now: Date): Promise<number> {
  const samples = await prisma.webhookEvent.findMany({
    where: { triggeredAt: { not: null }, createdAt: { gt: new Date(now.getTime() - CLOCK_SAMPLE_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    take: CLOCK_SAMPLE_SIZE,
    select: { createdAt: true, triggeredAt: true },
  });
  return clockLeadFromSamples(samples);
}

/** The pure half of estimateClockLeadMs. Exported for the test. */
export function clockLeadFromSamples(samples: Array<{ createdAt: Date; triggeredAt: Date | null }>): number {
  let lead: number | null = null;
  for (const { createdAt, triggeredAt } of samples) {
    if (!triggeredAt) continue;
    const lag = createdAt.getTime() - triggeredAt.getTime();
    lead = lead === null ? lag : Math.min(lead, lag);
  }
  return Math.max(0, lead ?? 0);
}

const INSTALL_PROBE = `#graphql
  query DropshipInstallProbe {
    shop { id }
  }
`;

export type InstallState = "installed" | "uninstalled" | "unknown";

/**
 * Whether the app is installed on a store right now, according to Shopify.
 *
 * Shopify revokes the tokens on uninstall, so a trivial query with the offline
 * token answers the question when the answer is clear. It often is not: with
 * expiring offline tokens a store uninstalled for more than an hour first needs
 * a token refresh, and the library turns every refused refresh except
 * invalid_subject_token into a bare 500 Response, the same thing a network
 * failure becomes. Callers must therefore treat "unknown" as "cannot tell", and
 * must not wait on it to become "uninstalled".
 */
export async function appInstallState(shopDomain: string): Promise<InstallState> {
  try {
    await gql(await offlineClient(shopDomain), INSTALL_PROBE);
    return "installed";
  } catch (error) {
    const state = classifyInstallProbeError(error);
    if (state === "unknown") logger.warn("Install probe failed", { shop: shopDomain, error });
    return state;
  }
}

/**
 * What a failed install probe says about the installation. Matched by class,
 * because the library's SessionNotFoundError never sets `name` and a name check
 * never matched. Exported for the test.
 */
export function classifyInstallProbeError(error: unknown): Exclude<InstallState, "installed"> {
  // No offline session at all: the uninstall already cleaned up.
  if (error instanceof SessionNotFoundError) return "uninstalled";
  if (error instanceof HttpResponseError) {
    const { code, body } = error.response;
    if (code === 401) return "uninstalled";
    // The expiring offline token could not be exchanged because the grant is gone.
    if (code === 400 && (body as { error?: string } | undefined)?.error === "invalid_subject_token") return "uninstalled";
  }
  return "unknown";
}

/** Events younger than this are left alone: their first attempt may still be on its way. */
const SWEEP_GRACE_MS = 2 * 60_000;
/** The shortest gap the sweep leaves after an attempt; the backoff grows from here. */
const SWEEP_BASE_GAP_MS = 5 * 60_000;
/** The longest gap between two sweep retries of one event. */
const SWEEP_MAX_GAP_MS = 6 * 60 * 60_000;
/** Attempts one hand-off can use up: the inline queue and BullMQ both try three times. */
const ATTEMPTS_PER_HANDOFF = 3;
/**
 * Ordinary topics stop being worth replaying after Shopify's own two-day
 * redelivery horizon: a fulfilment request replayed a week late does more harm
 * than good.
 */
const SWEEP_MAX_AGE_MS = 2 * 24 * 60 * 60_000;
/**
 * Privacy requests are retried for their whole 30-day window, less one hour:
 * the retention job deletes webhook rows at 30 days, and an event given up on
 * must be flagged before its row can disappear, or it would vanish unreported.
 */
const SWEEP_COMPLIANCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000 - 60 * 60_000;
/** Candidates read per sweep; more than the batch so events still backing off do not crowd out due ones. */
const SWEEP_SCAN = 200;
const SWEEP_BATCH = 50;

/**
 * How long the sweep waits after an event's last attempt before trying again.
 *
 * Doubles with every hand-off's worth of attempts, from five minutes up to six
 * hours. A flat gap with a flat 25-attempt cap gave up on an event after about
 * two hours, so an outage of Shopify, the database or a token longer than that
 * lost privacy requests for good; with this curve a privacy request is still
 * retried every six hours on day 29, and an ordinary one about a dozen times
 * over its two days. Exported for the test.
 */
export function webhookRetryDelayMs(attempts: number): number {
  const handoffs = Math.floor(Math.max(0, attempts) / ATTEMPTS_PER_HANDOFF);
  return Math.min(SWEEP_MAX_GAP_MS, SWEEP_BASE_GAP_MS * 2 ** Math.min(handoffs, 20));
}

/** Whether an unfinished event's backoff has run out. Exported for the test. */
export function webhookRetryDue(row: { attempts: number; lastAttemptAt: Date | null }, now: Date): boolean {
  if (!row.lastAttemptAt) return true;
  return now.getTime() - row.lastAttemptAt.getTime() >= webhookRetryDelayMs(row.attempts);
}

/** Rows not already given up on. An OR with null, because SQL's NOT LIKE drops NULL errors too. */
const notAbandoned: Prisma.WebhookEventWhereInput = { OR: [{ error: null }, { NOT: { error: { startsWith: WEBHOOK_ABANDONED_PREFIX } } }] };

/**
 * The rows the recovery sweep may hand back to the queue, before the per-row
 * backoff is applied in code (Prisma cannot compare two columns). Exported so
 * the test can pin the exact clause without a database.
 */
export function pendingWebhookFilter(now: Date): Prisma.WebhookEventWhereInput {
  const at = now.getTime();
  return {
    processedAt: null,
    createdAt: { lt: new Date(at - SWEEP_GRACE_MS), gt: new Date(at - SWEEP_COMPLIANCE_MAX_AGE_MS) },
    AND: [
      notAbandoned,
      { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(at - SWEEP_BASE_GAP_MS) } }] },
      { OR: [{ topic: { in: COMPLIANCE_TOPICS } }, { createdAt: { gt: new Date(at - SWEEP_MAX_AGE_MS) } }] },
    ],
  };
}

/** Unfinished rows past their retry window that have not been flagged yet. Exported for the test. */
export function expiredWebhookFilter(now: Date): Prisma.WebhookEventWhereInput {
  const at = now.getTime();
  return {
    processedAt: null,
    AND: [
      notAbandoned,
      { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      {
        OR: [
          { topic: { in: COMPLIANCE_TOPICS }, createdAt: { lt: new Date(at - SWEEP_COMPLIANCE_MAX_AGE_MS) } },
          { topic: { notIn: COMPLIANCE_TOPICS }, createdAt: { lt: new Date(at - SWEEP_MAX_AGE_MS) } },
        ],
      },
    ],
  };
}

/**
 * Re-queue stored webhooks nobody finished, and flag the ones out of time.
 *
 * Production runs jobs in memory, so a deploy or crash between the 200 and the
 * job's end lost the event: the row kept processedAt null and nothing ever
 * looked at it again. This runs on boot and on a timer (see queue.server) and
 * hands each unfinished, unclaimed event whose backoff has run out back to the
 * queue. The claim in processWebhookEvent makes a double hand-off harmless.
 */
export async function sweepPendingWebhooks(enqueueWebhook: (webhookEventId: string) => Promise<unknown>, now: Date = new Date()): Promise<number> {
  await abandonExpiredWebhooks(now);

  const candidates = await prisma.webhookEvent.findMany({
    where: pendingWebhookFilter(now),
    // Longest-waiting first: those are the ones whose backoff is most likely over.
    orderBy: [{ lastAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: SWEEP_SCAN,
    select: { id: true, topic: true, attempts: true, lastAttemptAt: true },
  });
  const due = candidates.filter((row) => webhookRetryDue(row, now)).slice(0, SWEEP_BATCH);
  let queued = 0;
  for (const row of due) {
    try {
      await enqueueWebhook(row.id);
      queued += 1;
    } catch (error) {
      logger.warn("Could not re-queue a pending webhook", { id: row.id, topic: row.topic, error });
    }
  }
  if (queued) logger.info("Re-queued unfinished webhooks", { queued });
  return queued;
}

/**
 * Stop retrying events whose window has closed, loudly.
 *
 * The attempt cap this replaced stopped selecting a row without a word, so a
 * lost privacy request looked exactly like one still in progress. Each event
 * given up on is logged at error level, written to the store's activity log,
 * and keeps an error starting with WEBHOOK_ABANDONED_PREFIX, which Settings →
 * Advanced lists. The payload is kept for whoever investigates; the retention
 * job minimises it on its own schedule. Exported for the test.
 */
export async function abandonExpiredWebhooks(now: Date = new Date()): Promise<number> {
  const rows = await prisma.webhookEvent.findMany({
    where: expiredWebhookFilter(now),
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true, topic: true, shopId: true, shopDomain: true, attempts: true, error: true, createdAt: true },
  });
  let abandoned = 0;
  for (const row of rows) {
    const lastError = row.error ?? "never processed";
    const error = `${WEBHOOK_ABANDONED_PREFIX}gave up after ${row.attempts} attempt(s); last error: ${lastError}`.slice(0, 2000);
    // Conditional on still being unfinished and unflagged, so a retry that
    // succeeds at the same moment is not overwritten.
    const { count } = await prisma.webhookEvent.updateMany({ where: { id: row.id, processedAt: null, AND: [notAbandoned] }, data: { error, lockedUntil: null } });
    if (count === 0) continue;
    abandoned += 1;
    const compliance = COMPLIANCE_TOPICS.includes(row.topic);
    logger.error(compliance ? "Privacy webhook abandoned after its 30-day window" : "Webhook abandoned after its retry window", {
      id: row.id,
      topic: row.topic,
      shop: row.shopDomain,
      attempts: row.attempts,
      receivedAt: row.createdAt,
      lastError,
    });
    if (row.shopId) {
      await logActivity(row.shopId, {
        action: "webhook.abandoned",
        level: "error",
        entity: "WebhookEvent",
        entityId: row.id,
        message: `Stopped retrying the ${row.topic} event received ${row.createdAt.toISOString()} after ${row.attempts} attempt(s). Last error: ${lastError}`,
      });
    }
  }
  return abandoned;
}
