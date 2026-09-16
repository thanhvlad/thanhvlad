/**
 * The AliExpress wire format.
 *
 * Every field name below is one AliExpress renamed between API generations, and
 * getting one wrong is invisible from inside the app: the gateway answers HTTP
 * 200 and the adapter parses an empty result, so the merchant sees "no shipping
 * options" or "no tracking" rather than an error. The payloads here are the
 * shapes the live DS gateway returns, so a rename is caught here instead of by
 * a merchant whose orders stop shipping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AliExpressAdapter } from "~/services/suppliers/aliexpress.server";
import { SupplierError } from "~/lib/errors";

// The adapter reads the environment when it is constructed, which happens inside
// the tests below — long after this module has finished evaluating.
process.env.ALIEXPRESS_APP_KEY = "12345";
process.env.ALIEXPRESS_APP_SECRET = "topsecret";

interface Capture {
  url: string;
  form: URLSearchParams;
}

let captured: Capture[] = [];

/** Answer every call with `bodies` in order, recording what was sent. */
function stubGateway(...bodies: unknown[]) {
  let index = 0;
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    captured.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const adapter = () => new AliExpressAdapter({ accessToken: "session-token" });

beforeEach(() => {
  captured = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getShippingQuotes", () => {
  // Captured from the live DS gateway for a FR destination.
  const freightResponse = {
    aliexpress_ds_freight_query_response: {
      result: {
        msg: "Call succeeds",
        code: 200,
        success: true,
        delivery_options: {
          delivery_option_d_t_o: [
            {
              code: "CAINIAO_STANDARD",
              company: "AliExpress Selection Standard",
              free_shipping: true,
              tracking: true,
              min_delivery_days: 7,
              max_delivery_days: 14,
              guaranteed_delivery_days: "60",
              delivery_date_desc: "Sep. 25 - Oct. 02",
              ship_from_country: "CN",
            },
            {
              code: "CAINIAO_PREMIUM",
              company: "AliExpress Premium Shipping",
              free_shipping: false,
              tracking: true,
              shipping_fee_cent: "13.57",
              shipping_fee_format: "13,57€",
              shipping_fee_currency: "EUR",
              min_delivery_days: 5,
              max_delivery_days: 9,
              ship_from_country: "ES",
            },
          ],
        },
      },
    },
  };

  it("calls aliexpress.ds.freight.query with a camelCase queryDeliveryReq", async () => {
    stubGateway(freightResponse);
    await adapter().getShippingQuotes({
      externalId: "1005006001",
      externalSkuId: "12000036083778130",
      quantity: 2,
      shipToCountry: "fr",
      province: "Ile-de-France",
    });

    const form = captured[0].form;
    expect(form.get("method")).toBe("aliexpress.ds.freight.query");
    expect(form.get("session")).toBe("session-token");
    expect(JSON.parse(form.get("queryDeliveryReq")!)).toEqual({
      productId: "1005006001",
      // A JSON number here is rejected by the gateway.
      quantity: "2",
      shipToCountry: "FR",
      selectedSkuId: "12000036083778130",
      provinceCode: "Ile-de-France",
      language: "en_US",
      locale: "en_US",
      currency: "USD",
    });
    // The DS method has no ship-from input, unlike the legacy DTO.
    expect(form.get("queryDeliveryReq")).not.toContain("sendGoodsCountryCode");
  });

  it("reads shipping_fee_cent as major units, not cents", async () => {
    stubGateway(freightResponse);
    const quotes = await adapter().getShippingQuotes({ externalId: "1005006001", quantity: 1, shipToCountry: "FR" });

    expect(quotes).toHaveLength(2);
    const [free, premium] = quotes;
    // `shipping_fee_cent` is absent entirely on a free option.
    expect(free).toMatchObject({
      carrierCode: "CAINIAO_STANDARD",
      carrierName: "AliExpress Selection Standard",
      cost: "0.00",
      isFreeShipping: true,
      hasTracking: true,
      minDeliveryDays: 7,
      maxDeliveryDays: 14,
      shipFromCountry: "CN",
      shipToCountry: "FR",
    });
    // "13.57" is 13.57, not 0.14 — the field name lies.
    expect(premium.cost).toBe("13.57");
    expect(premium.currency).toBe("EUR");
    expect(premium.isFreeShipping).toBe(false);
    // Each option reports its own origin; the caller's guess is not echoed back.
    expect(premium.shipFromCountry).toBe("ES");
  });

  it("still parses the legacy buyer-freight shape", async () => {
    stubGateway({
      aliexpress_ds_freight_query_response: {
        result: {
          aeop_freight_calculate_result_for_buyer_d_t_o_list: {
            aeop_freight_calculate_result_for_buyer_dto: [
              {
                service_name: "EMS",
                shipping_method: "EMS Express",
                estimated_delivery_time: "12-20 days",
                tracking_available: "true",
                freight: { cent: 1999, currency_code: "USD" },
              },
            ],
          },
        },
      },
    });
    const quotes = await adapter().getShippingQuotes({ externalId: "1005006001", quantity: 1, shipToCountry: "US" });
    expect(quotes).toHaveLength(1);
    // The legacy `freight.cent` really is cents.
    expect(quotes[0]).toMatchObject({ carrierCode: "EMS", carrierName: "EMS Express", cost: "19.99", minDeliveryDays: 12, maxDeliveryDays: 20 });
  });

  it("surfaces a business failure instead of reporting no options", async () => {
    stubGateway({
      aliexpress_ds_freight_query_response: {
        result: { success: false, code: "500", msg: "DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS" },
      },
    });
    await expect(
      adapter().getShippingQuotes({ externalId: "1005006001", quantity: 1, shipToCountry: "CU" }),
    ).rejects.toThrow(SupplierError);
  });
});

describe("getOrder", () => {
  // Captured verbatim from a live order.
  const orderResponse = {
    aliexpress_trade_ds_order_get_response: {
      result: {
        child_order_list: {
          // One child order arrives as a bare object, not an array.
          aeop_child_order_info: {
            product_count: "2",
            product_id: "32963302422",
            product_price: { amount: "5.03", currency_code: "USD" },
          },
        },
        gmt_create: "2026-05-23 23:58:25",
        logistics_info_list: {
          aeop_order_logistics_info: { logistics_no: "4202530292748909900774583084888436", logistics_service: "CAINIAO_STANDARD" },
        },
        logistics_status: "SELLER_SEND_GOODS",
        order_amount: { amount: "12.06", currency_code: "USD" },
        order_status: "WAIT_BUYER_ACCEPT_GOODS",
      },
    },
  };

  it("queries with single_order_query, not a flat order_id", async () => {
    stubGateway(orderResponse);
    await adapter().getOrder("3000000001");
    const form = captured[0].form;
    expect(form.get("method")).toBe("aliexpress.trade.ds.order.get");
    expect(JSON.parse(form.get("single_order_query")!)).toEqual({ order_id: 3000000001 });
    expect(form.get("order_id")).toBeNull();
  });

  it("reads the aeop_-prefixed wrappers and does not invent a ship date", async () => {
    stubGateway(orderResponse);
    const order = await adapter().getOrder("3000000001");
    expect(order).toMatchObject({
      status: "SHIPPED",
      // 5.03 x 2 — proof the child order was found under aeop_child_order_info.
      itemsCost: "10.06",
      shippingCost: "2.00",
      totalCost: "12.06",
      currency: "USD",
      shippedAt: null,
    });
  });

  it("treats a paid order under risk control as paid", async () => {
    stubGateway({
      aliexpress_trade_ds_order_get_response: {
        result: { order_status: "RISK_CONTROL", logistics_status: "WAIT_SELLER_SEND_GOODS", gmt_create: "2026-05-23 23:58:25" },
      },
    });
    // Reading it as unpaid would prompt the merchant to pay a second time.
    expect((await adapter().getOrder("3000000001"))?.status).toBe("PAID");
  });

  it("lets a cancelled child order override a live parent status", async () => {
    stubGateway({
      aliexpress_trade_ds_order_get_response: {
        result: {
          order_status: "WAIT_SELLER_SEND_GOODS",
          gmt_create: "2026-05-23 23:58:25",
          child_order_list: { aeop_child_order_info: [{ end_reason: "CANCELED", product_price: { amount: "1.00" }, product_count: "1" }] },
        },
      },
    });
    expect((await adapter().getOrder("3000000001"))?.status).toBe("CANCELED");
  });
});

describe("getTracking", () => {
  const orderResponse = {
    aliexpress_trade_ds_order_get_response: {
      result: {
        gmt_create: "2026-05-23 23:58:25",
        order_status: "WAIT_BUYER_ACCEPT_GOODS",
        logistics_status: "SELLER_SEND_GOODS",
        logistics_info_list: { aeop_order_logistics_info: { logistics_no: "62727952231", logistics_service: "CAINIAO_STANDARD" } },
      },
    },
  };

  it("adds the carrier name and the newest event from ds.order.tracking.get", async () => {
    stubGateway(orderResponse, {
      aliexpress_ds_order_tracking_get_response: {
        result: {
          ret: true,
          code: "0",
          data: {
            tracking_detail_line_list: {
              tracking_detail: [
                {
                  mail_no: "62727952231",
                  carrier_name: "AliExpress Selection Standard",
                  detail_node_list: {
                    // Newest first, and the timestamps are epoch milliseconds.
                    detail_node: [
                      { time_stamp: 1770194210868, tracking_detail_desc: "Your package is currently being prepared.", tracking_name: "IN_TRANSIT" },
                      { time_stamp: "1770192487065", tracking_detail_desc: "Your order has been successfully created", tracking_name: "CREATED" },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const tracking = await adapter().getTracking("3000000001");
    expect(captured[1].form.get("method")).toBe("aliexpress.ds.order.tracking.get");
    // Both params were renamed in 2026; the old spellings fail silently.
    expect(captured[1].form.get("ae_order_id")).toBe("3000000001");
    expect(captured[1].form.get("language")).toBe("en_US");

    expect(tracking).toHaveLength(1);
    expect(tracking[0]).toMatchObject({
      number: "62727952231",
      carrierCode: "CAINIAO_STANDARD",
      carrierName: "AliExpress Selection Standard",
      lastEvent: "Your package is currently being prepared.",
      status: "IN_TRANSIT",
    });
    expect(tracking[0].lastEventAt?.getTime()).toBe(1770194210868);
  });

  it("keeps the number when tracking data does not exist yet", async () => {
    // ret:false / 1001 is a not-yet-shipped state, not an error.
    stubGateway(orderResponse, {
      aliexpress_ds_order_tracking_get_response: { result: { ret: false, msg: "TRACKING DATA NOT FOUND", code: "1001" } },
    });
    const tracking = await adapter().getTracking("3000000001");
    expect(tracking).toHaveLength(1);
    expect(tracking[0]).toMatchObject({ number: "62727952231", lastEvent: null, carrierName: "CAINIAO_STANDARD" });
  });
});

describe("unwrap", () => {
  it("raises a top-level gateway error instead of parsing an empty payload", async () => {
    stubGateway({ code: "15", type: "ISP", message: "Remote service error", request_id: "abc123" });
    await expect(adapter().getOrder("3000000001")).rejects.toMatchObject({ code: "SUPPLIER_NOT_AUTHORIZED" });
  });

  it("marks a call-frequency rejection retryable", async () => {
    stubGateway({ error_response: { code: "ApiCallLimit", msg: "Api access frequency exceeds the limit", request_id: "abc124" } });
    await expect(adapter().getOrder("3000000001")).rejects.toMatchObject({ retryable: true });
  });
});
