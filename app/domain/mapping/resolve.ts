import { d, money, sum } from "~/lib/money";
import type {
  ResolveContext,
  ResolveResult,
  ResolvedSupplierLine,
  SupplierVariantSnapshot,
  VariantMappingRow,
} from "./types";

function fail(
  failure: ResolveResult["failure"],
  reason: string,
  skipped: ResolveResult["skipped"] = [],
): ResolveResult {
  return { ok: false, lines: [], totalCost: "0.00", failure, reason, skipped };
}

function toLine(
  row: VariantMappingRow,
  variant: SupplierVariantSnapshot,
  quantity: number,
): ResolvedSupplierLine {
  return {
    mappingRowId: row.id,
    supplierVariantId: variant.id,
    externalProductId: variant.externalProductId,
    externalSkuId: variant.externalSkuId,
    platform: variant.platform,
    title: variant.title,
    quantity,
    unitCost: money(variant.price),
    currency: variant.currency,
  };
}

function hasStock(
  variant: SupplierVariantSnapshot | undefined,
  needed: number,
  ignoreStock: boolean,
): boolean {
  if (!variant) return false;
  if (!variant.isAvailable) return false;
  if (ignoreStock) return true;
  return variant.stock >= needed;
}

/**
 * Rank ADVANCED candidates: an exact destination match always beats the "*"
 * wildcard, then explicit priority, then the row flagged as default.
 */
