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

/** Load (or lazily create) the Shop row for a Shopify session. */
export async function getOrCreateShop(domain: string): Promise<ShopWithSettings> {
  const existing = await prisma.shop.findUnique({ where: { domain } });
  if (existing) return withSettings(existing);

  const account = await prisma.account.create({
    data: { name: domain.replace(".myshopify.com", "") },
  });
  const shop = await prisma.shop.create({
    data: {
      domain,
      accountId: account.id,
      inventoryPolicy: { create: {} },
    },
  });
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
