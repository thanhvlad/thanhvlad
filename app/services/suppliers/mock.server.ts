import crypto from "node:crypto";
import type {
  PlaceOrderInput,
  PlaceOrderResult,
  ShippingQuoteParams,
  SupplierAdapter,
  SupplierOrderStatus,
  SupplierProductDetail,
  SupplierSearchParams,
  SupplierSearchResult,
  SupplierShippingQuote,
  SupplierTracking,
  SupplierVariantDetail,
} from "./types";
import { d, money } from "~/lib/money";

/**
 * Deterministic in-memory supplier used for development, demos and tests.
 *
 * - Product ids are stable, so mappings survive restarts.
 * - Orders move PLACED -> PAID -> SHIPPED -> DELIVERED as wall-clock time passes,
 *   so the tracking sync job has something to do.
 * - Stock and price wobble slightly per hour to exercise the auto-update rules.
 */

interface MockProductSeed {
  id: string;
  title: string;
  category: string;
  basePrice: number;
  options: Array<{ name: string; values: string[] }>;
  images: number;
  store: string;
  rating: number;
  orders: number;
}

const CATALOG: MockProductSeed[] = [
  { id: "1005006001", title: "Wireless Bluetooth Earbuds Pro, Noise Cancelling, 48H Battery", category: "Electronics", basePrice: 9.8, options: [{ name: "Color", values: ["Black", "White", "Navy"] }], images: 6, store: "TechNova Official Store", rating: 4.8, orders: 21430 },
  { id: "1005006002", title: "Minimalist Stainless Steel Watch for Men, Waterproof Quartz", category: "Watches", basePrice: 6.4, options: [{ name: "Color", values: ["Silver", "Gold", "Black"] }, { name: "Band", values: ["Mesh", "Leather"] }], images: 8, store: "ChronoCraft", rating: 4.7, orders: 8320 },
  { id: "1005006003", title: "Portable Blender USB Rechargeable 380ml Fresh Juice Cup", category: "Home & Kitchen", basePrice: 7.2, options: [{ name: "Color", values: ["Pink", "Green", "Blue"] }], images: 7, store: "HomeBright", rating: 4.6, orders: 15600 },
  { id: "1005006004", title: "Posture Corrector Back Brace, Adjustable, Breathable", category: "Health", basePrice: 3.9, options: [{ name: "Size", values: ["S", "M", "L", "XL"] }], images: 5, store: "WellnessLab", rating: 4.5, orders: 30210 },
  { id: "1005006005", title: "LED Strip Lights 5M RGB with Remote & App Control", category: "Lighting", basePrice: 4.6, options: [{ name: "Length", values: ["5M", "10M", "20M"] }, { name: "Plug", values: ["US", "EU", "UK"] }], images: 6, store: "LumiHome", rating: 4.7, orders: 45120 },
  { id: "1005006006", title: "Pet Grooming Glove, Gentle Deshedding Brush", category: "Pets", basePrice: 1.9, options: [{ name: "Color", values: ["Blue", "Pink"] }, { name: "Hand", values: ["Left", "Right", "Pair"] }], images: 4, store: "PawPal", rating: 4.4, orders: 12890 },
  { id: "1005006007", title: "Magnetic Phone Car Mount 360° Rotation", category: "Automotive", basePrice: 2.3, options: [{ name: "Color", values: ["Black", "Silver"] }], images: 5, store: "DriveMate", rating: 4.6, orders: 27000 },
  { id: "1005006008", title: "Yoga Mat Non-Slip 6mm TPE Eco Friendly", category: "Sports", basePrice: 8.9, options: [{ name: "Color", values: ["Purple", "Teal", "Grey"] }], images: 6, store: "FitFlow", rating: 4.8, orders: 9800 },
  { id: "1005006009", title: "Electric Milk Frother Handheld, 3 Speeds", category: "Home & Kitchen", basePrice: 3.1, options: [{ name: "Color", values: ["Black", "White", "Red"] }], images: 5, store: "HomeBright", rating: 4.5, orders: 18700 },
  { id: "1005006010", title: "Smart Water Bottle 500ml Temperature Display", category: "Sports", basePrice: 5.7, options: [{ name: "Color", values: ["Black", "Blue", "White"] }, { name: "Size", values: ["500ml", "750ml"] }], images: 6, store: "FitFlow", rating: 4.6, orders: 6600 },
  { id: "1005006011", title: "Laptop Stand Aluminium Adjustable Foldable", category: "Electronics", basePrice: 11.5, options: [{ name: "Color", values: ["Silver", "Space Grey"] }], images: 7, store: "TechNova Official Store", rating: 4.9, orders: 14200 },
  { id: "1005006012", title: "Sunset Lamp Projector 16 Colors USB", category: "Lighting", basePrice: 3.4, options: [{ name: "Type", values: ["Sunset", "Rainbow", "16 Colors"] }], images: 6, store: "LumiHome", rating: 4.5, orders: 51000 },
];

