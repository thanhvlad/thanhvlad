import { z } from "zod";
import type { SupplierPlatform, SupplierProductDetail } from "./types";

/**
 * A product the browser extension read off the supplier's own page.
 *
 * The merchant's browser has already loaded and rendered the product, so the
 * page carries everything the import list needs. Sending it straight here means
 * a real product can be imported with no supplier API account at all — which is
 * the whole point: connecting an AliExpress developer account is a later, and
 * separate, decision.
 *
 * Everything below crosses a trust boundary. The payload is shaped by a script
 * running on aliexpress.com, so it is validated as hostile input: bounded
 * lengths, bounded counts, and image sources restricted to http(s). The
 * platform is NEVER taken from the payload — the server derives it from the url
 * it recognised, so a caller cannot file a product under a platform of their
 * choosing.
 */

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), "must be an http(s) url");

const money = z
  .string()
  .trim()
  .max(32)
  .refine((v) => /^\d+(\.\d+)?$/.test(v), "must be a plain decimal amount");

export const CapturedAttribute = z.object({
  name: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(200),
});

export const CapturedVariant = z.object({
  externalSkuId: z.string().trim().min(1).max(80),
  skuAttr: z.string().trim().max(200).nullish(),
  sku: z.string().trim().max(120).nullish(),
  attributes: z.array(CapturedAttribute).max(8).default([]),
  image: httpUrl.nullish(),
  price: money,
  originalPrice: money.nullish(),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  isAvailable: z.boolean().default(true),
});

export const CapturedProduct = z.object({
  externalId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "unexpected characters"),
  title: z.string().trim().min(1).max(500),
  descriptionHtml: z.string().max(200_000).default(""),
  url: httpUrl,
  images: z.array(httpUrl).max(30).default([]),
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/),
  optionNames: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  variants: z.array(CapturedVariant).min(1).max(300),
  storeName: z.string().trim().max(200).nullish(),
  storeUrl: httpUrl.nullish(),
  storeId: z.string().trim().max(64).nullish(),
  rating: z.number().min(0).max(5).nullish(),
  orderCount: z.number().int().min(0).nullish(),
  categoryId: z.string().trim().max(64).nullish(),
  shipsFrom: z.array(z.string().trim().max(8)).max(10).default([]),
});

export type CapturedProductInput = z.infer<typeof CapturedProduct>;

/**
 * Turn a validated capture into the shape the catalogue already stores.
 * `platform` and `externalId` come from the server's own reading of the url so
 * the record cannot disagree with the link it was captured from.
 */
export function capturedToDetail(
  input: CapturedProductInput,
  platform: SupplierPlatform,
  externalId: string,
): SupplierProductDetail {
  const currency = input.currency.toUpperCase();
  return {
    externalId,
    platform,
    title: input.title,
    descriptionHtml: input.descriptionHtml,
    url: input.url,
    images: dedupe(input.images),
    currency,
    optionNames: input.optionNames,
    variants: input.variants.map((v) => ({
      externalSkuId: v.externalSkuId,
      skuAttr: v.skuAttr ?? null,
      sku: v.sku ?? null,
      attributes: v.attributes,
      image: v.image ?? null,
      price: v.price,
      originalPrice: v.originalPrice ?? null,
      currency,
      stock: v.stock,
      isAvailable: v.isAvailable && v.stock > 0,
    })),
    storeName: input.storeName ?? null,
    storeUrl: input.storeUrl ?? null,
    storeId: input.storeId ?? null,
    rating: input.rating ?? null,
    orderCount: input.orderCount ?? null,
    categoryId: input.categoryId ?? null,
    shipsFrom: input.shipsFrom,
    isAvailable: input.variants.some((v) => v.isAvailable && v.stock > 0),
    raw: { capturedByExtension: true },
  };
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
