import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { sendEmail } from "./email.server";
import { notify } from "./notifications.server";
import { gid } from "./shopify/graphql.server";

/**
 * Privacy compliance: the three mandatory Shopify webhooks and the retention
 * rules that back them up.
 *
 *   customers/data_request  the merchant must hand the customer their data;
 *                           the export is built here and handed to the merchant
 *                           as a notification (and a heads-up email when mail
 *                           is configured - never the data itself).
 *   customers/redact        personal data on the named orders is erased, in
 *                           every table that holds a copy of it.
 *   shop/redact             48 hours after uninstall, everything about the store
 *                           is erased, tokens included.
 *
 * Personal data does not only live in the Order columns. The same person's
 * name, phone and address are echoed into the order's validation issues, the
 * supplier's order response, supplier error messages, activity log lines,
 * notifications, stored data-request exports and the raw webhook payloads.
 * Erasing the columns and leaving those behind was not erasure, so every copy
 * is handled by eraseOrderPersonalData below.
 *
 * Retention (applyRetention, daily):
 *   - a store still uninstalled after RETENTION_DAYS is erased;
 *   - an order the app never fulfils (no line linked to a managed product and
 *     no supplier order) keeps no customer data at all;
 *   - a fulfilled, cancelled or ignored order loses its customer data
 *     CLOSED_ORDER_PII_DAYS after it last changed, and any order at all after
 *     STALE_ORDER_PII_DAYS - the merchant still has the full order in Shopify;
 *   - a data-request export is removed EXPORT_RETENTION_DAYS after it was made;
 *   - webhook payloads are cut down to their ids once processed (or once a day
 *     old) and the rows deleted after WEBHOOK_EVENT_RETENTION_DAYS.
 */

export const RETENTION_DAYS = 30;
/** Chargebacks and supplier disputes are the reason to keep an address after delivery. */
export const CLOSED_ORDER_PII_DAYS = 90;
/** Nothing legitimately stays open this long; an abandoned order must not keep an address forever. */
export const STALE_ORDER_PII_DAYS = 365;
/** Shopify gives the merchant 30 days to answer the customer. */
export const EXPORT_RETENTION_DAYS = 30;
/** Shopify retries a delivery for about four hours; a day is ample to process it. */
export const WEBHOOK_PAYLOAD_RETENTION_HOURS = 24;
/** Dedupe needs the webhook id only for the retry window; a month covers any replay. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

const REDACTED = "[redacted]";
/** The payload a webhook row keeps once nothing needs its contents. */
const MINIMISED_PAYLOAD: Prisma.InputJsonObject = { redacted: true };

interface ShopRef {
  id: string;
  domain: string;
  accountId: string | null;
}

interface CustomerPayload {
  id?: number | string;
  email?: string | null;
  phone?: string | null;
}

/** Order ids from a compliance payload, as Admin API gids. */
function orderGids(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => gid("Order", String(id))).filter((g) => !g.endsWith("/"));
}

