import { z } from "zod";

/**
 * Free-form per-shop preferences stored in `Shop.settings` (JSON). Everything
 * has a default so a freshly installed shop behaves sensibly with `{}`.
 */
export const shopSettingsSchema = z.object({
  // ---- Orders ----------------------------------------------------------------
  orders: z
    .object({
      /** Hold supplier orders until Shopify marks the order paid. */
      requirePaidOrder: z.boolean().default(true),
      blockHighRisk: z.boolean().default(true),
      blockPartiallyPaid: z.boolean().default(true),
      /** Auto-place supplier orders as soon as they become AWAITING_ORDER. */
      autoPlaceOrders: z.boolean().default(false),
      /** Delay auto placement, so a customer can still cancel. */
      autoPlaceDelayMinutes: z.number().int().min(0).max(1440).default(60),
      /** Default note sent to every supplier. */
      supplierNote: z
        .string()
        .max(500)
        .default("Please do not include any invoice, promotion or QR code in the package. Thank you!"),
      /** Tags to add to the Shopify order once the supplier order is placed. */
      tagOnPlaced: z.string().default("dropship-ordered"),
      tagOnShipped: z.string().default("dropship-shipped"),
      /** Use the customer's phone; otherwise fall back to a merchant-provided number. */
      phoneFallback: z.string().default(""),
      /** Replace the customer's phone with the fallback for every order. */
      overridePhone: z.boolean().default(false),
      /** Automatically split an address line that is too long into line 2. */
      autoFixAddress: z.boolean().default(true),
      /** Mark line items that the app does not manage as ignored. */
      ignoreUnmanagedItems: z.boolean().default(true),
      /** Cancel supplier orders when the Shopify order is cancelled (if possible). */
      cancelSupplierOnCancel: z.boolean().default(true),
    })
    .default({}),

  // ---- Fulfilment -----------------------------------------------------------
  fulfillment: z
    .object({
      /** Create a Shopify fulfilment as soon as tracking arrives. */
      autoFulfill: z.boolean().default(true),
      notifyCustomer: z.boolean().default(true),
      /** Replace the supplier's carrier name with a neutral one in emails. */
      carrierNameOverride: z.string().default(""),
      /** Custom tracking URL template ({tracking} is substituted). */
      trackingUrlTemplate: z.string().default(""),
      /** Poll tracking status until delivered. */
      trackDelivery: z.boolean().default(true),
    })
    .default({}),

  // ---- Shipping -------------------------------------------------------------
  shipping: z
    .object({
      fallback: z.enum(["CHEAPEST", "FASTEST", "NONE"]).default("CHEAPEST"),
      requireTracking: z.boolean().default(true),
      /** Cap on supplier shipping cost, in shop currency; 0 = no cap. */
      maxShippingCost: z.number().min(0).default(0),
    })
    .default({}),

  // ---- Import / products ----------------------------------------------------
  products: z
    .object({
      /** Publish to the Online Store sales channel on push. */
      publishOnPush: z.boolean().default(true),
      defaultStatus: z.enum(["ACTIVE", "DRAFT"]).default("ACTIVE"),
      defaultVendor: z.string().default(""),
      defaultProductType: z.string().default(""),
      defaultTags: z.string().default("dropship"),
      /** Track inventory in Shopify (else "continue selling when out of stock"). */
      trackInventory: z.boolean().default(true),
      /** Starting inventory assigned to each variant on push. */
      initialInventory: z.number().int().min(0).default(50),
      /** Import the supplier's description HTML. */
      importDescription: z.boolean().default(true),
      /** Strip supplier store names / links from the description. */
      cleanDescription: z.boolean().default(true),
      /** Maximum images imported per product. */
      maxImages: z.number().int().min(1).max(250).default(20),
      /** Weight unit for variants pushed to Shopify. */
      weightUnit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]).default("GRAMS"),
    })
    .default({}),

  // ---- Currency -------------------------------------------------------------
  currency: z
    .object({
      /** Supplier currency the pricing rules convert from. */
      supplierCurrency: z.string().default("USD"),
      /** Manual override; 0 = use the fetched market rate. */
      manualRate: z.number().min(0).default(0),
      /** Extra % buffer on top of the rate to absorb fluctuation. */
      bufferPercent: z.number().min(0).max(50).default(0),
    })
    .default({}),

  // ---- Notifications --------------------------------------------------------
  notifications: z
    .object({
      email: z.string().default(""),
      onOrderFailed: z.boolean().default(true),
      onPriceChange: z.boolean().default(true),
      onOutOfStock: z.boolean().default(true),
      onProductRemoved: z.boolean().default(true),
      onTrackingSynced: z.boolean().default(false),
      /** Daily digest instead of instant emails. */
      digest: z.boolean().default(false),
    })
    .default({}),

  // ---- UI -------------------------------------------------------------------
  ui: z
    .object({
      locale: z.enum(["en", "vi"]).default("en"),
      ordersPageSize: z.number().int().min(10).max(250).default(50),
      dismissedTips: z.array(z.string()).default([]),
    })
    .default({}),
});

export type ShopSettings = z.infer<typeof shopSettingsSchema>;

export function parseShopSettings(raw: unknown): ShopSettings {
  const result = shopSettingsSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  // Never let one bad key take the whole settings page down.
  return shopSettingsSchema.parse({});
}

/** Deep-merge a partial update into an existing settings object. */
export function mergeShopSettings(current: unknown, patch: DeepPartial<ShopSettings>): ShopSettings {
  const base = parseShopSettings(current);
  const merged: Record<string, unknown> = { ...base };
  for (const [section, values] of Object.entries(patch)) {
    if (values && typeof values === "object" && !Array.isArray(values)) {
      merged[section] = { ...(base as Record<string, unknown>)[section] as object, ...values };
    } else if (values !== undefined) {
      merged[section] = values;
    }
  }
  return shopSettingsSchema.parse(merged);
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