function rankAdvanced(rows: VariantMappingRow[], shipToCountry: string): VariantMappingRow[] {
  const country = shipToCountry.toUpperCase();
  return rows
    .filter((r) => r.shipToCountry === "*" || r.shipToCountry.toUpperCase() === country)
    .sort((a, b) => {
      const aExact = a.shipToCountry !== "*" ? 0 : 1;
      const bExact = b.shipToCountry !== "*" ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
}

/**
 * Decide what to buy from the supplier for one Shopify order line.
 *
 * Every mapping type funnels through here so the order pipeline, the mapping
 * preview in the UI and the "why is this order stuck?" panel all agree.
 */
export function resolveMapping(ctx: ResolveContext): ResolveResult {
  const enabled = ctx.rows.filter((r) => r.isEnabled);
  const skipped: ResolveResult["skipped"] = ctx.rows
    .filter((r) => !r.isEnabled)
    .map((r) => ({ mappingRowId: r.id, reason: "disabled" }));

  if (ctx.rows.length === 0) {
    return fail("NO_MAPPING", "This variant has no supplier mapped yet.");
  }
  if (enabled.length === 0) {
    return fail("MAPPING_DISABLED", "Every supplier option for this variant is disabled.", skipped);
  }

  const qty = Math.max(1, Math.trunc(ctx.orderedQuantity));
  const ignoreStock = ctx.ignoreStock ?? false;

  switch (ctx.type) {
    case "BASIC": {
      const row =
        enabled.find((r) => r.isDefault) ??
        [...enabled].sort((a, b) => a.priority - b.priority)[0];
      const variant = ctx.supplierVariants[row.supplierVariantId];
      const needed = qty * Math.max(1, row.quantity);
      if (!variant) {
        return fail("SUPPLIER_UNAVAILABLE", "The mapped supplier SKU is no longer available.", [
          ...skipped,
          { mappingRowId: row.id, reason: "supplier variant missing" },
        ]);
      }
      if (!hasStock(variant, needed, ignoreStock)) {
        return fail(
          "OUT_OF_STOCK",
          `Supplier has ${variant.stock} in stock but ${needed} are needed.`,
          [...skipped, { mappingRowId: row.id, reason: "out of stock" }],
        );
      }
      const line = toLine(row, variant, needed);
      return {
        ok: true,
        lines: [line],
        totalCost: money(d(line.unitCost).times(line.quantity)),
        skipped,
      };
    }

    case "ADVANCED": {
      const candidates = rankAdvanced(enabled, ctx.shipToCountry);
      if (candidates.length === 0) {
        return fail(
          "NO_COUNTRY_MATCH",
          `No supplier option covers shipping to ${ctx.shipToCountry}.`,
          skipped,
        );
      }
      for (const row of candidates) {
        const variant = ctx.supplierVariants[row.supplierVariantId];
        const needed = qty * Math.max(1, row.quantity);
        if (!variant) {
          skipped.push({ mappingRowId: row.id, reason: "supplier variant missing" });
          continue;
        }
        if (!hasStock(variant, needed, ignoreStock)) {
          skipped.push({
            mappingRowId: row.id,
            reason: `out of stock (${variant.stock} < ${needed})`,
          });
          continue;
        }
        const line = toLine(row, variant, needed);
        return {
          ok: true,
          lines: [line],
          totalCost: money(d(line.unitCost).times(line.quantity)),
          reason: `Selected supplier option ${row.id} for ${row.shipToCountry}.`,
          skipped,
        };
      }
      return fail(
        "OUT_OF_STOCK",
        "Every ranked supplier option is out of stock or unavailable.",
        skipped,
      );
    }

    case "BOGO": {
      // Tiers are keyed on the *ordered* quantity; `quantity` is the absolute
      // number of supplier units to buy when the tier matches.
      const tiers = [...enabled].sort(
        (a, b) => (b.minQuantity ?? 0) - (a.minQuantity ?? 0),
      );
      const match = tiers.find((r) => {
        const min = r.minQuantity ?? 1;
        const max = r.maxQuantity ?? Number.MAX_SAFE_INTEGER;
        return qty >= min && qty <= max;
      });
      if (!match) {
        return fail(
          "NO_QUANTITY_TIER",
          `No BOGO tier covers an ordered quantity of ${qty}.`,
          skipped,
        );
      }
      const variant = ctx.supplierVariants[match.supplierVariantId];
      const needed = Math.max(1, match.quantity);
      if (!variant) {
        return fail("SUPPLIER_UNAVAILABLE", "The mapped supplier SKU is no longer available.", [
          ...skipped,
          { mappingRowId: match.id, reason: "supplier variant missing" },
        ]);
      }
      if (!hasStock(variant, needed, ignoreStock)) {
        return fail(
          "OUT_OF_STOCK",
          `Supplier has ${variant.stock} in stock but ${needed} are needed.`,
          [...skipped, { mappingRowId: match.id, reason: "out of stock" }],
        );
      }
      const line = toLine(match, variant, needed);
      return {
        ok: true,
        lines: [line],
        totalCost: money(d(line.unitCost).times(line.quantity)),
        reason: `Matched BOGO tier ${match.minQuantity ?? 1}–${match.maxQuantity ?? "∞"}.`,
        skipped,
      };
    }

    case "BUNDLE": {
      // All rows in the winning group must be buyable; a partial bundle would
      // ship the customer an incomplete product.
      const groups = new Map<string, VariantMappingRow[]>();
      for (const row of enabled) {
        const key = row.bundleGroup ?? "default";
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const ordered = [...groups.entries()].sort((a, b) => {
        const aPriority = Math.min(...a[1].map((r) => r.priority));
        const bPriority = Math.min(...b[1].map((r) => r.priority));
        return aPriority - bPriority;
      });

      for (const [groupKey, rows] of ordered) {
        const lines: ResolvedSupplierLine[] = [];
        let complete = true;
        for (const row of rows) {
          const variant = ctx.supplierVariants[row.supplierVariantId];
          const needed = qty * Math.max(1, row.quantity);
          if (!variant || !hasStock(variant, needed, ignoreStock)) {
            skipped.push({
              mappingRowId: row.id,
              reason: variant ? "out of stock" : "supplier variant missing",
            });
            complete = false;
            break;
          }
          lines.push(toLine(row, variant, needed));
        }
        if (complete && lines.length > 0) {
          return {
            ok: true,
            lines,
            totalCost: money(sum(lines.map((l) => d(l.unitCost).times(l.quantity)))),
            reason: `Bundle group "${groupKey}" fulfilled with ${lines.length} SKUs.`,
            skipped,
          };
        }
      }
      return fail(
        "INCOMPLETE_BUNDLE",
        "No bundle group has every component in stock.",
        skipped,
      );
    }

    default:
      return fail("NO_MAPPING", `Unknown mapping type: ${String(ctx.type)}`);
  }
}

/** Human-readable label for a failure code, used by the orders table. */
export const FAILURE_LABELS: Record<NonNullable<ResolveResult["failure"]>, string> = {
  NO_MAPPING: "Not mapped",
  MAPPING_DISABLED: "Mapping disabled",
  NO_COUNTRY_MATCH: "No supplier ships here",
  NO_QUANTITY_TIER: "No quantity tier",
  OUT_OF_STOCK: "Supplier out of stock",
  SUPPLIER_UNAVAILABLE: "Supplier unavailable",
  INCOMPLETE_BUNDLE: "Incomplete bundle",
};
