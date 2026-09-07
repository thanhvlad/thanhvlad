import prisma from "~/db.server";
import { selectShipping } from "~/domain/shipping/select";
import type { SelectShippingResult, ShippingOption } from "~/domain/shipping/types";
import type { ShopSettings } from "~/domain/settings/shop-settings";
import { logActivity } from "./activity.server";

export async function listShippingPreferences(shopId: string) {
  return prisma.shippingPreference.findMany({
    where: { shopId },
    orderBy: [{ countryCode: "asc" }, { priority: "asc" }],
  });
}

export interface ShippingPreferenceInput {
  countryCode: string;
  carrierCode: string;
  carrierName?: string | null;
  priority?: number;
  maxCost?: string | number | null;
  maxDeliveryDays?: number | null;
  requireTracking?: boolean;
  isEnabled?: boolean;
}

export async function upsertShippingPreference(shopId: string, input: ShippingPreferenceInput, id?: string) {
  const data = {
    countryCode: (input.countryCode || "*").toUpperCase(),
    carrierCode: input.carrierCode.trim(),
    carrierName: input.carrierName ?? null,
    priority: input.priority ?? 0,
    maxCost: input.maxCost === null || input.maxCost === undefined || input.maxCost === "" ? null : String(input.maxCost),
    maxDeliveryDays: input.maxDeliveryDays ?? null,
    requireTracking: input.requireTracking ?? false,
    isEnabled: input.isEnabled ?? true,
  };
  const row = id
    ? await prisma.shippingPreference.update({ where: { id }, data })
    : await prisma.shippingPreference.upsert({
        where: { shopId_countryCode_carrierCode: { shopId, countryCode: data.countryCode, carrierCode: data.carrierCode } },
        create: { shopId, ...data },
        update: data,
      });
  await logActivity(shopId, {
    action: "shipping.preference.saved",
    entity: "ShippingPreference",
    entityId: row.id,
    message: `Shipping preference ${row.carrierCode} for ${row.countryCode} saved.`,
  });
  return row;
}

export async function deleteShippingPreference(shopId: string, id: string) {
  await prisma.shippingPreference.deleteMany({ where: { id, shopId } });
}

export async function reorderShippingPreferences(shopId: string, countryCode: string, orderedIds: string[]) {
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.shippingPreference.updateMany({ where: { id, shopId, countryCode: countryCode.toUpperCase() }, data: { priority: index } }),
    ),
  );
}

/** Run the selector with the shop's preferences and settings. */
export async function chooseShippingForShop(
  shopId: string,
  settings: ShopSettings["shipping"],
  options: ShippingOption[],
  shipToCountry: string,
): Promise<SelectShippingResult> {
  const preferences = await listShippingPreferences(shopId);
  return selectShipping({
    options,
    preferences: preferences.map((p) => ({
      id: p.id,
      countryCode: p.countryCode,
      carrierCode: p.carrierCode,
      priority: p.priority,
      maxCost: p.maxCost?.toString() ?? null,
      maxDeliveryDays: p.maxDeliveryDays,
      requireTracking: p.requireTracking,
      isEnabled: p.isEnabled,
    })),
    shipToCountry,
    fallback: settings.fallback,
    maxCost: settings.maxShippingCost > 0 ? settings.maxShippingCost : null,
    requireTracking: settings.requireTracking,
  });
}

/** Common carriers offered by AliExpress/CJ, for the picker in the UI. */
export const KNOWN_CARRIERS: Array<{ code: string; name: string }> = [
  { code: "CAINIAO_STANDARD", name: "AliExpress Standard Shipping" },
  { code: "CAINIAO_PREMIUM", name: "AliExpress Premium Shipping" },
  { code: "CAINIAO_ECONOMY", name: "Cainiao Super Economy" },
  { code: "CAINIAO_ECONOMY_SG", name: "Cainiao Super Economy Global" },
  { code: "EPACKET", name: "ePacket" },
  { code: "YANWEN", name: "Yanwen Economic Air Mail" },
  { code: "YANWEN_JYT", name: "Yanwen Special Line" },
  { code: "SUNYOU", name: "SunYou Economic Air Mail" },
  { code: "CHINA_POST", name: "China Post Registered Air Mail" },
  { code: "DHL", name: "DHL Express" },
  { code: "FEDEX", name: "FedEx" },
  { code: "UPS", name: "UPS" },
  { code: "USPS", name: "USPS" },
  { code: "CJPacket", name: "CJPacket" },
  { code: "CJPacket Ordinary", name: "CJPacket Ordinary" },
  { code: "USPS+", name: "USPS+ (CJ US warehouse)" },
  { code: "SELLER_SHIPPING", name: "Seller's Shipping Method" },
];
