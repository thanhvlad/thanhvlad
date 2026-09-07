import type { MappingType, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { resolveMapping } from "~/domain/mapping/resolve";
import type { ResolveResult, SupplierVariantSnapshot, VariantMappingRow } from "~/domain/mapping/types";
import { logActivity } from "./activity.server";
import { fetchAndCacheByReference } from "./suppliers/catalog.server";
import type { SupplierPlatform } from "./suppliers/types";

export interface MappingRowInput {
  productVariantId: string;
  supplierVariantId: string;
  quantity?: number;
  priority?: number;
  shipToCountry?: string;
  shipFromCountry?: string | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  bundleGroup?: string | null;
  isDefault?: boolean;
  isEnabled?: boolean;
}

export async function getMapping(productId: string) {
  return prisma.productMapping.findUnique({
    where: { productId },
    include: {
      variants: {
        include: { supplierVariant: { include: { supplierProduct: { select: { id: true, platform: true, externalId: true, title: true, url: true, storeName: true, images: true, isAvailable: true } } } } },
        orderBy: [{ productVariantId: "asc" }, { priority: "asc" }],
      },
    },
  });
}

/** Replace the mapping rows for a product wholesale. */
export async function saveMapping(shopId: string, productId: string, input: { type: MappingType; isEnabled?: boolean; notes?: string | null; rows: MappingRowInput[] }, actor?: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, shopId }, select: { id: true, title: true } });
  if (!product) throw new Error("Product not found");

  const validVariantIds = new Set((await prisma.productVariant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id));
  const rows = input.rows.filter((r) => validVariantIds.has(r.productVariantId) && r.supplierVariantId);

  // Exactly one default per variant for BASIC/ADVANCED keeps resolution deterministic.
  const seenDefault = new Set<string>();
  const normalised = rows.map((r, index) => {
    const isDefault = (input.type === "BASIC" ? true : (r.isDefault ?? false)) && !seenDefault.has(r.productVariantId);
    if (isDefault) seenDefault.add(r.productVariantId);
    return {
      productVariantId: r.productVariantId,
      supplierVariantId: r.supplierVariantId,
      quantity: Math.max(1, Math.trunc(r.quantity ?? 1)),
      priority: r.priority ?? index,
      shipToCountry: (r.shipToCountry || "*").toUpperCase(),
      shipFromCountry: r.shipFromCountry ?? null,
      minQuantity: input.type === "BOGO" ? (r.minQuantity ?? 1) : null,
      maxQuantity: input.type === "BOGO" ? (r.maxQuantity ?? null) : null,
      bundleGroup: input.type === "BUNDLE" ? (r.bundleGroup || "default") : null,
      isDefault,
      isEnabled: r.isEnabled ?? true,
    };
  });

  const mapping = await prisma.$transaction(async (tx) => {
    const m = await tx.productMapping.upsert({
      where: { productId },
      create: { productId, type: input.type, isEnabled: input.isEnabled ?? true, notes: input.notes ?? null },
      update: { type: input.type, isEnabled: input.isEnabled ?? true, notes: input.notes ?? null },
    });
    await tx.variantMapping.deleteMany({ where: { productMappingId: m.id } });
    if (normalised.length > 0) {
      await tx.variantMapping.createMany({ data: normalised.map((r) => ({ ...r, productMappingId: m.id })) });
    }
    return m;
  });

  await logActivity(shopId, {
    actor,
    action: "mapping.saved",
    entity: "Product",
    entityId: productId,
    message: `${input.type} mapping saved for "${product.title}" (${normalised.length} rows).`,
  });
  return mapping;
}

/** Fetch a supplier product so it can be used as a mapping source. */
export async function addSupplierProductForMapping(shopId: string, reference: string, platform?: SupplierPlatform) {
  const { product } = await fetchAndCacheByReference(shopId, reference, { platform });
  return product;
}

/** Supplier products currently referenced by a product's mapping, plus their variants. */
export async function supplierProductsForProduct(productId: string) {
  const rows = await prisma.variantMapping.findMany({
    where: { productMapping: { productId } },
    select: { supplierVariant: { select: { supplierProductId: true } } },
  });
  const ids = [...new Set(rows.map((r) => r.supplierVariant.supplierProductId))];
  if (ids.length === 0) return [];
  return prisma.supplierProduct.findMany({ where: { id: { in: ids } }, include: { variants: { orderBy: { createdAt: "asc" } } } });
}

export async function getSupplierProductWithVariants(id: string) {
  return prisma.supplierProduct.findUnique({ where: { id }, include: { variants: { orderBy: { createdAt: "asc" } } } });
}

