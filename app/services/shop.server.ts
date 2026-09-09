import type { Session } from "@shopify/shopify-api";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { parseShopSettings, type ShopSettings } from "~/domain/settings/shop-settings";
import { fetchShopInfo } from "./shopify/shop.server";
import { logActivity } from "./activity.server";
import type { AdminApiContext } from "~/shopify.server";

export type ShopWithSettings = Shop & { parsedSettings: ShopSettings };

export function withSettings(shop: Shop): ShopWithSettings {
  return { ...shop, parsedSettings: parseShopSettings(shop.settings) };
}

/**
 * Load (or lazily create) the Shop row for a Shopify session.
 *
 * A store's very first request runs the parent `/app` loader and the child
 * page loader concurrently, and afterAuth calls this again on top. Each of
 * them misses the read and races to create; the losers used to get a unique
 * violation on `domain` — a 500 on the merchant's first screen — and each had
 * already created an Account nobody would ever reference. The Account and the
 * Shop are now created together, so a loser leaves nothing behind, and a loser
 * simply reads the row the winner made.
 */
export async function getOrCreateShop(domain: string): Promise<ShopWithSettings> {
  const existing = await prisma.shop.findUnique({ where: { domain } });
  if (existing) return withSettings(existing);

  let shop: Shop;
  try {
    shop = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: { name: domain.replace(".myshopify.com", "") },
      });
      return tx.shop.create({
        data: {
          domain,
          accountId: account.id,
          inventoryPolicy: { create: {} },
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "P2002") throw error;
    const won = await prisma.shop.findUnique({ where: { domain } });
    if (!won) throw error;
    return withSettings(won);
  }

  await logActivity(shop.id, {
    action: "shop.created",
    message: `Shop ${domain} registered.`,
  });
  return withSettings(shop);
}

export async function getShopByDomain(domain: string): Promise<ShopWithSettings | null> {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  return shop ? withSettings(shop) : null;
}

export async function getShopById(id: string): Promise<ShopWithSettings | null> {
  const shop = await prisma.shop.findUnique({ where: { id } });
  return shop ? withSettings(shop) : null;
}

/**
 * afterAuth hook: make sure a Shop row exists, refresh the store profile from
 * Shopify and mark the app installed again if it was previously removed.
 */
export async function onShopInstalled({
  session,
  admin,
}: {
  session: Session;
  admin: AdminApiContext;
}) {
  const shop = await getOrCreateShop(session.shop);

  let profile: Prisma.ShopUpdateInput = {};
  try {
    const info = await fetchShopInfo(admin.graphql);
    profile = {
      name: info.name,
      email: info.email,
      country: info.countryCode,
      currency: info.currencyCode,
      timezone: info.ianaTimezone,
      moneyFormat: info.moneyFormat,
      primaryLocationId: info.primaryLocationId,
      isDevelopmentStore: info.isDevelopmentStore,
    };
  } catch (error) {
    logger.warn("Could not fetch shop profile after auth", { shop: session.shop, error });
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      ...profile,
      isActive: true,
      uninstalledAt: null,
      installedAt: shop.uninstalledAt ? new Date() : shop.installedAt,
    },
  });

  if (shop.uninstalledAt) {
    await logActivity(shop.id, { action: "shop.reinstalled", message: "App reinstalled." });
  }

  await backfillOrdersOnInstall(shop.id);
}

/**
 * A fresh install pulls in the last 30 days of orders, so the Orders page is
 * not empty until the next webhook and the merchant can start with the orders
 * they already have — which is what DSers does and what a reviewer expects to
 * see. Only runs while the store has no orders at all: a re-auth or a
 * reinstall of a store with history must not queue a second sync.
 *
 * The job module is loaded lazily: it imports every service, and a static
 * import here would create a cycle back through the Shopify client.
 */
async function backfillOrdersOnInstall(shopId: string) {
  try {
    const existing = await prisma.order.count({ where: { shopId } });
    if (existing > 0) return;
    const [{ findOrCreateJobRun }, { enqueue }] = await Promise.all([import("./jobs.server"), import("./jobs/index.server")]);
    const { job, reused } = await findOrCreateJobRun({ shopId, type: "sync-orders", payload: { days: 30, reason: "install" } });
    if (!reused) {
      await enqueue("sync-orders", { shopId, days: 30, jobRunId: job.id }, { dedupeKey: `sync-orders-${shopId}` });
    }
  } catch (error) {
    logger.warn("Could not queue the install order backfill", { shopId, error });
  }
}

export async function markShopUninstalled(domain: string) {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop) return;
  await prisma.shop.update({
    where: { id: shop.id },
    data: { isActive: false, uninstalledAt: new Date() },
  });
  await prisma.session.deleteMany({ where: { shop: domain } });
  await logActivity(shop.id, { action: "shop.uninstalled", message: "App uninstalled." });
}

export async function updateShopSettings(shopId: string, settings: ShopSettings) {
  return prisma.shop.update({
    where: { id: shopId },
    data: { settings: settings as unknown as Prisma.InputJsonValue },
  });
}

export async function setOnboardingStep(shopId: string, step: string) {
  return prisma.shop.update({ where: { id: shopId }, data: { onboardingStep: step } });
}

/** Sister stores under the same account, for the multi-store switcher. */
export async function listAccountShops(accountId: string | null) {
  if (!accountId) return [];
  return prisma.shop.findMany({
    where: { accountId },
    orderBy: { installedAt: "asc" },
    select: { id: true, domain: true, name: true, isActive: true, currency: true },
  });
}
