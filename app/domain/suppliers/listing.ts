/**
 * What an imported product is called in the merchant's own store.
 *
 * Both rules here exist because the first real product pushed to production
 * came out wrong in ways a customer would see. Read it back from Shopify and it
 * had the AliExpress seller's store name as its vendor, and no SKU on any of its
 * 41 variants.
 */

const SKU_PREFIX: Record<string, string> = {
  ALIEXPRESS: "AE",
  CJ_DROPSHIPPING: "CJ",
  TEMU: "TM",
  MOCK: "DEMO",
  MANUAL: "MAN",
};

/**
 * A SKU for a variant whose supplier gave none.
 *
 * Built from the supplier's own SKU id, which is unique across the supplier's
 * catalogue, so two products can never collide and re-importing the same
 * product gives the same SKU back. Readability is secondary: this is the value
 * a merchant searches their admin for and a supplier support agent can look up.
 */
export function fallbackSku(platform: string, externalSkuId: string | null | undefined): string | null {
  const id = String(externalSkuId ?? "").trim();
  if (!id) return null;
  const prefix = SKU_PREFIX[platform] ?? "SUP";
  // Shopify allows 255; keep well inside it and strip anything a spreadsheet or
  // a barcode printer would choke on.
  return `${prefix}-${id.replace(/[^A-Za-z0-9._-]/g, "")}`.slice(0, 64);
}

/**
 * The vendor shown on the storefront.
 *
 * Never the supplier's store name. Most themes print the vendor on the product
 * page, so "Stone's Store" there tells every customer exactly where to buy the
 * same item for a third of the price. The merchant's chosen default wins, then
 * their own store's name; with neither, the field is left empty rather than
 * leaking the source.
 */
export function storefrontVendor(defaultVendor: string | null | undefined, shopName: string | null | undefined): string | null {
  const chosen = String(defaultVendor ?? "").trim();
  if (chosen) return chosen;
  const own = String(shopName ?? "").trim();
  return own || null;
}
