import prisma from "~/db.server";
import { checkRewrite } from "~/domain/copy/check-rewrite";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { aiLandingAvailable, rewriteLandingPage, type RewriteInput } from "./ai-landing.server";
import { getImportedProduct } from "./import.server";
import type { ShopWithSettings } from "./shop.server";

/**
 * Run the landing-page rewrite over one import-list row and save the result.
 *
 * The page goes to a live storefront unreviewed, so nothing is written until
 * checkRewrite passes. A failure is recorded on the row as pushError - the
 * merchant sees exactly which rule was broken instead of a page that quietly
 * reads like the supplier wrote it.
 */

export interface RewriteOutcome {
  importedProductId: string;
  ok: boolean;
  title?: string;
  error?: string;
  warnings?: string[];
  /** Images the model judged unusable, so the merchant can act on them. */
  rejectedImages?: Array<{ index: number; reason: string }>;
}

/**
 * The shop's own finished pages, used as worked examples.
 *
 * These are what make the rewrite adapt per shop without anyone describing the
 * shop: their markup already renders correctly in that shop's theme, so it is
 * copied rather than guessed at. Longest first, because length is the cheapest
 * available proxy for "this one was actually written".
 */
export async function landingExamples(shopId: string, excludeId?: string, limit = 2) {
  const rows = await prisma.importedProduct.findMany({
    where: {
      shopId,
      status: "PUSHED",
      ...(excludeId ? { id: { not: excludeId } } : {}),
      // A supplier body is usually long too; the marker of a rewritten page is
      // the wrapper this store's finished pages all open with.
      description: { contains: "max-width:1080px" },
    },
    select: { title: true, description: true },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({ title: r.title, descriptionHtml: r.description }));
}

export async function rewriteImportedProduct(
  shop: ShopWithSettings,
  importedProductId: string,
  options: { actor?: string; examples?: Array<{ title: string; descriptionHtml: string }> } = {},
): Promise<RewriteOutcome> {
  if (!aiLandingAvailable()) {
    return { importedProductId, ok: false, error: "ANTHROPIC_API_KEY is not configured." };
  }

  const product = await getImportedProduct(shop.id, importedProductId);
  if (!product) return { importedProductId, ok: false, error: "Imported product not found" };

  const supplier = product.supplierProduct;
  const supplierVariants = supplier?.variants ?? [];

  const input: RewriteInput = {
    supplierTitle: supplier?.title ?? product.title,
    supplierDescriptionHtml: product.description || "",
    images: product.images.length ? product.images : (supplier?.images ?? []),
    optionNames: Array.isArray(product.options) ? (product.options as string[]) : [],
    variants: supplierVariants.slice(0, 40).map((v) => ({
      attributes: Array.isArray(v.attributes) ? (v.attributes as Array<{ name: string; value: string }>) : [],
      price: String(v.price),
      stock: v.stock,
    })),
    currency: supplier?.currency ?? shop.currency,
    storeName: supplier?.storeName ?? null,
    examples: options.examples ?? (await landingExamples(shop.id, importedProductId)),
  };

  if (input.variants.length === 0) {
    return { importedProductId, ok: false, error: "No supplier variants to write from." };
  }

  let result;
  try {
    result = await rewriteLandingPage(input);
  } catch (error) {
    const message = errorMessage(error);
    logger.warn("Landing rewrite failed", { importedProductId, error });
    await prisma.importedProduct.update({ where: { id: product.id }, data: { pushError: `AI rewrite failed: ${message}` } });
    return { importedProductId, ok: false, error: message };
  }

  const check = checkRewrite({
    title: result.title,
    descriptionHtml: result.descriptionHtml,
    tags: result.tags,
    heroImageIndex: result.heroImageIndex,
    imageCount: input.images.length,
  });

  if (!check.ok) {
    const message = `Rewrite rejected: ${check.failures.join(" ")}`;
    await prisma.importedProduct.update({ where: { id: product.id }, data: { pushError: message.slice(0, 900) } });
    await logActivity(shop.id, {
      actor: options.actor,
      action: "landing.rewrite_rejected",
      entity: "ImportedProduct",
      entityId: product.id,
      level: "warn",
      message: `${product.title}: ${check.failures.length} contract violation(s); nothing was changed.`,
    });
    return { importedProductId, ok: false, error: message, warnings: check.warnings };
  }

  // Lead with the image the model picked, keeping the rest in supplier order.
  const hero = input.images[result.heroImageIndex];
  const images = hero ? [hero, ...input.images.filter((u) => u !== hero)] : input.images;

  await prisma.importedProduct.update({
    where: { id: product.id },
    data: {
      title: result.title.slice(0, 255),
      description: result.descriptionHtml,
      tags: result.tags,
      images,
      pushError: null,
    },
  });

  const rejected = result.imageVerdicts.filter((v) => !v.usable).map((v) => ({ index: v.index, reason: v.reason }));

  // The merchant asked for the images to be judged. If the endpoint would not
  // carry them the page still ships, but they are told the verdicts are guesses
  // from the filenames rather than quietly given a weaker result.
  const warnings = [...check.warnings];
  if (!result.imagesAssessed && input.images.length > 0) {
    warnings.push("The AI endpoint would not accept the images, so they were not looked at. Check them yourself before this goes live.");
  }

  await logActivity(shop.id, {
    actor: options.actor,
    action: "landing.rewritten",
    entity: "ImportedProduct",
    entityId: product.id,
    level: result.imagesAssessed ? "info" : "warn",
    message:
      `${result.title} — rewritten to contract ${result.contractVersion}, ${check.wordCount} words` +
      `${rejected.length ? `, ${rejected.length} image(s) flagged` : ""}` +
      `${result.imagesAssessed ? "" : "; images not assessed"}.`,
  });

  return {
    importedProductId,
    ok: true,
    title: result.title,
    warnings,
    rejectedImages: rejected.length ? rejected : undefined,
  };
}
