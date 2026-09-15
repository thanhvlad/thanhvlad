/**
 * The checkout assist's pure logic (extension/checkout-core.js), evaluated as
 * the extension loads it. Page facts under test come from
 * docs/ALIEXPRESS_PAGE_MODEL.md.
 */
import { describe, expect, it } from "vitest";
import { loadCheckoutCore } from "./load-core";

const core = loadCheckoutCore();

const GLOBAL_ID = "1005010026778896";
const US_ID = "3256809840464144";
const SKU_ID = "12000057945176350";
const SKU_ATTR = "14:691#Play blue light;200007763:201441035";

describe("product ids across regional hosts", () => {
  it("adds and removes 2^51 exactly, in BigInt", () => {
    expect(core.REGIONAL_OFFSET).toBe(2251799813685248n);
    expect(BigInt(GLOBAL_ID) + core.REGIONAL_OFFSET).toBe(BigInt(US_ID));
    expect(core.productIdForHost(GLOBAL_ID, "www.aliexpress.us")).toBe(US_ID);
    expect(core.productIdForHost(US_ID, "www.aliexpress.us")).toBe(US_ID);
    expect(core.productIdForHost(US_ID, "vi.aliexpress.com")).toBe(GLOBAL_ID);
    expect(core.productIdForHost(GLOBAL_ID, "www.aliexpress.com")).toBe(GLOBAL_ID);
    expect(core.globalProductId(US_ID)).toBe(GLOBAL_ID);
    expect(core.globalProductId(GLOBAL_ID)).toBe(GLOBAL_ID);
  });

  it("stays exact beyond what a double can hold", () => {
    const big = "9007199254740993"; // 2^53 + 1, which Number rounds to 2^53
    expect(core.globalProductId(big)).toBe((9007199254740993n - 2251799813685248n).toString());
    expect(core.productIdForHost("6755399441055745", "www.aliexpress.us")).toBe("6755399441055745");
  });

  it("refuses what is not an id", () => {
    expect(core.globalProductId("abc")).toBeNull();
    expect(core.globalProductId("")).toBeNull();
    expect(core.globalProductId(null)).toBeNull();
    expect(core.globalProductId("1".repeat(21))).toBeNull();
    expect(core.productIdForHost("x", "www.aliexpress.us")).toBeNull();
  });

  it("tells whether two ids are the same product", () => {
    expect(core.sameProduct(GLOBAL_ID, US_ID)).toBe(true);
    expect(core.sameProduct(US_ID, GLOBAL_ID)).toBe(true);
    expect(core.sameProduct(GLOBAL_ID, "1005010026778897")).toBe(false);
    expect(core.sameProduct("abc", "abc")).toBe(false);
    expect(core.sameProduct(null, null)).toBe(false);
  });

  it("opens products on the global host and recognises AliExpress pages only", () => {
    expect(core.productPageUrl(US_ID)).toBe(`https://www.aliexpress.com/item/${GLOBAL_ID}.html`);
    expect(core.productPageUrl("nope")).toBeNull();
    expect(core.isAliExpressHost("vi.aliexpress.com")).toBe(true);
    expect(core.isAliExpressHost("aliexpress.us")).toBe(true);
    expect(core.isAliExpressHost("aliexpress.com.evil.example")).toBe(false);
    expect(core.isUsHost("www.aliexpress.us")).toBe(true);
    expect(core.isUsHost("www.aliexpress.com")).toBe(false);
    expect(core.isProductPage(`https://www.aliexpress.us/item/${US_ID}.html?gatewayAdapt=glo2usa4itemAdapt`)).toBe(true);
    expect(core.isProductPage(`http://www.aliexpress.com/item/${GLOBAL_ID}.html`)).toBe(false);
    expect(core.isProductPage("https://www.aliexpress.com/p/trade/confirm.html")).toBe(false);
    expect(core.productIdFromUrl(`https://www.aliexpress.us/item/${US_ID}.html`)).toBe(US_ID);
    expect(core.productIdFromUrl("https://www.aliexpress.com/")).toBeNull();
    expect(core.productIdFromUrl("not a url")).toBeNull();
    expect(core.isConfirmPage("https://www.aliexpress.us/p/trade/confirm.html?objectId=1")).toBe(true);
    expect(core.isConfirmPage("https://evil.example/p/trade/confirm.html")).toBe(false);
    expect(core.isConfirmPage("https://www.aliexpress.com/p/order/index.html")).toBe(false);
  });
});

describe("the confirm page URL", () => {
  const input = { origin: "https://www.aliexpress.us", objectId: US_ID, skuId: SKU_ID, skuAttr: SKU_ATTR, quantity: 1, countryCode: "US", shippingCompany: "CAINIAO_FULFILLMENT_STD" };

  it("carries the parameters AliExpress's own navigation used, encoded", () => {
    expect(core.buildConfirmUrl(input)).toBe(
      `https://www.aliexpress.us/p/trade/confirm.html?objectId=${US_ID}&skuId=${SKU_ID}` +
        "&skuAttr=14%3A691%23Play%20blue%20light%3B200007763%3A201441035&quantity=1&countryCode=US" +
        "&shippingCompany=CAINIAO_FULFILLMENT_STD&provinceCode=&cityCode=&from=aliexpress&aeOrderFrom=main_detail",
    );
    const read = core.readConfirmUrl(core.buildConfirmUrl(input));
    expect(read).toEqual({ objectId: US_ID, skuId: SKU_ID, skuAttr: SKU_ATTR, quantity: "1", countryCode: "US", shippingCompany: "CAINIAO_FULFILLMENT_STD" });
  });

  it("leaves the carrier out when the purchase order has none", () => {
    const url = core.buildConfirmUrl({ ...input, shippingCompany: null });
    expect(url).not.toContain("shippingCompany");
    expect(url).toContain("&countryCode=US&provinceCode=");
  });

  it("builds nothing from values that do not validate", () => {
    expect(core.buildConfirmUrl({ ...input, origin: "http://www.aliexpress.us" })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, origin: "https://evil.example" })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, objectId: "12ab" })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, skuId: "" })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, quantity: 0 })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, quantity: 1.5 })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, countryCode: "us" })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, shippingCompany: "A B" })).toBeNull();
    expect(core.buildConfirmUrl({ ...input, skuAttr: "x".repeat(1001) })).toBeNull();
    expect(core.buildConfirmUrl(null)).toBeNull();
    expect(core.readConfirmUrl("::")).toBeNull();
  });

  it("names every way the page differs from the item", () => {
    const item = { externalProductId: GLOBAL_ID, externalSkuId: SKU_ID, quantity: 1 };
    const url = core.buildConfirmUrl(input);
    expect(core.confirmUrlMismatches(url, item, "US")).toEqual([]);
    expect(core.confirmUrlMismatches(url, { ...item, quantity: 2 }, "US")).toEqual(["The quantity on this page is 1, not 2."]);
    expect(core.confirmUrlMismatches(url, item, "CA")).toEqual(["The destination on this page is US, not CA."]);
    expect(core.confirmUrlMismatches(url, { ...item, externalSkuId: "1" }, "US")).toHaveLength(1);
    expect(core.confirmUrlMismatches(url, { ...item, externalProductId: "1" }, "US")).toHaveLength(1);
    expect(core.confirmUrlMismatches("https://www.aliexpress.us/p/trade/confirm.html", item, "US")).toHaveLength(4);
    expect(core.confirmUrlMismatches("nonsense", item, "US")).toEqual(["The page address could not be read."]);
  });
});

