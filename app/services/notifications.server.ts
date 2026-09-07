import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";

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
    return await prisma.notification.create({
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
