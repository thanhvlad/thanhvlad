import type { Prisma, SupplierProduct, SupplierVariant } from "@prisma/client";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { adapterForShop, detectPlatform, getAdapter } from "./index.server";
import type { SupplierPlatform, SupplierProductDetail, SupplierShippingQuote } from "./types";

export type CachedSupplierProduct = SupplierProduct & { variants: SupplierVariant[] };

/**
 * Persist an upstream product snapshot. Variants are matched on the external
 * SKU id so a refresh updates price/stock in place and mappings stay intact.
 */
export async function cacheSupplierProduct(
  detail: SupplierProductDetail,
  supplierAccountId: string | null = null,
): Promise<CachedSupplierProduct> {
  const platform = detail.platform as SupplierPlatform;
  const product = await prisma.supplierProduct.upsert({
    where: { platform_externalId: { platform, externalId: detail.externalId } },
    create: {
      platform,
      externalId: detail.externalId,
      supplierAccountId,
      title: detail.title,
      url: detail.url,
      currency: detail.currency,
      storeName: detail.storeName ?? null,
      storeUrl: detail.storeUrl ?? null,
      storeId: detail.storeId ?? null,
      rating: detail.rating ?? null,
      orderCount: detail.orderCount ?? null,
      images: detail.images,
      categoryId: detail.categoryId ?? null,
      shipsFrom: detail.shipsFrom,
      isAvailable: detail.isAvailable,
      raw: sanitizeRaw(detail),
      lastFetchedAt: new Date(),
    },
    update: {
      supplierAccountId: supplierAccountId ?? undefined,
      title: detail.title,
      url: detail.url,
      currency: detail.currency,
      storeName: detail.storeName ?? null,
      storeUrl: detail.storeUrl ?? null,
      storeId: detail.storeId ?? null,
      rating: detail.rating ?? null,
      orderCount: detail.orderCount ?? null,
      images: detail.images,
      categoryId: detail.categoryId ?? null,
      shipsFrom: detail.shipsFrom,
      isAvailable: detail.isAvailable,
      raw: sanitizeRaw(detail),
      lastFetchedAt: new Date(),
    },
  });

  const seen = new Set<string>();
  for (const variant of detail.variants) {
    seen.add(variant.externalSkuId);
    await prisma.supplierVariant.upsert({
      where: { supplierProductId_externalSkuId: { supplierProductId: product.id, externalSkuId: variant.externalSkuId } },
      create: {
        supplierProductId: product.id,
        externalSkuId: variant.externalSkuId,
        skuAttr: variant.skuAttr ?? null,
        sku: variant.sku ?? null,
        attributes: variant.attributes as unknown as Prisma.InputJsonValue,
        image: variant.image,
        price: variant.price,
        originalPrice: variant.originalPrice ?? null,
        currency: variant.currency,
        stock: variant.stock,
        isAvailable: variant.isAvailable,
      },
      update: {
        skuAttr: variant.skuAttr ?? null,
        sku: variant.sku ?? null,
        attributes: variant.attributes as unknown as Prisma.InputJsonValue,
        image: variant.image,
        price: variant.price,
        originalPrice: variant.originalPrice ?? null,
        currency: variant.currency,
        stock: variant.stock,
        isAvailable: variant.isAvailable,
      },
    });
  }
  // SKUs the supplier dropped are marked unavailable rather than deleted so
  // existing mappings can surface a clear "supplier removed this SKU" error.
  //
  // Only when the response actually carried variants. `notIn: []` matches every
  // row, so a response we could not parse — or one the supplier truncated —
  // would mark the entire product unavailable and stop every order for it.
  if (seen.size > 0) {
    await prisma.supplierVariant.updateMany({
      where: { supplierProductId: product.id, externalSkuId: { notIn: [...seen] } },
      data: { isAvailable: false, stock: 0 },
    });
  } else {
    logger.warn("Supplier returned no variants; keeping the cached ones", {
      supplierProductId: product.id,
      platform: product.platform,
      externalId: product.externalId,
    });
  }

  if (detail.variants.length > 0) {
    await recordPriceSnapshots(product.id, detail.variants);
  }

  const variants = await prisma.supplierVariant.findMany({
    where: { supplierProductId: product.id },
    orderBy: { createdAt: "asc" },
  });
  return { ...product, variants };
}