const CARRIERS = [
  { code: "CAINIAO_STANDARD", name: "AliExpress Standard Shipping", base: 1.99, min: 12, max: 25, tracking: true },
  { code: "CAINIAO_ECONOMY", name: "Cainiao Super Economy", base: 0, min: 20, max: 45, tracking: false },
  { code: "EPACKET", name: "ePacket", base: 3.49, min: 8, max: 18, tracking: true },
  { code: "DHL", name: "DHL Express", base: 18.9, min: 3, max: 7, tracking: true },
  { code: "YANWEN", name: "Yanwen Economic Air Mail", base: 0.99, min: 15, max: 35, tracking: true },
];

/** Placed mock orders, so `getOrder` and `getTracking` behave across calls. */
const ORDERS = new Map<string, { placedAt: number; input: PlaceOrderInput; result: PlaceOrderResult; canceled?: boolean }>();
/** Bounded: this map lives for the process lifetime. */
const MAX_MOCK_ORDERS = 500;

function rememberOrder(key: string, value: { placedAt: number; input: PlaceOrderInput; result: PlaceOrderResult }) {
  ORDERS.set(key, value);
  while (ORDERS.size > MAX_MOCK_ORDERS) {
    const oldest = ORDERS.keys().next();
    if (oldest.done) break;
    ORDERS.delete(oldest.value);
  }
}

function hash(input: string): number {
  return parseInt(crypto.createHash("md5").update(input).digest("hex").slice(0, 8), 16);
}

/** Small hour-to-hour drift so the inventory job sees real changes. */
function drift(seed: string, amplitude: number): number {
  const hour = Math.floor(Date.now() / 3_600_000);
  const h = hash(`${seed}:${hour}`) % 1000;
  return ((h / 1000) * 2 - 1) * amplitude;
}

/**
 * Placeholder swatches as plain hex. The previous form interpolated an
 * `hsl(h,55%,55%)` string straight into the path, so every url carried raw
 * parentheses, commas and - worst - `%` characters that are not valid percent
 * escapes. Shopify's productSet rejected all of them with "File URL is
 * invalid", which meant no mock product could ever be published.
 */
const SWATCHES = ["4f7cac", "c1666b", "48a9a6", "d4b483", "8a6fbf", "5b8c5a", "c9784e", "3e6680"];

function image(productId: string, index: number): string {
  const swatch = SWATCHES[hash(`${productId}:${index}`) % SWATCHES.length];
  return `https://placehold.co/800x800/${swatch}/white.png?text=${encodeURIComponent(`${productId}-${index + 1}`)}`;
}

function cartesian(options: Array<{ name: string; values: string[] }>): string[][] {
  return options.reduce<string[][]>(
    (acc, option) => acc.flatMap((combo) => option.values.map((v) => [...combo, v])),
    [[]],
  );
}

function buildVariants(seed: MockProductSeed): SupplierVariantDetail[] {
  return cartesian(seed.options).map((values, index) => {
    const skuId = `${seed.id}-${index + 1}`;
    const priceDrift = drift(`price:${skuId}`, 0.08);
    const price = seed.basePrice * (1 + index * 0.05) * (1 + priceDrift);
    // Floored well above zero: an amplitude that could reach 0 made the mock
    // supplier report the whole catalogue out of stock during some hours of the
    // day, so the order tests passed or failed by wall clock.
    const stock = Math.max(25, Math.round(120 + drift(`stock:${skuId}`, 60)));
    return {
      externalSkuId: skuId,
      skuAttr: values.map((v, i) => `${seed.options[i].name}:${v}`).join(";"),
      sku: `MOCK-${seed.id.slice(-4)}-${index + 1}`,
      attributes: values.map((value, i) => ({
        name: seed.options[i].name,
        value,
        image: i === 0 ? image(seed.id, index % seed.images) : null,
      })),
      image: image(seed.id, index % seed.images),
      price: money(price),
      originalPrice: money(price * 1.6),
      currency: "USD",
      stock,
      isAvailable: stock > 0,
      weightGrams: 120 + index * 15,
    };
  });
}

