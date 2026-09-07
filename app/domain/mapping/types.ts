export type MappingType = "BASIC" | "ADVANCED" | "BOGO" | "BUNDLE";

export interface SupplierVariantSnapshot {
  id: string;
  supplierProductId: string;
  externalSkuId: string;
  /** Upstream product id, needed to place the order. */
  externalProductId: string;
  platform: string;
  title: string;
  sku?: string | null;
  price: string | number;
  currency: string;
  stock: number;
  isAvailable: boolean;
  shipsFrom?: string[];
}

export interface VariantMappingRow {
  id: string;
  productVariantId: string;
  supplierVariantId: string;
  /** Units of the supplier SKU per unit ordered (BUNDLE/BASIC), or the absolute
   *  quantity to buy for the matched tier (BOGO). */
  quantity: number;
  priority: number;
  /** ISO-3166 alpha-2, or "*" for any destination. */
  shipToCountry: string;
  shipFromCountry?: string | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  bundleGroup?: string | null;
  isDefault: boolean;
  isEnabled: boolean;
}

export interface ResolveContext {
  type: MappingType;
  rows: VariantMappingRow[];
  /** Supplier variants keyed by VariantMappingRow.supplierVariantId. */
  supplierVariants: Record<string, SupplierVariantSnapshot>;
  /** Destination country of the order. */
  shipToCountry: string;
  /** Units of the Shopify variant on the order line. */
  orderedQuantity: number;
  /** Skip the stock check (e.g. the merchant is previewing a mapping). */
  ignoreStock?: boolean;
}

export interface ResolvedSupplierLine {
  mappingRowId: string;
  supplierVariantId: string;
  externalProductId: string;
  externalSkuId: string;
  platform: string;
  title: string;
  /** Units to buy from the supplier. */
  quantity: number;
  unitCost: string;
  currency: string;
}

export type ResolutionFailure =
  | "NO_MAPPING"
  | "MAPPING_DISABLED"
  | "NO_COUNTRY_MATCH"
  | "NO_QUANTITY_TIER"
  | "OUT_OF_STOCK"
  | "SUPPLIER_UNAVAILABLE"
  | "INCOMPLETE_BUNDLE";

export interface ResolveResult {
  ok: boolean;
  lines: ResolvedSupplierLine[];
  totalCost: string;
  failure?: ResolutionFailure;
  /** Human-readable trace, stored on the order line for support. */
  reason?: string;
  /** Candidates that were considered and why they lost. */
  skipped: Array<{ mappingRowId: string; reason: string }>;
}