/** Keep at most one snapshot per SKU per hour, and only when something moved. */
const SNAPSHOT_INTERVAL_MS = 60 * 60_000;

async function recordPriceSnapshots(
  supplierProductId: string,
  variants: Array<{ externalSkuId: string; price: string | number; currency: string; stock: number }>,
) {
  const since = new Date(Date.now() - SNAPSHOT_INTERVAL_MS);
  const recent = await prisma.supplierPriceSnapshot.findMany({
    where: { supplierProductId, capturedAt: { gte: since } },
    orderBy: { capturedAt: "desc" },
  });
  const latest = new Map<string, (typeof recent)[number]>();
  for (const row of recent) {
    if (!latest.has(row.externalSkuId)) latest.set(row.externalSkuId, row);
  }

  // Every fetch used to write a row per variant, forever. The history is only
  // useful when it records a change.
  const fresh = variants.filter((v) => {
    const previous = latest.get(v.externalSkuId);
    if (!previous) return true;
    return String(previous.price) !== String(v.price) || previous.stock !== v.stock;
  });
  if (fresh.length === 0) return;

  await prisma.supplierPriceSnapshot.createMany({
    data: fresh.map((v) => ({
      supplierProductId,
      externalSkuId: v.externalSkuId,
      price: v.price,
      currency: v.currency,
      stock: v.stock,
    })),
  });
}

