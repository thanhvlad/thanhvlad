import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";

export interface ActivityInput {
  action: string;
  message: string;
  actor?: string;
  entity?: string;
  entityId?: string;
  level?: "debug" | "info" | "warn" | "error";
  meta?: Record<string, unknown>;
}

/** Append to the shop's activity feed. Never throws — logging must not break a job. */
export async function logActivity(shopId: string, input: ActivityInput) {
  try {
    await prisma.activityLog.create({
      data: {
        shopId,
        actor: input.actor ?? "system",
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        level: input.level ?? "info",
        message: input.message,
        meta: (input.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    logger.error("Failed to write activity log", { shopId, action: input.action, error });
  }
}

export async function listActivity(
  shopId: string,
  options: { entity?: string; entityId?: string; limit?: number; cursor?: string } = {},
) {
  return prisma.activityLog.findMany({
    where: {
      shopId,
      ...(options.entity ? { entity: options.entity } : {}),
      ...(options.entityId ? { entityId: options.entityId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
    ...(options.cursor ? { skip: 1, cursor: { id: options.cursor } } : {}),
  });
}
