import type { ImportStatus, ImportedProduct, ImportedVariant, Prisma, SupplierProduct, SupplierVariant } from "@prisma/client";
import prisma, { chunkedTransaction } from "~/db.server";
import { computePrice } from "~/domain/pricing/engine";
import type { PricingRuleInput } from "~/domain/pricing/types";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { d, money } from "~/lib/money";
import { logActivity } from "./activity.server";
import { convertToShopCurrency } from "./currency.server";
import { resolvePricingRule } from "./pricing.server";
import type { ShopWithSettings } from "./shop.server";
import type { GraphqlClient } from "./shopify/graphql.server";
import { createProduct, publishProduct } from "./shopify/products.server";
import { fetchAndCacheByReference, type CachedSupplierProduct } from "./suppliers/catalog.server";
import type { SupplierPlatform, SupplierProductDetail } from "./suppliers/types";

export type ImportedProductFull = ImportedProduct & {
  variants: (ImportedVariant & { supplierVariant: SupplierVariant | null })[];
  supplierProduct: (SupplierProduct & { variants: SupplierVariant[] }) | null;
};

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

/**
 * Put a supplier product on the Import List. Prices are converted to the shop
 * currency and run through the pricing rule so the merchant sees the final
 * numbers before pushing.
 */
export async function addToImportList(
  shop: ShopWithSettings,
  reference: string,
  options: { pricingRuleId?: string | null; platform?: SupplierPlatform; actor?: string } = {},
): Promise<ImportedProductFull> {
  const { product, detail } = await fetchAndCacheByReference(shop.id, reference, {
    platform: options.platform,
    shipToCountry: shop.country ?? "US",
  });

  const existing = await prisma.importedProduct.findUnique({
    where: { shopId_supplierProductId: { shopId: shop.id, supplierProductId: product.id } },
  });
  if (existing && existing.status !== "ARCHIVED") {
    return (await getImportedProduct(shop.id, existing.id))!;
  }

  const rule = await resolvePricingRule(shop.id, options.pricingRuleId);
  const settings = shop.parsedSettings.products;
  const variants = await buildVariantRows(shop, product, detail, rule);

  const data: Prisma.ImportedProductUncheckedCreateInput = {
    shopId: shop.id,
    supplierProductId: product.id,
    title: detail.title.slice(0, 255),
    description: settings.importDescription ? cleanDescription(detail.descriptionHtml, settings.cleanDescription) : "",
    vendor: settings.defaultVendor || detail.storeName || null,
    productType: settings.defaultProductType || null,
    tags: settings.defaultTags.split(",").map((t) => t.trim()).filter(Boolean),
    images: detail.images.slice(0, settings.maxImages),
    options: detail.optionNames as unknown as Prisma.InputJsonValue,
    excludedValues: {},
    status: "DRAFT",
    pricingRuleId: rule.id ?? null,
    variants: { create: variants },
  };

  const created = existing
    ? await prisma.importedProduct.update({
        where: { id: existing.id },
        data: { ...data, status: "DRAFT", pushError: null, pushedAt: null, pushedProductId: null, shopifyProductId: null, variants: { deleteMany: {}, create: variants } },
      })
    : await createOrAdopt(shop.id, product.id, data, variants);

  await logActivity(shop.id, {
    actor: options.actor,
    action: "import.added",
    entity: "ImportedProduct",
    entityId: created.id,
    message: `"${created.title}" added to the import list from ${product.platform}.`,
    meta: { supplierProductId: product.id, externalId: product.externalId },
  });
  return (await getImportedProduct(shop.id, created.id))!;
}

/**
 * Create the import-list row, or adopt the one a concurrent request just made.
 *
 * Read-then-create races against the unique index on (shopId, supplierProductId):
 * the browser extension double-clicking "add", or a retry overlapping the first
 * attempt, has both callers miss the read and the loser gets a P2002 the
 * merchant sees as a 500. The function is meant to be idempotent, so the
 * duplicate is treated as "already on your list".
 */
async function createOrAdopt(
  shopId: string,
  supplierProductId: string,
  data: Prisma.ImportedProductUncheckedCreateInput,
  variants: Prisma.ImportedVariantUncheckedCreateWithoutImportedProductInput[],
) {
  try {
    return await prisma.importedProduct.create({ data });
  } catch (error) {
    if (typeof error !== "object" || error === null || (error as { code?: string }).code !== "P2002") throw error;
    const winner = await prisma.importedProduct.findUnique({
      where: { shopId_supplierProductId: { shopId, supplierProductId } },
    });
    if (!winner) throw error;
    if (winner.status !== "ARCHIVED") return winner;
    return prisma.importedProduct.update({
      where: { id: winner.id },
      data: { ...data, status: "DRAFT", pushError: null, pushedAt: null, pushedProductId: null, shopifyProductId: null, variants: { deleteMany: {}, create: variants } },
    });
  }
}

