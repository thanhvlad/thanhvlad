import type { Notification, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { renderNotificationEmail, shouldEmail } from "~/domain/notifications/email";
import { parseShopSettings } from "~/domain/settings/shop-settings";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { emailConfigured, sendEmail } from "./email.server";

export type NotificationType =
  | "order.failed"
  | "order.placed"
  | "order.shipped"
  | "price.changed"
  | "stock.out"
  | "stock.back"
  | "product.removed"
  | "tracking.synced"
  | "supplier.auth"
  | "job.finished"
  | "system";

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  severity?: "info" | "warning" | "critical";
  meta?: Record<string, unknown>;
  /** Collapse repeats of the same key within `dedupeMinutes`. */
  dedupeKey?: string;
  dedupeMinutes?: number;
}

export async function notify(shopId: string, input: NotifyInput) {
  try {
    if (input.dedupeKey) {
      const since = new Date(Date.now() - (input.dedupeMinutes ?? 60) * 60_000);
      const dupe = await prisma.notification.findFirst({
        where: {
          shopId,
          type: input.type,
          createdAt: { gte: since },
          meta: { path: ["dedupeKey"], equals: input.dedupeKey },
        },
        select: { id: true },
      });
      if (dupe) return dupe;
    }
    const row = await prisma.notification.create({
      data: {
        shopId,
        type: input.type,
        severity: input.severity ?? "info",
        title: input.title,
        body: input.body,
        link: input.link,
        meta: { ...(input.meta ?? {}), dedupeKey: input.dedupeKey } as Prisma.InputJsonValue,
      },
    });
    // Instant delivery is best effort and never delays the caller: the order
    // sync that raised the notification is done with it either way. Digest
    // mode leaves `emailedAt` empty for the daily run to collect.
    void emailInstantly(row).catch((error) => logger.warn("Instant notification email failed", { shopId, error }));
    return row;
  } catch (error) {
    logger.error("Failed to create notification", { shopId, type: input.type, error });
    return null;
  }
}

export async function listNotifications(
  shopId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
) {
  return prisma.notification.findMany({
    where: {
      shopId,
      archivedAt: null,
      ...(options.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
  });
}

export async function countUnread(shopId: string) {
  return prisma.notification.count({ where: { shopId, readAt: null, archivedAt: null } });
}

export async function markRead(shopId: string, ids: string[] | "all") {
  return prisma.notification.updateMany({
    where: { shopId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
    data: { readAt: new Date() },
  });
}

export async function archiveNotifications(shopId: string, ids: string[] | "all") {
  return prisma.notification.updateMany({
    where: { shopId, archivedAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
    data: { archivedAt: new Date(), readAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

async function emailInstantly(row: Notification) {
  if (!emailConfigured()) return;
  const shop = await prisma.shop.findUnique({ where: { id: row.shopId }, select: { id: true, name: true, domain: true, settings: true } });
  if (!shop) return;
  const settings = parseShopSettings(shop.settings);
  if (settings.notifications.digest) return;
  if (!shouldEmail(settings.notifications, row.type, row.severity)) return;
  await emailNotifications({ id: shop.id, name: shop.name, domain: shop.domain, settings: shop.settings }, [row], { digest: false });
}

/**
 * Send one email for the given notifications and stamp them as emailed. The
 * stamp goes on before the send is confirmed, so a provider that accepts the
 * message and then hangs cannot make the next run send it twice.
 */
export async function emailNotifications(
  shop: { id: string; name: string | null; domain: string; settings: unknown },
  rows: Notification[],
  options: { digest: boolean },
): Promise<{ sent: boolean; error?: string }> {
  if (rows.length === 0) return { sent: false };
  const settings = parseShopSettings(shop.settings);
  const to = settings.notifications.email.trim();
  if (!to.includes("@")) return { sent: false, error: "no address" };

  await prisma.notification.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { emailedAt: new Date() } });
  const rendered = renderNotificationEmail({
    locale: settings.ui.locale,
    shopName: shop.name ?? shop.domain,
    shopDomain: shop.domain,
    appUrl: env().SHOPIFY_APP_URL,
    digest: options.digest,
    items: rows.map((r) => ({ type: r.type, severity: r.severity, title: r.title, body: r.body, link: r.link, createdAt: r.createdAt })),
  });
  const result = await sendEmail({ to, subject: rendered.subject, text: rendered.text, html: rendered.html, replyTo: env().SUPPORT_EMAIL });
  if (!result.ok) {
    logger.warn("Notification email not sent", { shopId: shop.id, provider: result.provider, error: result.error });
    // Give the rows back to the next run rather than losing them.
    await prisma.notification.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { emailedAt: null } });
    return { sent: false, error: result.error };
  }
  return { sent: true };
}

/** The local hour at which a shop's daily digest goes out. */
export const DIGEST_HOUR = 8;

function localHour(timezone: string, now: Date): number {
  try {
    const text = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(now);
    const hour = Number(text.replace(/\D/g, ""));
    return Number.isFinite(hour) ? hour % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/**
 * The daily digest for one shop: everything not yet emailed that the merchant
 * asked to hear about, sent once a day at DIGEST_HOUR local time.
 *
 * Runs every hour from the scheduler and does nothing outside that hour, so
 * a missed tick delays the digest by an hour rather than skipping a day.
 */
export async function sendDigest(shop: { id: string; name: string | null; domain: string; settings: unknown; timezone: string }, now: Date = new Date()): Promise<{ sent: boolean; count: number }> {
  const settings = parseShopSettings(shop.settings);
  if (!settings.notifications.digest || !settings.notifications.email.includes("@") || !emailConfigured()) return { sent: false, count: 0 };
  if (localHour(shop.timezone, now) !== DIGEST_HOUR) return { sent: false, count: 0 };

  const since = new Date(now.getTime() - 48 * 3_600_000);
  const rows = (
    await prisma.notification.findMany({
      where: { shopId: shop.id, emailedAt: null, archivedAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
  ).filter((r) => shouldEmail(settings.notifications, r.type, r.severity));
  if (rows.length === 0) return { sent: false, count: 0 };
  const result = await emailNotifications(shop, rows, { digest: true });
  return { sent: result.sent, count: rows.length };
}