describe("skuAvailability", () => {
  const skus = [
    { skuId: SKU_ID, skuAttr: SKU_ATTR, availQuantity: 5, salable: true },
    { skuId: "2", skuAttr: "14:1", availQuantity: 0, salable: true },
    { skuId: "3", skuAttr: "14:2", availQuantity: 9, salable: false },
    { skuId: "4", skuAttr: "14:3", availQuantity: null, salable: true },
  ];

  it("returns the page's own skuAttr for an available SKU", () => {
    expect(core.skuAvailability(skus, SKU_ID, 2)).toEqual({ ok: true, skuAttr: SKU_ATTR });
    expect(core.skuAvailability(skus, "4", 50)).toEqual({ ok: true, skuAttr: "14:3" });
  });

  it("stops for a missing, sold-out or short SKU", () => {
    expect(core.skuAvailability(skus, "999", 1)).toEqual({ ok: false, reason: "missing" });
    expect(core.skuAvailability(skus, "2", 1)).toMatchObject({ ok: false, reason: "out-of-stock" });
    expect(core.skuAvailability(skus, "3", 1)).toMatchObject({ ok: false, reason: "out-of-stock" });
    expect(core.skuAvailability(skus, SKU_ID, 6)).toMatchObject({ ok: false, reason: "not-enough", available: 5 });
    expect(core.skuAvailability(null, SKU_ID, 1)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("order numbers", () => {
  it("parses what the merchant types with the server's rule", () => {
    expect(core.parseOrderNumbers(" 8190000000000001, 8190000000000002;8190000000000001 ")).toEqual({ ids: ["8190000000000001", "8190000000000002"] });
    expect(core.parseOrderNumbers("").error).toMatch(/Enter the AliExpress order number/);
    expect(core.parseOrderNumbers("MOCK-1").error).toMatch(/not an AliExpress order number/);
    expect(core.parseOrderNumbers("<script>").error).toMatch(/not an AliExpress order number/);
    expect(core.parseOrderNumbers(Array.from({ length: 21 }, (_, i) => String(i)).join(" ")).error).toMatch(/at most 20/);
  });

  it("offers long numeric ids from orderId= and orderIds= on AliExpress pages only", () => {
    expect(core.orderIdsFromUrl("https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001")).toEqual(["8190000000000001"]);
    expect(core.orderIdsFromUrl("https://www.aliexpress.us/p/trade/payResult.html?orderIds=8190000000000001%2C8190000000000002")).toEqual(["8190000000000001", "8190000000000002"]);
    expect(core.orderIdsFromUrl("https://www.aliexpress.us/x?orderIds=8190000000000001,8190000000000001&orderId=8190000000000003")).toEqual(["8190000000000003", "8190000000000001"]);
    expect(core.orderIdsFromUrl("https://www.aliexpress.com/x?orderId=12345")).toEqual([]);
    expect(core.orderIdsFromUrl("https://www.aliexpress.com/x?orderId=81900000000abc01")).toEqual([]);
    expect(core.orderIdsFromUrl("https://evil.example/x?orderId=8190000000000001")).toEqual([]);
    expect(core.orderIdsFromUrl("https://www.aliexpress.com/p/trade/confirm.html?objectId=1")).toEqual([]);
    expect(core.orderIdsFromUrl("garbage")).toEqual([]);
  });
});

describe("splitStreet", () => {
  it("leaves a street of 35 characters or fewer alone", () => {
    const exactly35 = `123 ${"x".repeat(31)}`;
    expect(exactly35).toHaveLength(35);
    expect(core.splitStreet(exactly35, "Apt 5")).toEqual({ street: exactly35, unit: "Apt 5", moved: "", tooShort: false });
    expect(core.splitStreet("  1  Main   St ", null)).toEqual({ street: "1 Main St", unit: "", moved: "", tooShort: false });
  });

  it("cuts a longer line at a word boundary and moves the rest in front of address2", () => {
    const result = core.splitStreet("12345 Northwest Evergreen Parkway Suite 400", "Bldg B");
    expect(result).toEqual({ street: "12345 Northwest Evergreen Parkway", unit: "Suite 400, Bldg B", moved: "Suite 400", tooShort: false });
    expect(result.street.length).toBeLessThanOrEqual(35);
  });

  it("uses a space exactly at position 35 and keeps 35 characters", () => {
    const head = `123 ${"x".repeat(31)}`;
    const result = core.splitStreet(`${head} Apt 5`, "");
    expect(result.street).toBe(head);
    expect(result.unit).toBe("Apt 5");
  });

  it("cuts hard when there is no usable word boundary, and flags a street under 5 characters", () => {
    const long = "A".repeat(40);
    expect(core.splitStreet(long, "")).toEqual({ street: "A".repeat(35), unit: "AAAAA", moved: "AAAAA", tooShort: false });
    expect(core.splitStreet(`1 ${"B".repeat(40)}`, "").street).toHaveLength(35);
    expect(core.splitStreet("1 A", "").tooShort).toBe(true);
    expect(core.splitStreet("", "").tooShort).toBe(true);
  });
});

describe("nationalPhone", () => {
  it("strips the country code the form already shows", () => {
    expect(core.nationalPhone("+15125550100", "+1")).toEqual({ number: "5125550100", matchesDialCode: true });
    expect(core.nationalPhone("+1 (512) 555-0100", "+1")).toEqual({ number: "5125550100", matchesDialCode: true });
    expect(core.nationalPhone("15125550100", "+1")).toEqual({ number: "5125550100", matchesDialCode: true });
    expect(core.nationalPhone("001 512 555 0100", "+1")).toEqual({ number: "5125550100", matchesDialCode: true });
    expect(core.nationalPhone("(512) 555-0100", "+1")).toEqual({ number: "5125550100", matchesDialCode: true });
    expect(core.nationalPhone("+1 512 555 0100 ext 12", "+1")).toEqual({ number: "5125550100", matchesDialCode: true });
  });

  it("flags a number written with another country's code instead of rewriting it", () => {
    expect(core.nationalPhone("+84 912 345 678", "+1")).toEqual({ number: "84912345678", matchesDialCode: false });
    expect(core.nationalPhone(null, "+1")).toEqual({ number: "", matchesDialCode: true });
  });
});

describe("option titles", () => {
  it("matches exactly, ignoring case, accents and spacing", () => {
    expect(core.normalizeTitle("  São   Paulo ")).toBe("sao paulo");
    expect(core.matchOption(["Austintown", "Austin"], ["austin"])).toBe("Austin");
    expect(core.matchOption(["Cañon City"], ["Canon City"])).toBe("Cañon City");
    expect(core.matchOption(["Saint Louis"], ["St. Louis"])).toBeNull();
    expect(core.matchOption(["Alabama", "Texas"], ["Tex"])).toBeNull();
    expect(core.matchOption(["United States of America"], ["United States", "United States of America"])).toBe("United States of America");
    expect(core.matchOption(null, ["x"])).toBeNull();
    expect(core.matchOption(["Texas"], "texas")).toBe("Texas");
  });

  it("chooses Other for a city AliExpress does not list", () => {
    const titles = ["Abbeville", "Adamsville", "Other"];
    expect(core.chooseCityOption(titles, "adamsville")).toEqual({ title: "Adamsville", isOther: false });
    expect(core.chooseCityOption(titles, "Nowhere Springs")).toEqual({ title: "Other", isOther: true });
    expect(core.chooseCityOption(["Abbeville"], "Nowhere Springs")).toBeNull();
  });

  it("names countries in English and US states in full", () => {
    expect(core.countryName("US")).toBe("United States");
    expect(core.countryName("vn")).toBe("Vietnam");
    expect(core.countryName("QQ")).toBeNull();
    expect(core.countryName("USA")).toBeNull();
    expect(core.countryTitleCandidates("US")).toEqual(["United States", "United States of America", "USA"]);
    expect(core.countryTitleCandidates("DE")).toEqual(["Germany"]);
    expect(core.usStateName("TX")).toBe("Texas");
    expect(core.usStateName("us-ca")).toBe("California");
    expect(core.usStateName("DC")).toBe("District of Columbia");
    expect(core.usStateName("ZZ")).toBeNull();
    expect(core.usStateName("toString")).toBeNull();
    expect(Object.keys(core.US_STATES)).toHaveLength(56);
    expect(core.stateTitleCandidates("Texas", "TX")).toEqual(["Texas"]);
    expect(core.stateTitleCandidates(null, "TX")).toEqual(["Texas"]);
    // The full name comes first, because the first candidate is typed to
    // filter the list and "TX" filters "Texas" out.
    expect(core.stateTitleCandidates("TX", null)).toEqual(["Texas", "TX"]);
    expect(core.stateTitleCandidates("tx", "TX")).toEqual(["Texas", "tx"]);
    expect(core.stateTitleCandidates("Armed Forces Americas", "AA")).toEqual(["Armed Forces Americas"]);
    expect(core.stateTitleCandidates(null, null)).toEqual([]);
  });
});

describe("usFormStructure", () => {
  const usForm = () => ({
    plainInputs: [
      { placeholder: "First name", value: "" },
      { placeholder: "Last name", value: "" },
      { placeholder: "", value: "+1" },
      { placeholder: "Mobile number", value: "" },
      { placeholder: "Street", value: "" },
      { placeholder: "Apt, suite, unit, etc (optional)", value: "" },
      { placeholder: "E.g., 20001 or 20001-0000", value: "" },
      { placeholder: "Delivery instructions", value: "" },
    ],
    selectCount: 4,
  });

  it("accepts the measured US form", () => {
    expect(core.usFormStructure(usForm())).toEqual({ ok: true, dialCode: "+1" });
  });

  it("stops for anything else", () => {
    const defaultView = usForm();
    defaultView.plainInputs = defaultView.plainInputs.slice(0, 4);
    expect(core.usFormStructure(defaultView).ok).toBe(false);

    const vietnam = usForm();
    vietnam.plainInputs[2].value = "+84";
    expect(core.usFormStructure(vietnam)).toMatchObject({ ok: false });
    expect(core.usFormStructure(vietnam).reason).toMatch(/\+84/);

    const noCode = usForm();
    noCode.plainInputs[2].value = "";
    expect(core.usFormStructure(noCode).ok).toBe(false);

    const zipMoved = usForm();
    zipMoved.plainInputs[6].placeholder = "ZIP";
    expect(core.usFormStructure(zipMoved).ok).toBe(false);

    const reordered = usForm();
    reordered.plainInputs[4].placeholder = "E.g., 20001";
    expect(core.usFormStructure(reordered).ok).toBe(false);

    expect(core.usFormStructure({ ...usForm(), selectCount: 3 }).ok).toBe(false);
    // An extra drop-down would shift State and City onto the wrong lists.
    expect(core.usFormStructure({ ...usForm(), selectCount: 5 }).ok).toBe(false);
    expect(core.usFormStructure(null).ok).toBe(false);
  });
});

describe("defaultBoxState - rule 6 is read, not assumed", () => {
  it("reads a native, ARIA or Fusion checkbox as ticked", () => {
    expect(core.defaultBoxState([{ checked: true, ariaChecked: null, classes: ["next-checkbox-input"] }])).toBe("ticked");
    expect(core.defaultBoxState([{ checked: null, ariaChecked: "true", classes: [] }])).toBe("ticked");
    expect(core.defaultBoxState([{ checked: null, ariaChecked: "mixed", classes: [] }])).toBe("ticked");
    expect(core.defaultBoxState([{ checked: null, ariaChecked: null, classes: ["next-checkbox-wrapper", "checked"] }])).toBe("ticked");
    expect(core.defaultBoxState([{ checked: null, ariaChecked: null, classes: ["comet-checkbox-checked"] }])).toBe("ticked");
    expect(core.defaultBoxState([{ checked: null, ariaChecked: null, classes: ["next-checkbox-wrapper", "indeterminate"] }])).toBe("ticked");
  });

  it("reads unticked only when every box says so, and missing when there is none", () => {
    const wrapper = { checked: null, ariaChecked: null, classes: ["next-checkbox-wrapper"] };
    const input = { checked: false, ariaChecked: "false", classes: ["next-checkbox-input"] };
    expect(core.defaultBoxState([wrapper, input])).toBe("unticked");
    expect(core.defaultBoxState([{ checked: null, ariaChecked: null, classes: ["next-checkbox-unchecked"] }])).toBe("unticked");
    expect(core.defaultBoxState([wrapper, { ...input, checked: true }])).toBe("ticked");
    expect(core.defaultBoxState([])).toBe("missing");
    expect(core.defaultBoxState(null)).toBe("missing");
  });
});

describe("foreignFormValues - an edit form is not filled", () => {
  const intended = ["Jane", "Doe", "5125550100", "1 Main St", "", "78701"];

  it("accepts a new form, and one the fill itself typed into before", () => {
    expect(core.foreignFormValues(["", "", "+1", "", "", "", "", ""], intended)).toEqual([]);
    expect(core.foreignFormValues(["Jane", " doe ", "+1", "5125550100", "1 Main St", "", "78701", ""], intended)).toEqual([]);
  });

  it("points at every box holding something else", () => {
    expect(core.foreignFormValues(["Minh", "Nguyen", "+84", "901234567", "12 Le Loi", "", "", ""], intended)).toEqual([0, 1, 3, 4]);
    expect(core.foreignFormValues(["", "", "+1", "", "", "", "", "Leave at door"], intended)).toEqual([7]);
    expect(core.foreignFormValues(["x"], null)).toEqual([0]);
    expect(core.foreignFormValues(null, intended)).toEqual([]);
  });
});

describe("mismatchedFields - the fill reads its boxes back", () => {
  it("names the boxes that do not show what was typed", () => {
    const expected = { firstName: "Jane", lastName: "Doe", unit: "", zip: "78701" };
    expect(core.mismatchedFields(expected, { firstName: "Jane", lastName: "Doe ", unit: null, zip: "78701" })).toEqual([]);
    expect(core.mismatchedFields(expected, { firstName: "", lastName: "Doe", unit: "", zip: "" })).toEqual(["firstName", "zip"]);
    expect(core.mismatchedFields(expected, null)).toEqual(["firstName", "lastName", "zip"]);
  });
});

describe("money", () => {
  it("reads VND and USD totals as AliExpress formats them", () => {
    expect(core.parseMoneyText("₫2.861.602")).toEqual({ amount: 2861602, currency: "VND" });
    expect(core.parseMoneyText("Total: ₫ 2.861.602")).toEqual({ amount: 2861602, currency: "VND" });
    expect(core.parseMoneyText("236.000đ")).toEqual({ amount: 236000, currency: "VND" });
    expect(core.parseMoneyText("VND 150.000")).toEqual({ amount: 150000, currency: "VND" });
    expect(core.parseMoneyText("2 861 602 ₫")).toEqual({ amount: 2861602, currency: "VND" });
    expect(core.parseMoneyText("US $12.40")).toEqual({ amount: 12.4, currency: "USD" });
    expect(core.parseMoneyText("$1,234.56")).toEqual({ amount: 1234.56, currency: "USD" });
    expect(core.parseMoneyText("Total (2 items) US $25.00")).toEqual({ amount: 25, currency: "USD" });
    expect(core.parseMoneyText("Total US $1,005")).toEqual({ amount: 1005, currency: "USD" });
  });

  it("reads other formats and refuses text with no amount", () => {
    expect(core.parseMoneyText("1.234,56 €")).toEqual({ amount: 1234.56, currency: "EUR" });
    expect(core.parseMoneyText("12,40 €")).toEqual({ amount: 12.4, currency: "EUR" });
    expect(core.parseMoneyText("C$ 15.00")).toEqual({ amount: 15, currency: "CAD" });
    expect(core.parseMoneyText("£7.5")).toEqual({ amount: 7.5, currency: "GBP" });
    expect(core.parseMoneyText("42")).toEqual({ amount: 42, currency: null });
    expect(core.parseMoneyText("Free shipping")).toBeNull();
    expect(core.parseMoneyText("")).toBeNull();
    expect(core.parseMoneyText(null)).toBeNull();
    expect(core.formatAmount(2861602, "VND")).toBe("2861602 VND");
    expect(core.formatAmount(12.4, "USD")).toBe("12.40 USD");
  });

  it("expects the whole order for one item, and one item's goods for several", () => {
    const one = { currency: "USD", expectedTotal: "8.99", itemIndex: 0, items: [{ unitCost: "3.50", quantity: 2, currency: "USD" }] };
    expect(core.expectedCost(one)).toEqual({ amount: 8.99, currency: "USD", scope: "order" });
    const two = { ...one, itemIndex: 1, items: [one.items[0], { unitCost: "1.333", quantity: 3, currency: "USD" }] };
    expect(core.expectedCost(two)).toEqual({ amount: 4, currency: "USD", scope: "item" });
    expect(core.expectedCost({ ...one, expectedTotal: "n/a" })).toBeNull();
    expect(core.expectedCost({ ...two, items: [one.items[0], { unitCost: null, quantity: 1 }] })).toBeNull();
  });

  it("only warns, and gives no verdict across currencies", () => {
    const expected = { amount: 8.99, currency: "USD", scope: "order" };
    expect(core.compareTotals(expected, "US $9.20").kind).toBe("close");
    expect(core.compareTotals(expected, "US $15.00").kind).toBe("higher");
    expect(core.compareTotals(expected, "US $5.00").kind).toBe("lower");
    expect(core.compareTotals(expected, "₫236.000")).toEqual({ kind: "other-currency", page: { amount: 236000, currency: "VND" }, expectations: [expected] });
    expect(core.compareTotals(expected, "42").kind).toBe("other-currency");
    expect(core.compareTotals(expected, "")).toEqual({ kind: "unreadable", page: null });
    expect(core.compareTotals(null, "US $1").kind).toBe("no-expectation");
    expect(core.compareTotals([], "US $1").kind).toBe("no-expectation");
  });

  it("compares the page's total with the estimate in the page's currency, and shows both when neither shares it", () => {
    // The measured account: captured in VND, converted to the shop's USD, charged in USD.
    const job = { currency: "VND", expectedTotal: "1724188", shopCurrency: "USD", shopExpectedTotal: "66.10", itemIndex: 0, items: [{ unitCost: "1724188", quantity: 1, currency: "VND" }] };
    expect(core.expectedCosts(job)).toEqual([
      { amount: 1724188, currency: "VND", scope: "order" },
      { amount: 66.1, currency: "USD", scope: "order" },
    ]);
    expect(core.compareTotals(core.expectedCosts(job), "Total$93.62")).toMatchObject({ kind: "higher", page: { amount: 93.62, currency: "USD" }, expected: { currency: "USD" } });
    expect(core.compareTotals(core.expectedCosts(job), "Total ₫1.724.188").kind).toBe("close");
    const verdict = core.compareTotals(core.expectedCosts(job), "Total €50.00");
    expect(verdict.kind).toBe("other-currency");
    expect(verdict.expectations).toHaveLength(2);
    // No shop estimate on record, and none with several items (each item is its own checkout).
    expect(core.expectedCosts({ ...job, shopExpectedTotal: null })).toHaveLength(1);
    expect(core.expectedCosts({ ...job, shopCurrency: "usd" })).toHaveLength(1);
    expect(core.expectedCosts({ ...job, items: [job.items[0], { unitCost: "1", quantity: 1, currency: "VND" }] })).toEqual([{ amount: 1724188, currency: "VND", scope: "item" }]);
  });

  it("reads the confirm page's real total, with the subtotal only when the rows add up", () => {
    const rows = [
      { label: "Subtotal", text: "Subtotal $85.89" },
      { label: "Promo codes", text: "Promo codes -$0.00" },
      { label: "Shipping fee", text: "Shipping fee $2.99" },
      { label: "Additional charges", text: "Additional charges $4.74" },
    ];
    expect(core.quoteFromPage({ totalText: "Total$93.62", rows })).toEqual({ currency: "USD", total: 93.62, subtotal: 85.89, shipping: 2.99, charges: 4.74 });
    // A promo code: the subtotal no longer adds up and is left out, so the app takes goods = total - shipping - charges.
    expect(core.quoteFromPage({ totalText: "Total$83.62", rows: [...rows, { label: "Promo codes", text: "-$10.00" }] })).toEqual({ currency: "USD", total: 83.62, shipping: 2.99, charges: 4.74 });
    expect(core.quoteFromPage({ totalText: "Total ₫2.861.602", rows: [] })).toEqual({ currency: "VND", total: 2861602, shipping: 0, charges: 0 });
    expect(core.quoteFromPage({ totalText: "Total 42", rows })).toBeNull();
    expect(core.quoteFromPage({ totalText: "", rows })).toBeNull();
    expect(core.quoteFromPage(null)).toBeNull();
  });

  it("sums the items' quotes for the purchase order and builds the app's body", () => {
    const a = { currency: "USD", total: 93.62, subtotal: 85.89, shipping: 2.99, charges: 4.74, sent: true };
    const b = { currency: "USD", total: 10, shipping: 1, charges: 0 };
    expect(core.sumQuotes([a, null])).toEqual({ currency: "USD", total: 93.62, shipping: 2.99, charges: 4.74, subtotal: 85.89 });
    expect(core.sumQuotes([a, b])).toEqual({ currency: "USD", total: 103.62, shipping: 3.99, charges: 4.74 });
    expect(core.sumQuotes([a, { ...b, currency: "VND" }])).toBeNull();
    expect(core.sumQuotes([null, null])).toBeNull();
    expect(core.quoteBody(core.sumQuotes([a]))).toEqual({ currency: "USD", total: "93.62", subtotal: "85.89", shipping: "2.99", charges: "4.74", source: "confirm" });
    expect(core.quoteBody(b)).toEqual({ currency: "USD", total: "10.00", shipping: "1.00", charges: "0.00", source: "confirm" });
    expect(core.quoteBody(null)).toBeNull();
    expect(core.validQuote({ currency: "USD", total: -1 })).toBe(false);
    expect(core.validQuote({ currency: "usd", total: 1 })).toBe(false);
    expect(core.validQuote({ currency: "USD", total: 1, shipping: NaN })).toBe(false);
    expect(core.validQuote({ currency: "USD", total: 0 })).toBe(true);
  });
});

describe("the comet address form (aliexpress.us, English)", () => {
  const US = core.countryTitleCandidates("US");
  const cometInputs = () => [
    { type: "text", role: "", value: "United States" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "+1" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "combobox", value: "" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "" },
    { type: "text", role: "", value: "" },
  ];

  it("locates fields by the measured positions", () => {
    expect(core.COMET_POSITIONS).toMatchObject({ country: 0, firstName: 1, lastName: 2, dialCode: 3, phone: 4, search: 5, street: 6, unit: 7, state: 8, city: 9, zip: 10, instructions: 11, count: 12 });
    expect(core.COMET_TYPED).toEqual({ firstName: 1, lastName: 2, phone: 4, street: 6, unit: 7, zip: 10 });
    expect(core.COMET_TEXT_BOXES).toEqual([1, 2, 4, 6, 7, 10, 11]);
  });

  it("accepts the measured twelve-box US form and stops for anything else", () => {
    expect(core.cometFormStructure({ inputs: cometInputs() }, US)).toEqual({ ok: true, dialCode: "+1" });

    expect(core.cometFormStructure({ inputs: cometInputs().slice(0, 6) }, US).reason).toMatch(/6 boxes, not the 12/);
    const otherCountry = cometInputs();
    otherCountry[0].value = "Vietnam";
    expect(core.cometFormStructure({ inputs: otherCountry }, US)).toMatchObject({ ok: false, countryMismatch: true });
    expect(core.cometFormStructure({ inputs: otherCountry }, US).reason).toMatch(/"Vietnam", not the United States/);
    const otherDial = cometInputs();
    otherDial[3].value = "+84";
    expect(core.cometFormStructure({ inputs: otherDial }, US).reason).toMatch(/\+84/);
    const noSearch = cometInputs();
    noSearch[5].role = "";
    expect(core.cometFormStructure({ inputs: noSearch }, US).ok).toBe(false);
    const checkbox = cometInputs();
    checkbox[11].type = "checkbox";
    expect(core.cometFormStructure({ inputs: checkbox }, US).reason).toMatch(/Box 12 is not a text box/);
    expect(core.cometFormStructure(null, US).ok).toBe(false);
  });

  it("chooses a state from the cascade list with its letter headers skipped, and a city or Other", () => {
    const states = ["A", "Alabama", "Alaska", "T", "Tennessee", "Texas", "W", "Wyoming"];
    expect(core.cascadeLabels(states)).toEqual(["Alabama", "Alaska", "Tennessee", "Texas", "Wyoming"]);
    expect(core.chooseCascadeOption(states, core.stateTitleCandidates("Texas", "TX"))).toBe("Texas");
    expect(core.chooseCascadeOption(states, ["T"])).toBeNull();
    expect(core.chooseCascadeOption(states, ["Ontario"])).toBeNull();
    const cities = ["Abbott", "Austin", "Zavalla", "Other"];
    expect(core.chooseCascadeCity(cities, "austin")).toEqual({ label: "Austin", isOther: false });
    expect(core.chooseCascadeCity(cities, "Nowhere Springs")).toEqual({ label: "Other", isOther: true });
    expect(core.chooseCascadeCity(["Abbott"], "Nowhere Springs")).toBeNull();
    expect(core.chooseCascadeCity(cities, "")).toEqual({ label: "Other", isOther: true });
  });

  it("recognises the customer's address in the page's block by last name and house number", () => {
    const values = { firstName: "Test", lastName: "Customer", street: "12345 Northwest Evergreen Parkway" };
    expect(core.streetKey(values.street)).toBe("12345 Northwest");
    expect(core.addressBlockShows("Test Customer +1 512-555-0100 12345 Northwest Evergreen Parkway, Suite 400, Austin, Texas, 78701, United States Change", values)).toBe(true);
    expect(core.addressBlockShows("Merchant Owner 1 Main St, Austin, Texas Change", values)).toBe(false);
    expect(core.addressBlockShows("Test Customer 99 Elsewhere Rd", values)).toBe(false);
    expect(core.addressBlockShows("", values)).toBe(false);
    expect(core.addressBlockShows("Cher 1 Main St", { firstName: "Cher", lastName: "", street: "1 Main St" })).toBe(true);
    expect(core.addressBlockShows("Test Customer 12345 Northwest", { lastName: "Customer", street: "" })).toBe(false);
  });

  describe("saveButtonRefusal - the one verified exception to the click guard", () => {
    const intended = { firstName: "Test", lastName: "Customer", phone: "5125550100", street: "12345 Northwest Evergreen Parkway", unit: "Suite 400, Bldg B", zip: "78701" };
    const good = () => ({
      design: "comet",
      boxes: ["Test", "Customer", "5125550100", "12345 Northwest Evergreen Parkway", "Suite 400, Bldg B", "78701", ""],
      intended,
      actual: { ...intended },
      country: { shown: "United States", candidates: US },
      state: { shown: "Texas", candidates: ["Texas"] },
      city: { shown: "Austin", wanted: "Austin", otherAccepted: false },
      defaultSwitch: "off",
      button: { tag: "BUTTON", type: "button", text: "Save", classes: ["form-button-confirm", "comet-btn"], ancestorClasses: ["deliver-address-wrap", "comet-drawer-body"], inForm: false, disabled: false },
    });

    it("allows Save only when everything reads back as intended", () => {
      expect(core.saveButtonRefusal(good())).toBeNull();
      expect(core.saveButtonRefusal({ ...good(), city: { shown: "Other", wanted: "Nowhere Springs", otherAccepted: true } })).toBeNull();
      expect(core.saveButtonRefusal({ ...good(), button: { ...good().button, text: "Lưu" } })).toBeNull();
    });

    it.each([
      ["a value the extension did not type", { boxes: ["Test", "Customer", "5125550100", "1 Main St", "", "78701", ""] }, /did not type/],
      ["a delivery instruction it did not type", { boxes: [...good().boxes.slice(0, 6), "Leave at door"] }, /did not type/],
      ["a typed box that reads back differently", { actual: { ...intended, zip: "" } }, /zip/],
      ["another country", { country: { shown: "Canada", candidates: US } }, /not the United States/],
      ["another state", { state: { shown: "Alabama", candidates: ["Texas"] } }, /State/],
      ["another city", { city: { shown: "Austintown", wanted: "Austin", otherAccepted: false } }, /City/],
      ["City Other without the merchant told", { city: { shown: "Other", wanted: "Austin", otherAccepted: false } }, /City/],
      ["the default switch on", { defaultSwitch: "on" }, /Set as default/],
      ["the default switch missing", { defaultSwitch: "missing" }, /Set as default/],
      ["no button", { button: null }, /not found/],
      ["a submit button", { button: { ...good().button, type: "submit" } }, /submit/],
      ["an untyped button inside a form", { button: { ...good().button, type: null, inForm: true } }, /submit/],
      ["a disabled button", { button: { ...good().button, disabled: true } }, /disabled/],
      ["a button that is not Save", { button: { ...good().button, text: "Confirm" } }, /not Save/],
      ["Pay now", { button: { ...good().button, text: "Pay now" } }, /not Save/],
      ["a button without the form's Save class", { button: { ...good().button, classes: ["comet-btn"] } }, /not the address form's Save/],
      ["a Save inside the Place order box", { button: { ...good().button, ancestorClasses: ["pl-order-toal-container__btn-box"] } }, /Place order or payment/],
      ["a Save inside a payment area", { button: { ...good().button, ancestorClasses: ["placeorder-page-payment-container"] } }, /Place order or payment/],
      ["a design that was never measured", { design: "unknown" }, /design/],
      ["nothing typed", { intended: {} }, /Nothing was typed/],
    ])("refuses %s", (_name, overrides, pattern) => {
      expect(core.saveButtonRefusal({ ...good(), ...overrides })).toMatch(pattern);
    });

    it("judges the Fusion form's Confirm the same way", () => {
      const fusion = {
        ...good(),
        design: "fusion",
        boxes: ["Test", "Customer", "+1", "5125550100", "12345 Northwest Evergreen Parkway", "Suite 400, Bldg B", "78701", ""],
        button: { tag: "BUTTON", type: "button", text: "Confirm", classes: ["next-btn", "next-btn-primary"], ancestorClasses: ["next-dialog-footer"], inForm: false, disabled: false },
      };
      expect(core.saveButtonRefusal(fusion)).toBeNull();
      expect(core.saveButtonRefusal({ ...fusion, button: { ...fusion.button, text: "Xác nhận" } })).toBeNull();
      expect(core.saveButtonRefusal({ ...fusion, button: { ...fusion.button, text: "Save" } })).toMatch(/not Confirm/);
      expect(core.saveButtonRefusal({ ...fusion, defaultSwitch: "on" })).toMatch(/Set as default/);
      expect(core.saveButtonRefusal(null)).toMatch(/Nothing/);
    });
  });
});

describe("the automatic fill's bookkeeping", () => {
  it("runs once per item, again only when a recorded set is no longer shown, never after a stop", () => {
    const job = { stage: "confirm", itemIndex: 0, fill: null };
    expect(core.shouldAutoFill(job, false)).toBe(true);
    expect(core.shouldAutoFill(job, true)).toBe(false);
    expect(core.shouldAutoFill({ ...job, fill: { itemIndex: 0, result: "set" } }, false)).toBe(true);
    expect(core.shouldAutoFill({ ...job, fill: { itemIndex: 0, result: "partial", reason: "x" } }, false)).toBe(false);
    expect(core.shouldAutoFill({ ...job, fill: { itemIndex: 0, result: "failed", reason: "x" } }, false)).toBe(false);
    // A record for another item does not count.
    expect(core.shouldAutoFill({ ...job, itemIndex: 1, fill: { itemIndex: 0, result: "failed" } }, false)).toBe(true);
    expect(core.shouldAutoFill({ ...job, stage: "paying" }, false)).toBe(false);
    expect(core.fillOutcomeFor({ itemIndex: 1, fill: { itemIndex: 0, result: "set" } })).toBeNull();
    expect(core.fillOutcomeFor({ itemIndex: 0, fill: { itemIndex: 0, result: "set" } })).toEqual({ itemIndex: 0, result: "set" });
  });
});

describe("the AliExpress orders list, order detail and tracking pages", () => {
  it("recognises the pages", () => {
    expect(core.isOrdersPage("https://www.aliexpress.us/p/order/index.html")).toBe(true);
    expect(core.isOrdersPage("https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001")).toBe(true);
    expect(core.isOrderDetailPage("https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001")).toBe(true);
    expect(core.isOrderDetailPage("https://www.aliexpress.us/p/order/index.html")).toBe(false);
    expect(core.isTrackingPage("https://www.aliexpress.com/p/tracking/index.html?tradeOrderId=8190000000000001")).toBe(true);
    expect(core.isOrdersPage("https://evil.example/p/order/index.html")).toBe(false);
    expect(core.isTrackingPage("https://www.aliexpress.com/p/order/index.html")).toBe(false);
    expect(core.ordersPageUrl("https://www.aliexpress.us")).toBe("https://www.aliexpress.us/p/order/index.html");
    expect(core.ordersPageUrl("https://evil.example")).toBeNull();
    expect(core.ordersPageUrl("http://www.aliexpress.us")).toBeNull();
  });

  it("reads a status phrase as a whole word, even glued to the next element's text", () => {
    expect(core.orderStatusFromText("Awaiting deliveryDate: Sep 15, 2026Ref. Number: 8190")).toBe("Awaiting delivery");
    expect(core.orderStatusFromText("To payDate: Sep 15")).toBe("To pay");
    expect(core.orderStatusFromText("Order unpaid")).toBe("");
    expect(core.orderStatusFromText("Paid on: Sep 15")).toBe("Paid");
    expect(core.orderStatusFromText("Completed")).toBe("Completed");
    expect(core.orderStatusFromText("")).toBe("");
    expect(core.orderStatusFromText(null)).toBe("");
  });

  it("reads the status where the card prints it, unpaid first, never from a product title or a longer word", () => {
    // The measured card: status, then "Date:". A title after it must not read as a status.
    expect(core.orderStatusFromText("To payDate: Sep 15, 2026Ref. Number: 8190 Food Processing Machine Total:$3")).toBe("To pay");
    expect(core.orderStatusFromText("To pay Food Processing Machine Total:$3")).toBe("To pay");
    expect(core.orderStatusFromText("Awaiting paymentDate: Sep 15 Completed Set Total:$3")).toBe("Awaiting payment");
    // The lookahead is case-sensitive: a lowercase letter after the phrase is more of the same word.
    expect(core.orderStatusFromText("To payment due")).toBe("");
    expect(core.orderStatusFromText("Paidup")).toBe("");
    expect(core.orderStatusFromText("Date: Sep 15 Processing")).toBe("Processing");
    // The status element's phrase wins, then the card's, then the element's raw text.
    expect(core.parseOrderCard({ detailsHref: "?orderId=8190000000000001", productHrefs: [], statusText: "To payTrack status", cardText: "Completed" })).toMatchObject({ status: "To pay" });
    expect(core.parseOrderCard({ detailsHref: "?orderId=8190000000000001", productHrefs: [], statusText: "Awaiting flight", cardText: "To payDate: Sep 15" })).toMatchObject({ status: "To pay" });
    expect(core.parseOrderCard({ detailsHref: "?orderId=8190000000000001", productHrefs: [], statusText: "Awaiting flight", cardText: "" })).toMatchObject({ status: "Awaiting flight" });
  });

  it("takes Total and Date as whole labels, so Subtotal and Update are not read", () => {
    const text = "To payDate: Sep 15, 2026Ref. Number: 8190000000000001 Details Update: Sep 1 Subtotal:$85.89 Total:$93.62Pay now";
    expect(core.parseOrderCard({ detailsHref: "?orderId=8190000000000001", productHrefs: [], statusText: "", cardText: text })).toMatchObject({ status: "To pay", total: "$93.62", date: "Sep 15, 2026" });
    expect(core.parseOrderCard({ detailsHref: "?orderId=8190000000000001", productHrefs: [], statusText: "", cardText: "Update: Sep 1 Subtotal:$85.89" })).toMatchObject({ total: "", date: "" });
  });

  it("parses an order card into ids, SKU text, status, total and date, and nothing else", () => {
    const card = core.parseOrderCard({
      detailsHref: "https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001&spm=x",
      productHrefs: ["https://www.aliexpress.us/item/3256809840464144.html?x=1", "https://www.aliexpress.us/item/3256809840464144.html", "/item/1005006001.html"],
      statusText: "",
      skuText: "  Play blue light ",
      cardText: "Awaiting deliveryDate: Sep 15, 2026Ref. Number: 8190000000000001 Details Smart glasses Play blue light x1 Total:$93.62Confirm receivedTrack status",
    });
    expect(card).toEqual({
      orderId: "8190000000000001",
      productIds: ["3256809840464144", "1005010026778896", "1005006001"],
      skuText: "Play blue light",
      status: "Awaiting delivery",
      total: "$93.62",
      date: "Sep 15, 2026",
    });
    // The card's own status element wins over the text scan.
    expect(core.parseOrderCard({ detailsHref: "?orderId=8190000000000001", productHrefs: [], statusText: " To pay ", cardText: "" })).toMatchObject({ status: "To pay", total: "", date: "", productIds: [] });
    expect(core.parseOrderCard({ detailsHref: "?orderId=123", productHrefs: [], cardText: "" })).toBeNull();
    expect(core.parseOrderCard({ detailsHref: "", productHrefs: [], cardText: "" })).toBeNull();
    expect(core.parseOrderCard(null)).toBeNull();
    expect(core.orderIdFromHref("https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001")).toBe("8190000000000001");
    expect(core.orderIdFromHref("?orderId=81900000000000019999999999")).toBeNull();
    expect(core.productIdsFromHrefs(["/item/3256809840464144.html"])).toEqual(["3256809840464144", "1005010026778896"]);
    expect(core.productIdsFromHrefs(["/item/abc.html", null])).toEqual([]);
  });

  it("parses the order detail page (never its product links) and the tracking page", () => {
    // The detail page's item block is unmeasured and its recommendation strips link products too: no product ids from it, so the app only advances an order it knows.
    expect(core.parseOrderDetail({ url: "https://www.aliexpress.com/p/order/detail.html?orderId=8190000000000001", refNumberText: "Ref. Number: 8190000000000001 Copy", statusText: " Awaiting delivery ", productHrefs: ["/item/1005006001.html"] })).toEqual({
      orderId: "8190000000000001",
      productIds: [],
      skuText: "",
      status: "Awaiting delivery",
      total: "",
      date: "",
    });
    expect(core.parseOrderDetail({ url: "https://www.aliexpress.com/p/order/detail.html", refNumberText: "Ref. Number: 8190000000000002 Copy", statusText: "Closed" })).toMatchObject({ orderId: "8190000000000002", status: "Closed" });
    expect(core.parseOrderDetail({ url: "https://www.aliexpress.com/p/order/detail.html", refNumberText: "", statusText: "" })).toBeNull();

    expect(core.parseTrackingPage({ url: "https://www.aliexpress.com/p/tracking/index.html?tradeOrderId=8190000000000001", carrierText: " AliExpress Selection Standard Fast for Special Goods ", mailNoText: " SWX000000000000000001 " })).toEqual({
      tradeOrderId: "8190000000000001",
      trackingNumber: "SWX000000000000000001",
      carrier: "AliExpress Selection Standard Fast for Special Goods",
    });
    expect(core.parseTrackingPage({ url: "https://www.aliexpress.com/p/tracking/index.html?tradeOrderId=8190000000000001", carrierText: "", mailNoText: "no number yet" })).toBeNull();
    expect(core.parseTrackingPage({ url: "https://www.aliexpress.com/p/tracking/index.html", carrierText: "", mailNoText: "SWX000000000000000001" })).toBeNull();
    expect(core.parseTrackingPage(null)).toBeNull();
  });

  it("builds the sync body from well-formed orders only, capped at 100", () => {
    const orders = Array.from({ length: 120 }, (_, i) => ({ orderId: String(8190000000000000 + i), productIds: ["1005006001", "x"], skuText: "Black", status: "To pay", total: "$1", date: "Sep 15" }));
    const body = core.ordersSyncBody([...orders, { orderId: "123" }, null]);
    expect(body.orders).toHaveLength(100);
    expect(body.orders[0]).toEqual({ orderId: "8190000000000000", productIds: ["1005006001"], skuText: "Black", status: "To pay", total: "$1", date: "Sep 15" });
    expect(core.ordersSyncBody([{ orderId: "123" }])).toBeNull();
    expect(core.ordersSyncBody(null)).toBeNull();
    // Paying hints: a purchase order id and a time each, well-formed only, at most 20, and left out when there are none.
    const hinted = core.ordersSyncBody(orders.slice(0, 1), [{ purchaseOrderId: "po_waiting01", payingAt: 1789000000000 }, { purchaseOrderId: "x", payingAt: 1 }, { purchaseOrderId: "po_waiting02", payingAt: "soon" }, null]);
    expect(hinted.hints).toEqual([{ purchaseOrderId: "po_waiting01", payingAt: 1789000000000 }]);
    expect(core.ordersSyncBody(orders.slice(0, 1), Array.from({ length: 30 }, (_, i) => ({ purchaseOrderId: `po_waiting${i}`, payingAt: i, address: "never" }))).hints).toHaveLength(20);
    expect(core.ordersSyncBody(orders.slice(0, 1), [])).not.toHaveProperty("hints");
  });

  it("notes a multi-item purchase order's partial result on the job's current item only", () => {
    const job = { purchaseOrderId: "po_waiting01", stage: "paying", itemIndex: 1, items: [{ externalProductId: "1005006001" }, { externalProductId: "1005010026778896" }], recordedOrderIds: [["8190000000000000"], []] };
    const entry = { orderId: "8190000000000001", result: "partial", purchaseOrderId: "po_waiting01", matchedProductIds: ["1005010026778896"] };
    expect(core.attachOrderToJob(job, entry)).toEqual({ ...job, stage: "recorded", recordedOrderIds: [["8190000000000000"], ["8190000000000001"]] });
    // The regional form of the id matches the stored global one.
    expect(core.attachOrderToJob(job, { ...entry, matchedProductIds: ["3256809840464144"] })).toMatchObject({ stage: "recorded" });
    expect(core.attachOrderToJob({ ...job, stage: "confirm" }, entry)).toMatchObject({ stage: "recorded" });
    // Not this job's purchase order, another item's product, a number already noted, a job not on its checkout, another result.
    expect(core.attachOrderToJob(job, { ...entry, purchaseOrderId: "po_waiting02" })).toBeNull();
    expect(core.attachOrderToJob(job, { ...entry, matchedProductIds: ["1005006001"] })).toBeNull();
    expect(core.attachOrderToJob(job, { ...entry, orderId: "8190000000000000" })).toBeNull();
    expect(core.attachOrderToJob({ ...job, stage: "product" }, entry)).toBeNull();
    expect(core.attachOrderToJob({ ...job, stage: "recorded" }, entry)).toBeNull();
    expect(core.attachOrderToJob(job, { ...entry, result: "recorded" })).toBeNull();
    expect(core.attachOrderToJob(job, { ...entry, orderId: "12" })).toBeNull();
    expect(core.attachOrderToJob(null, entry)).toBeNull();
  });

  it("tells the same confirm-page quote from a changed one", () => {
    const a = { currency: "USD", total: 93.62, subtotal: 85.89, shipping: 2.99, charges: 4.74 };
    expect(core.sameQuote(a, { ...a, sent: true })).toBe(true);
    expect(core.sameQuote(a, { ...a, total: 93.621 })).toBe(true);
    expect(core.sameQuote(a, { ...a, total: 95.12, charges: 6.24 })).toBe(false);
    expect(core.sameQuote(a, { ...a, subtotal: undefined })).toBe(false);
    expect(core.sameQuote(a, { ...a, currency: "VND" })).toBe(false);
    expect(core.sameQuote(a, null)).toBe(false);
    // The purchase order's quote is rebuilt from the item's latest total, so the app gets the post-fill figure.
    const after = { ...a, total: 95.12, charges: 6.24 };
    expect(core.quoteBody(core.sumQuotes([after]))).toEqual({ currency: "USD", total: "95.12", subtotal: "85.89", shipping: "2.99", charges: "6.24", source: "confirm" });
  });

  it("describes each sync result in one line", () => {
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "recorded", orderName: "#21047" })).toBe("#21047 recorded as AliExpress order 8190000000000001.");
    expect(core.describeSyncResult({ orderId: "8190000000000002", result: "recorded", orderName: "#21047", externalOrderIds: ["8190000000000001", "8190000000000002"] })).toBe("#21047 recorded as AliExpress orders 8190000000000001, 8190000000000002.");
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "already", orderName: "#21047", closed: true })).toMatch(/closed on AliExpress/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "advanced", orderName: "#21047", status: "SHIPPED" })).toBe("#21047 (AliExpress order 8190000000000001) is now shipped.");
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "partial", orderName: "#21047" })).toMatch(/^#21047 has several items.*noted for its item in the checkout panel/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "ambiguous", candidates: [{ orderName: "#1" }, { orderName: "#2" }] })).toMatch(/#1, #2/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "ambiguous", reason: "date-unreadable", candidates: [{ orderName: "#1" }] })).toMatch(/date could not be read.*older than #1/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "ambiguous", reason: "variant-differs", candidates: [{ orderName: "#1" }] })).toMatch(/SKU text does not name the variant #1/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "unmatched" })).toBe("AliExpress order 8190000000000001: no DropshipHub order matched.");
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "unmatched", closed: true })).toMatch(/closed on AliExpress, so it was not recorded/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", result: "unmatched", reason: "older-than-orders", candidates: [{ orderName: "#1" }] })).toMatch(/dated before #1 was created/);
    expect(core.describeSyncResult({ orderId: "8190000000000001", error: "boom" })).toBe("AliExpress order 8190000000000001: boom.");
  });
});