async function buildVariantRows(
  shop: ShopWithSettings,
  product: CachedSupplierProduct,
  detail: SupplierProductDetail,
  rule: PricingRuleInput,
): Promise<Prisma.ImportedVariantUncheckedCreateWithoutImportedProductInput[]> {
  const settings = shop.parsedSettings;
  const rows: Prisma.ImportedVariantUncheckedCreateWithoutImportedProductInput[] = [];
  for (const sv of detail.variants) {
    const cached = product.variants.find((v) => v.externalSkuId === sv.externalSkuId);
    const cost = await convertToShopCurrency(sv.price, sv.currency, shop.currency, settings.currency);
    const priced = computePrice(rule, { cost: cost.toString(), shippingCost: 0 });
    rows.push({
      supplierVariantId: cached?.id ?? null,
      title: sv.attributes.map((a) => a.value).join(" / ") || "Default Title",
      sku: sv.sku ?? null,
      optionValues: sv.attributes.map((a) => a.value) as unknown as Prisma.InputJsonValue,
      image: sv.image ?? null,
      cost: cost.toString(),
      shippingCost: "0",
      price: priced.price,
      compareAtPrice: priced.compareAtPrice,
      weightGrams: sv.weightGrams ?? null,
      inventory: settings.products.trackInventory ? Math.min(settings.products.initialInventory, Math.max(0, sv.stock)) : settings.products.initialInventory,
      isEnabled: sv.isAvailable,
    });
  }
  return rows;
}