function buildProduct(seed: MockProductSeed): SupplierProductDetail {
  const variants = buildVariants(seed);
  return {
    externalId: seed.id,
    platform: "MOCK",
    title: seed.title,
    descriptionHtml: `<p>${seed.title}.</p><ul><li>Category: ${seed.category}</li><li>Ships from CN warehouse within 48 hours.</li><li>30-day buyer protection.</li></ul><p>Visit <a href="https://example.com/store">our store</a> for more.</p>`,
    url: `https://www.aliexpress.com/item/${seed.id}.html`,
    images: Array.from({ length: seed.images }, (_, i) => image(seed.id, i)),
    currency: "USD",
    optionNames: seed.options.map((o) => o.name),
    variants,
    storeName: seed.store,
    storeUrl: `https://www.aliexpress.com/store/${hash(seed.store) % 100000}`,
    storeId: String(hash(seed.store) % 100000),
    rating: seed.rating,
    orderCount: seed.orders,
    categoryId: seed.category,
    shipsFrom: ["CN", ...(hash(seed.id) % 3 === 0 ? ["US"] : [])],
    isAvailable: variants.some((v) => v.isAvailable),
  };
}

export class MockSupplierAdapter implements SupplierAdapter {
  readonly platform = "MOCK" as const;
  readonly displayName = "Demo supplier";
  readonly capabilities = {
    search: true,
    imageSearch: false,
    oauth: false,
    placeOrder: true,
    cancelOrder: true,
    tracking: true,
    shippingQuotes: true,
  };

  isConfigured() {
    return true;
  }

  parseProductReference(input: string): string | null {
    const trimmed = input.trim();
    const fromUrl = /item\/(\d{6,})/.exec(trimmed);
    if (fromUrl) return fromUrl[1];
    if (/^\d{6,}$/.test(trimmed)) return trimmed;
    return null;
  }