describe("clickRefusal - the one guard every programmatic click passes", () => {
  const allowed = {
    addNewAddress: { tag: "BUTTON", type: "button", classes: ["comet-v2-btn"], ancestorClasses: ["pl-address-item__new-btn-wrap", "pl-address-item-container"], text: "Add new address", inForm: false },
    enterManually: { tag: "SPAN", classes: ["manual-link"], ancestorClasses: ["deliver-address-form"], text: "Enter manually", inForm: true },
    selectTrigger: { tag: "SPAN", classes: ["next-select-trigger"], ancestorClasses: ["next-select", "deliver-address-form"], text: "Alabama", inForm: true },
    cityOption: { tag: "LI", role: "option", title: "Payson", text: "Payson", ancestorClasses: ["next-select-menu"] },
    otherOption: { tag: "LI", role: "option", title: "Other", text: "Other", ancestorClasses: ["next-select-menu", "display-flex"] },
    countryOption: { tag: "LI", role: "option", title: "United States", text: "United States", ancestorClasses: ["next-select-menu"] },
    // The comet drawer and cascade modal (measured 2026-09-15).
    changeLink: { tag: "A", classes: [], ancestorClasses: ["pl-address-item__arrrow", "pl-address-item-container"], text: "Change", inForm: false },
    cometAddAddress: { tag: "BUTTON", type: "button", classes: ["comet-btn", "comet-btn-primary", "add-address"], ancestorClasses: ["comet-drawer-body", "comet-drawer", "pl-address-model-cls"], text: "Add new address", inForm: false },
    cometEnterManually: { tag: "DIV", classes: ["text-button-container"], ancestorClasses: ["deliver-address-form", "mt-form", "deliver-address-wrap"], text: "Enter manually", inForm: false },
    cometStateBox: { tag: "INPUT", type: "text", classes: ["one-textinput"], ancestorClasses: ["default-select-wrap", "mt-form-item", "deliver-address-form"], inForm: false },
    cascadeState: { tag: "DIV", classes: ["group-item"], ancestorClasses: ["drawer-cascade-list", "drawer-list-wrap", "mt-drawer-modal", "mt-modal", "mt-modal--bottom"], text: "Texas" },
    cascadeCityOther: { tag: "DIV", classes: ["group-item"], ancestorClasses: ["drawer-cascade-list", "mt-drawer-modal"], text: "Other" },
    cascadeClose: { tag: "SPAN", classes: ["mt-icon-close"], ancestorClasses: ["drawer-cascade-header", "mt-drawer-modal"], text: "" },
  };

  it.each(Object.entries(allowed))("allows %s", (_name, descriptor) => {
    expect(core.clickRefusal(descriptor)).toBeNull();
  });

  const refused = {
    placeOrder: { tag: "BUTTON", type: "button", classes: ["comet-v2-btn", "place-order-primary-btn"], text: "Place order" },
    placeOrderInnerSpan: { tag: "SPAN", classes: [], ancestorClasses: ["pl-order-toal-container__btn-box", "pl-order-toal-container"], text: "" },
    addressConfirm: { tag: "BUTTON", type: "button", classes: ["next-btn", "next-btn-primary"], ancestorClasses: ["next-dialog-footer"], text: "Confirm", inForm: false },
    addressConfirmVi: { tag: "BUTTON", type: "button", classes: ["next-btn"], text: "Xác nhận" },
    untypedButtonInForm: { tag: "BUTTON", type: null, classes: ["next-btn"], text: "Cancel", inForm: true },
    submitButton: { tag: "BUTTON", type: "submit", text: "Next" },
    submitInput: { tag: "INPUT", type: "submit" },
    form: { tag: "FORM", classes: ["deliver-address-form"] },
    defaultCheckbox: { tag: "INPUT", type: "checkbox", ancestorClasses: ["next-checkbox-wrapper"] },
    defaultCheckboxLabel: { tag: "LABEL", classes: ["next-checkbox-wrapper"], text: "Set as default shipping address" },
    roleCheckbox: { tag: "SPAN", role: "checkbox", text: "Default" },
    ariaChecked: { tag: "SPAN", ariaChecked: true, text: "Default" },
    paymentRadio: { tag: "INPUT", type: "radio" },
    paymentMethod: { tag: "DIV", classes: ["pl-card-item"], ancestorClasses: ["pl-payment-method-container"], text: "Visa" },
    walletArea: { tag: "DIV", ancestorClasses: ["pay-wallet"], text: "Balance" },
    payNow: { tag: "DIV", text: "Pay now" },
    checkoutButton: { tag: "A", text: "Checkout" },
    checkoutClass: { tag: "DIV", classes: ["cart-checkout-btn"], text: "" },
    buyNow: { tag: "BUTTON", type: "button", classes: ["buy-now--buynow--Ab3cD"], text: "Buy now" },
    buyNowVi: { tag: "BUTTON", type: "button", text: "Mua ngay" },
    payVi: { tag: "DIV", text: "Thanh toán" },
    ariaLabelled: { tag: "DIV", ariaLabel: "Place order" },
    containerOfForbidden: { tag: "DIV", classes: ["pl-block-container"], containsForbidden: true },
    // The comet drawer and page (measured 2026-09-15).
    payNowButton: { tag: "BUTTON", type: "button", classes: ["comet-btn", "comet-btn-primary", "place-order-primary-btn"], text: "Pay now" },
    cometSave: { tag: "BUTTON", type: "button", classes: ["comet-btn", "form-button-confirm"], ancestorClasses: ["deliver-address-wrap"], text: "Save" },
    cometSaveVi: { tag: "BUTTON", type: "button", classes: ["form-button-confirm"], text: "Lưu" },
    defaultSwitch: { tag: "DIV", classes: ["mt-switch", "switcher"], ancestorClasses: ["deliver-address-wrap"], text: "" },
    defaultSwitchKnob: { tag: "DIV", classes: ["mt-switch-knob"], ancestorClasses: ["mt-switch", "switcher"], text: "" },
    addressRadioLabel: { tag: "LABEL", classes: ["comet-radio", "comet-radio-checked"], ancestorClasses: ["ae-address-item-wrapper", "cm-address-list"], text: "" },
    addressRadioInput: { tag: "INPUT", type: "radio", classes: ["comet-radio-input"] },
    addressEdit: { tag: "SPAN", classes: ["ae-address-item-edit-btn"], ancestorClasses: ["ae-address-item-wrapper"], text: "" },
    addressDelete: { tag: "I", classes: ["comet-icon"], ancestorClasses: ["ae-address-item-delete-btn", "ae-address-item-wrapper"], text: "" },
    paymentChange: { tag: "BUTTON", type: "button", classes: ["comet-btn-link", "chosen-channel--chosen-channel-change-btn"], ancestorClasses: ["placeorder-page-payment-container"], text: "Change" },
    quantityPlus: { tag: "SPAN", classes: ["comet-input-number-handler"], ancestorClasses: ["comet-input-number"], text: "+" },
    couponRow: { tag: "DIV", classes: ["pl-coupon-item"], text: "Apply" },
  };

  it.each(Object.entries(refused))("refuses %s", (_name, descriptor) => {
    expect(core.clickRefusal(descriptor)).toEqual(expect.any(String));
  });

  it("refuses a missing descriptor", () => {
    expect(core.clickRefusal(null)).toEqual(expect.any(String));
  });

  // A click bubbles, and the browser activates the nearest button, label or
  // input around the node clicked. The guard judges those as well.
  describe("controls around the element, which the click would activate", () => {
    const span = (activators: object[]) => ({ tag: "SPAN", classes: [], ancestorClasses: ["deliver-address-form"], text: "Enter manually", inForm: true, activators });

    it("refuses a span inside an untyped button in a form, which submits it", () => {
      expect(core.clickRefusal(span([]))).toBeNull();
      expect(core.clickRefusal(span([{ tag: "BUTTON", type: null, classes: ["comet-btn"], text: "Enter manually", inForm: true }]))).toMatch(/submits a form/);
    });

    it("refuses a span inside a submit button, in a form or not", () => {
      expect(core.clickRefusal({ ...span([{ tag: "BUTTON", type: "submit", classes: [], text: "Enter manually", inForm: false }]), inForm: false })).toMatch(/submits a form/);
    });

    it("refuses a span inside a label whose control is a checkbox", () => {
      const label = { tag: "LABEL", classes: [], text: "Set as default shipping address", control: { tag: "INPUT", type: "checkbox", classes: [] } };
      expect(core.clickRefusal({ tag: "SPAN", classes: [], text: "Set as default shipping address", inForm: true, activators: [label] })).toMatch(/checkbox/);
      // The label itself, clicked directly, with the checkbox elsewhere in the page (label for="…").
      expect(core.clickRefusal(label)).toMatch(/checkbox/);
      expect(core.clickRefusal({ ...label, control: { tag: "INPUT", type: "text", classes: [] } })).toBeNull();
    });

    it("refuses a span inside Place order or a payment choice, whatever its own classes", () => {
      expect(core.clickRefusal(span([{ tag: "BUTTON", type: "button", classes: ["place-order-primary-btn"], text: "" }]))).toMatch(/Place order/);
      expect(core.clickRefusal({ tag: "SPAN", text: "Visa", activators: [{ tag: "DIV", role: "radio", text: "Visa" }] })).toMatch(/payment choice/);
    });

    it("allows a span inside a plain button that commits nothing", () => {
      expect(core.clickRefusal(span([{ tag: "BUTTON", type: "button", classes: ["comet-btn"], text: "Enter manually", inForm: true }]))).toBeNull();
      expect(core.clickRefusal({ tag: "SPAN", text: "Add new address", activators: [{ tag: "A", classes: [], text: "Add new address", inForm: false }] })).toBeNull();
    });
  });
});