function orderFilter(shopId: string, ids: string[], customer: CustomerPayload | undefined): Prisma.OrderWhereInput {
  const email = customer?.email?.trim().toLowerCase();
  const or: Prisma.OrderWhereInput[] = [];
  if (ids.length > 0) or.push({ shopifyOrderId: { in: ids } });
  if (email) or.push({ customerEmail: { equals: email, mode: "insensitive" } });
  if (or.length === 0) return { shopId, id: "" };
  return { shopId, OR: or };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

interface PersonalOrderFields {
  customerName?: string | null;
  customerEmail?: string | null;
  phone?: string | null;
  note?: string | null;
  shippingAddress?: unknown;
}

const ADDRESS_VALUE_KEYS = ["name", "firstName", "lastName", "company", "address1", "address2", "zip", "phone", "taxNumber"] as const;

/**
 * Every string that identifies the person behind an order, for scrubbing free
 * text that may have echoed it. Very short fragments are left out: scrubbing a
 * two-letter first name out of every log line would mangle unrelated words and
 * identify nobody.
 */
export function personalValues(order: PersonalOrderFields | null | undefined, customer?: CustomerPayload): string[] {
  const values: Array<string | null | undefined> = [order?.customerName, order?.customerEmail, order?.phone, order?.note, customer?.email, customer?.phone];
  const address = (order?.shippingAddress ?? {}) as Record<string, unknown>;
  for (const key of ADDRESS_VALUE_KEYS) {
    const value = address[key];
    if (typeof value === "string") values.push(value);
  }
  const out = new Set<string>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || value.length < 3) continue;
    out.add(value);
    // Suppliers and gateways reformat phone numbers; the bare digits catch
    // "+44 20 7123 4567" echoed back as "442071234567".
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 6 && /^[\d\s()+.-]+$/.test(value)) out.add(digits);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function valuePattern(values: string[]): RegExp | null {
  if (values.length === 0) return null;
  const alternatives = values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Bounded on letters and digits, so "Ada" is scrubbed from "Ada Lovelace"
  // but not from "Canada".
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

export function scrubText(text: string, values: string[]): string;
export function scrubText(text: string | null | undefined, values: string[]): string | null;
export function scrubText(text: string | null | undefined, values: string[]): string | null {
  if (text === null || text === undefined) return null;
  const pattern = valuePattern(values);
  return pattern ? text.replace(pattern, REDACTED) : text;
}

/** Deep copy of a JSON value with every personal value replaced inside its strings. */
export function scrubJson<T>(value: T, values: string[]): T {
  const pattern = valuePattern(values);
  if (!pattern) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.replace(pattern, REDACTED);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return walk(value) as T;
}

const ADDRESS_ISSUE_FIELDS = new Set(["name", "firstName", "lastName", "company", "address1", "address2", "city", "province", "provinceCode", "zip", "phone", "taxNumber", "countryCode", "country"]);

/**
 * An order's issues with the person taken out. Address issues quote the
 * offending value ("+44..." has 12 digits) and some carry a truncated copy of
 * the name or street as a suggestion, which a value scrub cannot recognise, so
 * those lose every quoted fragment and every suggestion.
 */
export function redactIssues(issues: unknown, values: string[]): Prisma.InputJsonValue {
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object")
    .map((issue) => {
      const field = typeof issue.field === "string" ? issue.field : undefined;
      let message = typeof issue.message === "string" ? issue.message : "";
      if (field && ADDRESS_ISSUE_FIELDS.has(field)) message = message.replace(/"[^"]*"/g, `"${REDACTED}"`);
      return {
        code: issue.code ?? null,
        severity: issue.severity ?? null,
        message: scrubText(message, values),
        ...(field ? { field } : {}),
        ...(typeof issue.lineItemId === "string" ? { lineItemId: issue.lineItemId } : {}),
      };
    }) as Prisma.InputJsonValue;
}

/**
 * The parts of PurchaseOrder.raw the app reads back. Everything else is the
 * supplier's own order response, which echoes the consignee's name, address
 * and phone and is never read again.
 */
export function minimalPurchaseOrderRaw(raw: unknown): Prisma.InputJsonValue {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, Prisma.InputJsonValue> = {};
  if (Array.isArray(source.externalOrderIds)) out.externalOrderIds = source.externalOrderIds.filter((id) => typeof id === "string" || typeof id === "number") as Prisma.InputJsonValue;
  if (typeof source.shippingReason === "string") out.shippingReason = source.shippingReason;
  if (typeof source.capturedByExtension === "boolean") out.capturedByExtension = source.capturedByExtension;
  if (typeof source.paymentUrl === "string") out.paymentUrl = source.paymentUrl;
  return out;
}

/**
 * A webhook payload cut down to the ids its handler needs. The order topics
 * only ever read the order id and refetch the rest from Shopify, so a pending
 * delivery still processes correctly after this.
 */
export function minimalWebhookPayload(topic: string, payload: unknown): Prisma.InputJsonValue {
  const source = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const out: Record<string, Prisma.InputJsonValue> = { redacted: true };
  if (topic.startsWith("ORDERS_") || topic.startsWith("FULFILLMENTS_")) {
    for (const key of ["id", "admin_graphql_api_id", "order_id"]) {
      const value = source[key];
      if (typeof value === "string" || typeof value === "number") out[key] = value;
    }
  }
  return out;
}

export interface CustomerMatch {
  /** Shopify order gids. */
  orderIds: string[];
  customerId?: string | null;
  emails: string[];
}

function numericId(value: unknown): string {
  return String(value ?? "").replace(/^gid:\/\/shopify\/\w+\//, "");
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Whether a stored webhook payload is about this customer or one of their orders. */
export function webhookPayloadMatches(topic: string, payload: unknown, match: CustomerMatch): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  // Already cut down to ids: nothing personal left to export or erase.
  if (p.redacted === true) return false;
  const orderNumbers = new Set(match.orderIds.map(numericId));
  const emails = new Set(match.emails.map(lower).filter(Boolean));
  const customer = (p.customer ?? {}) as Record<string, unknown>;
  if (emails.size > 0 && [p.email, p.contact_email, customer.email].some((e) => emails.has(lower(e)))) return true;
  if (match.customerId && customer.id !== undefined && String(customer.id) === String(match.customerId)) return true;
  if (topic.startsWith("ORDERS_") && orderNumbers.has(numericId(p.id))) return true;
  if (p.order_id !== undefined && orderNumbers.has(numericId(p.order_id))) return true;
  for (const key of ["orders_to_redact", "orders_requested"]) {
    const list = p[key];
    if (Array.isArray(list) && list.some((id) => orderNumbers.has(numericId(id)))) return true;
  }
  return false;
}

/** Whether a stored data-request export is about this customer. */
export function exportMatches(dataRequest: unknown, match: CustomerMatch): boolean {
  if (!dataRequest || typeof dataRequest !== "object") return false;
  const d = dataRequest as { customer?: { id?: unknown; email?: unknown }; orders?: Array<{ shopifyOrderId?: unknown }> };
  if (match.customerId && d.customer?.id !== undefined && d.customer?.id !== null && String(d.customer.id) === String(match.customerId)) return true;
  const emails = new Set(match.emails.map(lower).filter(Boolean));
  if (emails.size > 0 && emails.has(lower(d.customer?.email))) return true;
  const ids = new Set(match.orderIds);
  return (d.orders ?? []).some((o) => typeof o.shopifyOrderId === "string" && ids.has(o.shopifyOrderId));
}

/**
 * Whether an order should hold the customer's name, email, phone and address.
 *
 * Only an order the app can act on needs them: one with a line linked to a
 * product it manages, or one that already has a supplier order or a Shopify
 * fulfilment request behind it. Every other order is somebody else's to ship,
 * and its totals and destination country are all the reports use.
 */
export function orderNeedsCustomerData(input: { managedLines: number; purchaseOrders: number; fulfillmentRequests: number }): boolean {
  return input.managedLines > 0 || input.purchaseOrders > 0 || input.fulfillmentRequests > 0;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Data request
// ---------------------------------------------------------------------------

/** Most recent webhook rows scanned when looking for one person's payloads. */
const WEBHOOK_SCAN_LIMIT = 5000;

async function matchingWebhookEvents(shopId: string, match: CustomerMatch) {
  const rows = await prisma.webhookEvent.findMany({
    where: { shopId, NOT: { payload: { equals: MINIMISED_PAYLOAD } } },
    select: { id: true, topic: true, payload: true, processedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: WEBHOOK_SCAN_LIMIT,
  });
  return rows.filter((row) => webhookPayloadMatches(row.topic, row.payload, match));
}

/**
 * Build the export for a data request and give it to the merchant.
 *
 * Returns the number of orders included. The export is stored on the
 * notification so an admin can download it from the app for
 * EXPORT_RETENTION_DAYS. The email that goes with it only says a request
 * arrived: it used to carry the whole export as JSON, which put the customer's
 * address in a mail provider's logs and the merchant's inbox for good.
 */
export async function handleCustomerDataRequest(shop: ShopRef, payload: Record<string, unknown>): Promise<{ orders: number }> {
  const customer = (payload.customer ?? {}) as CustomerPayload;
  const requestId = String((payload.data_request as { id?: unknown } | undefined)?.id ?? payload.id ?? Date.now());
  const ids = orderGids(payload.orders_requested);

  const orders = await prisma.order.findMany({
    where: orderFilter(shop.id, ids, customer),
    include: {
      lineItems: { select: { title: true, variantTitle: true, sku: true, quantity: true, price: true } },
      purchaseOrders: {
        select: {
          platform: true,
          externalOrderId: true,
          status: true,
          totalCost: true,
          currency: true,
          placedAt: true,
          supplierNote: true,
          errorMessage: true,
          raw: true,
          trackings: { select: { number: true, carrierName: true, status: true } },
        },
      },
      fulfillmentRequests: { select: { requestMessage: true, responseMessage: true, requestedAt: true } },
    },
    orderBy: { shopifyCreatedAt: "asc" },
  });

  const match: CustomerMatch = {
    orderIds: [...new Set([...ids, ...orders.map((o) => o.shopifyOrderId)])],
    customerId: customer.id !== undefined ? String(customer.id) : null,
    emails: [customer.email, ...orders.map((o) => o.customerEmail)].filter((e): e is string => Boolean(e)),
  };
  // Order webhooks still waiting to be cut down are a copy of the same data;
  // the compliance topics themselves are the request, not the person's data.
  const webhookCopies = (await matchingWebhookEvents(shop.id, match)).filter((w) => w.topic.startsWith("ORDERS_") || w.topic.startsWith("FULFILLMENTS_"));

  const exportData = {
    generatedAt: new Date().toISOString(),
    shop: shop.domain,
    dataRequestId: requestId,
    customer: { id: customer.id ?? null, email: customer.email ?? null, phone: customer.phone ?? null },
    orders: orders.map((o) => ({
      shopifyOrderId: o.shopifyOrderId,
      name: o.name,
      createdAt: o.shopifyCreatedAt,
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      phone: o.phone,
      shippingAddress: o.shippingAddress,
      note: o.note,
      issues: o.issues,
      lineItems: o.lineItems.map((l) => ({ ...l, price: l.price.toString() })),
      supplierOrders: o.purchaseOrders.map(({ raw, ...po }) => ({ ...po, totalCost: po.totalCost?.toString() ?? null, supplierResponse: raw })),
      fulfillmentRequests: o.fulfillmentRequests,
    })),
    webhookCopies: webhookCopies.map((w) => ({ topic: w.topic, receivedAt: w.createdAt, payload: w.payload })),
  };

  const title = `Customer data request #${requestId}`;
  // The notification body is shown to every role and emailed with the other
  // notifications, so it names the Shopify customer id, never their email.
  const body = `Shopify relayed a personal data request for customer ${customer.id ?? "(no id)"}. ${orders.length} order(s) matched; an admin can download the export under Notifications for ${EXPORT_RETENTION_DAYS} days. Pass it on within 30 days.`;
  await notify(shop.id, {
    type: "system",
    severity: "warning",
    title,
    body,
    link: "/app/notifications",
    meta: { dataRequest: exportData as unknown as Prisma.InputJsonValue },
  });
  await logActivity(shop.id, { action: "gdpr.data_request", message: `${title}: ${orders.length} order(s) exported.`, meta: { customerId: customer.id ?? null, orders: orders.length } });

  const settings = await prisma.shop.findUnique({ where: { id: shop.id }, select: { settings: true, email: true } });
  const to = ((settings?.settings as { notifications?: { email?: string } } | null)?.notifications?.email || settings?.email || "").trim();
  if (to.includes("@")) {
    const result = await sendEmail({
      to,
      subject: `[${shop.domain}] ${title}`,
      text: `${body}\n\nFor the customer's privacy the export is not attached. Open DropshipHub in your Shopify admin and go to Notifications to download it.\n\n${env().SHOPIFY_APP_URL}/app/notifications`,
      replyTo: env().SUPPORT_EMAIL,
    });
    if (!result.ok && result.provider !== "none") logger.warn("Data request email failed", { shop: shop.domain, error: result.error });
  }
  return { orders: orders.length };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

const ORDER_PERSONAL_SELECT = {
  id: true,
  shopifyOrderId: true,
  countryCode: true,
  customerName: true,
  customerEmail: true,
  phone: true,
  note: true,
  shippingAddress: true,
  issues: true,
} satisfies Prisma.OrderSelect;

type OrderPersonalRow = Prisma.OrderGetPayload<{ select: typeof ORDER_PERSONAL_SELECT }>;

/**
 * Remove one order's personal data from every table that can hold a copy.
 *
 * The Order row stays - revenue and cost reporting must still add up - with its
 * country code, which is not personal on its own and which the destination
 * reports depend on. `extraValues` carries identifiers from outside the order
 * (the email and phone in a customers/redact payload).
 */
async function eraseOrderPersonalData(shopId: string, order: OrderPersonalRow, extraValues: string[] = []): Promise<void> {
  const values = [...new Set([...personalValues(order), ...extraValues])].sort((a, b) => b.length - a.length);

  await prisma.order.update({
    where: { id: order.id },
    data: {
      customerName: null,
      customerEmail: null,
      phone: null,
      note: null,
      shippingAddress: { countryCode: order.countryCode } as Prisma.InputJsonValue,
      issues: redactIssues(order.issues, values),
    },
  });

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: { orderId: order.id },
    select: { id: true, raw: true, errorMessage: true, supplierNote: true, trackings: { select: { id: true, syncError: true } } },
  });
  for (const po of purchaseOrders) {
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        raw: minimalPurchaseOrderRaw(po.raw),
        errorMessage: scrubText(po.errorMessage, values),
        supplierNote: scrubText(po.supplierNote, values),
      },
    });
    for (const tracking of po.trackings) {
      const syncError = scrubText(tracking.syncError, values);
      if (syncError !== tracking.syncError) await prisma.trackingNumber.update({ where: { id: tracking.id }, data: { syncError } });
    }
  }

  const requests = await prisma.fulfillmentRequest.findMany({
    where: { orderId: order.id },
    select: { id: true, responseMessage: true, quote: true, quoteError: true },
  });
  for (const request of requests) {
    await prisma.fulfillmentRequest.update({
      where: { id: request.id },
      data: {
        // Typed by a merchant into Shopify's dialog: free text about this
        // order, often naming the customer, and not recognisable by value.
        requestMessage: null,
        responseMessage: scrubText(request.responseMessage, values),
        quoteError: scrubText(request.quoteError, values),
        ...(request.quote !== null ? { quote: scrubJson(request.quote, values) as Prisma.InputJsonValue } : {}),
      },
    });
  }

  if (values.length === 0) return;

  const logs = await prisma.activityLog.findMany({ where: { shopId, entity: "Order", entityId: order.id }, select: { id: true, message: true, meta: true } });
  for (const log of logs) {
    const message = scrubText(log.message, values);
    const meta = scrubJson(log.meta, values);
    if (message !== log.message || !sameJson(meta, log.meta)) {
      await prisma.activityLog.update({ where: { id: log.id }, data: { message, meta: meta as Prisma.InputJsonValue } });
    }
  }

  const notifications = await prisma.notification.findMany({ where: { shopId, link: `/app/orders/${order.id}` }, select: { id: true, title: true, body: true, meta: true } });
  for (const n of notifications) {
    const title = scrubText(n.title, values);
    const body = scrubText(n.body, values);
    const meta = scrubJson(n.meta, values);
    if (title !== n.title || body !== n.body || !sameJson(meta, n.meta)) {
      await prisma.notification.update({ where: { id: n.id }, data: { title, body, meta: meta as Prisma.InputJsonValue } });
    }
  }

  // Bulk "place orders" runs keep each order's supplier error in their result.
  const runs = await prisma.jobRun.findMany({
    where: { shopId, type: "place-orders", payload: { path: ["orderIds"], array_contains: [order.id] } },
    select: { id: true, result: true, error: true },
  });
  for (const run of runs) {
    const result = scrubJson(run.result, values);
    const error = scrubText(run.error, values);
    if (error !== run.error || !sameJson(result, run.result)) {
      await prisma.jobRun.update({ where: { id: run.id }, data: { result: result as Prisma.InputJsonValue, error } });
    }
  }
}