  async searchProducts(params: SupplierSearchParams): Promise<SupplierSearchResult> {
    const q = params.query.trim().toLowerCase();
    let matches = CATALOG.filter(
      (p) => !q || p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
    );
    switch (params.sort) {
      case "orders":
        matches = [...matches].sort((a, b) => b.orders - a.orders);
        break;
      case "price_asc":
        matches = [...matches].sort((a, b) => a.basePrice - b.basePrice);
        break;
      case "price_desc":
        matches = [...matches].sort((a, b) => b.basePrice - a.basePrice);
        break;
      case "rating":
        matches = [...matches].sort((a, b) => b.rating - a.rating);
        break;
      default:
        break;
    }
    if (params.minPrice !== undefined) matches = matches.filter((p) => p.basePrice >= params.minPrice!);
    if (params.maxPrice !== undefined) matches = matches.filter((p) => p.basePrice <= params.maxPrice!);

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, params.pageSize ?? 20);
    const slice = matches.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: slice.map((p) => ({
        externalId: p.id,
        title: p.title,
        url: `https://www.aliexpress.com/item/${p.id}.html`,
        image: image(p.id, 0),
        price: money(p.basePrice),
        originalPrice: money(p.basePrice * 1.6),
        currency: "USD",
        orderCount: p.orders,
        rating: p.rating,
        storeName: p.store,
        storeId: String(hash(p.store) % 100000),
        shipsFrom: ["CN"],
        shippingFrom: "1.99",
      })),
      page,
      pageSize,
      total: matches.length,
      hasMore: page * pageSize < matches.length,
    };
  }

  async getProduct(externalId: string): Promise<SupplierProductDetail | null> {
    const seed = CATALOG.find((p) => p.id === externalId);
    if (seed) return buildProduct(seed);
    // Unknown ids still resolve, so any pasted URL "works" in development.
    if (/^\d{6,}$/.test(externalId)) {
      const synthetic: MockProductSeed = {
        id: externalId,
        title: `Sample product ${externalId}`,
        category: "General",
        basePrice: 2 + (hash(externalId) % 2000) / 100,
        options: [{ name: "Color", values: ["Black", "White"] }],
        images: 4,
        store: "Sample Store",
        rating: 4.3,
        orders: hash(externalId) % 5000,
      };
      return buildProduct(synthetic);
    }
    return null;
  }

  async getShippingQuotes(params: ShippingQuoteParams): Promise<SupplierShippingQuote[]> {
    const country = params.shipToCountry.toUpperCase();
    const regionFactor = ["US", "CA", "GB", "DE", "FR", "AU"].includes(country) ? 1 : 1.35;
    return CARRIERS.filter((c) => !(c.code === "EPACKET" && !["US", "CA", "GB", "AU"].includes(country))).map((c) => ({
      carrierCode: c.code,
      carrierName: c.name,
      cost: money(c.base * regionFactor * Math.max(1, params.quantity * 0.6)),
      currency: "USD",
      shipFromCountry: params.shipFromCountry ?? "CN",
      shipToCountry: country,
      minDeliveryDays: c.min,
      maxDeliveryDays: c.max,
      hasTracking: c.tracking,
      isFreeShipping: c.base === 0,
    }));
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const existing = ORDERS.get(input.reference);
    if (existing) return existing.result;

    let itemsCost = d(0);
    for (const item of input.items) {
      const product = await this.getProduct(item.externalProductId);
      const variant = product?.variants.find((v) => v.externalSkuId === item.externalSkuId);
      if (!product || !variant) {
        throw new Error(`Unknown SKU ${item.externalProductId}/${item.externalSkuId}`);
      }
      if (!variant.isAvailable || variant.stock < item.quantity) {
        throw new Error(`SKU ${item.externalSkuId} is out of stock`);
      }
      itemsCost = itemsCost.plus(d(variant.price).times(item.quantity));
    }
    const quotes = await this.getShippingQuotes({
      externalId: input.items[0].externalProductId,
      quantity: input.items.reduce((n, i) => n + i.quantity, 0),
      shipToCountry: input.address.countryCode,
    });
    const chosen = quotes.find((q) => q.carrierCode === input.items[0].carrierCode) ?? quotes[0];
    const shippingCost = d(chosen?.cost ?? 0);

    const externalOrderId = `MOCK-${Date.now().toString(36).toUpperCase()}-${hash(input.reference) % 10000}`;
    const result: PlaceOrderResult = {
      externalOrderId,
      status: "AWAITING_PAYMENT",
      itemsCost: money(itemsCost),
      shippingCost: money(shippingCost),
      totalCost: money(itemsCost.plus(shippingCost)),
      currency: "USD",
      paymentUrl: `https://example.com/pay/${externalOrderId}`,
      // AliExpress cancels an unpaid order after 24 hours and the Payments page
      // counts down to it. Without a deadline here the countdown, the
      // "expiring soon" tally and the reminder job all have nothing to show, so
      // anyone trying the app on the Demo supplier — a new merchant, an App
      // Store reviewer — sees an empty column and reads it as broken.
      paymentDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    rememberOrder(input.reference, { placedAt: Date.now(), input, result });
    ORDERS.set(externalOrderId, { placedAt: Date.now(), input, result });
    return result;
  }

  async getOrder(externalOrderId: string): Promise<SupplierOrderStatus | null> {
    const entry = ORDERS.get(externalOrderId);
    if (!entry) {
      // Orders placed by a previous process: synthesize a plausible lifecycle from the id.
      if (!externalOrderId.startsWith("MOCK-")) return null;
      return { externalOrderId, status: "SHIPPED", raw: { synthetic: true } };
    }
    if (entry.canceled) return { externalOrderId, status: "CANCELED" };
    const ageMinutes = (Date.now() - entry.placedAt) / 60_000;
    const status = ageMinutes < 1 ? "AWAITING_PAYMENT" : ageMinutes < 3 ? "PAID" : ageMinutes < 30 ? "SHIPPED" : "DELIVERED";
    return {
      externalOrderId,
      status,
      itemsCost: entry.result.itemsCost,
      shippingCost: entry.result.shippingCost,
      totalCost: entry.result.totalCost,
      currency: "USD",
      paidAt: ageMinutes >= 1 ? new Date(entry.placedAt + 60_000) : null,
      shippedAt: ageMinutes >= 3 ? new Date(entry.placedAt + 180_000) : null,
    };
  }

  async cancelOrder(externalOrderId: string): Promise<boolean> {
    const entry = ORDERS.get(externalOrderId);
    if (!entry) return false;
    const ageMinutes = (Date.now() - entry.placedAt) / 60_000;
    if (ageMinutes >= 3) return false; // already shipped
    entry.canceled = true;
    return true;
  }

  async getTracking(externalOrderId: string): Promise<SupplierTracking[]> {
    const status = await this.getOrder(externalOrderId);
    if (!status || !["SHIPPED", "DELIVERED"].includes(status.status)) return [];
    const number = `LP${String(hash(externalOrderId)).padStart(11, "0")}CN`;
    return [
      {
        number,
        carrierCode: "CAINIAO_STANDARD",
        carrierName: "AliExpress Standard Shipping",
        url: `https://global.cainiao.com/detail.htm?mailNoList=${number}`,
        status: status.status === "DELIVERED" ? "DELIVERED" : "IN_TRANSIT",
        lastEvent: status.status === "DELIVERED" ? "Delivered" : "Departed from origin facility",
        lastEventAt: new Date(),
      },
    ];
  }
}

export const MOCK_CATALOG_IDS = CATALOG.map((p) => p.id);