/** Strip supplier self-promotion and scripts from imported HTML. */
export function cleanDescription(html: string, aggressive: boolean): string {
  let out = html ?? "";
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/\son\w+="[^"]*"/gi, "");
  if (aggressive) {
    out = out.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
    out = out.replace(/(aliexpress|alibaba|cjdropshipping|taobao|1688)\.[a-z.]+/gi, "");
    out = out.replace(/<p>\s*<\/p>/gi, "");
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listImportList(
  shopId: string,
  options: { status?: ImportStatus | "ALL"; search?: string; page?: number; pageSize?: number } = {},
) {
  const page = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page as number)) : 1;
  const pageSize = Math.min(100, options.pageSize ?? 25);
  const where: Prisma.ImportedProductWhereInput = {
    shopId,
    ...(options.status && options.status !== "ALL" ? { status: options.status } : { status: { not: "ARCHIVED" } }),
    ...(options.search ? { title: { contains: options.search, mode: "insensitive" } } : {}),
  };
  const [items, total, counts] = await Promise.all([
    prisma.importedProduct.findMany({
      where,
      include: { variants: { select: { id: true, price: true, cost: true, isEnabled: true } }, supplierProduct: { select: { platform: true, externalId: true, storeName: true, url: true, isAvailable: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.importedProduct.count({ where }),
    prisma.importedProduct.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } }),
  ]);
  return {
    items,
    total,
    page,
    pageSize,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<ImportStatus, number>>,
  };
}

export async function getImportedProduct(shopId: string, id: string): Promise<ImportedProductFull | null> {
  return prisma.importedProduct.findFirst({
    where: { id, shopId },
    include: {
      variants: { include: { supplierVariant: true }, orderBy: { createdAt: "asc" } },
      supplierProduct: { include: { variants: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface ImportedProductPatch {
  title?: string;
  description?: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  collections?: string[];
  handle?: string | null;
  images?: string[];
  options?: string[];
  excludedValues?: Record<string, string[]>;
  pricingRuleId?: string | null;
}

export async function updateImportedProduct(shopId: string, id: string, patch: ImportedProductPatch) {
  const product = await prisma.importedProduct.findFirst({ where: { id, shopId } });
  if (!product) throw new Error("Imported product not found");
  return prisma.importedProduct.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 255) } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.vendor !== undefined ? { vendor: patch.vendor } : {}),
      ...(patch.productType !== undefined ? { productType: patch.productType } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.collections !== undefined ? { collections: patch.collections } : {}),
      ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
      ...(patch.images !== undefined ? { images: patch.images } : {}),
      ...(patch.options !== undefined ? { options: patch.options as unknown as Prisma.InputJsonValue } : {}),
      ...(patch.excludedValues !== undefined ? { excludedValues: patch.excludedValues as unknown as Prisma.InputJsonValue } : {}),
      ...(patch.pricingRuleId !== undefined ? { pricingRuleId: patch.pricingRuleId } : {}),
      status: product.status === "FAILED" ? "DRAFT" : product.status,
    },
  });
}

export interface ImportedVariantPatch {
  id: string;
  price?: string | number;
  compareAtPrice?: string | number | null;
  sku?: string | null;
  inventory?: number;
  isEnabled?: boolean;
  weightGrams?: number | null;
  image?: string | null;
}

export async function updateImportedVariants(shopId: string, importedProductId: string, patches: ImportedVariantPatch[]) {
  const product = await prisma.importedProduct.findFirst({ where: { id: importedProductId, shopId }, select: { id: true } });
  if (!product) throw new Error("Imported product not found");
  await chunkedTransaction(
    patches.map((p) =>
      prisma.importedVariant.updateMany({
        where: { id: p.id, importedProductId },
        data: {
          ...(p.price !== undefined ? { price: money(p.price) } : {}),
          ...(p.compareAtPrice !== undefined ? { compareAtPrice: p.compareAtPrice === null || p.compareAtPrice === "" ? null : money(p.compareAtPrice) } : {}),
          ...(p.sku !== undefined ? { sku: p.sku } : {}),
          ...(p.inventory !== undefined ? { inventory: Math.max(0, Math.trunc(p.inventory)) } : {}),
          ...(p.isEnabled !== undefined ? { isEnabled: p.isEnabled } : {}),
          ...(p.weightGrams !== undefined ? { weightGrams: p.weightGrams } : {}),
          ...(p.image !== undefined ? { image: p.image } : {}),
        },
      }),
    ),
  );
}

/** Re-run a pricing rule over every variant of an imported product. */
export async function applyPricingRuleToImport(shopId: string, importedProductId: string, pricingRuleId: string | null) {
  const product = await getImportedProduct(shopId, importedProductId);
  if (!product) throw new Error("Imported product not found");
  const rule = await resolvePricingRule(shopId, pricingRuleId);
  await chunkedTransaction(
    product.variants.map((v) => {
      const priced = computePrice(rule, { cost: v.cost.toString(), shippingCost: v.shippingCost.toString() });
      return prisma.importedVariant.update({
        where: { id: v.id },
        data: { price: priced.price, compareAtPrice: priced.compareAtPrice },
      });
    }),
  );
  await prisma.importedProduct.update({ where: { id: importedProductId }, data: { pricingRuleId } });
}

export async function removeFromImportList(shopId: string, ids: string[]) {
  const result = await prisma.importedProduct.deleteMany({ where: { shopId, id: { in: ids } } });
  await logActivity(shopId, { action: "import.removed", message: `${result.count} product(s) removed from the import list.` });
  return result.count;
}

/**
 * Split one imported product into several, one per value of `optionName`
 * (DSers "split product"). Each child keeps only the variants carrying that
 * value and drops the option from its option list.
 */
export async function splitImportedProduct(shopId: string, importedProductId: string, optionName: string) {
  const product = await getImportedProduct(shopId, importedProductId);
  if (!product) throw new Error("Imported product not found");
  const options = product.options as unknown as string[];
  const index = options.indexOf(optionName);
  if (index < 0) throw new Error(`Option "${optionName}" not found`);

  const values = new Set<string>();
  for (const v of product.variants) values.add((v.optionValues as unknown as string[])[index] ?? "");

  const created: string[] = [];
  for (const value of values) {
    const child = await prisma.importedProduct.create({
      data: {
        shopId,
        supplierProductId: null, // children are not unique per supplier product
        title: `${product.title} - ${value}`.slice(0, 255),
        description: product.description,
        vendor: product.vendor,
        productType: product.productType,
        tags: product.tags,
        collections: product.collections,
        images: product.images,
        options: options.filter((_, i) => i !== index) as unknown as Prisma.InputJsonValue,
        pricingRuleId: product.pricingRuleId,
        status: "DRAFT",
        variants: {
          create: product.variants
            .filter((v) => ((v.optionValues as unknown as string[])[index] ?? "") === value)
            .map((v) => ({
              supplierVariantId: v.supplierVariantId,
              title: (v.optionValues as unknown as string[]).filter((_, i) => i !== index).join(" / ") || "Default Title",
              sku: v.sku,
              optionValues: (v.optionValues as unknown as string[]).filter((_, i) => i !== index) as unknown as Prisma.InputJsonValue,
              image: v.image,
              cost: v.cost,
              shippingCost: v.shippingCost,
              price: v.price,
              compareAtPrice: v.compareAtPrice,
              weightGrams: v.weightGrams,
              inventory: v.inventory,
              isEnabled: v.isEnabled,
            })),
        },
      },
    });
    created.push(child.id);
  }
  await prisma.importedProduct.update({ where: { id: importedProductId }, data: { status: "ARCHIVED" } });
  await logActivity(shopId, { action: "import.split", entity: "ImportedProduct", entityId: importedProductId, message: `"${product.title}" split by ${optionName} into ${created.length} products.` });
  return created;
}

// ---------------------------------------------------------------------------
// Push to Shopify
// ---------------------------------------------------------------------------

export interface PushResult {
  importedProductId: string;
  ok: boolean;
  productId?: string;
  shopifyProductId?: string;
  error?: string;
}

/**
 * Create the Shopify product, mirror it locally and auto-create a BASIC
 * mapping from each variant to the supplier SKU it was imported from.
 */
export async function pushImportedProduct(shop: ShopWithSettings, client: GraphqlClient, importedProductId: string, actor?: string): Promise<PushResult> {
  const product = await getImportedProduct(shop.id, importedProductId);
  if (!product) return { importedProductId, ok: false, error: "Imported product not found" };
  if (product.status === "PUSHED" && product.pushedProductId) {
    return { importedProductId, ok: true, productId: product.pushedProductId };
  }
  const enabledVariants = product.variants.filter((v) => v.isEnabled);
  if (enabledVariants.length === 0) {
    await prisma.importedProduct.update({ where: { id: product.id }, data: { status: "FAILED", pushError: "No enabled variants" } });
    return { importedProductId, ok: false, error: "No enabled variants" };
  }

  await prisma.importedProduct.update({ where: { id: product.id }, data: { status: "PUSHING", pushError: null } });
  const settings = shop.parsedSettings.products;

  try {
    const optionNames = product.options as unknown as string[];
    const excluded = (product.excludedValues ?? {}) as Record<string, string[]>;
    const variantsToPush = enabledVariants.filter((v) => {
      const values = v.optionValues as unknown as string[];
      return !optionNames.some((name, i) => (excluded[name] ?? []).includes(values[i]));
    });

    const pushed = await createProduct(client, {
      // Adopt the product a previous attempt already created rather than making
      // a second listing of the same item. `productSet` upserts on this id.
      id: product.shopifyProductId,
      title: product.title,
      descriptionHtml: product.description,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      handle: product.handle,
      status: settings.defaultStatus,
      optionNames,
      images: product.images,
      variants: variantsToPush.map((v) => ({
        optionValues: v.optionValues as unknown as string[],
        sku: v.sku,
        price: money(v.price),
        compareAtPrice: v.compareAtPrice ? money(v.compareAtPrice) : null,
        cost: money(v.cost),
        weightGrams: v.weightGrams,
        inventoryQuantity: v.inventory,
        imageUrl: v.image,
      })),
      locationId: shop.primaryLocationId,
      trackInventory: settings.trackInventory,
      weightUnit: settings.weightUnit,
      collectionIds: product.collections,
    });

    // Recorded before anything else: from here on the product exists in the
    // merchant's store, and a failure below must not lose track of it.
    if (product.shopifyProductId !== pushed.id) {
      await prisma.importedProduct.update({ where: { id: product.id }, data: { shopifyProductId: pushed.id } });
    }

    if (settings.publishOnPush && settings.defaultStatus === "ACTIVE") {
      await publishProduct(client, pushed.id).catch((error) => logger.warn("Publish failed", { productId: pushed.id, error }));
    }

    // The header rows go in one short transaction; the per-variant work runs
    // outside it. A product with a few hundred variants issued two writes per
    // variant inside a single interactive transaction, which timed out (P2028)
    // and rolled the whole mirror back while the Shopify product stayed.
    const local = await prisma.$transaction(async (tx) => {
      const row = await tx.product.upsert({
        where: { shopId_shopifyProductId: { shopId: shop.id, shopifyProductId: pushed.id } },
        create: {
          shopId: shop.id,
          shopifyProductId: pushed.id,
          title: pushed.title,
          handle: pushed.handle,
          status: pushed.status,
          vendor: product.vendor,
          featuredImage: pushed.featuredImage ?? product.images[0] ?? null,
          lastSyncedAt: new Date(),
        },
        update: { title: pushed.title, handle: pushed.handle, status: pushed.status, featuredImage: pushed.featuredImage ?? undefined },
      });
      await tx.productMapping.upsert({
        where: { productId: row.id },
        create: { productId: row.id, type: "BASIC" },
        update: {},
      });
      return row;
    });

    const mapping = (await prisma.productMapping.findUnique({ where: { productId: local.id } }))!;

    for (const sv of pushed.variants) {
      const source = matchVariant(variantsToPush, sv.optionValues);
      const variant = await prisma.productVariant.upsert({
        where: { productId_shopifyVariantId: { productId: local.id, shopifyVariantId: sv.id } },
        create: {
          productId: local.id,
          shopifyVariantId: sv.id,
          inventoryItemId: sv.inventoryItemId,
          title: sv.title,
          sku: sv.sku,
          optionValues: sv.optionValues as unknown as Prisma.InputJsonValue,
          price: sv.price,
          compareAtPrice: sv.compareAtPrice,
          cost: source ? source.cost : null,
          inventoryQuantity: source?.inventory ?? 0,
          position: sv.position,
        },
        update: { title: sv.title, sku: sv.sku, price: sv.price, compareAtPrice: sv.compareAtPrice, cost: source?.cost ?? undefined, position: sv.position },
      });
      if (source?.supplierVariantId) {
        // Replace rather than append: a re-push of the same product would
        // otherwise stack a duplicate mapping row per attempt, and
        // VariantMapping has no unique constraint to stop it (nor could it —
        // BOGO and bundle mappings legitimately repeat a supplier SKU).
        await prisma.variantMapping.deleteMany({ where: { productMappingId: mapping.id, productVariantId: variant.id } });
        await prisma.variantMapping.create({
          data: {
            productMappingId: mapping.id,
            productVariantId: variant.id,
            supplierVariantId: source.supplierVariantId,
            quantity: 1,
            priority: 0,
            shipToCountry: "*",
            isDefault: true,
          },
        });
      }
    }

    await prisma.importedProduct.update({
      where: { id: product.id },
      data: { status: "PUSHED", pushedProductId: local.id, pushedAt: new Date(), pushError: null },
    });

    await logActivity(shop.id, {
      actor,
      action: "product.pushed",
      entity: "Product",
      entityId: local.id,
      message: `"${pushed.title}" pushed to Shopify with ${pushed.variants.length} variant(s).`,
      meta: { shopifyProductId: pushed.id },
    });
    return { importedProductId, ok: true, productId: local.id, shopifyProductId: pushed.id };
  } catch (error) {
    const message = errorMessage(error);
    logger.error("Push to Shopify failed", { importedProductId, error });
    await prisma.importedProduct.update({ where: { id: product.id }, data: { status: "FAILED", pushError: message } });
    await logActivity(shop.id, { actor, action: "product.push_failed", entity: "ImportedProduct", entityId: product.id, level: "error", message: `Push failed for "${product.title}": ${message}` });
    return { importedProductId, ok: false, error: message };
  }
}

function matchVariant(
  candidates: (ImportedVariant & { supplierVariant: SupplierVariant | null })[],
  optionValues: string[],
) {
  const key = optionValues.map((v) => v.trim().toLowerCase()).join("|");
  return (
    candidates.find((v) => (v.optionValues as unknown as string[]).map((x) => x.trim().toLowerCase()).join("|") === key) ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}

/** Quick margin summary for the import list cards. */
export function summarizeMargins(variants: Array<{ price: Prisma.Decimal | string; cost: Prisma.Decimal | string; isEnabled: boolean }>) {
  const enabled = variants.filter((v) => v.isEnabled);
  if (enabled.length === 0) return { minPrice: "0.00", maxPrice: "0.00", minCost: "0.00", maxCost: "0.00", avgMargin: "0.00" };
  const prices = enabled.map((v) => d(v.price));
  const costs = enabled.map((v) => d(v.cost));
  const margins = enabled.map((v) => {
    const p = d(v.price);
    return p.isZero() ? d(0) : p.minus(d(v.cost)).dividedBy(p).times(100);
  });
  const sorted = (arr: ReturnType<typeof d>[]) => [...arr].sort((a, b) => a.comparedTo(b));
  return {
    minPrice: money(sorted(prices)[0]),
    maxPrice: money(sorted(prices)[prices.length - 1]),
    minCost: money(sorted(costs)[0]),
    maxCost: money(sorted(costs)[costs.length - 1]),
    avgMargin: margins.reduce((a, b) => a.plus(b), d(0)).dividedBy(margins.length).toFixed(1),
  };
}
