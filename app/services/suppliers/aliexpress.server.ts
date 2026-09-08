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
 * Gateways
 *   TOP-style : https://api-sg.aliexpress.com/sync   (method=aliexpress.ds.*)
 *   REST-style: https://api-sg.aliexpress.com/rest   (path in the signature)
 *
 * Signature: HMAC-SHA256 over the parameters sorted by key and concatenated as
 * `key + value`, uppercase hex. For the REST gateway the API path is prefixed
 * to that string and `method` is not part of it.
 *
 * Method names matter and are not guessable — several DS operations live under
 * non-`ds` prefixes:
 *   product detail   aliexpress.ds.product.get
 *   image search     aliexpress.ds.image.search
 *   feed browse      aliexpress.ds.recommend.feed.get
 *   keyword search   aliexpress.affiliate.product.query   (needs a tracking id)
 *   freight quote    aliexpress.ds.freight.query
 *   place order      aliexpress.ds.order.create
 *   order detail     aliexpress.trade.ds.order.get
 *   tracking         aliexpress.ds.order.tracking.get
 *   register store   aliexpress.ds.add.info
 *
 * Order creation takes `sku_attr` ("14:350853#Black;5:361386"), while freight
 * quotes take the numeric `sku_id`. Sending the wrong one is the single most
 * common cause of rejected orders, so both are carried through the mapping.
 */

type Json = Record<string, unknown>;

/**
 * TOP request signature: HMAC-SHA256 over the parameters sorted by key and
 * concatenated as `key + value`, uppercase hex.
 *
 * `pathPrefix` is prepended for the REST gateway, where the API path is part of
 * the signed string and `method` is not among the parameters.
 *
 * Exported and pure so it can be pinned by a test: every live call fails if this
 * is wrong by one character, and nothing else in the app would notice.
 */
export function signTopParams(secret: string, params: Record<string, string>, pathPrefix = ""): string {
  const base =
    pathPrefix +
    Object.keys(params)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => `${k}${params[k]}`)
      .join("");
  return crypto.createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

/** Upstream order_status → our lifecycle. */
const ORDER_STATUS_MAP: Record<string, SupplierOrderState> = {
  PLACE_ORDER_SUCCESS: "AWAITING_PAYMENT",
  WAIT_BUYER_PAY: "AWAITING_PAYMENT",
  // RISK_CONTROL starts 24 hours AFTER the buyer's payment completes, so it is
  // a paid state. Reading it as unpaid asks the merchant to pay a second time.
  RISK_CONTROL: "PAID",
  WAIT_SELLER_EXAMINE_MONEY: "PAID",
  FUND_PROCESSING: "PAID",
  IN_FROZEN: "PAID",
  WAIT_SELLER_SEND_GOODS: "PAID",
  // AliExpress spells the partial-shipment status both ways.
  SELLER_PART_SEND_GOODS: "SHIPPED",
  SELLER_SEND_PART_GOODS: "SHIPPED",
  WAIT_BUYER_ACCEPT_GOODS: "SHIPPED",
  IN_ISSUE: "SHIPPED",
  FINISH: "DELIVERED",
  FIN: "DELIVERED",
  IN_CANCEL: "CANCELED",
  CANCEL: "CANCELED",
  CLOSED: "CANCELED",
  ORDER_CANCEL: "CANCELED",
};

/** `logistics_status` values that mean at least one parcel has left the seller. */
const SHIPPED_LOGISTICS_STATUSES = new Set([
  "SELLER_SEND_GOODS",
  "SELLER_SEND_PART_GOODS",
  "SELLER_PART_SEND_GOODS",
  "BUYER_ACCEPT_GOODS",
]);

/** Documented `error_code` values from order creation, mapped to advice. */
const ORDER_ERROR_HINTS: Record<string, string> = {
  B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL:
    "AliExpress rejected the shipping address. Check the province, postal code and phone, and any customs id the destination requires.",
  BLACKLIST_BUYER_IN_LIST: "This AliExpress account is blocked from ordering. Contact AliExpress support.",
  USER_ACCOUNT_DISABLED: "The connected AliExpress account is disabled. Reconnect it under Suppliers.",
  PRICE_PAY_CURRENCY_ERROR: "The payment currency is not accepted for this order. Set the supplier currency to USD in Settings → Currency.",
  DELIVERY_METHOD_NOT_EXIST: "The chosen shipping method is no longer offered for this destination. Adjust your shipping preferences.",
  INVENTORY_HOLD_ERROR: "The supplier ran out of stock for this SKU while the order was being placed.",
  REPEATED_ORDER_ERROR: "AliExpress treated this as a duplicate order. Check your AliExpress order list before retrying.",
  ERROR_WHEN_BUILD_FOR_PLACE_ORDER: "AliExpress could not build the order, usually a bad SKU or quantity. Re-map the variant and retry.",
  A001_ORDER_CANNOT_BE_PLACED: "AliExpress declined the order. Try again later or order manually.",
  A002_INVALID_ZONE: "AliExpress does not ship this item to that region.",
  A003_SUSPICIOUS_BUYER: "AliExpress flagged the buying account. Log in to AliExpress and resolve the alert.",
  A004_CANNOT_USER_COUPON: "The coupon or promotion could not be applied.",
  A005_INVALID_COUNTRIES: "The destination country is not supported for this product.",
  A006_INVALID_ACCOUNT_INFO: "The AliExpress account information is incomplete. Complete your AliExpress profile.",
};

