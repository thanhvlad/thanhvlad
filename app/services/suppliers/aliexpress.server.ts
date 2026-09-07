import crypto from "node:crypto";
import { SupplierError } from "~/lib/errors";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { d, money } from "~/lib/money";
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
  SupplierVariantDetail,
} from "./types";

/**
 * AliExpress Open Platform — Dropshipping (DS) API.
 *
 * Docs: https://openservice.aliexpress.com/doc/doc.htm (Dropshipping solution).
 * All calls go through the `/sync` gateway with an HMAC-SHA256 signature over
 * the sorted parameter list. OAuth uses the `/oauth/authorize` page and the
 * `/auth/token/create` + `/auth/token/refresh` endpoints.
 */

type Json = Record<string, unknown>;

const ORDER_STATUS_MAP: Record<string, SupplierOrderState> = {
  PLACE_ORDER_SUCCESS: "AWAITING_PAYMENT",
  WAIT_BUYER_PAY: "AWAITING_PAYMENT",
  RISK_CONTROL: "AWAITING_PAYMENT",
  WAIT_SELLER_EXAMINE_MONEY: "PAID",
  FUND_PROCESSING: "PAID",
  WAIT_SELLER_SEND_GOODS: "PAID",
  SELLER_PART_SEND_GOODS: "SHIPPED",
  WAIT_BUYER_ACCEPT_GOODS: "SHIPPED",
  IN_ISSUE: "SHIPPED",
  IN_FROZEN: "PAID",
  FINISH: "DELIVERED",
  IN_CANCEL: "CANCELED",
  CANCEL: "CANCELED",
  CLOSED: "CANCELED",
};

export class AliExpressAdapter implements SupplierAdapter {
  readonly platform = "ALIEXPRESS" as const;
  readonly displayName = "AliExpress";
  readonly capabilities = {
    search: true,
    imageSearch: true,
    oauth: true,
    placeOrder: true,
    cancelOrder: false,
    tracking: true,
    shippingQuotes: true,
  };

  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly apiBase: string;
  private readonly authBase: string;
  private readonly redirectUri: string;
  private readonly trackingId: string | undefined;
  private readonly session: string | null;

  constructor(private readonly credentials: SupplierCredentials = {}) {
    const config = env();
    this.appKey = config.ALIEXPRESS_APP_KEY ?? "";
    this.appSecret = config.ALIEXPRESS_APP_SECRET ?? "";
    this.apiBase = config.ALIEXPRESS_API_BASE;
    this.authBase = config.ALIEXPRESS_AUTH_BASE;
    this.redirectUri = config.ALIEXPRESS_REDIRECT_URI ?? `${config.SHOPIFY_APP_URL}/app/suppliers/callback/aliexpress`;
    this.trackingId = config.ALIEXPRESS_TRACKING_ID;
    this.session = credentials.accessToken ?? null;
  }

  isConfigured() {
    return Boolean(this.appKey && this.appSecret);
  }

  // ---------------------------------------------------------------------------
  // Signing & transport
  // ---------------------------------------------------------------------------

  private sign(params: Record<string, string>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("");
    return crypto.createHmac("sha256", this.appSecret).update(sorted).digest("hex").toUpperCase();
  }

