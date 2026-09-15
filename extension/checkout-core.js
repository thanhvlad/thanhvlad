/* global BigInt, globalThis */

/**
 * The checkout assist's logic that needs no page: everything the background
 * worker and the checkout content script decide from plain values.
 *
 * It is one plain script rather than a module because Chrome loads content
 * scripts as classic scripts and a service worker pulls it in with
 * importScripts; both see it as `globalThis.DropshipHubCheckout`. In a content
 * script that global lives in the extension's isolated world, never the
 * page's, so nothing here is reachable by AliExpress's own JavaScript. Keeping
 * it free of DOM and chrome.* calls is also what lets the tests evaluate it in
 * a bare node:vm context.
 *
 * Page facts come from docs/ALIEXPRESS_PAGE_MODEL.md, measured on a real
 * logged-in account on 2026-09-14/15.
 */
(function attach(root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Product ids and hosts
  // ---------------------------------------------------------------------------

  /**
   * A US-routed account is redirected from aliexpress.com to aliexpress.us,
   * where the same product carries the global id plus 2^51. The measured sum
   * still fits in a double, with less than a factor of three to spare: a
   * larger id would round to its neighbour and open a different product or
   * none, with nothing to show that it had. BigInt keeps the arithmetic exact
   * for any id AliExpress issues.
   */
  const REGIONAL_OFFSET = 2n ** 51n;
  const DIGITS = /^\d{1,20}$/;

  function globalProductId(id) {
    const text = String(id ?? "").trim();
    if (!DIGITS.test(text)) return null;
    const value = BigInt(text);
    return (value >= REGIONAL_OFFSET ? value - REGIONAL_OFFSET : value).toString();
  }

  function isUsHost(hostname) {
    return /(^|\.)aliexpress\.us$/i.test(String(hostname ?? ""));
  }

  function isAliExpressHost(hostname) {
    return /(^|\.)aliexpress\.(com|us)$/i.test(String(hostname ?? ""));
  }

  /** The id a product has on `hostname`, from the id stored for it (either form). */
  function productIdForHost(storedId, hostname) {
    const global = globalProductId(storedId);
    if (global === null) return null;
    return isUsHost(hostname) ? (BigInt(global) + REGIONAL_OFFSET).toString() : global;
  }

  /** Whether two ids name the same product, whichever host each came from. */
  function sameProduct(a, b) {
    const left = globalProductId(a);
    return left !== null && left === globalProductId(b);
  }

  function parseUrl(raw) {
    try {
      return new URL(String(raw));
    } catch {
      return null;
    }
  }

  /**
   * The product page a checkout opens for an item. Always the global host with
   * the global id: AliExpress redirects to the account's regional host itself,
   * and the content script reads the id that host uses from the page.
   */
  function productPageUrl(storedId) {
    const global = globalProductId(storedId);
    return global === null ? null : `https://www.aliexpress.com/item/${global}.html`;
  }

  function isProductPage(raw) {
    const url = parseUrl(raw);
    return Boolean(url && url.protocol === "https:" && isAliExpressHost(url.hostname) && /^\/(item|i)\/\d+\.html$/i.test(url.pathname));
  }

  function productIdFromUrl(raw) {
    const url = parseUrl(raw);
    const match = url ? /^\/(?:item|i)\/(\d+)\.html$/i.exec(url.pathname) : null;
    return match ? match[1] : null;
  }

  function isConfirmPage(raw) {
    const url = parseUrl(raw);
    return Boolean(url && url.protocol === "https:" && isAliExpressHost(url.hostname) && url.pathname === "/p/trade/confirm.html");
  }

  // ---------------------------------------------------------------------------
  // The confirm page URL
  // ---------------------------------------------------------------------------

  const COUNTRY_CODE = /^[A-Z]{2}$/;
  const CARRIER_CODE = /^[A-Za-z0-9_-]{1,64}$/;
  const MAX_QUANTITY = 9999;

  /**
   * The confirm page "Buy now" opens, built for a SKU directly. The parameter
   * order and the empty provinceCode/cityCode/from/aeOrderFrom values are the
   * ones recorded from AliExpress's own navigation. Every value is encoded
   * with encodeURIComponent rather than URLSearchParams, whose "+" for a space
   * would reach AliExpress as a literal plus inside skuAttr ("Play blue light").
   * Returns null for anything that does not validate, so a malformed purchase
   * order never becomes a checkout for something else.
   */
  function buildConfirmUrl(input) {
    const origin = parseUrl(input?.origin);
    if (!origin || origin.protocol !== "https:" || !isAliExpressHost(origin.hostname)) return null;
    const objectId = String(input.objectId ?? "");
    const skuId = String(input.skuId ?? "");
    const quantity = Number(input.quantity);
    const countryCode = String(input.countryCode ?? "");
    const skuAttr = typeof input.skuAttr === "string" ? input.skuAttr : "";
    const carrier = input.shippingCompany == null ? "" : String(input.shippingCompany);
    if (!DIGITS.test(objectId) || !DIGITS.test(skuId)) return null;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return null;
    if (!COUNTRY_CODE.test(countryCode)) return null;
    if (skuAttr.length > 1000) return null;
    if (carrier && !CARRIER_CODE.test(carrier)) return null;

    const params = [
      ["objectId", objectId],
      ["skuId", skuId],
      ["skuAttr", skuAttr],
      ["quantity", String(quantity)],
      ["countryCode", countryCode],
    ];
    if (carrier) params.push(["shippingCompany", carrier]);
    params.push(["provinceCode", ""], ["cityCode", ""], ["from", "aliexpress"], ["aeOrderFrom", "main_detail"]);
    const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `${origin.origin}/p/trade/confirm.html?${query}`;
  }

  function readConfirmUrl(raw) {
    const url = parseUrl(raw);
    if (!url) return null;
    const get = (name) => url.searchParams.get(name);
    return {
      objectId: get("objectId"),
      skuId: get("skuId"),
      skuAttr: get("skuAttr"),
      quantity: get("quantity"),
      countryCode: get("countryCode"),
      shippingCompany: get("shippingCompany"),
    };
  }

  /**
   * What on the confirm page's URL differs from the item being bought. The
   * merchant can change the SKU, quantity or destination on that page, and a
   * checkout for the wrong one is money spent on the wrong goods.
   */
  function confirmUrlMismatches(raw, item, countryCode) {
    const read = readConfirmUrl(raw);
    if (!read) return ["The page address could not be read."];
    const problems = [];
    if (!sameProduct(read.objectId, item?.externalProductId)) problems.push("The product on this page is not the item's product.");
    if (read.skuId !== String(item?.externalSkuId ?? "")) problems.push("The variant (skuId) on this page is not the item's variant.");
    if (read.quantity !== String(item?.quantity ?? "")) problems.push(`The quantity on this page is ${read.quantity ?? "missing"}, not ${item?.quantity}.`);
    if (read.countryCode !== String(countryCode ?? "")) problems.push(`The destination on this page is ${read.countryCode ?? "missing"}, not ${countryCode}.`);
    return problems;
  }

  /**
   * Whether the product page offers the item's SKU in the quantity wanted.
   * `skus` is what page-reader.js reads from the page's own SKU.skuPaths.
   */
  function skuAvailability(skus, skuId, quantity) {
    const wanted = String(skuId ?? "");
    const row = Array.isArray(skus) ? skus.find((s) => s && String(s.skuId) === wanted) : null;
    if (!row) return { ok: false, reason: "missing" };
    const stock = Number.isFinite(row.availQuantity) ? row.availQuantity : null;
    if (row.salable === false || stock === 0) return { ok: false, reason: "out-of-stock", skuAttr: row.skuAttr ?? null };
    if (stock !== null && stock < Number(quantity)) return { ok: false, reason: "not-enough", available: stock, skuAttr: row.skuAttr ?? null };
    return { ok: true, skuAttr: typeof row.skuAttr === "string" ? row.skuAttr : null };
  }

  // ---------------------------------------------------------------------------
  // AliExpress order numbers
  // ---------------------------------------------------------------------------

  /** The same rule the popup and the server apply to a reported order number. */
  const ORDER_NUMBER = /^[A-Za-z0-9_-]{1,64}$/;

  function parseOrderNumbers(raw) {
    const ids = [...new Set(String(raw ?? "").split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))];
    if (ids.length === 0) return { error: "Enter the AliExpress order number." };
    if (ids.length > 20) return { error: "Enter at most 20 order numbers." };
    const bad = ids.find((id) => !ORDER_NUMBER.test(id) || /^mock-/i.test(id));
    if (bad) return { error: `"${bad.slice(0, 40)}" is not an AliExpress order number. Copy it from the order in your AliExpress account.` };
    return { ids };
  }

  /**
   * Order ids a page address seems to carry after Place order. The page shown
   * then has NOT been measured, so this only proposes numbers for the merchant
   * to confirm; it never records anything by itself. AliExpress order numbers
   * are long digit strings, and short numbers in these parameters are ignored.
   */
  function orderIdsFromUrl(raw) {
    const url = parseUrl(raw);
    if (!url || !isAliExpressHost(url.hostname)) return [];
    const values = [...url.searchParams.getAll("orderId"), ...url.searchParams.getAll("orderIds")];
    const ids = values.flatMap((v) => v.split(/[\s,;|]+/)).map((v) => v.trim()).filter((v) => /^\d{12,20}$/.test(v));
    return [...new Set(ids)].slice(0, 20);
  }

  // ---------------------------------------------------------------------------
  // Address values for the US form
  // ---------------------------------------------------------------------------

  const STREET_MAX = 35;
  const STREET_MIN = 5;

  function collapse(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  /**
   * AliExpress's US Street box takes 5 to 35 characters including the house
   * number; a longer line is refused when the merchant presses Confirm. The
   * line is cut at the last space that keeps it within 35, and what is left
   * goes in front of address2 in "Apt, suite, unit", so nothing of the
   * customer's address is dropped. A first word longer than the box is cut
   * hard, because there is no word boundary to use.
   */
  function splitStreet(address1, address2, max = STREET_MAX) {
    const line1 = collapse(address1);
    const line2 = collapse(address2);
    if (line1.length <= max) return { street: line1, unit: line2, moved: "", tooShort: line1.length < STREET_MIN };
    const cut = line1.slice(0, max + 1).lastIndexOf(" ");
    const head = cut >= STREET_MIN ? line1.slice(0, cut) : line1.slice(0, max);
    const rest = cut >= STREET_MIN ? line1.slice(cut + 1) : line1.slice(max);
    const street = head.replace(/[\s,]+$/, "");
    const moved = rest.replace(/^[\s,]+/, "").trim();
    return { street, unit: [moved, line2].filter(Boolean).join(", "), moved, tooShort: street.length < STREET_MIN };
  }

  /**
   * The Mobile number box wants the national number: the country code sits in
   * its own box beside it (+1 on the US form). A number typed with the code
   * again became "+1 15125550100" and failed AliExpress's length check.
   * `matchesDialCode` is false for a number written with another country's
   * code, which the merchant must look at rather than have silently rewritten.
   */
  function nationalPhone(raw, dialCode) {
    const dial = String(dialCode ?? "").replace(/\D/g, "");
    const text = String(raw ?? "").split(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i)[0].trim();
    let international = text.startsWith("+");
    let digits = text.replace(/\D/g, "");
    if (!international && text.startsWith("00")) {
      international = true;
      digits = digits.slice(2);
    }
    if (international) {
      if (dial && digits.startsWith(dial)) return { number: digits.slice(dial.length), matchesDialCode: true };
      return { number: digits, matchesDialCode: !dial };
    }
    // A North American number written as 1 + ten digits carries the code without the plus.
    if (dial === "1" && digits.length === 11 && digits.startsWith("1")) return { number: digits.slice(1), matchesDialCode: true };
    return { number: digits, matchesDialCode: true };
  }

  /** Case-, accent- and spacing-insensitive form of an option title. */
  function normalizeTitle(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** The first option title equal to one of the candidates, or null. Never a partial match. */
  function matchOption(titles, candidates) {
    const list = Array.isArray(titles) ? titles : [];
    for (const candidate of (Array.isArray(candidates) ? candidates : [candidates]).map(normalizeTitle).filter(Boolean)) {
      const hit = list.find((t) => normalizeTitle(t) === candidate);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  /**
   * The City option for a customer's city. AliExpress's list per state is
   * fixed and always ends in "Other"; a city it does not know gets "Other"
   * with `isOther` set, so the panel can tell the merchant to check it rather
   * than pick a similarly named town.
   */
  function chooseCityOption(titles, city) {
    const exact = matchOption(titles, [city]);
    if (exact !== null) return { title: exact, isOther: false };
    const other = matchOption(titles, ["Other"]);
    return other !== null ? { title: other, isOther: true } : null;
  }

  function countryName(code) {
    const value = String(code ?? "").toUpperCase();
    if (!COUNTRY_CODE.test(value)) return null;
    try {
      const name = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(value);
      return name || null;
    } catch {
      return null;
    }
  }

  /** Names the Country/region select may use; only the first one is typed to filter. */
  function countryTitleCandidates(code) {
    const aliases = { US: ["United States", "United States of America", "USA"] };
    const name = countryName(code);
    return [...new Set([name, ...(aliases[String(code ?? "").toUpperCase()] ?? [])].filter(Boolean))];
  }

  const US_STATES = Object.freeze({
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
    KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
    MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
    NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
    TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", GU: "Guam",
    VI: "Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands",
  });

  /** "TX" -> "Texas", also for a code written "US-TX". */
  function usStateName(code) {
    const value = String(code ?? "").toUpperCase().replace(/^US-/, "");
    return Object.prototype.hasOwnProperty.call(US_STATES, value) ? US_STATES[value] : null;
  }

  /**
   * State option titles are full names. Shopify's province is usually the
   * full name already, but an order imported with only a code ("TX") would
   * otherwise match nothing.
   */
  function stateTitleCandidates(province, provinceCode) {
    return [...new Set([collapse(province), usStateName(provinceCode), usStateName(province)].filter(Boolean))];
  }

  /**
   * Whether the open address form is the US form the fill was written for.
   * Inputs carry no name or id and their placeholders are localized, so fields
   * are found by position; the checks below are what makes position safe. A
   * different country re-renders a different form (Vietnam uses province,
   * district and ward), and typing a street into its third box would put the
   * customer's address in the wrong fields, so anything else stops the fill.
   *
   * `plainInputs` are the form's text inputs outside its selects, in order.
   */
  function usFormStructure(snapshot) {
    const inputs = Array.isArray(snapshot?.plainInputs) ? snapshot.plainInputs : [];
    const selects = Number(snapshot?.selectCount) || 0;
    if (inputs.length !== 8) {
      return { ok: false, reason: `The form has ${inputs.length} text boxes, not the 8 of the US address form DropshipHub knows.` };
    }
    if (selects < 4) return { ok: false, reason: `The form has ${selects} drop-downs, not the 4 of the US address form.` };
    const dial = String(inputs[2]?.value ?? "").trim();
    if (!/^\+\d{1,4}$/.test(dial)) return { ok: false, reason: "The third box is not the phone country code." };
    if (dial !== "+1") return { ok: false, reason: `The phone country code is ${dial}, not +1 for the United States.` };
    const zipLike = /(^|\D)\d{5}(\D|$)/;
    if (!zipLike.test(String(inputs[6]?.placeholder ?? ""))) return { ok: false, reason: "The seventh box does not look like the ZIP box." };
    const misplaced = [0, 1, 3, 4, 5, 7].find((i) => zipLike.test(String(inputs[i]?.placeholder ?? "")));
    if (misplaced !== undefined) return { ok: false, reason: "The boxes are not in the order of the US address form." };
    return { ok: true, dialCode: dial };
  }

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------

  /**
   * Ordered: a symbol several currencies share ("$") is tried after the
   * specific forms ("C$", "US $"). Codes are matched in capitals only, so the
   * word "try" in a label is not Turkish lira.
   */
  const CURRENCY_HINTS = [
    [/\bVND\b|₫|\d\s?đ(?![A-Za-z])/, "VND"],
    [/\bUSD\b|US\s?\$/, "USD"],
    [/\bCAD\b|CA?\$/, "CAD"],
    [/\bAUD\b|AU?\$/, "AUD"],
    [/\bNZD\b|NZ\$/, "NZD"],
    [/\bBRL\b|R\$/, "BRL"],
    [/\bMXN\b|MX\$/, "MXN"],
    [/\bEUR\b|€/, "EUR"],
    [/\bGBP\b|£/, "GBP"],
    [/\bRUB\b|₽/, "RUB"],
    [/\bKRW\b|₩/, "KRW"],
    [/\bJPY\b/, "JPY"],
    [/\bCNY\b/, "CNY"],
    [/\bPLN\b|zł/, "PLN"],
    [/\bTRY\b|₺/, "TRY"],
    [/\bINR\b|₹/, "INR"],
    [/\$/, "USD"],
  ];

  /**
   * One amount: groups of three digits with ONE repeated separator (".", ",",
   * space, apostrophe), then an optional one- or two-digit decimal part.
   * "₫2.861.602" is 2861602, "US $1,234.56" is 1234.56, "1.234,56 €" is
   * 1234.56, "12,40" is 12.4. A single separator before exactly three digits
   * is read as a thousands separator: VND, the currency the measured account
   * displayed, has no minor unit, and a three-decimal price is not shown.
   */
  const AMOUNT_TOKEN = /\d{1,3}([.,' ’])\d{3}(?:\1\d{3})*(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)/g;

  function parseMoneyText(text) {
    if (typeof text !== "string") return null;
    const clean = text.replace(/[  ]/g, " ");
    const tokens = [...clean.matchAll(AMOUNT_TOKEN)];
    if (tokens.length === 0) return null;
    // The total row may also say how many items it covers; the amount comes last.
    const token = tokens[tokens.length - 1];
    const raw = token[0];
    const group = token[1];
    // Groups always end in three digits, so one or two digits after the last
    // separator can only be the decimal part.
    const decimal = /[.,](\d{1,2})$/.exec(raw);
    const integerPart = decimal ? raw.slice(0, raw.length - decimal[0].length) : raw;
    const fraction = decimal ? decimal[1] : "";
    const integer = group ? integerPart.split(group).join("") : integerPart;
    if (!/^\d+$/.test(integer)) return null;
    const amount = Number(fraction ? `${integer}.${fraction}` : integer);
    if (!Number.isFinite(amount)) return null;
    let currency = null;
    for (const [pattern, code] of CURRENCY_HINTS) {
      if (pattern.test(clean)) {
        currency = code;
        break;
      }
    }
    return { amount, currency };
  }

  function formatAmount(amount, currency) {
    const digits = currency === "VND" || currency === "JPY" || currency === "KRW" ? 0 : 2;
    return `${Number(amount).toFixed(digits)} ${currency ?? ""}`.trim();
  }

  /**
   * What DropshipHub expects this checkout to cost. A one-item purchase order
   * is compared whole, shipping estimate included. With several items each
   * AliExpress checkout covers one item, so only that item's goods can be
   * compared, and shipping comes on top.
   */
  function decimal(value) {
    // Number(null) and Number("") are 0, which would read as "expects nothing".
    return /^\d+(\.\d+)?$/.test(String(value ?? "").trim()) ? Number(value) : null;
  }

  function expectedCost(job) {
    const items = Array.isArray(job?.items) ? job.items : [];
    const item = items[job?.itemIndex ?? 0];
    if (items.length <= 1) {
      const total = decimal(job?.expectedTotal);
      return total !== null ? { amount: total, currency: job.currency, scope: "order" } : null;
    }
    const unit = decimal(item?.unitCost);
    if (!item || unit === null) return null;
    return { amount: Math.round(unit * Number(item.quantity) * 100) / 100, currency: item.currency || job.currency, scope: "item" };
  }

  /**
   * Compares the page's total with the expectation, as a warning only. The
   * page shows the account's display currency, which on the measured account
   * was VND whatever the host, so a total in another currency is shown beside
   * the expectation without a verdict: converting it here would be a guess.
   */
  function compareTotals(expected, pageText) {
    const page = parseMoneyText(pageText);
    if (!expected) return { kind: "no-expectation", page };
    if (!page) return { kind: "unreadable", page: null };
    if (!page.currency || page.currency !== expected.currency) return { kind: "other-currency", page };
    const tolerance = Math.max(expected.amount * 0.1, 0.5);
    if (page.amount > expected.amount + tolerance) return { kind: "higher", page };
    if (page.amount < expected.amount - tolerance) return { kind: "lower", page };
    return { kind: "close", page };
  }

  // ---------------------------------------------------------------------------
  // The click guard
  // ---------------------------------------------------------------------------

  const COMMIT_WORDS = /\b(place\s+order|pay(\s+now)?|checkout|check\s+out|buy\s+now|confirm|submit|save)\b/i;
  const COMMIT_WORDS_VI = /(đặt hàng|thanh toán|mua ngay|xác nhận|lưu)/i;
  const PAYMENT_CLASS = /(^|[-_])(pay|payment|payments|wallet|billing)([-_]|$)/i;
  // Only on the element itself: the whole confirm page may sit in a wrapper
  // named for checkout, and refusing every click under it would refuse the fill.
  const CHECKOUT_CLASS = /(^|[-_])(checkout|place-?order|buy-?now)([-_]|$)/i;

  /**
   * Why a click on this element must not happen, or null when it may.
   *
   * Every programmatic click in the checkout content script goes through this
   * one classifier. The extension helps the merchant fill an address; it must
   * never commit their AliExpress account to anything, and a selector that
   * drifts after an AliExpress release could otherwise land a "helpful" click
   * on Place order, Pay, a payment method or the address form's Confirm. The
   * rules are deliberately broader than those controls: a refused click only
   * means the merchant clicks that one thing themselves.
   *
   * `d` is a plain descriptor the content script builds from the element:
   * { tag, type, role, classes, ancestorClasses, text, ariaLabel, title,
   *   inForm, ariaChecked, containsForbidden }.
   */
  function clickRefusal(d) {
    if (!d || typeof d !== "object") return "Nothing to click.";
    const tag = String(d.tag ?? "").toLowerCase();
    const type = String(d.type ?? "").toLowerCase();
    const role = String(d.role ?? "").toLowerCase();
    const classes = Array.isArray(d.classes) ? d.classes.map(String) : [];
    const ancestors = Array.isArray(d.ancestorClasses) ? d.ancestorClasses.map(String) : [];
    const all = [...classes, ...ancestors];

    if (all.some((c) => c === "place-order-primary-btn" || c.startsWith("pl-order-toal-container__btn-box"))) {
      return "It is AliExpress's Place order control.";
    }
    if (all.some((c) => PAYMENT_CLASS.test(c))) return "It is in a payment area.";
    if (classes.some((c) => CHECKOUT_CLASS.test(c) || /buy-now--buynow/.test(c))) return "It is a checkout or Buy now control.";
    if (tag === "form") return "It is a form.";
    if (tag === "input" && ["submit", "image", "checkbox", "radio", "reset"].includes(type)) {
      return type === "checkbox" || type === "radio" ? "It is a checkbox or payment choice." : "It submits a form.";
    }
    if (tag === "button" && (type === "submit" || (!type && d.inForm))) return "It submits a form.";
    if (role === "checkbox" || role === "radio" || role === "switch" || d.ariaChecked || classes.some((c) => /checkbox|radio/i.test(c))) {
      return "It is a checkbox or payment choice.";
    }
    if (d.containsForbidden) return "It contains a control DropshipHub never clicks.";
    const words = [d.text, d.ariaLabel, d.title].map((v) => String(v ?? "")).join(" ");
    if (COMMIT_WORDS.test(words) || COMMIT_WORDS_VI.test(words)) return "Its label commits an order, a payment or the address.";
    return null;
  }

  // ---------------------------------------------------------------------------
  // The checkout job
  // ---------------------------------------------------------------------------

  /**
   * A job older than this is discarded. It holds a customer's address, and a
   * checkout abandoned in the morning should not reappear in a tab opened in
   * the afternoon.
   */
  const JOB_MAX_AGE_MS = 4 * 3_600_000;
  const PURCHASE_ORDER_ID = /^[A-Za-z0-9_-]{8,64}$/;

  function shortText(value, max = 300) {
    return value == null ? null : String(value).slice(0, max);
  }

  /** The job for one tab, built from an order the popup got from GET /api/extension/orders. */
  function buildJob(order, tabId, now) {
    if (!order || typeof order !== "object") return { error: "No order to check out." };
    if (!PURCHASE_ORDER_ID.test(String(order.id ?? ""))) return { error: "The order has no valid id." };
    if (order.platform && order.platform !== "ALIEXPRESS") return { error: "Only AliExpress orders can be checked out from the extension." };
    const rawItems = Array.isArray(order.items) ? order.items : [];
    if (rawItems.length === 0 || rawItems.length > 20) return { error: "The order has no items to check out." };
    const items = [];
    for (const item of rawItems) {
      const productId = globalProductId(item?.externalProductId);
      const skuId = String(item?.externalSkuId ?? "");
      const quantity = Number(item?.quantity);
      if (productId === null || !DIGITS.test(skuId)) return { error: `"${String(item?.title ?? "An item").slice(0, 60)}" is not linked to an AliExpress variant.` };
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return { error: "An item has an invalid quantity." };
      items.push({
        title: shortText(item.title, 200) ?? "",
        variantLabel: shortText(item.variantLabel, 200),
        quantity,
        externalProductId: productId,
        externalSkuId: skuId,
        skuAttr: shortText(item.skuAttr, 1000),
        carrierCode: item.carrierCode && CARRIER_CODE.test(String(item.carrierCode)) ? String(item.carrierCode) : null,
        unitCost: shortText(item.unitCost, 32),
        currency: shortText(item.currency, 3),
      });
    }
    const a = order.shippingAddress && typeof order.shippingAddress === "object" ? order.shippingAddress : {};
    const countryCode = String(a.countryCode ?? "").toUpperCase();
    if (!COUNTRY_CODE.test(countryCode)) return { error: "The order's shipping address has no country." };
    const address = {};
    for (const key of ["name", "firstName", "lastName", "company", "phone", "address1", "address2", "city", "province", "provinceCode", "zip", "country", "taxNumber"]) {
      address[key] = shortText(a[key]);
    }
    address.countryCode = countryCode;
    return {
      job: {
        tabId,
        purchaseOrderId: String(order.id),
        orderName: shortText(order.orderName, 60) ?? "",
        currency: shortText(order.currency, 3),
        expectedTotal: shortText(order.totalCost, 32),
        address,
        items,
        itemIndex: 0,
        recordedOrderIds: items.map(() => []),
        stage: "product",
        startedAt: now,
      },
    };
  }

  function isJobExpired(job, now) {
    return !job || !Number.isFinite(job.startedAt) || now - job.startedAt > JOB_MAX_AGE_MS || now < job.startedAt - 60_000;
  }

  function isLastItem(job) {
    return Array.isArray(job?.items) && job.itemIndex >= job.items.length - 1;
  }

  /** Every order number recorded for the purchase order so far, in item order, once each. */
  function jobOrderIds(job) {
    const lists = Array.isArray(job?.recordedOrderIds) ? job.recordedOrderIds : [];
    return [...new Set(lists.flatMap((ids) => (Array.isArray(ids) ? ids : [])))];
  }

  /** The popup's wording for a refusal from the placed endpoint, shared with the panel. */
  function explainRefusal(status, answer) {
    const reason = typeof answer?.error === "string" ? answer.error : "";
    if (status === 400) return `Not saved. Check what you entered: ${reason}`;
    if (status === 401) return "Not saved: the app refused the token. Check the token in the extension options.";
    if (status === 404) return "Not saved: this order is no longer in DropshipHub. Cancel this checkout.";
    if (status === 409) return `Not saved: ${reason}`;
    if (status === 413) return "Not saved: what you entered is too long.";
    if (status === 429) return `Not saved: ${reason || "too many requests. Try again in a minute."}`;
    return `Not saved: the app answered ${status}${reason ? ` (${reason})` : ""}.`;
  }

  root.DropshipHubCheckout = Object.freeze({
    REGIONAL_OFFSET,
    STREET_MAX,
    JOB_MAX_AGE_MS,
    US_STATES,
    globalProductId,
    productIdForHost,
    sameProduct,
    isAliExpressHost,
    isUsHost,
    productPageUrl,
    isProductPage,
    productIdFromUrl,
    isConfirmPage,
    buildConfirmUrl,
    readConfirmUrl,
    confirmUrlMismatches,
    skuAvailability,
    parseOrderNumbers,
    orderIdsFromUrl,
    splitStreet,
    nationalPhone,
    normalizeTitle,
    matchOption,
    chooseCityOption,
    countryName,
    countryTitleCandidates,
    usStateName,
    stateTitleCandidates,
    usFormStructure,
    parseMoneyText,
    formatAmount,
    expectedCost,
    compareTotals,
    clickRefusal,
    buildJob,
    isJobExpired,
    isLastItem,
    jobOrderIds,
    explainRefusal,
  });
})(globalThis);