/**
 * Erase personal data on the orders Shopify names, and every other copy of
 * this customer's data: stored data-request exports, compliance log lines and
 * the webhook payloads that carried it here.
 */
export async function redactCustomer(shop: ShopRef, payload: Record<string, unknown>): Promise<{ orders: number }> {
  const customer = (payload.customer ?? {}) as CustomerPayload;
  const ids = orderGids(payload.orders_to_redact);
  const targets = await prisma.order.findMany({ where: orderFilter(shop.id, ids, customer), select: ORDER_PERSONAL_SELECT });
  const customerValues = personalValues(null, customer);

  for (const order of targets) {
    await eraseOrderPersonalData(shop.id, order, customerValues);
  }

  const match: CustomerMatch = {
    orderIds: [...new Set([...ids, ...targets.map((o) => o.shopifyOrderId)])],
    customerId: customer.id !== undefined ? String(customer.id) : null,
    emails: [customer.email, ...targets.map((o) => o.customerEmail)].filter((e): e is string => Boolean(e)),
  };
  const values = [...new Set([...customerValues, ...targets.flatMap((o) => personalValues(o))])].sort((a, b) => b.length - a.length);

  // A data-request export made earlier for the same person is a full copy.
  const requests = await prisma.notification.findMany({ where: { shopId: shop.id, type: "system" }, select: { id: true, title: true, body: true, meta: true } });
  for (const n of requests) {
    const meta = (n.meta ?? {}) as Record<string, unknown>;
    const holdsExport = exportMatches(meta.dataRequest, match);
    const rest = holdsExport ? Object.fromEntries(Object.entries(meta).filter(([key]) => key !== "dataRequest")) : meta;
    const scrubbedMeta = scrubJson(rest, values);
    const body = scrubText(n.body, values);
    const title = scrubText(n.title, values);
    if (holdsExport || body !== n.body || title !== n.title || !sameJson(scrubbedMeta, meta)) {
      await prisma.notification.update({ where: { id: n.id }, data: { title, body, meta: scrubbedMeta as Prisma.InputJsonValue } });
    }
  }

  // Compliance log lines written before they stopped naming the customer.
  const gdprLogs = await prisma.activityLog.findMany({ where: { shopId: shop.id, action: { startsWith: "gdpr." } }, select: { id: true, message: true, meta: true } });
  for (const log of gdprLogs) {
    const message = scrubText(log.message, values);
    const meta = scrubJson(log.meta, values);
    if (message !== log.message || !sameJson(meta, log.meta)) {
      await prisma.activityLog.update({ where: { id: log.id }, data: { message, meta: meta as Prisma.InputJsonValue } });
    }
  }

  await logActivity(shop.id, { action: "gdpr.customer_redact", message: `Redacted ${targets.length} order(s) for customer ${customer.id ?? "(no id)"}.` });

  // Last, because the redaction request being processed right now is one of
  // these rows: once its payload is cut down a retry has nothing to redact,
  // which is only safe after the work above has completed.
  const webhookRows = await matchingWebhookEvents(shop.id, match);
  for (const row of webhookRows) {
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { payload: minimalWebhookPayload(row.topic, row.payload) } });
  }
  return { orders: targets.length };
}