  private async call<T = Json>(method: string, params: Record<string, string | number | undefined>, options: { requireSession?: boolean } = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new SupplierError("SUPPLIER_NOT_CONFIGURED", "AliExpress app key/secret are not configured.");
    }
    if (options.requireSession !== false && !this.session) {
      throw new SupplierError("SUPPLIER_NOT_AUTHORIZED", "Connect an AliExpress account first.");
    }
    const base: Record<string, string> = {
      app_key: this.appKey,
      method,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      v: "2.0",
      format: "json",
      simplify: "true",
      ...(this.session ? { session: this.session } : {}),
    };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) base[k] = String(v);
    }
    base.sign = this.sign(base);

    const body = await httpJson<Json>(this.apiBase, { method: "POST", form: base, retries: 2 });
    const key = `${method.replace(/\./g, "_")}_response`;
    const envelope = (body[key] ?? body) as Json;

    if (body.error_response) {
      const err = body.error_response as Json;
      const code = String(err.code ?? err.sub_code ?? "UNKNOWN");
      const message = String(err.msg ?? err.sub_msg ?? "AliExpress API error");
      logger.warn("AliExpress API error", { method, code, message });
      const authFailure = /session|token|auth/i.test(message) || ["25", "26", "27"].includes(code);
      throw new SupplierError(authFailure ? "SUPPLIER_NOT_AUTHORIZED" : "SUPPLIER_API", `${message} (${code})`, {
        retryable: /rate|limit|busy|timeout/i.test(message),
        details: err,
      });
    }
    if (envelope.rsp_code && String(envelope.rsp_code) !== "200") {
      throw new SupplierError("SUPPLIER_API", String(envelope.rsp_msg ?? "AliExpress request rejected"), {
        details: envelope,
      });
    }
    return envelope as T;
  }

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  getAuthorizationUrl(state: string): string {
    const url = new URL(`${this.authBase}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("force_auth", "true");
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("client_id", this.appKey);
    url.searchParams.set("state", state);
    return url.toString();
  }

  private async tokenCall(path: "/auth/token/create" | "/auth/token/refresh", extra: Record<string, string>): Promise<SupplierTokens> {
    const params: Record<string, string> = {
      app_key: this.appKey,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      ...extra,
    };
    // The REST gateway prefixes the API path to the signed string.
    const sorted = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
    params.sign = crypto.createHmac("sha256", this.appSecret).update(path + sorted).digest("hex").toUpperCase();

    const restBase = this.apiBase.replace(/\/sync$/, "/rest");
    const body = await httpJson<Json>(`${restBase}${path}`, { method: "POST", form: params });
    if (!body.access_token) {
      throw new SupplierError("SUPPLIER_OAUTH", String(body.message ?? body.error_msg ?? "Token exchange failed"), {
        details: body,
      });
    }
    const expiresIn = Number(body.expires_in ?? 0);
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      externalUserId: body.user_id ? String(body.user_id) : body.seller_id ? String(body.seller_id) : null,
      meta: {
        account: body.account ?? null,
        sellerId: body.seller_id ?? null,
        refreshExpiresIn: body.refresh_expires_in ?? null,
      },
    };
  }

  exchangeCode(code: string) {
    return this.tokenCall("/auth/token/create", { code });
  }

  refreshTokens(refreshToken: string) {
    return this.tokenCall("/auth/token/refresh", { refresh_token: refreshToken });
  }

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  parseProductReference(input: string): string | null {
    const trimmed = input.trim();
    const patterns = [
      /aliexpress\.[a-z.]+\/item\/(?:[\w-]+\/)?(\d{6,})/i,
      /aliexpress\.[a-z.]+\/i\/(\d{6,})/i,
      /[?&]productId=(\d{6,})/i,
      /^(\d{6,})$/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(trimmed);
      if (match) return match[1];
    }
    return null;
  }

  async searchProducts(params: SupplierSearchParams): Promise<SupplierSearchResult> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, params.pageSize ?? 20);
    const sortBy = {
      default: undefined,
      orders: "orders,desc",
      price_asc: "price,asc",
      price_desc: "price,desc",
      newest: "createTime,desc",
      rating: "evaluateRate,desc",
    }[params.sort ?? "default"];

    if (params.imageUrl) {
      return this.searchByImage(params.imageUrl, params);
    }

    const data = await this.call<Json>("aliexpress.ds.text.search", {
      keyWord: params.query,
      pageSize,
      pageIndex: page,
      countryCode: params.shipToCountry ?? "US",
      currency: "USD",
      local: "en_US",
      sortBy,
      categoryId: params.categoryId,
    });
    const result = (data.data ?? data.result ?? data) as Json;
    const products = extractList(result, ["products", "selection_search_product"]);
    const total = Number(result.totalCount ?? result.total_count ?? 0) || null;
    return {
      items: products.map((p) => ({
        externalId: String(p.itemId ?? p.item_id ?? p.productId ?? ""),
        title: String(p.title ?? p.subject ?? ""),
        url: String(p.itemUrl ?? `https://www.aliexpress.com/item/${p.itemId}.html`),
        image: (p.itemMainPic as string) ?? (p.productMainImageUrl as string) ?? null,
        price: money(p.salePrice ?? p.targetSalePrice ?? p.price ?? 0),
        originalPrice: p.originalPrice ? money(p.originalPrice) : null,
        currency: String(p.salePriceCurrency ?? p.targetSalePriceCurrency ?? "USD"),
        orderCount: Number(p.orders ?? p.lastestVolume ?? 0) || null,
        rating: p.evaluateRate ? Number(String(p.evaluateRate).replace("%", "")) / 20 : p.score ? Number(p.score) : null,
        storeName: (p.shopName as string) ?? null,
        storeId: p.shopId ? String(p.shopId) : null,
        shipsFrom: p.shipFrom ? [String(p.shipFrom)] : ["CN"],
        shippingFrom: p.shippingFee !== undefined ? money(p.shippingFee) : null,
      })).filter((item) => item.externalId),
      page,
      pageSize,
      total,
      hasMore: total ? page * pageSize < total : products.length === pageSize,
    };
  }

  private async searchByImage(imageUrl: string, params: SupplierSearchParams): Promise<SupplierSearchResult> {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new SupplierError("SUPPLIER_API", "Could not download the image to search with.");
    const bytes = Buffer.from(await response.arrayBuffer()).toString("base64");
    const data = await this.call<Json>("aliexpress.ds.image.search", {
      image_file_bytes: bytes,
      shpt_to: params.shipToCountry ?? "US",
      target_currency: "USD",
      target_language: "en",
      sort: params.sort === "price_asc" ? "SALE_PRICE_ASC" : params.sort === "price_desc" ? "SALE_PRICE_DESC" : undefined,
    });
    const products = extractList((data.data ?? data) as Json, ["products", "traffic_image_product_d_t_o"]);
    return {
      items: products.map((p) => ({
        externalId: String(p.product_id ?? ""),
        title: String(p.product_title ?? ""),
        url: String(p.product_detail_url ?? `https://www.aliexpress.com/item/${p.product_id}.html`),
        image: (p.product_main_image_url as string) ?? null,
        price: money(p.target_sale_price ?? p.sale_price ?? 0),
        originalPrice: p.target_original_price ? money(p.target_original_price) : null,
        currency: String(p.target_sale_price_currency ?? "USD"),
        orderCount: Number(p.lastest_volume ?? 0) || null,
        rating: p.evaluate_rate ? Number(String(p.evaluate_rate).replace("%", "")) / 20 : null,
        storeName: (p.shop_name as string) ?? null,
        storeId: p.shop_id ? String(p.shop_id) : null,
        shipsFrom: ["CN"],
      })).filter((i) => i.externalId),
      page: 1,
      pageSize: products.length,
      total: products.length,
      hasMore: false,
    };
  }

  async getProduct(externalId: string, options: { shipToCountry?: string; locale?: string } = {}): Promise<SupplierProductDetail | null> {
    const data = await this.call<Json>("aliexpress.ds.product.get", {
      product_id: externalId,
      ship_to_country: options.shipToCountry ?? "US",
      target_currency: "USD",
      target_language: options.locale ?? "en",
    });
    const result = (data.result ?? data) as Json;
    const base = (result.ae_item_base_info_dto ?? {}) as Json;
    if (!base.product_id && !base.subject) return null;

    const skuList = extractList((result.ae_item_sku_info_dtos ?? {}) as Json, ["ae_item_sku_info_d_t_o"]);
    const media = (result.ae_multimedia_info_dto ?? {}) as Json;
    const store = (result.ae_store_info ?? {}) as Json;
    const pkg = (result.package_info_dto ?? {}) as Json;
    const logistics = (result.logistics_info_dto ?? {}) as Json;

    const optionNames: string[] = [];
    const variants: SupplierVariantDetail[] = skuList.map((sku) => {
      const props = extractList((sku.ae_sku_property_dtos ?? {}) as Json, ["ae_sku_property_d_t_o"]);
      const attributes = props.map((p) => {
        const name = String(p.sku_property_name ?? "Option");
        if (!optionNames.includes(name)) optionNames.push(name);
        return {
          name,
          value: String(p.property_value_definition_name ?? p.sku_property_value ?? ""),
          image: (p.sku_image as string) ?? null,
        };
      });
      const stock = Number(sku.sku_available_stock ?? sku.sku_stock ?? sku.ipm_sku_stock ?? 0);
      const salePrice = sku.offer_sale_price ?? sku.offer_bulk_sale_price ?? sku.sku_price;
      return {
        externalSkuId: String(sku.sku_id ?? sku.id ?? ""),
        skuAttr: (sku.sku_attr as string) ?? null,
        sku: (sku.sku_code as string) ?? null,
        attributes,
        image: attributes.find((a) => a.image)?.image ?? null,
        price: money(salePrice ?? 0),
        originalPrice: sku.sku_price ? money(sku.sku_price) : null,
        currency: String(sku.currency_code ?? base.currency_code ?? "USD"),
        stock,
        isAvailable: stock > 0 && String(sku.sku_stock ?? "true") !== "false",
        weightGrams: pkg.gross_weight ? Math.round(Number(pkg.gross_weight) * 1000 / Math.max(1, skuList.length)) : null,
      };
    });

    const images = String(media.image_urls ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      externalId: String(base.product_id ?? externalId),
      platform: "ALIEXPRESS",
      title: String(base.subject ?? ""),
      descriptionHtml: String(base.detail ?? base.mobile_detail ?? ""),
      url: `https://www.aliexpress.com/item/${externalId}.html`,
      images,
      currency: String(base.currency_code ?? "USD"),
      optionNames,
      variants,
      storeName: (store.store_name as string) ?? null,
      storeUrl: store.store_id ? `https://www.aliexpress.com/store/${store.store_id}` : null,
      storeId: store.store_id ? String(store.store_id) : null,
      rating: base.avg_evaluation_rating ? Number(base.avg_evaluation_rating) : null,
      orderCount: base.sales_count ? Number(base.sales_count) : null,
      categoryId: base.category_id ? String(base.category_id) : null,
      shipsFrom: logistics.ship_from ? [String(logistics.ship_from)] : ["CN"],
      isAvailable: String(base.product_status_type ?? "onSelling") === "onSelling" && variants.some((v) => v.isAvailable),
      raw: result,
    };
  }

  async getShippingQuotes(params: ShippingQuoteParams): Promise<SupplierShippingQuote[]> {
    const data = await this.call<Json>("aliexpress.ds.freight.query", {
      queryDeliveryReq: JSON.stringify({
        productId: params.externalId,
        quantity: params.quantity,
        shipToCountry: params.shipToCountry,
        selectedSkuId: params.externalSkuId ?? undefined,
        provinceCode: params.province ?? undefined,
        cityCode: undefined,
        locale: "en_US",
        currency: "USD",
        language: "en",
        source: "CN",
      }),
    });
    const result = (data.result ?? data) as Json;
    const options = extractList((result.delivery_options ?? {}) as Json, ["delivery_option_d_t_o"]);
    return options.map((o) => ({
      carrierCode: String(o.code ?? o.service_name ?? ""),
      carrierName: String(o.company ?? o.code ?? ""),
      cost: money(o.shipping_fee_cent !== undefined ? Number(o.shipping_fee_cent) / 100 : o.shipping_fee_format ?? o.amount ?? 0),
      currency: String(o.shipping_fee_currency ?? "USD"),
      shipFromCountry: String(o.ship_from_country ?? "CN"),
      shipToCountry: params.shipToCountry.toUpperCase(),
      minDeliveryDays: o.min_delivery_days !== undefined ? Number(o.min_delivery_days) : null,
      maxDeliveryDays: o.max_delivery_days !== undefined ? Number(o.max_delivery_days) : null,
      hasTracking: String(o.tracking ?? "true") !== "false",
      isFreeShipping: String(o.free_shipping ?? "false") === "true" || Number(o.shipping_fee_cent ?? 1) === 0,
    })).filter((o) => o.carrierCode);
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const address = input.address;
    const payload = {
      out_order_id: input.reference,
      logistics_address: {
        address: address.address1,
        address2: address.address2 ?? "",
        city: address.city,
        contact_person: address.name,
        full_name: address.name,
        country: address.countryCode,
        province: address.province ?? "",
        zip: address.zip ?? "",
        mobile_no: address.phone,
        phone_country: address.phoneCountryCode ?? "",
        locale: "en_US",
        tax_number: address.taxNumber ?? undefined,
        passport_no: undefined,
        cpf: address.countryCode === "BR" ? address.taxNumber ?? undefined : undefined,
        rut_no: address.countryCode === "CL" ? address.taxNumber ?? undefined : undefined,
      },
      product_items: input.items.map((item) => ({
        product_id: item.externalProductId,
        product_count: item.quantity,
        sku_attr: item.externalSkuId,
        logistics_service_name: item.carrierCode ?? undefined,
        order_memo: input.note ?? undefined,
      })),
    };

    const data = await this.call<Json>("aliexpress.ds.order.create", {
      param_place_order_request4_open_api_d_t_o: JSON.stringify(payload),
      ds_extend_request: JSON.stringify({
        payment: { pay_currency: input.currency ?? "USD" },
        promotion: this.trackingId ? { promotion_channel_info: this.trackingId } : undefined,
      }),
    });
    const result = (data.result ?? data) as Json;
    const success = String(result.is_success ?? "false") === "true";
    if (!success) {
      throw new SupplierError("SUPPLIER_ORDER_REJECTED", String(result.error_msg ?? result.error_code ?? "Order rejected by AliExpress"), {
        details: result,
      });
    }
    const orderIds = extractList((result.order_list ?? {}) as Json, ["number"]).map((n) => String(typeof n === "object" ? Object.values(n)[0] : n));
    const primary = orderIds[0];
    if (!primary) throw new SupplierError("SUPPLIER_ORDER_REJECTED", "AliExpress returned no order id.", { details: result });

    // Costs are not part of the create response; read them back.
    const status = await this.getOrder(primary).catch(() => null);
    return {
      externalOrderId: primary,
      externalOrderIds: orderIds,
      status: status?.status ?? "AWAITING_PAYMENT",
      itemsCost: status?.itemsCost ?? "0.00",
      shippingCost: status?.shippingCost ?? "0.00",
      totalCost: status?.totalCost ?? "0.00",
      currency: status?.currency ?? "USD",
      paymentUrl: `https://www.aliexpress.com/p/order/index.html?orderId=${primary}`,
      raw: result,
    };
  }

  async getOrder(externalOrderId: string): Promise<SupplierOrderStatus | null> {
    const data = await this.call<Json>("aliexpress.ds.trade.order.get", {
      single_order_query: JSON.stringify({ order_id: externalOrderId }),
    });
    const result = (data.result ?? data) as Json;
    if (!result.order_status && !result.id) return null;
    const amount = (result.order_amount ?? {}) as Json;
    const children = extractList((result.child_order_list ?? {}) as Json, ["ae_child_order_info"]);
    const itemsCost = children.reduce((acc, child) => {
      const price = (child.product_price ?? {}) as Json;
      return acc.plus(d(price.amount ?? 0).times(Number(child.product_count ?? 1)));
    }, d(0));
    const total = d(amount.amount ?? 0);
    return {
      externalOrderId,
      status: ORDER_STATUS_MAP[String(result.order_status ?? "")] ?? "PLACED",
      itemsCost: itemsCost.isZero() ? null : money(itemsCost),
      shippingCost: itemsCost.isZero() || total.isZero() ? null : money(total.minus(itemsCost)),
      totalCost: total.isZero() ? null : money(total),
      currency: String(amount.currency_code ?? "USD"),
      paidAt: result.gmt_pay_time ? new Date(String(result.gmt_pay_time)) : null,
      shippedAt: /SEND_GOODS|ACCEPT_GOODS|FINISH/.test(String(result.order_status)) ? new Date() : null,
      raw: result,
    };
  }

  async getTracking(externalOrderId: string): Promise<SupplierTracking[]> {
    const data = await this.call<Json>("aliexpress.ds.order.tracking.get", {
      ae_order_id: externalOrderId,
      language: "en_US",
    });
    const result = ((data.result ?? data) as Json);
    const payload = (result.data ?? result) as Json;
    const lines = extractList((payload.tracking_detail_line_list ?? {}) as Json, ["tracking_detail"]);
    return lines
      .map((line) => {
        const nodes = extractList((line.detail_node_list ?? {}) as Json, ["detail_node"]);
        const last = nodes[nodes.length - 1] ?? {};
        return {
          number: String(line.mail_no ?? line.tracking_number ?? ""),
          carrierCode: (line.carrier_code as string) ?? null,
          carrierName: (line.carrier_name as string) ?? null,
          url: line.mail_no ? `https://global.cainiao.com/detail.htm?mailNoList=${line.mail_no}` : null,
          status: (line.logistics_status as string) ?? null,
          lastEvent: (last.tracking_detail_desc as string) ?? (last.node_desc as string) ?? null,
          lastEventAt: last.time_stamp ? new Date(Number(last.time_stamp)) : null,
        };
      })
      .filter((t) => t.number);
  }
}

/**
 * The AliExpress gateway wraps arrays as `{ key: [...] }` and sometimes flattens
 * a single element to an object; normalise both to an array of objects.
 */
function extractList(container: Json, keys: string[]): Json[] {
  let node: unknown = container;
  for (const key of keys) {
    if (node && typeof node === "object" && key in (node as Json)) {
      node = (node as Json)[key];
    } else {
      break;
    }
  }
  if (Array.isArray(node)) return node.filter((n) => n && typeof n === "object") as Json[];
  if (node && typeof node === "object" && node !== container) return [node as Json];
  return [];
}
