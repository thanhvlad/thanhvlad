/**
 * Supplier adapter contract.
 *
 * Every upstream marketplace (AliExpress, CJ, ...) is wrapped in an adapter
 * implementing this interface, so the import list, mapping, order placement
 * and tracking jobs are written once. A mock adapter with realistic fixtures
 * lets the whole flow run with no upstream credentials.
 */

export type SupplierPlatform = "ALIEXPRESS" | "CJ_DROPSHIPPING" | "TEMU" | "MANUAL" | "MOCK";

export interface SupplierTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  externalUserId?: string | null;
  meta?: Record<string, unknown>;
}

export interface SupplierCredentials {
  accessToken?: string | null;
  refreshToken?: string | null;
  meta?: Record<string, unknown>;
}

// ---- Catalog ----------------------------------------------------------------

export interface SupplierSearchParams {
  query: string;
  page?: number;
  pageSize?: number;
  shipToCountry?: string;
  shipFromCountry?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: "default" | "orders" | "price_asc" | "price_desc" | "newest" | "rating";
  categoryId?: string;
  /** Search by image URL, where the platform supports it. */
  imageUrl?: string;
}

export interface SupplierSearchItem {
  externalId: string;
  title: string;
  url: string;
  image: string | null;
  price: string;
  originalPrice?: string | null;
  currency: string;
  orderCount?: number | null;
  rating?: number | null;
  storeName?: string | null;
  storeId?: string | null;
  shipsFrom?: string[];
  /** Cheapest shipping seen in search, when the platform returns it. */
  shippingFrom?: string | null;
  /** Delivery estimate the search surface returned, e.g. "10". */
  shipToDays?: string | null;
  /** Affiliate/promotion link, when the platform returns one. */
  promotionLink?: string | null;
}

export interface SupplierSearchResult {
  items: SupplierSearchItem[];
  page: number;
  pageSize: number;
  total: number | null;
  hasMore: boolean;
  /** Surfaced to the merchant when the result set is degraded or filtered locally. */
  notice?: string;
}

export interface SupplierAttribute {
  name: string;
  value: string;
  image?: string | null;
}

export interface SupplierVariantDetail {
  externalSkuId: string;
  skuAttr?: string | null;
  sku?: string | null;
  attributes: SupplierAttribute[];
  image: string | null;
  price: string;
  originalPrice?: string | null;
  currency: string;
  stock: number;
  isAvailable: boolean;
  weightGrams?: number | null;
}

export interface SupplierProductDetail {
  externalId: string;
  platform: SupplierPlatform;
  title: string;
  descriptionHtml: string;
  url: string;
  images: string[];
  currency: string;
  /** Option names in display order, e.g. ["Color", "Size"]. */
  optionNames: string[];
  variants: SupplierVariantDetail[];
  storeName?: string | null;
  storeUrl?: string | null;
  storeId?: string | null;
  rating?: number | null;
  orderCount?: number | null;
  categoryId?: string | null;
  shipsFrom: string[];
  isAvailable: boolean;
  raw?: unknown;
}

export interface SupplierShippingQuote {
  carrierCode: string;
  carrierName: string;
  cost: string;
  currency: string;
  shipFromCountry: string;
  shipToCountry: string;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  hasTracking: boolean;
  isFreeShipping: boolean;
}

export interface ShippingQuoteParams {
  externalId: string;
  externalSkuId?: string | null;
  quantity: number;
  shipToCountry: string;
  shipFromCountry?: string | null;
  /** Postal code / province improve accuracy on some platforms. */
  zip?: string | null;
  province?: string | null;
}

// ---- Orders -----------------------------------------------------------------

export interface SupplierOrderAddress {
  name: string;
  phone: string;
  phoneCountryCode?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  province?: string | null;
  zip?: string | null;
  countryCode: string;
  /** CPF / RUT / PCCC etc. */
  taxNumber?: string | null;
  email?: string | null;
}

export interface PlaceOrderItem {
  externalProductId: string;
  externalSkuId: string;
  /**
   * Attribute-encoded SKU ("14:350853#Black;5:361386"). AliExpress order
   * creation takes `sku_attr`, not the numeric sku id; freight quotes take the
   * numeric id. Adapters that only need one of the two ignore the other.
   */
  externalSkuAttr?: string | null;
  quantity: number;
  /** Carrier chosen by the shipping selector. */
  carrierCode?: string | null;
  shipFromCountry?: string | null;
}

export interface PlaceOrderInput {
  /** Our internal purchase order id; sent as the client reference for idempotency. */
  reference: string;
  items: PlaceOrderItem[];
  address: SupplierOrderAddress;
  note?: string | null;
  currency?: string;
}

export interface PlaceOrderResult {
  externalOrderId: string;
  /** Some platforms split into several upstream orders. */
  externalOrderIds?: string[];
  status: SupplierOrderState;
  itemsCost: string;
  shippingCost: string;
  totalCost: string;
  currency: string;
  /** URL where the merchant pays, when payment is manual. */
  paymentUrl?: string | null;
  /** When the supplier will auto-cancel the order if it stays unpaid. */
  paymentDueAt?: Date | null;
  raw?: unknown;
}

export type SupplierOrderState =
  | "PLACED"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELED"
  | "FAILED";

export interface SupplierOrderStatus {
  externalOrderId: string;
  status: SupplierOrderState;
  itemsCost?: string | null;
  shippingCost?: string | null;
  totalCost?: string | null;
  currency?: string | null;
  paidAt?: Date | null;
  shippedAt?: Date | null;
  /** Refreshed deep link to pay this order on the supplier's site. */
  paymentUrl?: string | null;
  raw?: unknown;
}

export interface SupplierTracking {
  number: string;
  carrierCode?: string | null;
  carrierName?: string | null;
  url?: string | null;
  status?: string | null;
  lastEvent?: string | null;
  lastEventAt?: Date | null;
}

// ---- Adapter ----------------------------------------------------------------

export interface SupplierCapabilities {
  search: boolean;
  imageSearch: boolean;
  oauth: boolean;
  placeOrder: boolean;
  cancelOrder: boolean;
  tracking: boolean;
  shippingQuotes: boolean;
}

export interface SupplierAdapter {
  readonly platform: SupplierPlatform;
  readonly displayName: string;
  readonly capabilities: SupplierCapabilities;

  /** True when the adapter has what it needs (app keys, tokens) to make calls. */
  isConfigured(): boolean;
  /** True when a merchant account is connected (as opposed to only server keys). */
  hasSession?(): boolean;

  // Auth
  getAuthorizationUrl?(state: string): string;
  exchangeCode?(code: string): Promise<SupplierTokens>;
  refreshTokens?(refreshToken: string): Promise<SupplierTokens>;
  /** Register the merchant's store with the platform's dropshipping programme. */
  registerStore?(storeUrl: string): Promise<boolean>;

  // Catalog
  /** Extract the upstream product id from a URL or raw id; null when not recognised. */
  parseProductReference(input: string): string | null;
  searchProducts(params: SupplierSearchParams): Promise<SupplierSearchResult>;
  getProduct(externalId: string, options?: { shipToCountry?: string; locale?: string }): Promise<SupplierProductDetail | null>;
  getShippingQuotes(params: ShippingQuoteParams): Promise<SupplierShippingQuote[]>;

  // Orders
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  getOrder(externalOrderId: string): Promise<SupplierOrderStatus | null>;
  cancelOrder?(externalOrderId: string, reason?: string): Promise<boolean>;
  getTracking(externalOrderId: string): Promise<SupplierTracking[]>;
}

export type SupplierAdapterFactory = (credentials: SupplierCredentials) => SupplierAdapter;
