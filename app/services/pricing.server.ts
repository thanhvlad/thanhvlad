import type { PricingRule, PricingRuleTier, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { DEFAULT_PRICING_RULE, computePrice } from "~/domain/pricing/engine";
import type { PriceOp, PricingRuleInput } from "~/domain/pricing/types";
import { logActivity } from "./activity.server";

export type PricingRuleWithTiers = PricingRule & { tiers: PricingRuleTier[] };

export function toRuleInput(rule: PricingRuleWithTiers | null): PricingRuleInput {
  if (!rule) return DEFAULT_PRICING_RULE;
  return {
    id: rule.id,
    name: rule.name,
    basePriceOp: rule.basePriceOp as PriceOp,
    basePriceValue: rule.basePriceValue.toString(),
    compareAtOp: rule.compareAtOp as PriceOp,
    compareAtValue: rule.compareAtValue?.toString() ?? null,
    centsEnding: rule.centsEnding,
    roundToMultiple: rule.roundToMultiple?.toString() ?? null,
    includeShipping: rule.includeShipping,
    minPrice: rule.minPrice?.toString() ?? null,
    maxPrice: rule.maxPrice?.toString() ?? null,
    tiers: rule.tiers
      .slice()
      .sort((a, b) => a.minCost.comparedTo(b.minCost))
      .map((t) => ({
        id: t.id,
        minCost: t.minCost.toString(),
        maxCost: t.maxCost?.toString() ?? null,
        priceOp: t.priceOp as PriceOp,
        priceValue: t.priceValue.toString(),
        compareAtOp: t.compareAtOp as PriceOp,
        compareAtValue: t.compareAtValue?.toString() ?? null,
      })),
  };
}

export async function listPricingRules(shopId: string): Promise<PricingRuleWithTiers[]> {
  return prisma.pricingRule.findMany({
    where: { shopId },
    include: { tiers: { orderBy: { minCost: "asc" } } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export async function getPricingRule(shopId: string, id: string): Promise<PricingRuleWithTiers | null> {
  return prisma.pricingRule.findFirst({ where: { id, shopId }, include: { tiers: { orderBy: { minCost: "asc" } } } });
}

export async function getDefaultPricingRule(shopId: string): Promise<PricingRuleWithTiers | null> {
  return prisma.pricingRule.findFirst({
    where: { shopId, isDefault: true, isEnabled: true },
    include: { tiers: { orderBy: { minCost: "asc" } } },
  });
}

/** Load the rule that applies: explicit id, else the shop default, else built-in. */
export async function resolvePricingRule(shopId: string, ruleId?: string | null): Promise<PricingRuleInput> {
  if (ruleId) {
    const explicit = await getPricingRule(shopId, ruleId);
    if (explicit) return toRuleInput(explicit);
  }
  return toRuleInput(await getDefaultPricingRule(shopId));
}

export interface PricingRuleFormInput {
  name: string;
  description?: string | null;
  isDefault?: boolean;
  isEnabled?: boolean;
  basePriceOp: PriceOp;
  basePriceValue: string | number;
  compareAtOp?: PriceOp;
  compareAtValue?: string | number | null;
  centsEnding?: number | null;
  roundToMultiple?: string | number | null;
  includeShipping?: boolean;
  minPrice?: string | number | null;
  maxPrice?: string | number | null;
  syncCostOfGoods?: boolean;
  tiers?: Array<{
    minCost: string | number;
    maxCost?: string | number | null;
    priceOp: PriceOp;
    priceValue: string | number;
    compareAtOp?: PriceOp;
    compareAtValue?: string | number | null;
  }>;
}

function toData(input: PricingRuleFormInput): Omit<Prisma.PricingRuleUncheckedCreateInput, "shopId" | "tiers"> {
  return {
    name: input.name.trim() || "Untitled rule",
    description: input.description ?? null,
    isDefault: input.isDefault ?? false,
    isEnabled: input.isEnabled ?? true,
    basePriceOp: input.basePriceOp,
    basePriceValue: String(input.basePriceValue ?? 0),
    compareAtOp: input.compareAtOp ?? "NONE",
    compareAtValue: input.compareAtValue === null || input.compareAtValue === undefined || input.compareAtValue === "" ? null : String(input.compareAtValue),
    centsEnding: input.centsEnding ?? null,
    roundToMultiple: input.roundToMultiple === null || input.roundToMultiple === undefined || input.roundToMultiple === "" ? null : String(input.roundToMultiple),
    includeShipping: input.includeShipping ?? false,
    minPrice: input.minPrice === null || input.minPrice === undefined || input.minPrice === "" ? null : String(input.minPrice),
    maxPrice: input.maxPrice === null || input.maxPrice === undefined || input.maxPrice === "" ? null : String(input.maxPrice),
    syncCostOfGoods: input.syncCostOfGoods ?? true,
  };
}

export async function createPricingRule(shopId: string, input: PricingRuleFormInput) {
  const rule = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.pricingRule.updateMany({ where: { shopId, isDefault: true }, data: { isDefault: false } });
    }
    const count = await tx.pricingRule.count({ where: { shopId } });
    return tx.pricingRule.create({
      data: {
        shopId,
        ...toData(input),
        isDefault: input.isDefault ?? count === 0,
        tiers: {
          create: (input.tiers ?? []).map((t) => ({
            minCost: String(t.minCost),
            maxCost: t.maxCost === null || t.maxCost === undefined || t.maxCost === "" ? null : String(t.maxCost),
            priceOp: t.priceOp,
            priceValue: String(t.priceValue),
            compareAtOp: t.compareAtOp ?? "NONE",
            compareAtValue: t.compareAtValue === null || t.compareAtValue === undefined || t.compareAtValue === "" ? null : String(t.compareAtValue),
          })),
        },
      },
      include: { tiers: true },
    });
  });
  await logActivity(shopId, { action: "pricing.rule.created", entity: "PricingRule", entityId: rule.id, message: `Pricing rule "${rule.name}" created.` });
  return rule;
}

export async function updatePricingRule(shopId: string, id: string, input: PricingRuleFormInput) {
  // Scoped: the id arrives from a form field, so without the ownership check a
  // merchant could rewrite another store's pricing rule.
  const owned = await prisma.pricingRule.findFirst({ where: { id, shopId }, select: { id: true } });
  if (!owned) throw new Error("Pricing rule not found");
  const rule = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.pricingRule.updateMany({ where: { shopId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    await tx.pricingRuleTier.deleteMany({ where: { pricingRuleId: id } });
    return tx.pricingRule.update({
      where: { id },
      data: {
        ...toData(input),
        tiers: {
          create: (input.tiers ?? []).map((t) => ({
            minCost: String(t.minCost),
            maxCost: t.maxCost === null || t.maxCost === undefined || t.maxCost === "" ? null : String(t.maxCost),
            priceOp: t.priceOp,
            priceValue: String(t.priceValue),
            compareAtOp: t.compareAtOp ?? "NONE",
            compareAtValue: t.compareAtValue === null || t.compareAtValue === undefined || t.compareAtValue === "" ? null : String(t.compareAtValue),
          })),
        },
      },
      include: { tiers: true },
    });
  });
  await logActivity(shopId, { action: "pricing.rule.updated", entity: "PricingRule", entityId: rule.id, message: `Pricing rule "${rule.name}" updated.` });
  return rule;
}

export async function deletePricingRule(shopId: string, id: string) {
  const rule = await prisma.pricingRule.findFirst({ where: { id, shopId } });
  if (!rule) return;
  await prisma.pricingRule.delete({ where: { id } });
  if (rule.isDefault) {
    const next = await prisma.pricingRule.findFirst({ where: { shopId }, orderBy: { createdAt: "asc" } });
    if (next) await prisma.pricingRule.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  await logActivity(shopId, { action: "pricing.rule.deleted", entity: "PricingRule", entityId: id, message: `Pricing rule "${rule.name}" deleted.` });
}

export async function setDefaultPricingRule(shopId: string, id: string) {
  const [, updated] = await prisma.$transaction([
    prisma.pricingRule.updateMany({ where: { shopId, isDefault: true }, data: { isDefault: false } }),
    // updateMany, not update: scoped to the shop so an id from another store is
    // a no-op rather than a cross-tenant write.
    prisma.pricingRule.updateMany({ where: { id, shopId }, data: { isDefault: true } }),
  ]);
  if (updated.count === 0) throw new Error("Pricing rule not found");
}

/** Preview a rule against sample costs for the pricing page. */
export function previewRule(rule: PricingRuleInput, costs: number[] = [1, 3, 5, 10, 20, 50, 100]) {
  return costs.map((cost) => ({ cost, ...computePrice(rule, { cost }) }));
}

export { computePrice };
