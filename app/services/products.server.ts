import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { computePrice } from "~/domain/pricing/engine";
import { money } from "~/lib/money";
import { logActivity } from "./activity.server";
import { resolvePricingRule } from "./pricing.server";
import type { ShopWithSettings } from "./shop.server";
import type { GraphqlClient } from "./shopify/graphql.server";
import { deleteProduct as deleteShopifyProduct, fetchProduct, updateVariantPrices } from "./shopify/products.server";

export async function listProducts(
  shopId: string,
  options: { search?: string; mapped?: "all" | "mapped" | "unmapped"; page?: number; pageSize?: number; autoUpdate?: boolean } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, options.pageSize ?? 25);
  const where: Prisma.ProductWhereInput = {
    shopId,
    ...(options.search ? { title: { contains: options.search, mode: "insensitive" } } : {}),
    ...(options.mapped === "mapped" ? { mapping: { variants: { some: {} } } } : {}),
    ...(options.mapped === "unmapped" ? { OR: [{ mapping: null }, { mapping: { variants: { none: {} } } }] } : {}),
    ...(options.autoUpdate !== undefined ? { autoUpdateEnabled: options.autoUpdate } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        variants: { select: { id: true, price: true, cost: true, inventoryQuantity: true }, orderBy: { position: "asc" } },
        mapping: { select: { type: true, isEnabled: true, _count: { select: { variants: true } } } },
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function getProduct(shopId: string, id: string) {
  return prisma.product.findFirst({
    where: { id, shopId },
    include: {
      variants: {
        orderBy: { position: "asc" },
        include: {
          variantMappings: { include: { supplierVariant: { include: { supplierProduct: { select: { id: true, platform: true, externalId: true, title: true, url: true, storeName: true, isAvailable: true, images: true } } } } } },
        },
      },
      mapping: true,
    },
  });
}

/**
 * Refresh a local mirror from Shopify (products/update webhook). Variants that
 * disappeared in Shopify are removed along with their mapping rows.
 */
export async function syncProductFromShopify(shop: ShopWithSettings, client: GraphqlClient, shopifyProductId: string) {
  const local = await prisma.product.findUnique({ where: { shopId_shopifyProductId: { shopId: shop.id, shopifyProductId } } });
  if (!local) return null;
  const remote = await fetchProduct(client, shopifyProductId);
  if (!remote) {
    await handleProductDeleted(shop.id, shopifyProductId);
    return null;
  }
  await prisma.product.update({
    where: { id: local.id },
    data: { title: remote.title, handle: remote.handle, status: remote.status, vendor: remote.vendor, featuredImage: remote.featuredImage, lastSyncedAt: new Date() },
  });
  const seen: string[] = [];
  for (const v of remote.variants) {
    seen.push(v.id);
    await prisma.productVariant.upsert({
      where: { productId_shopifyVariantId: { productId: local.id, shopifyVariantId: v.id } },
      create: {
        productId: local.id,
        shopifyVariantId: v.id,
        inventoryItemId: v.inventoryItemId,
        title: v.title,
        sku: v.sku,
        optionValues: v.optionValues as unknown as Prisma.InputJsonValue,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        cost: v.cost,
        inventoryQuantity: v.inventoryQuantity,
        position: v.position,
      },
      update: {
        inventoryItemId: v.inventoryItemId,
        title: v.title,
        sku: v.sku,
        optionValues: v.optionValues as unknown as Prisma.InputJsonValue,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        cost: v.cost ?? undefined,
        inventoryQuantity: v.inventoryQuantity,
        position: v.position,
      },
    });
  }
  await prisma.productVariant.deleteMany({ where: { productId: local.id, shopifyVariantId: { notIn: seen } } });
  return local.id;
}

export async function handleProductDeleted(shopId: string, shopifyProductId: string) {
  const local = await prisma.product.findUnique({ where: { shopId_shopifyProductId: { shopId, shopifyProductId } } });
  if (!local) return;
  await prisma.product.delete({ where: { id: local.id } });
  await prisma.importedProduct.updateMany({ where: { shopId, pushedProductId: local.id }, data: { pushedProductId: null } });
  await logActivity(shopId, { action: "product.deleted_in_shopify", entity: "Product", entityId: local.id, message: `"${local.title}" was deleted in Shopify; local mapping removed.` });
}

/** Bring an existing Shopify product under management so it can be mapped. */
export async function importExistingShopifyProduct(shop: ShopWithSettings, client: GraphqlClient, shopifyProductId: string, actor?: string) {
  const remote = await fetchProduct(client, shopifyProductId);
  if (!remote) throw new Error("Product not found in Shopify");
  const row = await prisma.product.upsert({
    where: { shopId_shopifyProductId: { shopId: shop.id, shopifyProductId } },
    create: {
      shopId: shop.id,
      shopifyProductId,
      title: remote.title,
      handle: remote.handle,
      status: remote.status,
      vendor: remote.vendor,
      featuredImage: remote.featuredImage,
      lastSyncedAt: new Date(),
      mapping: { create: { type: "BASIC" } },
    },
    update: { title: remote.title, handle: remote.handle, status: remote.status, featuredImage: remote.featuredImage, lastSyncedAt: new Date() },
  });
  await syncProductFromShopify(shop, client, shopifyProductId);
  await logActivity(shop.id, { actor, action: "product.linked", entity: "Product", entityId: row.id, message: `"${remote.title}" linked for supplier mapping.` });
  return row;
}

/**
 * Reprice a managed product from its mapped supplier costs. Uses the default
 * mapping row per variant (BASIC / default of ADVANCED).
 */
export async function repriceProduct(shop: ShopWithSettings, client: GraphqlClient, productId: string, pricingRuleId?: string | null, actor?: string) {
  const product = await getProduct(shop.id, productId);
  if (!product) throw new Error("Product not found");
  const rule = await resolvePricingRule(shop.id, pricingRuleId);
  const updates: Array<{ id: string; price: string; compareAtPrice: string | null; cost: string | null }> = [];
  const local: Array<{ id: string; price: string; compareAtPrice: string | null; cost: string | null }> = [];

  for (const variant of product.variants) {
    const row = variant.variantMappings.find((m) => m.isDefault && m.isEnabled) ?? variant.variantMappings.find((m) => m.isEnabled);
    const supplierCost = row?.supplierVariant.price ?? variant.cost;
    if (!supplierCost) continue;
    const priced = computePrice(rule, { cost: supplierCost.toString() });
    updates.push({ id: variant.shopifyVariantId, price: priced.price, compareAtPrice: priced.compareAtPrice, cost: money(supplierCost) });
    local.push({ id: variant.id, price: priced.price, compareAtPrice: priced.compareAtPrice, cost: money(supplierCost) });
  }
  if (updates.length === 0) return 0;
  await updateVariantPrices(client, product.shopifyProductId, updates);
  await prisma.$transaction(local.map((u) => prisma.productVariant.update({ where: { id: u.id }, data: { price: u.price, compareAtPrice: u.compareAtPrice, cost: u.cost } })));
  await logActivity(shop.id, { actor, action: "product.repriced", entity: "Product", entityId: productId, message: `"${product.title}" repriced (${updates.length} variants).` });
  return updates.length;
}

export async function deleteProducts(shop: ShopWithSettings, client: GraphqlClient | null, ids: string[], options: { alsoInShopify: boolean }, actor?: string) {
  const products = await prisma.product.findMany({ where: { shopId: shop.id, id: { in: ids } } });
  let deletedRemote = 0;
  for (const product of products) {
    if (options.alsoInShopify && client) {
      try {
        await deleteShopifyProduct(client, product.shopifyProductId);
        deletedRemote += 1;
      } catch (error) {
        await logActivity(shop.id, { actor, action: "product.delete_failed", entity: "Product", entityId: product.id, level: "warn", message: `Could not delete "${product.title}" in Shopify: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  await prisma.product.deleteMany({ where: { shopId: shop.id, id: { in: ids } } });
  await prisma.importedProduct.updateMany({ where: { shopId: shop.id, pushedProductId: { in: ids } }, data: { pushedProductId: null } });
  await logActivity(shop.id, { actor, action: "product.deleted", message: `${products.length} product(s) removed from the app${options.alsoInShopify ? ` and ${deletedRemote} deleted in Shopify` : ""}.` });
  return { removed: products.length, deletedRemote };
}

export async function setAutoUpdate(shopId: string, ids: string[], enabled: boolean) {
  return prisma.product.updateMany({ where: { shopId, id: { in: ids } }, data: { autoUpdateEnabled: enabled } });
}

export async function countProducts(shopId: string) {
  const [total, mapped, autoUpdate] = await Promise.all([
    prisma.product.count({ where: { shopId } }),
    prisma.product.count({ where: { shopId, mapping: { variants: { some: {} } } } }),
    prisma.product.count({ where: { shopId, autoUpdateEnabled: true } }),
  ]);
  return { total, mapped, unmapped: total - mapped, autoUpdate };
}