describe("the checkout job", () => {
  const order = {
    id: "po_cm123456",
    orderName: "#1001",
    platform: "ALIEXPRESS",
    currency: "USD",
    totalCost: "8.99",
    shippingAddress: {
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      phone: "+15125550100",
      address1: "1 Main St",
      address2: null,
      city: "Austin",
      province: "Texas",
      provinceCode: "TX",
      zip: "78701",
      country: "United States",
      countryCode: "us",
      email: "jane@example.com",
    },
    items: [
      { title: "Earbuds", variantLabel: "Color: Black", quantity: 2, externalProductId: US_ID, externalSkuId: SKU_ID, skuAttr: SKU_ATTR, carrierCode: "CAINIAO_FULFILLMENT_STD", unitCost: "3.50", currency: "USD" },
      { title: "Case", variantLabel: null, quantity: 1, externalProductId: GLOBAL_ID, externalSkuId: "1", skuAttr: null, carrierCode: "bad code!", unitCost: "1.00", currency: "USD" },
    ],
  };

  it("keeps what a checkout needs and nothing it does not", () => {
    const { job, error } = core.buildJob(order, 7, 1_000);
    expect(error).toBeUndefined();
    expect(job).toMatchObject({ tabId: 7, purchaseOrderId: "po_cm123456", orderName: "#1001", currency: "USD", expectedTotal: "8.99", itemIndex: 0, stage: "product", startedAt: 1_000 });
    expect(job.recordedOrderIds).toEqual([[], []]);
    expect(job.address).toMatchObject({ firstName: "Jane", lastName: "Doe", countryCode: "US", provinceCode: "TX" });
    expect(JSON.stringify(job)).not.toContain("jane@example.com");
    expect(job.items[0]).toMatchObject({ externalProductId: GLOBAL_ID, externalSkuId: SKU_ID, carrierCode: "CAINIAO_FULFILLMENT_STD", quantity: 2 });
    expect(job.items[1].carrierCode).toBeNull();
  });

  it("recognises a purchase order id, and nothing else", () => {
    expect(core.isPurchaseOrderId("po_cm123456")).toBe(true);
    expect(core.isPurchaseOrderId("short")).toBe(false);
    expect(core.isPurchaseOrderId("../../etc/passwd")).toBe(false);
    expect(core.isPurchaseOrderId(12345678)).toBe(false);
  });

  it("refuses orders a checkout cannot open", () => {
    expect(core.buildJob(null, 1, 0).error).toBeTruthy();
    expect(core.buildJob({ ...order, id: "x" }, 1, 0).error).toMatch(/valid id/);
    expect(core.buildJob({ ...order, platform: "CJ" }, 1, 0).error).toMatch(/Only AliExpress/);
    expect(core.buildJob({ ...order, items: [] }, 1, 0).error).toMatch(/no items/);
    expect(core.buildJob({ ...order, items: [{ ...order.items[0], externalSkuId: null }] }, 1, 0).error).toMatch(/not linked/);
    expect(core.buildJob({ ...order, items: [{ ...order.items[0], quantity: 0 }] }, 1, 0).error).toMatch(/quantity/);
    expect(core.buildJob({ ...order, shippingAddress: { ...order.shippingAddress, countryCode: null } }, 1, 0).error).toMatch(/country/);
  });

  it("expires after a few hours, and collects order numbers once each", () => {
    const { job } = core.buildJob(order, 7, 10_000_000);
    expect(core.isJobExpired(job, 10_000_000 + 60_000)).toBe(false);
    expect(core.isJobExpired(job, 10_000_000 + core.JOB_MAX_AGE_MS + 1)).toBe(true);
    expect(core.isJobExpired({ ...job, startedAt: undefined }, 10_000_000)).toBe(true);
    expect(core.isJobExpired(job, 10_000_000 - 3_600_000)).toBe(true);
    expect(core.isJobExpired(null, 0)).toBe(true);

    expect(core.isLastItem(job)).toBe(false);
    expect(core.isLastItem({ ...job, itemIndex: 1 })).toBe(true);
    expect(core.jobOrderIds({ ...job, recordedOrderIds: [["8190000000000001"], ["8190000000000002", "8190000000000001"]] })).toEqual(["8190000000000001", "8190000000000002"]);
    expect(core.jobOrderIds({})).toEqual([]);
  });

  it("explains the placed endpoint's refusals", () => {
    expect(core.explainRefusal(401, {})).toMatch(/token/);
    expect(core.explainRefusal(409, { error: "already recorded as supplier order 1" })).toBe("Not saved: already recorded as supplier order 1");
    expect(core.explainRefusal(404, {})).toMatch(/no longer in DropshipHub/);
    expect(core.explainRefusal(400, { error: "externalOrderIds bad" })).toMatch(/externalOrderIds bad/);
    expect(core.explainRefusal(413, {})).toMatch(/too long/);
    expect(core.explainRefusal(429, {})).toMatch(/too many requests/);
    expect(core.explainRefusal(500, null)).toBe("Not saved: the app answered 500.");
  });
});
