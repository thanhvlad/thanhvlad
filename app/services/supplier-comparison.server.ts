import type { Prisma } from "@prisma/client";
import prisma, { chunkedTransaction } from "~/db.server";
import { matchVariants } from "~/domain/mapping/match";
import { isWorthSwitching, scoreCandidates, type ScoreInput, type ScoredCandidate } from "~/domain/suppliers/score";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money } from "~/lib/money";
import { logActivity } from "./activity.server";
import { convertToShopCurrency } from "./currency.server";
import { saveMapping, suggestMappingForProduct } from "./mapping.server";
import { notify } from "./notifications.server";
import type { ShopWithSettings } from "./shop.server";
import { cacheSupplierProduct, getShippingOptions } from "./suppliers/catalog.server";
import { adapterForShop } from "./suppliers/index.server";
import type { SupplierPlatform, SupplierSearchItem } from "./suppliers/types";

/**
 * Supplier optimizer.
 *
 * For a product already mapped to one supplier, find comparable listings, work
 * out what each would actually cost delivered to the shop's main market, how
 * much of the product's variant range it can cover, and rank them. The merchant
 * sees the trade-off and can switch in one click.
 */

export interface ComparisonRow extends ScoredCandidate {
  supplierProductId: string;
  platform: SupplierPlatform;
  title: string;
  url: string | null;
  image: string | null;
  storeName: string | null;
  carrierName: string | null;
  currency: string;
  matchedVariants: number;
  totalVariants: number;
  dismissed: boolean;
}

export interface ComparisonResult {
  rows: ComparisonRow[];
  betterOption: ComparisonRow | null;
  evaluatedAt: Date | null;
  shipToCountry: string;
}

/** Read the stored comparison without going upstream. */
export async function getComparison(shop: ShopWithSettings, productId: string): Promise<ComparisonResult> {
  const [product, candidates] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, shopId: shop.id }, select: { id: true, _count: { select: { variants: true } } } }),
    prisma.supplierCandidate.findMany({
      where: { productId },
      include: { supplierProduct: { select: { id: true, platform: true, title: true, url: true, images: true, storeName: true, isAvailable: true } } },
      orderBy: { score: "desc" },
    }),
  ]);
  if (!product || candidates.length === 0) {
    return { rows: [], betterOption: null, evaluatedAt: null, shipToCountry: shop.country ?? "US" };
  }

  const scored = scoreCandidates(
    candidates.map((c) => ({
      id: c.supplierProductId,
      itemCost: c.itemCost.toString(),
      shippingCost: c.shippingCost.toString(),
      deliveryDays: c.deliveryDays,
      rating: c.rating,
      orderCount: c.orderCount,
      isAvailable: c.supplierProduct.isAvailable && c.dismissedAt === null,
      isCurrent: c.isCurrent,
      coverage: coverageOf(c.scoreBreakdown),
    })),
  );

  const rows: ComparisonRow[] = scored.map((s) => {
    const row = candidates.find((c) => c.supplierProductId === s.id)!;
    const breakdown = (row.scoreBreakdown ?? {}) as Record<string, unknown>;
    return {
      ...s,
      supplierProductId: row.supplierProductId,
      platform: row.supplierProduct.platform,
      title: row.supplierProduct.title,
      url: row.supplierProduct.url,
      image: row.supplierProduct.images[0] ?? null,
      storeName: row.supplierProduct.storeName,
      carrierName: row.carrierName,
      currency: row.currency,
      matchedVariants: Number(breakdown.matchedVariants ?? 0),
      totalVariants: Number(breakdown.totalVariants ?? product._count.variants),
      dismissed: row.dismissedAt !== null,
    };
  });

  return {
    rows,
    betterOption: (isWorthSwitching(scored) && rows.find((r) => r.id === isWorthSwitching(scored)!.id)) || null,
    evaluatedAt: candidates[0]?.evaluatedAt ?? null,
    shipToCountry: shop.country ?? "US",
  };
}

function coverageOf(breakdown: Prisma.JsonValue): number {
  if (!breakdown || typeof breakdown !== "object") return 1;
  const value = (breakdown as Record<string, unknown>).coverage;
  return typeof value === "number" && value >= 0 && value <= 1 ? value : 1;
}

/**
 * Search the supplier platform for alternatives to a product's current supplier
 * and score them. Costs are converted to the shop currency and include shipping
 * to the shop's own country, because that is the number the merchant lives with.
 */