/**
 * Codes that mean the merchant must reconnect.
 *
 * The api-sg gateway answers with string identifiers (`InvalidCode`,
 * `InsufficientPermission`, …), not the small integers the legacy Taobao TOP
 * router used, so both are matched and the message is a last resort.
 */
const AUTH_ERROR_CODES = new Set(["15", "25", "26", "27", "40", "41", "42", "43"]);

function isAuthFailure(code: string, message: string): boolean {
  if (AUTH_ERROR_CODES.has(code)) return true;
  if (/token|session|auth|permission|InvalidCode|AppCallLimit/i.test(code)) return true;
  return /session|token|auth|expire|permission/i.test(message);
}

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
  private readonly syncBase: string;
  private readonly restBase: string;
  private readonly redirectUri: string;
  private readonly trackingId: string | undefined;
  private readonly session: string | null;

  constructor(private readonly credentials: SupplierCredentials = {}) {
    const config = env();
    this.appKey = config.ALIEXPRESS_APP_KEY ?? "";
    this.appSecret = config.ALIEXPRESS_APP_SECRET ?? "";
    this.syncBase = config.ALIEXPRESS_API_BASE.replace(/\/(sync|rest)\/?$/, "") + "/sync";
    this.restBase = config.ALIEXPRESS_API_BASE.replace(/\/(sync|rest)\/?$/, "") + "/rest";
    this.redirectUri =
      config.ALIEXPRESS_REDIRECT_URI ?? `${config.SHOPIFY_APP_URL}/app/suppliers/callback/aliexpress`;
    this.trackingId = config.ALIEXPRESS_TRACKING_ID || undefined;
    this.session = credentials.accessToken ?? null;
  }

  isConfigured() {
    return Boolean(this.appKey && this.appSecret);
  }

  hasSession() {
    return Boolean(this.session);
  }

  // ---------------------------------------------------------------------------
  // Signing & transport
  // ---------------------------------------------------------------------------

  /**
   * HMAC-SHA256 over sorted `key+value` pairs. When `pathPrefix` is given (REST
   * gateway) it is prepended and `method` must not be in `params`.
   */
  private sign(params: Record<string, string>, pathPrefix = ""): string {
    return signTopParams(this.appSecret, params, pathPrefix);
  }

  private systemParams(method: string): Record<string, string> {
    return {
      app_key: this.appKey,
      method,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      format: "json",
      v: "2.0",
      ...(this.session ? { session: this.session } : {}),
    };
  }

  /** Call a TOP-gateway (`aliexpress.*`) method and return the unwrapped payload. */
  private async call<T = Json>(
    method: string,
    params: Record<string, string | number | undefined | null>,
    options: { requireSession?: boolean; idempotent?: boolean } = {},
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new SupplierError("SUPPLIER_NOT_CONFIGURED", "AliExpress app key and secret are not configured on the server.");
    }
    if (options.requireSession !== false && !this.session) {
      throw new SupplierError("SUPPLIER_NOT_AUTHORIZED", "Connect your AliExpress account first (Suppliers → AliExpress).");
    }

    const form = this.systemParams(method);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      form[key] = String(value);
    }
    form.sign = this.sign(form);

    const body = await httpJson<Json>(this.syncBase, {
      method: "POST",
      form,
      timeoutMs: 30_000,
      // Reads retry; anything that creates or cancels an order does not, or a
      // timed-out order would be placed a second time by the transport itself.
      ...(options.idempotent === false ? { idempotent: false } : { retries: 2 }),
    });
    return this.unwrap<T>(body, method);
  }

  /**
   * Peel the gateway envelope.
   *
   * Responses look like `{"<method_with_underscores>_response": {...}}`, but the
   * key does not always follow the method name (order creation answers under
   * `aliexpress_trade_buy_placeorder_response`), so any `*_response` key is
   * accepted. Errors arrive as `error_response` or as a non-200 `resp_code` /
   * `rsp_code` inside the envelope.
   */
  private unwrap<T>(body: Json, method: string): T {
    // The api-sg gateway reports signing, timestamp, permission and parameter
    // failures as a TOP-LEVEL {code, type, message, request_id} with HTTP 200
    // and no `error_response` wrapper. Without this branch such a response is
    // handed to the parsers as a perfectly successful empty payload, and the
    // merchant sees "no results" instead of "your app key is wrong".
    if (body.code !== undefined && !isSuccessCode(body.code) && body.request_id !== undefined) {
      const code = String(body.code);
      const message = String(body.message ?? "AliExpress API error");
      logger.warn("AliExpress gateway error", { method, code, type: body.type, message, requestId: body.request_id });
      throw new SupplierError(
        isAuthFailure(code, message) ? "SUPPLIER_NOT_AUTHORIZED" : "SUPPLIER_API",
        `${message} (${code})`,
        { retryable: /rate|limit|busy|timeout|frequen|ISP/i.test(`${code} ${message} ${body.type ?? ""}`), details: body },
      );
    }

    if (body.error_response) {
      const err = body.error_response as Json;
      const code = String(err.code ?? err.sub_code ?? "UNKNOWN");
      const message = String(err.sub_msg ?? err.msg ?? "AliExpress API error");
      const retryable = /rate|limit|busy|timeout|frequen/i.test(message);
      const isAuth = isAuthFailure(code, message);
      logger.warn("AliExpress API error", { method, code, message, requestId: err.request_id });
      throw new SupplierError(isAuth ? "SUPPLIER_NOT_AUTHORIZED" : "SUPPLIER_API", `${message} (${code})`, {
        retryable,
        details: err,
      });
    }

    const expected = `${method.replace(/\./g, "_")}_response`;
    const key =
      (expected in body && expected) ||
      Object.keys(body).find((k) => k.endsWith("_response")) ||
      null;
    let node: Json = key ? ((body[key] ?? {}) as Json) : body;

    // Affiliate-style envelopes nest one more level and carry their own code.
    if (node.resp_result && typeof node.resp_result === "object") {
      const resp = node.resp_result as Json;
      const code = Number(resp.resp_code ?? 200);
      if (code && code !== 200) {
        throw new SupplierError("SUPPLIER_API", String(resp.resp_msg ?? `AliExpress returned ${code}`), { details: resp });
      }
      node = resp;
    }
    // Business methods carry their own result code, spelled `rsp_code`,
    // `resp_code` or plain `code` depending on the method, and success is any of
    // 0 / "0" / "00" / 200.
    const rspCode = node.rsp_code ?? node.resp_code ?? node.code;
    if (rspCode !== undefined && !isSuccessCode(rspCode)) {
      throw new SupplierError("SUPPLIER_API", String(node.rsp_msg ?? node.resp_msg ?? node.msg ?? `AliExpress returned ${rspCode}`), {
        details: node,
      });
    }
    // Some DS methods report failure inside `result` instead. The `ret` shape is
    // deliberately excluded: `aliexpress.ds.order.tracking.get` answers a
    // not-yet-shipped order with `{ret:false, code:"1001", msg:"TRACKING DATA
    // NOT FOUND"}`, which is a normal state its caller reads, not an error.
    const inner = node.result as Json | undefined;
    if (inner && typeof inner === "object" && inner.ret === undefined) {
      const innerCode = inner.code;
      if (inner.success === false || (innerCode !== undefined && !isSuccessCode(innerCode))) {
        throw new SupplierError("SUPPLIER_API", String(inner.msg ?? inner.message ?? `AliExpress returned ${innerCode}`), {
          details: inner,
        });
      }
    }
    return node as T;
  }

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  getAuthorizationUrl(state: string): string {
    const url = new URL(`${env().ALIEXPRESS_AUTH_BASE.replace(/\/$/, "")}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("force_auth", "true");
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("client_id", this.appKey);
    url.searchParams.set("state", state);
    url.searchParams.set("sp", "ae");
    return url.toString();
  }

  private async tokenCall(path: "/auth/token/create" | "/auth/token/refresh", extra: Record<string, string>): Promise<SupplierTokens> {
    if (!this.isConfigured()) {
      throw new SupplierError("SUPPLIER_NOT_CONFIGURED", "AliExpress app key and secret are not configured on the server.");
    }
    const params: Record<string, string> = {
      app_key: this.appKey,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      ...extra,
    };
    params.sign = this.sign(params, path);

    const body = await httpJson<Json>(`${this.restBase}${path}`, { method: "POST", form: params, retries: 1 });
    if (!body.access_token) {
      const message = String(body.error_msg ?? body.message ?? body.error_description ?? "Token exchange failed");
      throw new SupplierError("SUPPLIER_OAUTH", message, { details: body });
    }
    const expiresIn = Number(body.expires_in ?? 0);
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : null,
      // expires_in is seconds on this gateway; guard against a ms value.
      expiresAt: expiresIn ? new Date(Date.now() + (expiresIn > 10_000_000 ? expiresIn : expiresIn * 1000)) : null,
      externalUserId: body.user_id ? String(body.user_id) : body.seller_id ? String(body.seller_id) : null,
      meta: {
        account: body.account ?? null,
        accountPlatform: body.account_platform ?? null,
        sellerId: body.seller_id ?? null,
        refreshExpiresIn: body.refresh_expires_in ?? null,
        havanaId: body.havana_id ?? null,
      },
    };
  }

  exchangeCode(code: string) {
    return this.tokenCall("/auth/token/create", { code });
  }

  refreshTokens(refreshToken: string) {
    return this.tokenCall("/auth/token/refresh", { refresh_token: refreshToken });
  }

  /**
   * Register the store with the dropshipping programme. AliExpress requires this
   * once per authorised account before DS order APIs are enabled.
   */
  async registerStore(storeUrl: string): Promise<boolean> {
    const data = await this.call<Json>("aliexpress.ds.add.info", {
      param0: JSON.stringify({ store_url: storeUrl, extend_info: { platform: "shopify" } }),
    });
    return Boolean(data.result ?? true);
  }

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  parseProductReference(input: string): string | null {
    const trimmed = input.trim();
    const patterns = [
      /aliexpress\.[a-z.]+\/item\/(?:[\w-]+\/)?(\d{6,})/i,
      /aliexpress\.[a-z.]+\/i\/(\d{6,})/i,
      /\/p\/[\w-]+\/(\d{6,})/i,
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
    if (params.imageUrl) return this.searchByImage(params.imageUrl, params);

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, params.pageSize ?? 20);

    // Keyword search lives on the affiliate surface and needs a tracking id.
    if (params.query.trim() && this.trackingId) {
      const data = await this.call<Json>("aliexpress.affiliate.product.query", {
        keywords: params.query,
        page_no: page,
        page_size: pageSize,
        target_currency: "USD",
        target_language: "EN",
        tracking_id: this.trackingId,
        ship_to_country: params.shipToCountry ?? "US",
        category_ids: params.categoryId,
        min_sale_price: params.minPrice !== undefined ? Math.round(params.minPrice * 100) : undefined,
        max_sale_price: params.maxPrice !== undefined ? Math.round(params.maxPrice * 100) : undefined,
        sort: affiliateSort(params.sort),
      });
      return this.normalizeAffiliatePage(data, page, pageSize);
    }

    // Without a keyword (or without a tracking id) fall back to the DS feed.
    const data = await this.call<Json>("aliexpress.ds.recommend.feed.get", {
      feed_name: params.categoryId ? undefined : "DS_Top_Selling",
      category_id: params.categoryId,
      page_no: page,
      page_size: pageSize,
      target_currency: "USD",
      target_language: "EN",
      country: params.shipToCountry ?? "US",
      sort: feedSort(params.sort),
    });
    const result = this.normalizeAffiliatePage(data, page, pageSize);
    if (params.query.trim()) {
      // The feed cannot filter by keyword upstream; narrow locally so the UI
      // still behaves, and tell the caller why the result set is small.
      const needle = params.query.trim().toLowerCase();
      result.items = result.items.filter((i) => i.title.toLowerCase().includes(needle));
      result.total = result.items.length;
      result.notice =
        "Keyword search needs an AliExpress affiliate tracking id (ALIEXPRESS_TRACKING_ID). Showing filtered feed results instead.";
    }
    return result;
  }

  private normalizeAffiliatePage(node: Json, page: number, pageSize: number): SupplierSearchResult {
    const result = (node.result ?? node.data ?? node) as Json;
    const products = asArray(result.products, "product") ?? asArray((result.products as Json)?.product, "product") ?? [];
    const total = Number(result.total_record_count ?? result.current_record_count ?? products.length) || null;
    return {
      items: products
        .map((p) => ({
          externalId: String(p.product_id ?? p.item_id ?? ""),
          title: String(p.product_title ?? p.item_title ?? ""),
          url: String(p.product_detail_url ?? `https://www.aliexpress.com/item/${p.product_id}.html`),
          image: (p.product_main_image_url as string) ?? null,
          price: money(p.target_sale_price ?? p.sale_price ?? 0),
          originalPrice: p.target_original_price ? money(p.target_original_price) : null,
          currency: String(p.target_sale_price_currency ?? p.sale_price_currency ?? "USD"),
          orderCount: Number(p.lastest_volume ?? 0) || null,
          rating: p.evaluate_rate ? Number(String(p.evaluate_rate).replace("%", "")) / 20 : null,
          storeName: (p.shop_name as string) ?? null,
          storeId: p.shop_id ? String(p.shop_id) : null,
          shipsFrom: ["CN"],
          shipToDays: p.ship_to_days ? String(p.ship_to_days) : null,
          promotionLink: (p.promotion_link as string) ?? null,
        }))
        .filter((i) => i.externalId),
      page,
      pageSize,
      total,
      hasMore: Boolean(result.total_page_no ? page < Number(result.total_page_no) : products.length === pageSize),
    };
  }

  private async searchByImage(imageUrl: string, params: SupplierSearchParams): Promise<SupplierSearchResult> {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new SupplierError("SUPPLIER_API", "Could not download that image to search with.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > 100 * 1024) {
      throw new SupplierError("SUPPLIER_API", "AliExpress image search accepts images up to 100 KB.");
    }
    const data = await this.call<Json>("aliexpress.ds.image.search", {
      image_file_bytes: buffer.toString("base64"),
      shpt_to: params.shipToCountry ?? "US",
      target_currency: "USD",
      target_language: "EN",
      product_cnt: Math.min(150, params.pageSize ?? 40),
      sort: imageSort(params.sort),
    });
    const page = this.normalizeAffiliatePage((data.data ?? data) as Json, 1, params.pageSize ?? 40);
    page.hasMore = false;
    return page;
  }

  async getProduct(externalId: string, options: { shipToCountry?: string; locale?: string } = {}): Promise<SupplierProductDetail | null> {
    const node = await this.call<Json>("aliexpress.ds.product.get", {
      product_id: externalId,
      ship_to_country: options.shipToCountry ?? "US",
      target_currency: "USD",
      target_language: (options.locale ?? "EN").toUpperCase(),
    });
    const result = (node.result ?? node) as Json;
    const base = (result.ae_item_base_info_dto ?? {}) as Json;
    if (!base.product_id && !base.subject) return null;

    const skuList = asArray(result.ae_item_sku_info_dtos, "ae_item_sku_info_d_t_o") ?? [];
    const media = (result.ae_multimedia_info_dto ?? {}) as Json;
    const store = (result.ae_store_info ?? {}) as Json;
    const pkg = (result.package_info_dto ?? {}) as Json;
    const logistics = (result.logistics_info_dto ?? {}) as Json;

    const optionNames: string[] = [];
    const variants: SupplierVariantDetail[] = skuList.map((sku) => {
      const props = asArray(sku.aeop_s_k_u_propertys ?? sku.ae_sku_property_dtos, "ae_sku_property_d_t_o") ?? [];
      const attributes = props.map((p) => {
        const name = String(p.sku_property_name ?? "Option");
        if (!optionNames.includes(name)) optionNames.push(name);
        return {
          name,
          value: String(p.property_value_definition_name ?? p.sku_property_value ?? ""),
          image: (p.sku_image as string) ?? null,
        };
      });
      const stock = Number(sku.sku_available_stock ?? sku.s_k_u_available_stock ?? sku.ipm_sku_stock ?? 0);
      const inStock = String(sku.sku_stock ?? "true") !== "false";
      return {
        // `sku_id` is the numeric id freight quotes take; `id` is a legacy field
        // that sometimes holds the attribute string instead, so it comes second.
        externalSkuId: String(sku.sku_id ?? sku.id ?? ""),
        // `sku_attr` is what order creation needs. When the response omits it,
        // it has to be rebuilt from the property ids — joining the human-readable
        // values ("Red;XL") produces a string AliExpress rejects.
        skuAttr: (sku.sku_attr as string) ?? skuAttrFromProperties(props),
        sku: (sku.sku_code as string) ?? null,
        attributes,
        image: attributes.find((a) => a.image)?.image ?? null,
        price: money(sku.offer_sale_price ?? sku.sku_price ?? 0),
        originalPrice: sku.sku_price ? money(sku.sku_price) : null,
        currency: String(sku.currency_code ?? base.currency_code ?? "USD"),
        stock,
        isAvailable: inStock && stock > 0,
        weightGrams: pkg.gross_weight ? Math.round(Number(pkg.gross_weight) * 1000) : null,
      };
    });

    const images = String(media.image_urls ?? "")
      .split(/[;,]/)
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
      orderCount: base.evaluation_count ? Number(base.evaluation_count) : null,
      categoryId: base.category_id ? String(base.category_id) : null,
      shipsFrom: logistics.ship_to_country ? ["CN"] : ["CN"],
      isAvailable: String(base.product_status_type ?? "onSelling") === "onSelling" && variants.some((v) => v.isAvailable),
      raw: result,
    };
  }

  /**
   * Freight quotes.
   *
   * The DS method is `aliexpress.ds.freight.query`, whose single business
   * parameter is `queryDeliveryReq` — a JSON string with **camelCase** keys, not
   * the snake_case DTO the legacy buyer-freight methods take. It has no
   * ship-from input: each returned option reports its own `ship_from_country`.
   *
   * The legacy `aliexpress.logistics.buyer.freight.calculate` shape is still
   * accepted here as a fallback, because the two differ in every field name and
   * an account provisioned before the DS migration can still answer that way.
   */
  async getShippingQuotes(params: ShippingQuoteParams): Promise<SupplierShippingQuote[]> {
    const node = await this.call<Json>("aliexpress.ds.freight.query", {
      queryDeliveryReq: JSON.stringify({
        productId: String(params.externalId),
        // Quantity goes over the wire as a string; a JSON number is rejected.
        quantity: String(Math.max(1, params.quantity)),
        shipToCountry: params.shipToCountry.toUpperCase(),
        // Freight takes the numeric sku id, unlike order creation.
        ...(params.externalSkuId ? { selectedSkuId: String(params.externalSkuId) } : {}),
        ...(params.province ? { provinceCode: params.province } : {}),
        language: "en_US",
        locale: "en_US",
        currency: "USD",
      }),
    });
    const result = (node.result ?? node) as Json;
    const options =
      asArray(result.delivery_options, "delivery_option_d_t_o") ??
      asArray(
        result.aeop_freight_calculate_result_for_buyer_d_t_o_list ?? result.aeop_freight_calculate_result_for_buyer_dtolist,
        "aeop_freight_calculate_result_for_buyer_dto",
      ) ??
      [];

    return options
      .map((o) => {
        const legacy = (o.freight ?? null) as Json | null;
        // `code` doubles as the `logistics_service_name` order creation needs,
        // so it has to win over the legacy spellings.
        const carrierCode = String(o.code ?? o.service_name ?? o.shipping_method ?? "");
        const carrierName = String(o.company ?? o.shipping_method ?? o.service_name ?? carrierCode);
        // `shipping_fee_cent` is misnamed: it is a decimal string in MAJOR units
        // ("13.57" alongside "13,57€"), and it is omitted entirely on free
        // options. Only the legacy `freight.cent` is really cents.
        const cost = hasValue(o.shipping_fee_cent)
          ? d(String(o.shipping_fee_cent))
          : hasValue(legacy?.cent)
            ? d(String(legacy!.cent)).dividedBy(100)
            : d(String(legacy?.amount ?? 0));
        const [fallbackMin, fallbackMax] = parseDeliveryWindow(String(o.estimated_delivery_time ?? ""));
        return {
          carrierCode,
          carrierName,
          cost: money(cost),
          currency: String(o.shipping_fee_currency ?? legacy?.currency_code ?? "USD").toUpperCase(),
          // There is no ship-from input, so the option's own origin is the only
          // truthful answer; echoing the caller's guess would invent data.
          shipFromCountry: String(o.ship_from_country ?? params.shipFromCountry ?? "CN").toUpperCase(),
          shipToCountry: params.shipToCountry.toUpperCase(),
          minDeliveryDays: toDays(o.min_delivery_days) ?? fallbackMin,
          maxDeliveryDays: toDays(o.max_delivery_days) ?? fallbackMax,
          // DS returns a real boolean `tracking`; the legacy field is the string
          // `tracking_available`.
          hasTracking: hasValue(o.tracking)
            ? o.tracking === true || String(o.tracking) === "true"
            : String(o.tracking_available ?? "true") === "true",
          isFreeShipping: o.free_shipping === true || String(o.free_shipping ?? "") === "true" || cost.isZero(),
        };
      })
      .filter((o) => o.carrierCode);
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const a = input.address;
    const missingSku = input.items.find((i) => !i.externalSkuAttr);
    if (missingSku) {
      throw new SupplierError(
        "SUPPLIER_ORDER_REJECTED",
        `The mapped SKU for product ${missingSku.externalProductId} has no AliExpress sku_attr. Re-import the supplier product so the app can read it, then retry.`,
      );
    }

    const country = a.countryCode.toUpperCase();
    const tax = a.taxNumber?.trim() || undefined;
    const payload = {
      logistics_address: {
        address: asciiAddress(a.address1),
        address2: asciiAddress(a.address2),
        city: asciiAddress(a.city),
        province: asciiAddress(a.province),
        zip: sanitizeZip(a.zip),
        country,
        contact_person: asciiAddress(a.name),
        full_name: asciiAddress(a.name),
        mobile_no: a.phone,
        phone_country: a.phoneCountryCode ?? "",
        locale: "en_US",
        // Destination-specific customs identifiers. AliExpress reads whichever
        // field matches the country, and each country has exactly one right slot:
        // `cpf` for Brazil, `rut_no` for Chile, `foreigner_passport_no` (paired
        // with `is_foreigner`) for Korea, `vat_no` for the EU/TR VAT countries.
        // `passport_no` is the Russia/CIS passport triple and is not Korea's.
        tax_number: tax,
        cpf: country === "BR" ? tax : undefined,
        rut_no: country === "CL" ? tax : undefined,
        foreigner_passport_no: country === "KR" ? tax : undefined,
        is_foreigner: country === "KR" && tax ? "true" : undefined,
        vat_no: ["IT", "ES", "TR"].includes(country) ? tax : undefined,
      },
      product_items: input.items.map((item) => ({
        product_id: Number(item.externalProductId),
        product_count: item.quantity,
        sku_attr: item.externalSkuAttr,
        logistics_service_name: item.carrierCode ?? undefined,
        order_memo: input.note ? asciiAddress(input.note) : undefined,
      })),
    };

    const extend: Json = {
      payment: {
        pay_currency: input.currency ?? "USD",
        // The merchant pays on aliexpress.com — see the Payments page. Asking
        // AliExpress to auto-pay would need a stored payment method and silently
        // charges the account, so it stays off.
        try_to_pay: "false",
      },
      // Our own reference for this purchase order. It is stable across retries,
      // so a retry after a lost response is recognisable as the same order
      // rather than placed a second time.
      out_order_id: input.reference,
      trade_extra_param: { business_model: "retail" },
      ...(this.trackingId ? { promotion: { promotion_channel_info: this.trackingId } } : {}),
    };

    const node = await this.call<Json>(
      "aliexpress.ds.order.create",
      {
        param_place_order_request4_open_api_d_t_o: JSON.stringify(payload),
        ds_extend_request: JSON.stringify(extend),
      },
      { idempotent: false },
    );

    const result = (node.result ?? node) as Json;
    if (String(result.is_success ?? "false") !== "true") {
      const code = String(result.error_code ?? "UNKNOWN");
      const hint = ORDER_ERROR_HINTS[code];
      throw new SupplierError("SUPPLIER_ORDER_REJECTED", hint ?? String(result.error_msg ?? `AliExpress rejected the order (${code})`), {
        details: result,
      });
    }

    const orderIds = extractOrderIds(result.order_list);
    const primary = orderIds[0];
    if (!primary) {
      throw new SupplierError("SUPPLIER_ORDER_REJECTED", "AliExpress accepted the order but returned no order id.", { details: result });
    }

    const status = await this.getOrder(primary).catch(() => null);
    return {
      externalOrderId: primary,
      externalOrderIds: orderIds,
      status: status?.status ?? "AWAITING_PAYMENT",
      itemsCost: status?.itemsCost ?? "0.00",
      shippingCost: status?.shippingCost ?? "0.00",
      totalCost: status?.totalCost ?? "0.00",
      currency: status?.currency ?? input.currency ?? "USD",
      paymentUrl: orderPaymentUrl(primary),
      // AliExpress cancels unpaid orders after 24 hours.
      paymentDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      raw: result,
    };
  }

  async getOrder(externalOrderId: string): Promise<SupplierOrderStatus | null> {
    const result = await this.fetchOrderDetail(externalOrderId);
    if (!result) return null;

    const amount = (result.order_amount ?? {}) as Json;
    const children = childOrders(result);
    const itemsCost = children.reduce((acc, child) => {
      const price = (child.product_price ?? {}) as Json;
      return acc.plus(d(price.amount ?? 0).times(Number(child.product_count ?? 1)));
    }, d(0));
    const total = d(amount.amount ?? 0);
    const orderStatus = String(result.order_status ?? "");
    let status = ORDER_STATUS_MAP[orderStatus] ?? "PLACED";
    const logisticsStatus = String(result.logistics_status ?? "");
    // A cancellation surfaces on the child order while the parent status can
    // still read as live, so the child wins.
    if (children.some((child) => String(child.end_reason ?? "").toUpperCase() === "CANCELED")) {
      status = "CANCELED";
    } else if (status === "PAID" && SHIPPED_LOGISTICS_STATUSES.has(logisticsStatus)) {
      // The order can be paid while its own status still says "waiting to send".
      status = "SHIPPED";
    }

    return {
      externalOrderId,
      status,
      itemsCost: itemsCost.isZero() ? null : money(itemsCost),
      shippingCost: itemsCost.isZero() || total.isZero() ? null : money(total.minus(itemsCost)),
      totalCost: total.isZero() ? null : money(total),
      currency: String(amount.currency_code ?? "USD"),
      // Undocumented on the DS order API and usually absent; read when present
      // rather than invented, so the stored date is either real or empty.
      paidAt: result.gmt_pay_time ? new Date(String(result.gmt_pay_time)) : null,
      // AliExpress exposes no ship timestamp here. Stamping "now" on every poll
      // would drift the date to whenever the sync ran, so the caller stamps it
      // once on the transition instead.
      shippedAt: null,
      paymentUrl: orderPaymentUrl(externalOrderId),
      raw: result,
    };
  }

  /**
   * `aliexpress.trade.ds.order.get` takes a single `single_order_query` DTO, not
   * a flat `order_id`, and answers with `aeop_`-prefixed wrapper keys.
   */
  private async fetchOrderDetail(externalOrderId: string): Promise<Json | null> {
    const node = await this.call<Json>("aliexpress.trade.ds.order.get", {
      single_order_query: JSON.stringify({ order_id: Number(externalOrderId) }),
    });
    const result = (node.result ?? node) as Json;
    if (!result.order_status && !result.gmt_create) return null;
    return result;
  }

  /**
   * Tracking is a two-step read: the order detail carries the tracking numbers
   * and the service code, then `aliexpress.ds.order.tracking.get` adds the
   * carrier's display name and the event history.
   *
   * The two sources disagree often enough that both are read: the order can
   * already carry a `logistics_no` while the tracking API still answers
   * "TRACKING DATA NOT FOUND", and the tracking API can carry a `mail_no` the
   * order has not picked up yet.
   */
  async getTracking(externalOrderId: string): Promise<SupplierTracking[]> {
    const result = await this.fetchOrderDetail(externalOrderId);
    const shipments = result ? logisticsLegs(result) : [];
    const events = await this.fetchTrackingLines(externalOrderId);

    const byNumber = new Map<string, SupplierTracking>();
    for (const shipment of shipments) {
      const number = String(shipment.logistics_no ?? "");
      if (!number) continue;
      const serviceCode = String(shipment.logistics_service ?? "") || null;
      byNumber.set(number, {
        number,
        carrierCode: serviceCode,
        // Replaced below by the carrier's real name when tracking has one; the
        // service code is a placeholder, not a label to show a customer.
        carrierName: serviceCode,
        url: cainiaoTrackingUrl(number),
        status: null,
        lastEvent: null,
        lastEventAt: null,
      });
    }

    for (const line of events) {
      const number = String(line.mail_no ?? "");
      // A line with no mail_no yet still describes the order's only shipment, so
      // its events are attached to that one rather than dropped.
      const target = number ? byNumber.get(number) : byNumber.size === 1 ? [...byNumber.values()][0] : undefined;
      const nodes = asArray(line.detail_node_list, "detail_node") ?? [];
      // The DS tracking nodes come back newest first.
      const latest = nodes[0];
      const carrierName = String(line.carrier_name ?? "") || null;
      const entry: SupplierTracking = target ?? {
        number,
        carrierCode: null,
        carrierName,
        url: cainiaoTrackingUrl(number),
        status: null,
        lastEvent: null,
        lastEventAt: null,
      };
      if (carrierName) entry.carrierName = carrierName;
      if (latest) {
        entry.lastEvent = String(latest.tracking_detail_desc ?? "") || null;
        entry.status = String(latest.tracking_name ?? "") || null;
        entry.lastEventAt = epochMillis(latest.time_stamp);
      }
      if (!target && number) byNumber.set(number, entry);
    }

    return [...byNumber.values()];
  }

  /**
   * `aliexpress.ds.order.tracking.get` takes `ae_order_id` and a required
   * `language`; both names changed in a 2026 revision and the older spellings
   * fail silently. A not-yet-shipped order answers `ret:false` / code 1001,
   * which is a state, not an error.
   */
  private async fetchTrackingLines(externalOrderId: string): Promise<Json[]> {
    try {
      const node = await this.call<Json>("aliexpress.ds.order.tracking.get", {
        ae_order_id: Number(externalOrderId),
        language: "en_US",
      });
      const result = (node.result ?? node) as Json;
      if (result.ret === false || !result.data) return [];
      const data = result.data as Json;
      return asArray(data.tracking_detail_line_list, "tracking_detail") ?? [];
    } catch (error) {
      // The numbers from the order detail are still worth syncing to Shopify.
      logger.debug("AliExpress tracking detail unavailable", { externalOrderId, error });
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Where the merchant pays a specific unpaid AliExpress order. */
export function orderPaymentUrl(orderId: string): string {
  return `https://www.aliexpress.com/p/order/detail.html?orderId=${encodeURIComponent(orderId)}`;
}

/**
 * The merchant's order list, for paying several orders in one visit. The page
 * filters by tab click, not by query string, so it opens on "All orders" — any
 * `?orderStatus=` parameter is silently ignored.
 */
export const ALIEXPRESS_UNPAID_ORDERS_URL = "https://www.aliexpress.com/p/order/index.html";

/** Public carrier-agnostic tracking page, used when AliExpress gives no link. */
function cainiaoTrackingUrl(number: string): string {
  return `https://global.cainiao.com/detail.htm?mailNoList=${encodeURIComponent(number)}`;
}

/**
 * `aliexpress.trade.ds.order.get` wraps its lists under `aeop_`-prefixed keys;
 * the newer `aliexpress.ds.trade.order.get` uses `ae_`. The gateway aliases one
 * onto the other, so both spellings are accepted.
 */
function childOrders(result: Json): Json[] {
  return (
    asArray(result.child_order_list, "aeop_child_order_info") ??
    asArray(result.child_order_list, "ae_child_order_info") ??
    []
  );
}

function logisticsLegs(result: Json): Json[] {
  return (
    asArray(result.logistics_info_list, "aeop_order_logistics_info") ??
    asArray(result.logistics_info_list, "ae_order_logistics_info") ??
    []
  );
}

/** Tracking timestamps are epoch milliseconds, as a JSON number or a string. */
function epochMillis(value: unknown): Date | null {
  if (!hasValue(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n);
}

/**
 * Rebuild `sku_attr` from the SKU's properties when the response omits it.
 *
 * The wire format is `propertyId:valueId` pairs joined by `;`. Joining the
 * human-readable values instead yields "Red;XL", which AliExpress rejects with
 * SKU_NOT_EXIST — so a pair with no value id makes the whole string unusable
 * and the caller is better off with nothing.
 */
function skuAttrFromProperties(props: Json[]): string | null {
  if (props.length === 0) return null;
  const pairs: string[] = [];
  for (const p of props) {
    const propertyId = p.sku_property_id;
    const valueId = p.property_value_id ?? p.property_value_id_long;
    if (!hasValue(propertyId) || !hasValue(valueId)) return null;
    pairs.push(`${propertyId}:${valueId}`);
  }
  return pairs.join(";");
}

/**
 * AliExpress validates addresses against a Latin-1 character set and rejects
 * spaced postal codes, so accents are folded and non-ASCII dropped before the
 * address is submitted. An address that reduces to nothing is left as-is, so
 * the failure comes back from AliExpress rather than from an empty field.
 */
function asciiAddress(value: string | null | undefined): string {
  if (!value) return "";
  const folded = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return folded || value.trim();
}

/** Postal codes go over the wire without separators ("184 36" → "18436"). */
function sanitizeZip(value: string | null | undefined): string {
  return value ? value.replace(/[\s-]/g, "").trim() : "";
}

/** Present and meaningful — `0` and `false` count, `""`/null/undefined do not. */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** A day count that AliExpress may send as a number or a numeric string. */
function toDays(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** AliExpress spells success as 0, "0", "00" or 200 depending on the surface. */
function isSuccessCode(value: unknown): boolean {
  const text = String(value);
  return text === "0" || text === "00" || text === "200";
}

/**
 * The gateway wraps arrays as `{ key: [...] }`, sometimes flattens a single
 * element to an object, and sometimes returns the array directly.
 */
function asArray(container: unknown, key: string): Json[] | null {
  if (container === null || container === undefined) return null;
  if (Array.isArray(container)) return container.filter((n) => n && typeof n === "object") as Json[];
  if (typeof container !== "object") return null;
  const node = (container as Json)[key];
  if (Array.isArray(node)) return node.filter((n) => n && typeof n === "object") as Json[];
  if (node && typeof node === "object") return [node as Json];
  // A wrapper object with a single value under an unexpected key still counts —
  // AliExpress renames these wrappers between methods and versions, and the
  // single-object form (one child order, one logistics leg) is the common case.
  const values = Object.values(container as Json);
  if (values.length === 1 && Array.isArray(values[0])) {
    return (values[0] as unknown[]).filter((n) => n && typeof n === "object") as Json[];
  }
  if (values.length === 1 && values[0] && typeof values[0] === "object") {
    return [values[0] as Json];
  }
  return [];
}

/** `order_list` is `number[]`, `{ number: [...] }`, or a single value. */
function extractOrderIds(orderList: unknown): string[] {
  if (orderList === null || orderList === undefined) return [];
  if (Array.isArray(orderList)) return orderList.map(String).filter(Boolean);
  if (typeof orderList === "object") {
    const values = Object.values(orderList as Json).flat();
    return values.map(String).filter((v) => v && v !== "undefined");
  }
  return [String(orderList)];
}

/** "5-9 days" / "7" / "10-20" → [min, max]. */
function parseDeliveryWindow(text: string): [number | null, number | null] {
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length === 0) return [null, null];
  if (numbers.length === 1) return [Number(numbers[0]), Number(numbers[0])];
  return [Number(numbers[0]), Number(numbers[1])];
}

function affiliateSort(sort: SupplierSearchParams["sort"]): string | undefined {
  switch (sort) {
    case "orders":
      return "LAST_VOLUME_DESC";
    case "price_asc":
      return "SALE_PRICE_ASC";
    case "price_desc":
      return "SALE_PRICE_DESC";
    default:
      return undefined;
  }
}

function feedSort(sort: SupplierSearchParams["sort"]): string | undefined {
  switch (sort) {
    case "orders":
      return "volumeDesc";
    case "price_asc":
      return "priceAsc";
    case "price_desc":
      return "priceDesc";
    case "rating":
      return "ratingDesc";
    default:
      return undefined;
  }
}

function imageSort(sort: SupplierSearchParams["sort"]): string | undefined {
  switch (sort) {
    case "orders":
      return "LAST_VOLUME_DESC";
    case "price_asc":
      return "SALE_PRICE_ASC";
    case "price_desc":
      return "SALE_PRICE_DESC";
    default:
      return undefined;
  }
}