/**
 * Erase a store.
 *
 * Deleting the Shop row is not erasure on its own. Session rows are keyed by
 * the raw domain with no relation to Shop, so no cascade reaches them and the
 * store's live access token would survive; the Account row and its
 * account-scoped supplier tokens are orphaned the same way when it was the
 * account's last store. Webhooks that arrived before the Shop row existed are
 * stored without a shopId and are only recognisable by the domain in them.
 */
export async function redactShop(shop: ShopRef, reason: string): Promise<void> {
  const { domain, accountId } = shop;
  await prisma.session.deleteMany({ where: { shop: domain } });
  await prisma.webhookEvent.deleteMany({ where: { shopId: null, payload: { path: ["shop_domain"], equals: domain } } });
  await prisma.shop.delete({ where: { id: shop.id } }).catch(() => undefined);
  if (accountId) {
    const remaining = await prisma.shop.count({ where: { accountId } });
    if (remaining === 0) {
      // Cascades to StaffAccount and the account-scoped SupplierAccount rows
      // holding encrypted supplier tokens.
      await prisma.account.delete({ where: { id: accountId } }).catch(() => undefined);
    }
  }
  logger.info("Store data erased", { shop: domain, reason });
}

/**
 * Erase every store still uninstalled after the retention window. Returns the
 * domains erased. Idempotent and safe to run daily: a store that reinstalled is
 * active again and is not touched.
 */
