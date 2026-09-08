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
 * rule that backs them up.
 *
 *   customers/data_request  the merchant must hand the customer their data;
 *                           the export is built here and handed to the merchant
 *                           as a notification (and by email when configured).
 *   customers/redact        personal data on the named orders is erased.
 *   shop/redact             48 hours after uninstall, everything about the store
 *                           is erased, tokens included.
 *
 * Shopify only sends shop/redact for stores that actually uninstalled through
 * Shopify. A daily purge erases any store still marked uninstalled after
 * RETENTION_DAYS regardless, so a missed webhook cannot leave a store's data
 * behind indefinitely.
 */

export const RETENTION_DAYS = 30;

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

/**
 * Build the export for a data request and give it to the merchant.
 *
 * Returns the number of orders included. The export is stored on the
 * notification so the merchant can download it later from the app, and is
 * emailed as well when the deployment can send mail — Shopify gives the
 * merchant 30 days to answer the customer, and an unread notification is a
 * thin thread to hang that on.
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
          trackings: { select: { number: true, carrierName: true, status: true } },
        },
      },
    },
    orderBy: { shopifyCreatedAt: "asc" },
  });

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
      lineItems: o.lineItems.map((l) => ({ ...l, price: l.price.toString() })),
      supplierOrders: o.purchaseOrders.map((po) => ({ ...po, totalCost: po.totalCost?.toString() ?? null })),
    })),
  };

  const title = `Customer data request #${requestId}`;
  const body = `Shopify relayed a request from ${customer.email ?? `customer ${customer.id ?? "?"}`} for their personal data. ${orders.length} order(s) matched; download the export and pass it on within 30 days.`;
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
      text: `${body}\n\nThe export is attached below as JSON and is also available under Notifications in the app.\n\n${JSON.stringify(exportData, null, 2)}`,
      replyTo: env().SUPPORT_EMAIL,
    });
    if (!result.ok && result.provider !== "none") logger.warn("Data request email failed", { shop: shop.domain, error: result.error });
  }
  return { orders: orders.length };
}

/**
 * Erase personal data on the orders Shopify names. Order rows themselves stay
 * — revenue and cost reporting must still add up — but nothing that identifies
 * the person remains. The country code is kept because it is not personal on
 * its own and the destination reports depend on it.
 */
export async function redactCustomer(shop: ShopRef, payload: Record<string, unknown>): Promise<{ orders: number }> {
  const customer = (payload.customer ?? {}) as CustomerPayload;
  const ids = orderGids(payload.orders_to_redact);
  const targets = await prisma.order.findMany({ where: orderFilter(shop.id, ids, customer), select: { id: true, countryCode: true } });
  for (const order of targets) {
    await prisma.order.update({
      where: { id: order.id },
      data: {
        customerName: null,
        customerEmail: null,
        phone: null,
        note: null,
        shippingAddress: { countryCode: order.countryCode } as Prisma.InputJsonValue,
      },
    });
  }
  await logActivity(shop.id, { action: "gdpr.customer_redact", message: `Redacted ${targets.length} order(s) for customer ${customer.id ?? customer.email ?? "?"}.` });
  return { orders: targets.length };
}

/**
 * Erase a store.
 *
 * Deleting the Shop row is not erasure on its own. Session rows are keyed by
 * the raw domain with no relation to Shop, so no cascade reaches them and the
 * store's live access token would survive; the Account row and its
 * account-scoped supplier tokens are orphaned the same way when it was the
 * account's last store.
 */
export async function redactShop(shop: ShopRef, reason: string): Promise<void> {
  const { domain, accountId } = shop;
  await prisma.session.deleteMany({ where: { shop: domain } });
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
