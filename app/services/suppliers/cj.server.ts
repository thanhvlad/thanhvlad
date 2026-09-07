import { SupplierError } from "~/lib/errors";
import { env } from "~/lib/env.server";
import { money } from "~/lib/money";
import { httpJson } from "./http.server";
import type {
  PlaceOrderInput,
  PlaceOrderResult,
  ShippingQuoteParams,
  SupplierAdapter,
  SupplierCredentials,
  SupplierOrderState,
  SupplierOrderStatus,
  SupplierProductDetail,
  SupplierSearchParams,
  SupplierSearchResult,
  SupplierShippingQuote,
  SupplierTokens,
  SupplierTracking,
} from "./types";

/**
 * CJ Dropshipping API 2.0 — https://developers.cjdropshipping.com
 *
 * Auth is email + API key exchanged for a bearer token (`CJ-Access-Token`).
 * We store the token as the account's accessToken and refresh via the
 * refreshToken endpoint when it expires.
 */

type Json = Record<string, unknown>;

interface CjEnvelope<T> {
  code: number;
  result: boolean;
  message: string;
  data: T;
}

const STATUS_MAP: Record<string, SupplierOrderState> = {
  CREATED: "PLACED",
  IN_CART: "PLACED",
  UNPAID: "AWAITING_PAYMENT",
  UNSHIPPED: "PAID",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELED",
  CANCELED: "CANCELED",
};

export class CjDropshippingAdapter implements SupplierAdapter {
  readonly platform = "CJ_DROPSHIPPING" as const;
  readonly displayName = "CJ Dropshipping";
  readonly capabilities = {
    search: true,
    imageSearch: false,
    oauth: false,
    placeOrder: true,
    cancelOrder: true,
    tracking: true,
    shippingQuotes: true,
  };

  private readonly base: string;
  private readonly token: string | null;

  constructor(private readonly credentials: SupplierCredentials = {}) {
    this.base = env().CJ_API_BASE.replace(/\/$/, "");
    this.token = credentials.accessToken ?? null;
  }

  isConfigured() {
    return Boolean(this.token || (env().CJ_EMAIL && env().CJ_API_KEY));
  }

  private async request<T>(path: string, options: { method?: "GET" | "POST"; query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}): Promise<T> {
    if (options.auth !== false && !this.token) {
      throw new SupplierError("SUPPLIER_NOT_AUTHORIZED", "Connect a CJ Dropshipping account first.");
    }
    const envelope = await httpJson<CjEnvelope<T>>(`${this.base}${path}`, {
      method: options.method ?? "GET",
      query: options.query,
      body: options.body,
      headers: this.token && options.auth !== false ? { "CJ-Access-Token": this.token } : {},
    });
    if (!envelope || envelope.result === false || (envelope.code && envelope.code !== 200)) {
      const message = envelope?.message ?? "CJ API error";
      const authFailure = /token|login|unauthor/i.test(message) || envelope?.code === 1600100 || envelope?.code === 1600200;
      throw new SupplierError(authFailure ? "SUPPLIER_NOT_AUTHORIZED" : "SUPPLIER_API", message, {
        retryable: /too many|limit|frequent/i.test(message),
        details: envelope as unknown as Json,
      });
    }
    return envelope.data;
  }

  // ---- Auth -------------------------------------------------------------------

  /** CJ has no OAuth; `exchangeCode` accepts "email:apiKey" from the connect form. */
  async exchangeCode(code: string): Promise<SupplierTokens> {
    const [email, apiKey] = code.includes(":") ? code.split(":", 2) : [env().CJ_EMAIL ?? "", env().CJ_API_KEY ?? ""];
    const data = await this.request<Json>("/authentication/getAccessToken", {
      method: "POST",
      auth: false,
      body: { email, password: apiKey },
    });
    return {
      accessToken: String(data.accessToken),
      refreshToken: data.refreshToken ? String(data.refreshToken) : null,
      expiresAt: data.accessTokenExpiryDate ? new Date(String(data.accessTokenExpiryDate)) : null,
      externalUserId: data.openId ? String(data.openId) : email,
      meta: { email },
    };
  }

  async refreshTokens(refreshToken: string): Promise<SupplierTokens> {
    const data = await this.request<Json>("/authentication/refreshAccessToken", {
      method: "POST",
      auth: false,
      body: { refreshToken },
    });
    return {
      accessToken: String(data.accessToken),
      refreshToken: data.refreshToken ? String(data.refreshToken) : refreshToken,
      expiresAt: data.accessTokenExpiryDate ? new Date(String(data.accessTokenExpiryDate)) : null,
    };
  }