export async function purgeUninstalledShops(now: Date = new Date(), retentionDays = RETENTION_DAYS): Promise<{ purged: string[] }> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const stale = await prisma.shop.findMany({
    where: { isActive: false, uninstalledAt: { not: null, lt: cutoff } },
    select: { id: true, domain: true, accountId: true },
  });
  for (const shop of stale) {
    await redactShop(shop, `uninstalled more than ${retentionDays} days ago`);
  }
  return { purged: stale.map((s) => s.domain) };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Orders handled per daily run, so a first run over a large backlog cannot hold the worker for hours. */
const RETENTION_ORDER_LIMIT = 5000;
const RETENTION_BATCH = 200;

/**
 * The orders whose customer data has outlived its purpose. Exported so the
 * rule can be read (and tested) apart from the loop that applies it.
 */
export function ordersPastRetention(now: Date): Prisma.OrderWhereInput {
  const day = 86_400_000;
  return {
    AND: [
      // Only rows that still hold something, so a run never revisits its own work.
      { OR: [{ customerName: { not: null } }, { customerEmail: { not: null } }, { phone: { not: null } }, { note: { not: null } }] },
      {
        OR: [
          { stage: { in: ["FULFILLED", "CANCELED", "IGNORED"] }, updatedAt: { lt: new Date(now.getTime() - CLOSED_ORDER_PII_DAYS * day) } },
          { shopifyCreatedAt: { lt: new Date(now.getTime() - STALE_ORDER_PII_DAYS * day) } },
          // Never fulfilled by the app. The hour keeps this off an order whose
          // line items are still being written by the sync that created it.
          {
            createdAt: { lt: new Date(now.getTime() - 3_600_000) },
            lineItems: { none: { productVariantId: { not: null } } },
            purchaseOrders: { none: {} },
            fulfillmentRequests: { none: {} },
          },
        ],
      },
    ],
  };
}

