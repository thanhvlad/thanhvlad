/**
 * Copy the lifecycle screens depend on.
 *
 * The billing module was written but never spread into the dictionary, so the
 * Plan and Stores screens carried their own lookup helper, and any other screen
 * asking for a billing key got undefined. The supplier copy described a demo
 * driver in environment-variable terms and promised automatic ordering the app
 * does not do; it must describe ordering the one way it actually works.
 */
import { describe, expect, it } from "vitest";
import { makeT, translate, type I18nKey } from "~/lib/i18n";
import * as billing from "~/lib/i18n-modules/billing";

const PLACEMENT_EN =
  "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.";

describe("lifecycle copy", () => {
  it("serves every billing key through the shared dictionary, in both languages", () => {
    const en = makeT("en");
    const vi = makeT("vi");
    for (const key of Object.keys(billing.en) as I18nKey[]) {
      expect(en(key)).toBe(billing.en[key as keyof typeof billing.en]);
      expect(vi(key)).toBeTruthy();
    }
    expect(vi("billing.plan.trialUsed")).toBe(billing.vi["billing.plan.trialUsed"]);
    expect(en("billing.plan.aiRewrites", { n: 20 })).toBe("20 AI product page rewrites a month");
  });

  it("describes AliExpress ordering the way it works, never as the extension ordering by itself", () => {
    const body = translate("en", "suppliers.mockMode.body");
    expect(body).toContain(PLACEMENT_EN);
    expect(body).not.toMatch(/SUPPLIER_DRIVER|orders complete automatically/);
    expect(translate("en", "suppliers.extension.body")).toContain(PLACEMENT_EN);
    expect(translate("vi", "suppliers.mockMode.body")).toContain("Bạn tự đặt và thanh toán đơn ở đó");
    // Where the extension comes from while it is not in the Chrome Web Store.
    expect(translate("en", "suppliers.extension.step1")).toMatch(/app owner.*Load unpacked/);
    expect(translate("vi", "suppliers.extension.step1")).toContain("chủ ứng dụng");
  });

  it("no longer carries the fulfilment step that claimed the app places supplier orders on accept", () => {
    expect(translate("en", "settings.fulfillmentService.how.step3" as I18nKey)).toBeUndefined();
  });
});