  // ---- Catalog ---------------------------------------------------------------

  parseProductReference(input: string): string | null {
    const trimmed = input.trim();
    const fromUrl = /cjdropshipping\.com\/product\/(?:[\w-]+-)?p-([0-9A-F-]{20,})/i.exec(trimmed);
    if (fromUrl) return fromUrl[1].toUpperCase();
    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(trimmed)) return trimmed.toUpperCase();
    return null;
  }

  async searchProducts(params: SupplierSearchParams): Promise<SupplierSearchResult> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, params.pageSize ?? 20);
    const data = await this.request<{ list: Json[]; total: number }>("/product/list", {
      query: {
        productNameEn: params.query || undefined,
        pageNum: page,
        pageSize,
        countryCode: params.shipFromCountry,
        minPrice: params.minPrice,
        maxPrice: params.maxPrice,
      },
    });
    return {
      items: (data.list ?? []).map((p) => ({
        externalId: String(p.pid),
        title: String(p.productNameEn ?? ""),
        url: `https://cjdropshipping.com/product/p-${p.pid}.html`,
        image: (p.productImage as string) ?? null,
        price: money(String(p.sellPrice ?? "0").split("--")[0]),
        currency: "USD",
        orderCount: Number(p.listedNum ?? 0) || null,
        rating: null,
        storeName: "CJ Dropshipping",
        shipsFrom: p.sourceFrom ? [String(p.sourceFrom)] : ["CN"],
      })),
      page,
      pageSize,
      total: data.total ?? null,
      hasMore: page * pageSize < (data.total ?? 0),
    };
  }

  async getProduct(externalId: string): Promise<SupplierProductDetail | null> {
    const data = await this.request<Json>("/product/query", { query: { pid: externalId } });
    if (!data || !data.pid) return null;
    const variants = ((data.variants as Json[]) ?? []);
    const optionNames: string[] = [];
    const stockByVid = new Map<string, number>();
    await Promise.all(
      variants.slice(0, 60).map(async (v) => {
        try {
          const stock = await this.request<Array<{ totalInventoryNum?: number; storageNum?: number }>>(
            "/product/stock/queryByVid",
            { query: { vid: String(v.vid) } },
          );
          stockByVid.set(String(v.vid), stock.reduce((n, s) => n + Number(s.totalInventoryNum ?? s.storageNum ?? 0), 0));
        } catch {
          stockByVid.set(String(v.vid), 0);
        }
      }),
    );

    const detail: SupplierProductDetail = {
      externalId: String(data.pid),
      platform: "CJ_DROPSHIPPING",
      title: String(data.productNameEn ?? ""),
      descriptionHtml: String(data.description ?? ""),
      url: `https://cjdropshipping.com/product/p-${data.pid}.html`,
      images: Array.isArray(data.productImageSet) ? (data.productImageSet as string[]) : data.productImage ? [String(data.productImage)] : [],
      currency: "USD",
      optionNames,
      variants: variants.map((v) => {
        // CJ encodes options as "Color-Size" in variantKey; the names are on the product.
        const keyParts = String(v.variantKey ?? v.variantNameEn ?? "").split("-").map((s) => s.trim()).filter(Boolean);
        const names = (String(data.productKeyEn ?? "").split(",").map((s) => s.trim()).filter(Boolean));
        const attributes = keyParts.map((value, i) => {
          const name = names[i] ?? `Option ${i + 1}`;
          if (!optionNames.includes(name)) optionNames.push(name);
          return { name, value, image: null };
        });
        const stock = stockByVid.get(String(v.vid)) ?? 0;
        return {
          externalSkuId: String(v.vid),
          skuAttr: (v.variantKey as string) ?? null,
          sku: (v.variantSku as string) ?? null,
          attributes,
          image: (v.variantImage as string) ?? null,
          price: money(v.variantSellPrice ?? 0),
          currency: "USD",
          stock,
          isAvailable: stock > 0,
          weightGrams: v.variantWeight ? Number(v.variantWeight) : null,
        };
      }),
      storeName: "CJ Dropshipping",
      storeUrl: "https://cjdropshipping.com",
      storeId: "cj",
      rating: null,
      orderCount: Number(data.listedNum ?? 0) || null,
      categoryId: data.categoryId ? String(data.categoryId) : null,
      shipsFrom: data.sourceFrom ? [String(data.sourceFrom)] : ["CN"],
      isAvailable: String(data.status ?? "3") === "3",
      raw: data,
    };
    return detail;
  }

  async getShippingQuotes(params: ShippingQuoteParams): Promise<SupplierShippingQuote[]> {
    const data = await this.request<Json[]>("/logistic/freightCalculate", {
      method: "POST",
      body: {
        startCountryCode: params.shipFromCountry ?? "CN",
        endCountryCode: params.shipToCountry,
        zip: params.zip ?? undefined,
        products: [{ quantity: params.quantity, vid: params.externalSkuId }],
      },
    });
    return (data ?? []).map((o) => {
      const [min, max] = String(o.logisticAging ?? "").split("-").map((s) => Number(s.trim()));
      return {
        carrierCode: String(o.logisticName ?? ""),
        carrierName: String(o.logisticNameEn ?? o.logisticName ?? ""),
        cost: money(o.logisticPrice ?? 0),
        currency: "USD",
        shipFromCountry: params.shipFromCountry ?? "CN",
        shipToCountry: params.shipToCountry.toUpperCase(),
        minDeliveryDays: Number.isFinite(min) ? min : null,
        maxDeliveryDays: Number.isFinite(max) ? max : Number.isFinite(min) ? min : null,
        hasTracking: true,
        isFreeShipping: Number(o.logisticPrice ?? 1) === 0,
      };
    });
  }

  // ---- Orders ----------------------------------------------------------------

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const a = input.address;
    const orderId = await this.request<string>("/shopping/order/createOrder", {
      method: "POST",
      body: {
        orderNumber: input.reference,
        shippingZip: a.zip ?? "",
        shippingCountryCode: a.countryCode,
        shippingCountry: a.countryCode,
        shippingProvince: a.province ?? "",
        shippingCity: a.city,
        shippingAddress: [a.address1, a.address2].filter(Boolean).join(", "),
        shippingCustomerName: a.name,
        shippingPhone: a.phone,
        taxId: a.taxNumber ?? undefined,
        remark: input.note ?? "",
        fromCountryCode: input.items[0]?.shipFromCountry ?? "CN",
        logisticName: input.items[0]?.carrierCode ?? undefined,
        products: input.items.map((i) => ({ vid: i.externalSkuId, quantity: i.quantity })),
      },
    });
    const detail = await this.getOrder(String(orderId));
    return {
      externalOrderId: String(orderId),
      status: detail?.status ?? "AWAITING_PAYMENT",
      itemsCost: detail?.itemsCost ?? "0.00",
      shippingCost: detail?.shippingCost ?? "0.00",
      totalCost: detail?.totalCost ?? "0.00",
      currency: "USD",
      paymentUrl: "https://cjdropshipping.com/myCJ/orders.html",
      raw: detail?.raw,
    };
  }

  async getOrder(externalOrderId: string): Promise<SupplierOrderStatus | null> {
    const data = await this.request<Json>("/shopping/order/getOrderDetail", { query: { orderId: externalOrderId } });
    if (!data) return null;
    return {
      externalOrderId,
      status: STATUS_MAP[String(data.orderStatus ?? "").toUpperCase()] ?? "PLACED",
      itemsCost: data.productAmount !== undefined ? money(data.productAmount) : null,
      shippingCost: data.postageAmount !== undefined ? money(data.postageAmount) : null,
      totalCost: data.orderAmount !== undefined ? money(data.orderAmount) : null,
      currency: "USD",
      paidAt: data.paymentDate ? new Date(String(data.paymentDate)) : null,
      shippedAt: data.shippedDate ? new Date(String(data.shippedDate)) : null,
      raw: data,
    };
  }

  async cancelOrder(externalOrderId: string): Promise<boolean> {
    try {
      await this.request("/shopping/order/deleteOrder", { method: "GET", query: { orderId: externalOrderId } });
      return true;
    } catch {
      return false;
    }
  }

  async getTracking(externalOrderId: string): Promise<SupplierTracking[]> {
    const order = await this.getOrder(externalOrderId);
    const number = order?.raw && (order.raw as Json).trackNumber ? String((order.raw as Json).trackNumber) : null;
    if (!number) return [];
    let status: string | null = null;
    let lastEvent: string | null = null;
    try {
      const info = await this.request<Json[]>("/logistic/getTrackInfo", { query: { trackNumber: number } });
      status = (info?.[0]?.trackingStatus as string) ?? null;
      lastEvent = (info?.[0]?.lastMileInfo as string) ?? null;
    } catch {
      // Tracking info is best-effort.
    }
    return [
      {
        number,
        carrierCode: (order?.raw as Json)?.logisticName ? String((order!.raw as Json).logisticName) : null,
        carrierName: (order?.raw as Json)?.logisticName ? String((order!.raw as Json).logisticName) : null,
        url: `https://www.17track.net/en/track?nums=${number}`,
        status,
        lastEvent,
        lastEventAt: null,
      },
    ];
  }
}