export interface RetentionResult {
  purged: string[];
  ordersRedacted: number;
  exportsRemoved: number;
  webhookPayloadsMinimised: number;
  webhookEventsDeleted: number;
}

/**
 * The daily retention run. Everything here is idempotent: a row already cut
 * down no longer matches its filter.
 */
export async function applyRetention(now: Date = new Date()): Promise<RetentionResult> {
  const { purged } = await purgeUninstalledShops(now);

  let ordersRedacted = 0;
  let cursor: string | undefined;
  while (ordersRedacted < RETENTION_ORDER_LIMIT) {
    const batch = await prisma.order.findMany({
      where: { ...ordersPastRetention(now), ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { ...ORDER_PERSONAL_SELECT, shopId: true },
      orderBy: { id: "asc" },
      take: RETENTION_BATCH,
    });
    if (batch.length === 0) break;
    for (const { shopId, ...order } of batch) {
      try {
        await eraseOrderPersonalData(shopId, order);
        ordersRedacted += 1;
      } catch (error) {
        logger.error("Retention redaction failed", { orderId: order.id, error });
      }
    }
    cursor = batch[batch.length - 1].id;
  }

  let exportsRemoved = 0;
  const oldRequests = await prisma.notification.findMany({
    where: { type: "system", createdAt: { lt: new Date(now.getTime() - EXPORT_RETENTION_DAYS * 86_400_000) } },
    select: { id: true, meta: true },
  });
  for (const n of oldRequests) {
    const meta = (n.meta ?? {}) as Record<string, unknown>;
    if (!("dataRequest" in meta)) continue;
    const rest = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== "dataRequest"));
    await prisma.notification.update({ where: { id: n.id }, data: { meta: { ...rest, exportRemovedAt: now.toISOString() } as Prisma.InputJsonValue } });
    exportsRemoved += 1;
  }

  // A processed delivery is never read again, so its payload goes entirely;
  // the webhook id stays for dedupe.
  const minimised = await prisma.webhookEvent.updateMany({
    where: { processedAt: { not: null }, NOT: { payload: { equals: MINIMISED_PAYLOAD } } },
    data: { payload: MINIMISED_PAYLOAD },
  });
  // One still unprocessed after a day has long outlived Shopify's retries, but
  // a stuck queue may yet run it, so it keeps the ids its handler reads.
  let webhookPayloadsMinimised = minimised.count;
  const stuck = await prisma.webhookEvent.findMany({
    where: { processedAt: null, createdAt: { lt: new Date(now.getTime() - WEBHOOK_PAYLOAD_RETENTION_HOURS * 3_600_000) } },
    select: { id: true, topic: true, payload: true },
    take: RETENTION_ORDER_LIMIT,
  });
  for (const row of stuck) {
    if ((row.payload as { redacted?: unknown } | null)?.redacted === true) continue;
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { payload: minimalWebhookPayload(row.topic, row.payload) } });
    webhookPayloadsMinimised += 1;
  }
  const deleted = await prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * 86_400_000) } } });

  return { purged, ordersRedacted, exportsRemoved, webhookPayloadsMinimised, webhookEventsDeleted: deleted.count };
}
