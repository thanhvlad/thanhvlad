import { randomUUID } from "node:crypto";
import prisma from "~/db.server";
import { aiRewriteAllowance, aiUsagePeriod, type AiRewriteAllowance } from "~/domain/billing/plans";
import { checkRewrite } from "~/domain/copy/check-rewrite";
import { exampleFitsBrand, resolveStoreBrand, type StoreBrand } from "~/domain/copy/lumora-contract";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { logActivity } from "./activity.server";
import { aiLandingAvailable, rewriteLandingPage, rewriteWasNotBilled, type RewriteInput } from "./ai-landing.server";
import { currentPlan } from "./billing.server";
import { cleanDescription, getImportedProduct } from "./import.server";
import type { ShopWithSettings } from "./shop.server";
import { gql, offlineClient } from "./shopify/graphql.server";

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

type ShopRef = Pick<ShopWithSettings, "id" | "accountId">;

/**
 * Whose allowance a rewrite comes out of. The plan belongs to the account, so
 * every store on it shares one allowance; a store not yet on an account is
 * counted on its own rather than for free.
 */
function usageOwnerKey(shop: ShopRef): string {
  return shop.accountId ?? `shop:${shop.id}`;
}

/** This month's rewrite allowance for the shop's account, as it stands now. */
export async function getAiRewriteAllowance(shop: ShopRef): Promise<AiRewriteAllowance> {
  const [plan, row] = await Promise.all([
    currentPlan(shop),
    prisma.aiRewriteUsage.findUnique({
      where: { ownerKey_period: { ownerKey: usageOwnerKey(shop), period: aiUsagePeriod() } },
      select: { used: true },
    }),
  ]);
  return aiRewriteAllowance(plan, row?.used ?? 0);
}

/**
 * Take one rewrite out of this month's allowance, or refuse.
 *
 * A single conditional upsert, so two batches running at once cannot both take
 * the last rewrite: the row only moves while it is under the limit, and the
 * affected-row count says whether it did. Returns the period it was charged to
 * so a refund lands in the same month even if the call straddles midnight.
 */
async function reserveAiRewrite(shop: ShopRef): Promise<{ period: string } | null> {
  const plan = await currentPlan(shop);
  const limit = aiRewriteAllowance(plan, 0).limit;
  if (limit <= 0) return null;
  const period = aiUsagePeriod();
  const key = usageOwnerKey(shop);
  const applied = await prisma.$executeRaw`
    INSERT INTO "AiRewriteUsage" ("id", "ownerKey", "period", "used", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${key}, ${period}, 1, NOW(), NOW())
    ON CONFLICT ("ownerKey", "period") DO UPDATE
      SET "used" = "AiRewriteUsage"."used" + 1, "updatedAt" = NOW()
      WHERE "AiRewriteUsage"."used" < ${limit}`;
  return applied > 0 ? { period } : null;
}

/** Give back a rewrite whose call never produced a billable answer. */
async function releaseAiRewrite(shop: ShopRef, period: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "AiRewriteUsage" SET "used" = GREATEST("used" - 1, 0), "updatedAt" = NOW()
    WHERE "ownerKey" = ${usageOwnerKey(shop)} AND "period" = ${period}`;
}

const BRAND_QUERY = `#graphql
  query DropshipStoreBrand {
    shop {
      name
      contactEmail
    }
  }
`;

/** A batch rewrites one product at a time and would otherwise ask per product. */
const brandCache = new Map<string, { at: number; name: string | null; contactEmail: string | null }>();
const BRAND_TTL_MS = 5 * 60_000;

/**
 * The store's public name and contact address, straight from Shopify.
 *
 * Asked at rewrite time rather than read from the Shop row because the row
 * holds `shop.email` - the address Shopify uses to reach the merchant, which
 * must never be printed on a storefront. When Shopify cannot be asked the
 * email stays `undefined`, and resolveStoreBrand falls back to the store's own
 * finished pages instead of dropping the address.
 */
async function storeBrand(shop: ShopWithSettings, examples: Array<{ descriptionHtml: string }>): Promise<StoreBrand> {
  let name: string | null = shop.name;
  let contactEmail: string | null | undefined;
  const cached = brandCache.get(shop.id);
  if (cached && Date.now() - cached.at < BRAND_TTL_MS) {
    name = cached.name ?? name;
    contactEmail = cached.contactEmail;
  } else {
    try {
      const client = await offlineClient(shop.domain);
      const data = await gql<{ shop: { name: string; contactEmail: string } }>(client, BRAND_QUERY);
      name = data.shop.name || name;
      contactEmail = data.shop.contactEmail || null;
      brandCache.set(shop.id, { at: Date.now(), name: data.shop.name || null, contactEmail });
    } catch (error) {
      logger.warn("Could not read the store's contact email for the rewrite", { shopId: shop.id, error: errorMessage(error) });
    }
  }
  return resolveStoreBrand({ shopName: name, domain: shop.domain, contactEmail, examples });
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
    examples: [],
    brand: { name: shop.name ?? shop.domain, supportEmail: null, signOffTagline: null },
  };

  if (input.variants.length === 0) {
    return { importedProductId, ok: false, error: "No supplier variants to write from." };
  }

  const examples = options.examples ?? (await landingExamples(shop.id, importedProductId));
  input.brand = await storeBrand(shop, examples);
  input.examples = examples.filter((e) => exampleFitsBrand(e.descriptionHtml, input.brand.name));

  // The allowance is taken here, per product and at the moment of spending,
  // not when the batch was queued: a batch queued with rewrites to spare can
  // meet another batch that used them first.
  const reservation = await reserveAiRewrite(shop);
  if (!reservation) {
    const message = "This month's AI rewrite allowance is used up, so this product was not rewritten. Upgrade under Settings → Plan or wait for next month.";
    await prisma.importedProduct.update({ where: { id: product.id }, data: { pushError: message } });
    return { importedProductId, ok: false, error: message };
  }

  let result;
  try {
    result = await rewriteLandingPage(input);
  } catch (error) {
    const message = errorMessage(error);
    if (rewriteWasNotBilled(error)) await releaseAiRewrite(shop, reservation.period);
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
    supportEmail: input.brand.supportEmail,
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
      description: cleanDescription(result.descriptionHtml, false),
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