/**
 * Suggest a BASIC mapping by matching option values: "Red / XL" on Shopify to
 * the supplier SKU whose attribute values are {Red, XL}. Order-insensitive and
 * case-insensitive; falls back to the sole supplier SKU when there is only one.
 */
export async function autoMapByOptions(productId: string, supplierProductId: string): Promise<MappingRowInput[]> {
  const [variants, supplier] = await Promise.all([
    prisma.productVariant.findMany({ where: { productId }, orderBy: { position: "asc" } }),
    getSupplierProductWithVariants(supplierProductId),
  ]);
  if (!supplier) return [];
  const normalise = (values: string[]) => values.map((v) => v.trim().toLowerCase()).filter(Boolean).sort().join("|");
  const bySignature = new Map<string, string>();
  for (const sv of supplier.variants) {
    const attrs = (sv.attributes as unknown as Array<{ value: string }>) ?? [];
    bySignature.set(normalise(attrs.map((a) => a.value)), sv.id);
  }
  const rows: MappingRowInput[] = [];
  for (const variant of variants) {
    const values = (variant.optionValues as unknown as string[]) ?? [];
    const match = bySignature.get(normalise(values)) ?? bySignature.get(normalise(variant.title.split("/"))) ?? (supplier.variants.length === 1 ? supplier.variants[0].id : undefined);
    if (match) rows.push({ productVariantId: variant.id, supplierVariantId: match, quantity: 1, isDefault: true });
  }
  return rows;
}

/** Build the pure-resolver context for one Shopify variant. */
export async function buildResolveContext(productVariantId: string, shipToCountry: string, orderedQuantity: number, options: { ignoreStock?: boolean } = {}) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: productVariantId },
    include: {
      product: { include: { mapping: true } },
      variantMappings: { include: { supplierVariant: { include: { supplierProduct: true } } } },
    },
  });
  if (!variant) return null;
  const mapping = variant.product.mapping;
  const rows: VariantMappingRow[] = variant.variantMappings.map((m) => ({
    id: m.id,
    productVariantId: m.productVariantId,
    supplierVariantId: m.supplierVariantId,
    quantity: m.quantity,
    priority: m.priority,
    shipToCountry: m.shipToCountry,
    shipFromCountry: m.shipFromCountry,
    minQuantity: m.minQuantity,
    maxQuantity: m.maxQuantity,
    bundleGroup: m.bundleGroup,
    isDefault: m.isDefault,
    isEnabled: m.isEnabled && (mapping?.isEnabled ?? true),
  }));
  const supplierVariants: Record<string, SupplierVariantSnapshot> = {};
  for (const m of variant.variantMappings) {
    const sv = m.supplierVariant;
    supplierVariants[sv.id] = {
      id: sv.id,
      supplierProductId: sv.supplierProductId,
      externalSkuId: sv.externalSkuId,
      externalProductId: sv.supplierProduct.externalId,
      platform: sv.supplierProduct.platform,
      title: `${sv.supplierProduct.title} — ${((sv.attributes as unknown as Array<{ value: string }>) ?? []).map((a) => a.value).join(" / ")}`,
      sku: sv.sku,
      price: sv.price.toString(),
      currency: sv.currency,
      stock: sv.stock,
      isAvailable: sv.isAvailable && sv.supplierProduct.isAvailable,
      shipsFrom: sv.supplierProduct.shipsFrom,
    };
  }
  return {
    type: (mapping?.type ?? "BASIC") as VariantMappingRow extends never ? never : "BASIC" | "ADVANCED" | "BOGO" | "BUNDLE",
    rows,
    supplierVariants,
    shipToCountry: shipToCountry || "*",
    orderedQuantity,
    ignoreStock: options.ignoreStock,
  };
}

export async function resolveForVariant(productVariantId: string, shipToCountry: string, orderedQuantity: number, options: { ignoreStock?: boolean } = {}): Promise<ResolveResult> {
  const ctx = await buildResolveContext(productVariantId, shipToCountry, orderedQuantity, options);
  if (!ctx) {
    return { ok: false, lines: [], totalCost: "0.00", failure: "NO_MAPPING", reason: "The variant is not managed by the app.", skipped: [] };
  }
  return resolveMapping(ctx);
}

/** Count of mapping rows per variant, for the products table badges. */
export async function mappingSummary(productIds: string[]) {
  const rows = await prisma.variantMapping.groupBy({
    by: ["productMappingId"],
    where: { productMapping: { productId: { in: productIds } } },
    _count: { _all: true },
  });
  return rows;
}

export type MappingWithRows = NonNullable<Awaited<ReturnType<typeof getMapping>>>;
export type { Prisma };