function sanitizeRaw(detail: SupplierProductDetail): Prisma.InputJsonValue {
  // Raw payloads can be several hundred KB (full description HTML); keep the
  // description out since it is already stored on the ImportedProduct.
  const { raw, descriptionHtml: _description, ...rest } = detail;
  void _description;
  return JSON.parse(JSON.stringify({ ...rest, raw: raw ?? null }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * Resolve a pasted URL/id to a cached supplier product, fetching it from the
 * platform when it is missing or stale.
 */
export async function fetchAndCacheByReference(
  shopId: string,
  reference: string,
  options: { forceRefresh?: boolean; shipToCountry?: string; platform?: SupplierPlatform } = {},
): Promise<{ product: CachedSupplierProduct; detail: SupplierProductDetail }> {
  const detected = options.platform
    ? { platform: options.platform, externalId: getAdapter(options.platform).parseProductReference(reference) ?? reference }
    : detectPlatform(reference);
  if (!detected) throw new Error(`Could not recognise a supplier product in "${reference}".`);

  const { adapter, account } = await adapterForShop(shopId, detected.platform);
  const detail = await adapter.getProduct(detected.externalId, { shipToCountry: options.shipToCountry });
  if (!detail) throw new Error(`Supplier product ${detected.externalId} was not found.`);
  // Record under the platform the merchant asked for even when the mock served it.
  const product = await cacheSupplierProduct({ ...detail, platform: detected.platform }, account?.id ?? null);
  return { product, detail };
}

/** Re-read a cached supplier product from upstream. Returns null if it vanished. */
export async function refreshSupplierProduct(
  shopId: string,
  supplierProductId: string,
): Promise<{ product: CachedSupplierProduct; detail: SupplierProductDetail } | null> {
  const existing = await prisma.supplierProduct.findUnique({ where: { id: supplierProductId } });
  if (!existing) return null;
  const { adapter, account } = await adapterForShop(shopId, existing.platform);
  try {
    const detail = await adapter.getProduct(existing.externalId);
    if (!detail) {
      await prisma.supplierProduct.update({ where: { id: existing.id }, data: { isAvailable: false, lastFetchedAt: new Date() } });
      await prisma.supplierVariant.updateMany({ where: { supplierProductId: existing.id }, data: { isAvailable: false, stock: 0 } });
      return null;
    }
    const product = await cacheSupplierProduct({ ...detail, platform: existing.platform }, account?.id ?? existing.supplierAccountId);
    return { product, detail };
  } catch (error) {
    logger.warn("Supplier refresh failed", { supplierProductId, error });
    throw error;
  }
}

export async function cacheShippingOptions(
  supplierProductId: string,
  quotes: SupplierShippingQuote[],
  key: { quantity: number; externalSkuId: string } = { quantity: 1, externalSkuId: "" },
) {
  for (const quote of quotes) {
    await prisma.supplierShippingOption.upsert({
      where: {
        supplierProductId_shipFromCountry_shipToCountry_carrierCode_quantity_externalSkuId: {
          supplierProductId,
          shipFromCountry: quote.shipFromCountry,
          shipToCountry: quote.shipToCountry,
          carrierCode: quote.carrierCode,
          quantity: key.quantity,
          externalSkuId: key.externalSkuId,
        },
      },
      create: {
        supplierProductId,
        quantity: key.quantity,
        externalSkuId: key.externalSkuId,
        shipFromCountry: quote.shipFromCountry,
        shipToCountry: quote.shipToCountry,
        carrierCode: quote.carrierCode,
        carrierName: quote.carrierName,
        cost: quote.cost,
        currency: quote.currency,
        minDeliveryDays: quote.minDeliveryDays,
        maxDeliveryDays: quote.maxDeliveryDays,
        hasTracking: quote.hasTracking,
        isFreeShipping: quote.isFreeShipping,
      },
      update: {
        carrierName: quote.carrierName,
        cost: quote.cost,
        currency: quote.currency,
        minDeliveryDays: quote.minDeliveryDays,
        maxDeliveryDays: quote.maxDeliveryDays,
        hasTracking: quote.hasTracking,
        isFreeShipping: quote.isFreeShipping,
        fetchedAt: new Date(),
      },
    });
  }
}

/** Shipping quotes for a supplier product, served from cache when fresh. */
export async function getShippingOptions(
  shopId: string,
  supplierProductId: string,
  params: { shipToCountry: string; externalSkuId?: string | null; quantity?: number; maxAgeMinutes?: number },
): Promise<SupplierShippingQuote[]> {
  const product = await prisma.supplierProduct.findUnique({ where: { id: supplierProductId } });
  if (!product) return [];
  const country = params.shipToCountry.toUpperCase();
  const maxAge = (params.maxAgeMinutes ?? 360) * 60_000;

  // The cache key carries the quantity and SKU the quote was priced for:
  // suppliers price per parcel, so serving a 1-unit quote for a 5-unit order
  // understates the cost and can pick a carrier that will not take the parcel.
  const quantity = Math.max(1, Math.trunc(params.quantity ?? 1));
  const externalSkuId = params.externalSkuId ?? "";
  const cached = await prisma.supplierShippingOption.findMany({
    where: {
      supplierProductId,
      shipToCountry: country,
      quantity,
      externalSkuId,
      fetchedAt: { gte: new Date(Date.now() - maxAge) },
    },
  });
  if (cached.length > 0) {
    return cached.map((o) => ({
      carrierCode: o.carrierCode,
      carrierName: o.carrierName,
      cost: o.cost.toString(),
      currency: o.currency,
      shipFromCountry: o.shipFromCountry,
      shipToCountry: o.shipToCountry,
      minDeliveryDays: o.minDeliveryDays,
      maxDeliveryDays: o.maxDeliveryDays,
      hasTracking: o.hasTracking,
      isFreeShipping: o.isFreeShipping,
    }));
  }

  const { adapter } = await adapterForShop(shopId, product.platform);
  const quotes = await adapter.getShippingQuotes({
    externalId: product.externalId,
    externalSkuId: externalSkuId || null,
    quantity,
    shipToCountry: country,
  });
  await cacheShippingOptions(supplierProductId, quotes, { quantity, externalSkuId });
  return quotes;
}

/** Price history for the product page sparkline. */
export async function priceHistory(supplierProductId: string, externalSkuId: string, limit = 30) {
  return prisma.supplierPriceSnapshot.findMany({
    where: { supplierProductId, externalSkuId },
    orderBy: { capturedAt: "desc" },
    take: limit,
  });
}