export async function findAlternativeSuppliers(
  shop: ShopWithSettings,
  productId: string,
  options: { limit?: number; actor?: string } = {},
): Promise<ComparisonResult> {
  const limit = Math.min(12, options.limit ?? 6);
  const shipTo = (shop.country ?? "US").toUpperCase();

  const product = await prisma.product.findFirst({
    where: { id: productId, shopId: shop.id },
    include: {
      variants: { orderBy: { position: "asc" } },
      mapping: { include: { variants: { include: { supplierVariant: { include: { supplierProduct: true } } } } } },
    },
  });
  if (!product) throw new Error("Product not found");

  const currentSupplierProduct = product.mapping?.variants[0]?.supplierVariant.supplierProduct ?? null;
  const platform: SupplierPlatform = currentSupplierProduct?.platform ?? "ALIEXPRESS";
  const { adapter } = await adapterForShop(shop.id, platform);

  // Search by the supplier's own title where we have it — it is written in the
  // marketplace's vocabulary, which finds far better matches than the merchant's
  // rewritten Shopify title.
  const query = (currentSupplierProduct?.title ?? product.title).split(/[,|(]/)[0].slice(0, 80);
  let found: SupplierSearchItem[] = [];
  try {
    const search = await adapter.searchProducts({ query, pageSize: limit * 2, shipToCountry: shipTo, sort: "orders" });
    found = search.items;
  } catch (error) {
    logger.warn("Supplier search for alternatives failed", { productId, error });
    throw new Error(`Could not search the supplier: ${errorMessage(error)}`);
  }

  const currentExternalId = currentSupplierProduct?.externalId;
  const shortlist = found.filter((i) => i.externalId !== currentExternalId).slice(0, limit);

  const inputs: ScoreInput[] = [];
  const meta = new Map<string, { supplierProductId: string; carrierName: string | null; matched: number; total: number; currency: string }>();

  // Always include the supplier in use so the comparison has a baseline.
  if (currentSupplierProduct) {
    const evaluated = await evaluateCandidate(shop, product.variants, currentSupplierProduct.id, shipTo).catch((error) => {
      logger.warn("Could not evaluate the current supplier", { productId, error });
      return null;
    });
    if (evaluated) {
      inputs.push({ ...evaluated.score, isCurrent: true });
      meta.set(currentSupplierProduct.id, evaluated.meta);
    }
  }

  for (const item of shortlist) {
    try {
      const detail = await adapter.getProduct(item.externalId, { shipToCountry: shipTo });
      if (!detail) continue;
      const cached = await cacheSupplierProduct({ ...detail, platform }, null);
      const evaluated = await evaluateCandidate(shop, product.variants, cached.id, shipTo, {
        rating: item.rating ?? detail.rating ?? null,
        orderCount: item.orderCount ?? detail.orderCount ?? null,
      });
      inputs.push(evaluated.score);
      meta.set(cached.id, evaluated.meta);
    } catch (error) {
      logger.debug("Skipping a candidate supplier", { externalId: item.externalId, error });
    }
  }

  if (inputs.length === 0) {
    return { rows: [], betterOption: null, evaluatedAt: new Date(), shipToCountry: shipTo };
  }

  const scored = scoreCandidates(inputs);
  await chunkedTransaction(
    scored.map((s) => {
      const m = meta.get(s.id)!;
      return prisma.supplierCandidate.upsert({
        where: { productId_supplierProductId: { productId, supplierProductId: s.id } },
        create: {
          productId,
          supplierProductId: s.id,
          itemCost: String(s.itemCost),
          shippingCost: String(s.shippingCost),
          landedCost: s.landedCost,
          currency: m.currency,
          deliveryDays: s.deliveryDays,
          carrierName: m.carrierName,
          rating: s.rating,
          orderCount: s.orderCount,
          score: s.score,
          scoreBreakdown: { ...s.breakdown, matchedVariants: m.matched, totalVariants: m.total } as Prisma.InputJsonValue,
          isCurrent: Boolean(s.isCurrent),
        },
        update: {
          itemCost: String(s.itemCost),
          shippingCost: String(s.shippingCost),
          landedCost: s.landedCost,
          currency: m.currency,
          deliveryDays: s.deliveryDays,
          carrierName: m.carrierName,
          rating: s.rating,
          orderCount: s.orderCount,
          score: s.score,
          scoreBreakdown: { ...s.breakdown, matchedVariants: m.matched, totalVariants: m.total } as Prisma.InputJsonValue,
          isCurrent: Boolean(s.isCurrent),
          evaluatedAt: new Date(),
        },
      });
    }),
  );

  const better = isWorthSwitching(scored);
  await logActivity(shop.id, {
    actor: options.actor,
    action: "supplier.compared",
    entity: "Product",
    entityId: productId,
    message: `Compared ${scored.length} supplier(s) for "${product.title}"${better ? `; a cheaper one saves ${better.savingsVsCurrent} ${meta.get(better.id)?.currency ?? ""} per unit.` : "; the current supplier is still the best."}`,
  });
  if (better) {
    await notify(shop.id, {
      type: "price.changed",
      title: `Cheaper supplier found for "${product.title}"`,
      body: `Saves ${better.savingsVsCurrent} per unit (${better.savingsPercent}%).`,
      link: `/app/products/${productId}`,
      dedupeKey: `supplier-better:${productId}`,
      dedupeMinutes: 60 * 24 * 7,
    });
  }

  return getComparison(shop, productId);
}

/** Cost, shipping and variant coverage of one supplier product for this product. */
async function evaluateCandidate(
  shop: ShopWithSettings,
  variants: Array<{ id: string; optionValues: Prisma.JsonValue; title: string }>,
  supplierProductId: string,
  shipTo: string,
  overrides: { rating?: number | null; orderCount?: number | null } = {},
): Promise<{ score: ScoreInput; meta: { supplierProductId: string; carrierName: string | null; matched: number; total: number; currency: string } }> {
  const supplier = await prisma.supplierProduct.findUniqueOrThrow({
    where: { id: supplierProductId },
    include: { variants: true },
  });

  const available = supplier.variants.filter((v) => v.isAvailable && v.stock > 0);
  const pool = available.length > 0 ? available : supplier.variants;
  const cheapest = pool.reduce((best, v) => (d(v.price).lessThan(d(best.price)) ? v : best), pool[0]);

  const itemCost = cheapest
    ? await convertToShopCurrency(cheapest.price.toString(), cheapest.currency, shop.currency, shop.parsedSettings.currency)
    : d(0);

  let shippingCost = d(0);
  let deliveryDays: number | null = null;
  let carrierName: string | null = null;
  try {
    const quotes = await getShippingOptions(shop.id, supplierProductId, {
      shipToCountry: shipTo,
      externalSkuId: cheapest?.externalSkuId ?? null,
      quantity: 1,
      maxAgeMinutes: 720,
    });
    const usable = quotes.filter((q) => q.hasTracking);
    const chosen = (usable.length ? usable : quotes).sort((a, b) => d(a.cost).comparedTo(d(b.cost)))[0];
    if (chosen) {
      shippingCost = await convertToShopCurrency(chosen.cost, chosen.currency, shop.currency, shop.parsedSettings.currency);
      deliveryDays = chosen.maxDeliveryDays ?? chosen.minDeliveryDays ?? null;
      carrierName = chosen.carrierName;
    }
  } catch (error) {
    logger.debug("No shipping quote for candidate", { supplierProductId, error });
  }

  // Coverage: how many of the product's variants this supplier could actually
  // serve, using the same matcher the mapping screen uses.
  const match = matchVariants(
    variants.map((v) => ({ id: v.id, values: ((v.optionValues as unknown as string[]) ?? []).filter(Boolean), label: v.title })),
    supplier.variants.map((sv) => ({
      id: sv.id,
      values: (((sv.attributes as unknown as Array<{ value: string }>) ?? []).map((a) => a.value)).filter(Boolean),
      label: sv.sku ?? sv.externalSkuId,
      isAvailable: sv.isAvailable && sv.stock > 0,
    })),
  );
  const matched = match.assignments.filter((a) => a.candidateId).length;
  const total = Math.max(1, variants.length);

  return {
    score: {
      id: supplierProductId,
      itemCost: money(itemCost),
      shippingCost: money(shippingCost),
      deliveryDays,
      rating: overrides.rating ?? supplier.rating,
      orderCount: overrides.orderCount ?? supplier.orderCount,
      isAvailable: supplier.isAvailable && pool.some((v) => v.isAvailable),
      coverage: matched / total,
    },
    meta: { supplierProductId, carrierName, matched, total, currency: shop.currency },
  };
}

/** Re-map the product onto a different supplier product and mark it current. */
export async function switchSupplier(shop: ShopWithSettings, productId: string, supplierProductId: string, actor?: string) {
  const suggestion = await suggestMappingForProduct(productId, supplierProductId, { useAi: true });
  if (suggestion.rows.length === 0) {
    throw new Error("None of that supplier's SKUs could be matched to this product's variants. Map it by hand instead.");
  }
  await saveMapping(
    shop.id,
    productId,
    {
      type: "BASIC",
      rows: suggestion.rows.map((r) => ({
        productVariantId: r.productVariantId,
        supplierVariantId: r.supplierVariantId,
        quantity: 1,
        isDefault: true,
        source: r.source,
        confidence: r.confidence,
      })),
    },
    actor,
  );
  await prisma.$transaction([
    prisma.supplierCandidate.updateMany({ where: { productId }, data: { isCurrent: false } }),
    prisma.supplierCandidate.updateMany({ where: { productId, supplierProductId }, data: { isCurrent: true, dismissedAt: null } }),
  ]);
  const supplier = await prisma.supplierProduct.findUnique({ where: { id: supplierProductId }, select: { title: true } });
  await logActivity(shop.id, {
    actor,
    action: "supplier.switched",
    entity: "Product",
    entityId: productId,
    message: `Supplier switched to "${supplier?.title ?? supplierProductId}" (${suggestion.rows.length} variant(s) mapped${suggestion.unresolved ? `, ${suggestion.unresolved} left to map by hand` : ""}).`,
  });
  return suggestion;
}

export async function dismissCandidate(shop: ShopWithSettings, productId: string, supplierProductId: string) {
  await prisma.supplierCandidate.updateMany({
    where: { productId, supplierProductId, product: { shopId: shop.id } },
    data: { dismissedAt: new Date() },
  });
}
