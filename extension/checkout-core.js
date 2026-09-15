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

  // Any id at or above 2^51 is read as regional. Global ids issued today are
  // about 1.005e15, well under 2^51 (2.25e15); if AliExpress ever issues a
  // global id past 2^51 this test misreads it, and the product check on the
  // page (sameProduct against the page's own productId) fails rather than
  // opening another product.
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

  /** The orders list (/p/order/index.html) and an order's detail page (/p/order/detail.html). */
  function isOrdersPage(raw) {
    const url = parseUrl(raw);
    return Boolean(url && url.protocol === "https:" && isAliExpressHost(url.hostname) && /^\/p\/order\//i.test(url.pathname));
  }

  function isOrderDetailPage(raw) {
    const url = parseUrl(raw);
    return Boolean(url && url.protocol === "https:" && isAliExpressHost(url.hostname) && /^\/p\/order\/detail\.html$/i.test(url.pathname));
  }

  function isTrackingPage(raw) {
    const url = parseUrl(raw);
    return Boolean(url && url.protocol === "https:" && isAliExpressHost(url.hostname) && /^\/p\/tracking\//i.test(url.pathname));
  }

  /** The orders list on the host the checkout tab is on, where the paid order appears. */
  function ordersPageUrl(origin) {
    const url = parseUrl(origin);
    if (!url || url.protocol !== "https:" || !isAliExpressHost(url.hostname)) return null;
    return `${url.origin}/p/order/index.html`;
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
    // Full names first: the first candidate is what gets typed to filter the
    // list, and typing "TX" filtered the State list down to nothing, because
    // "texas" does not contain "tx", before "Texas" could ever be matched.
    return [...new Set([usStateName(provinceCode), usStateName(province), collapse(province)].filter(Boolean))];
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
    // Exactly 4: State and City are taken as the third and fourth, and an extra
    // drop-down in front of them would shift both onto the wrong lists.
    if (selects !== 4) return { ok: false, reason: `The form has ${selects} drop-downs, not the 4 of the US address form.` };
    const dial = String(inputs[2]?.value ?? "").trim();
    if (!/^\+\d{1,4}$/.test(dial)) return { ok: false, reason: "The third box is not the phone country code." };
    if (dial !== "+1") return { ok: false, reason: `The phone country code is ${dial}, not +1 for the United States.` };
    const zipLike = /(^|\D)\d{5}(\D|$)/;
    if (!zipLike.test(String(inputs[6]?.placeholder ?? ""))) return { ok: false, reason: "The seventh box does not look like the ZIP box." };
    const misplaced = [0, 1, 3, 4, 5, 7].find((i) => zipLike.test(String(inputs[i]?.placeholder ?? "")));
    if (misplaced !== undefined) return { ok: false, reason: "The boxes are not in the order of the US address form." };
    return { ok: true, dialCode: dial };
  }

  /**
   * Whether "Set as default shipping address" is ticked: "ticked", "unticked"
   * or "missing". The fill never clicks that box, but the form it fills may
   * already have it ticked, for instance when the merchant opened the edit
   * form of their own default address. Filling that form would put the
   * customer's address over the merchant's default the moment they press
   * Confirm, so a ticked box stops the fill, and the panel says the box is
   * unticked only after reading it. Anything that is not clearly unticked
   * (aria-checked="mixed", a "checked" or "indeterminate" class) counts as
   * ticked.
   *
   * `boxes` describe every checkbox-like node of the address dialog:
   * { checked: boolean | null, ariaChecked: string | null, classes: string[] }.
   */
  function defaultBoxState(boxes) {
    const list = Array.isArray(boxes) ? boxes.filter((box) => box && typeof box === "object") : [];
    if (list.length === 0) return "missing";
    const ticked = list.some((box) => {
      const aria = String(box.ariaChecked ?? "").toLowerCase();
      const classes = Array.isArray(box.classes) ? box.classes.map(String) : [];
      return (
        box.checked === true ||
        aria === "true" ||
        aria === "mixed" ||
        classes.some((c) => /^(is-)?(checked|indeterminate)$|[-_](checked|indeterminate)$/i.test(c))
      );
    });
    return ticked ? "ticked" : "unticked";
  }

  /**
   * Positions of the address form's text boxes that already hold something
   * other than the customer's values. AliExpress uses the same form to edit a
   * saved address, and the fill overwrote that address with the customer's
   * name, phone and street, ready to be saved over the merchant's own. A new
   * address form is empty apart from the phone country code; a value the fill
   * itself typed on an earlier press is one of `intended` and is allowed, so
   * pressing Fill address again still works.
   */
  function foreignFormValues(values, intended) {
    const allowed = new Set((Array.isArray(intended) ? intended : []).map(normalizeTitle).filter(Boolean));
    const list = Array.isArray(values) ? values : [];
    const foreign = [];
    list.forEach((value, index) => {
      const text = collapse(value);
      if (!text || /^\+\d{1,4}$/.test(text) || allowed.has(normalizeTitle(text))) return;
      foreign.push(index);
    });
    return foreign;
  }

  /**
   * The keys whose value on the page is not the value the fill typed. A
   * React re-render can put a controlled input's old value back, and a State
   * or City change can clear the boxes after it, so the fill reads every box
   * back rather than report "Address filled" on the strength of having typed.
   */
  function mismatchedFields(expected, actual) {
    const want = expected && typeof expected === "object" ? expected : {};
    const have = actual && typeof actual === "object" ? actual : {};
    return Object.keys(want).filter((key) => collapse(want[key]) !== collapse(have[key]));
  }

  // ---------------------------------------------------------------------------
  // The comet address form (www.aliexpress.us in English, measured 2026-09-15)
  // ---------------------------------------------------------------------------

  /**
   * Field positions among the comet form's inputs (`.deliver-address-form
   * input`, twelve once "Enter manually" has been pressed). The inputs carry
   * no name, id or placeholder, so position is all there is, and
   * cometFormStructure is what makes position safe to type by.
   */
  const COMET_POSITIONS = Object.freeze({
    country: 0,
    firstName: 1,
    lastName: 2,
    dialCode: 3,
    phone: 4,
    search: 5,
    street: 6,
    unit: 7,
    state: 8,
    city: 9,
    zip: 10,
    instructions: 11,
    count: 12,
  });

  /** The comet boxes the fill types into, and the ones a saved address would show up in. */
  const COMET_TYPED = Object.freeze({ firstName: 1, lastName: 2, phone: 4, street: 6, unit: 7, zip: 10 });
  const COMET_TEXT_BOXES = Object.freeze([1, 2, 4, 6, 7, 10, 11]);

  /**
   * Whether the open comet form is the measured US add-address form.
   * `inputs` describe the form's inputs in order: { type, role, value }.
   * The country box must already show the United States: changing the
   * country there has not been measured, so the fill stops instead.
   */
  function cometFormStructure(snapshot, countryCandidates) {
    const inputs = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
    if (inputs.length !== COMET_POSITIONS.count) {
      return { ok: false, reason: `The form has ${inputs.length} boxes, not the ${COMET_POSITIONS.count} of the US address form DropshipHub knows.` };
    }
    const odd = inputs.findIndex((input) => NOT_TEXT_TYPES.has(String(input?.type ?? "").toLowerCase()));
    if (odd >= 0) return { ok: false, reason: `Box ${odd + 1} is not a text box.` };
    const dial = collapse(inputs[COMET_POSITIONS.dialCode]?.value);
    if (!/^\+\d{1,4}$/.test(dial)) return { ok: false, reason: "The fourth box is not the phone country code." };
    if (dial !== "+1") return { ok: false, reason: `The phone country code is ${dial}, not +1 for the United States.` };
    if (String(inputs[COMET_POSITIONS.search]?.role ?? "").toLowerCase() !== "combobox") {
      return { ok: false, reason: "The sixth box is not the address search box." };
    }
    const country = collapse(inputs[COMET_POSITIONS.country]?.value);
    if (matchOption([country], countryCandidates) === null) {
      return { ok: false, countryMismatch: true, reason: `The Country/region box shows "${country || "nothing"}", not the United States. Choose United States yourself, then press Fill address again.` };
    }
    return { ok: true, dialCode: dial };
  }

  const NOT_TEXT_TYPES = new Set(["checkbox", "radio", "hidden", "submit", "button", "image", "reset", "file"]);

  /**
   * The labels of a cascade list worth choosing from. At the state level the
   * list also holds single-letter headers ("A", "C") between the states; a
   * header is never an option.
   */
  function cascadeLabels(labels) {
    return (Array.isArray(labels) ? labels : []).map(collapse).filter((label) => label.length >= 2);
  }

  /** The state (or any level's) option equal to one of the candidates, headers skipped; null when none. */
  function chooseCascadeOption(labels, candidates) {
    return matchOption(cascadeLabels(labels), candidates);
  }

  /**
   * Whether the cascade modal has left the state level after a state was
   * chosen: its steps (`.drawer-cascade-steps` text) name the chosen state,
   * or the list no longer carries the state level's single-letter headers.
   * Merely "the labels changed" is not enough: the state list re-rendering
   * would read as the city list, and the customer's city would be looked for
   * among states.
   */
  function cascadeMovedPastStates(labels, stepsText, stateLabel) {
    const state = normalizeTitle(stateLabel);
    if (state && normalizeTitle(stepsText).includes(state)) return true;
    const list = (Array.isArray(labels) ? labels : []).map(collapse).filter(Boolean);
    return list.length > 0 && !list.some((label) => label.length === 1);
  }

  /**
   * The city option: an exact match, else "Other", which AliExpress lists
   * last in every state. A city chosen as "Other" is flagged so the merchant
   * is told, and the save verification accepts it only with that flag.
   */
  function chooseCascadeCity(labels, city) {
    const list = cascadeLabels(labels);
    const exact = matchOption(list, [city]);
    if (exact !== null) return { label: exact, isOther: false };
    const other = matchOption(list, ["Other"]);
    return other !== null ? { label: other, isOther: true } : null;
  }

  /**
   * The house number and street word a saved address shows, "12345 northwest"
   * for "12345 Northwest Evergreen Parkway". Two tokens, because a bare "1"
   * would be found in any block of text.
   */
  function streetKey(street) {
    return collapse(street).split(" ").slice(0, 2).join(" ");
  }

  /**
   * Whether the confirm page's address block shows the customer's address:
   * its text carries the customer's last name and the street's house number
   * with the first street word. Used to skip a fill that is already done, and
   * to verify a save. `text` is the block's textContent.
   */
  function addressBlockShows(text, values) {
    const name = collapse(values?.lastName) || collapse(values?.firstName);
    const key = streetKey(values?.street);
    if (!name || !key) return false;
    const block = normalizeTitle(text);
    return block.includes(normalizeTitle(name)) && block.includes(normalizeTitle(key));
  }

  const SAVE_WORDS = { comet: /^(save|lưu)$/i, fusion: /^(confirm|xác nhận)$/i };

  /**
   * Why the address form must NOT be saved by the extension, or null when it
   * may. This is the one deliberate exception to the click guard: Save on the
   * add-new-address form commits the customer's address to the merchant's
   * AliExpress address book, which is what placing the order means, and it is
   * clicked only after every one of these reads back as intended.
   *
   * `s` describes the form as read from the page just before the click:
   * { design: "comet" | "fusion",
   *   boxes: [values of every text box a saved address would show in],
   *   intended: { firstName, lastName, phone, street, unit, zip },
   *   actual:   the same keys, read back by position,
   *   country:  { shown, candidates },
   *   state:    { shown, candidates },
   *   city:     { shown, wanted, otherAccepted },
   *   defaultSwitch: "on" | "off" | "missing",
   *   button:   { tag, type, text, classes, ancestorClasses, inForm, disabled, visible } }
   *
   * `visible` is whether the button has a box on the page (client rects); a
   * button read as anything but visible is refused, since a hidden Save is
   * not the one the drawer shows and its click was never verified.
   */
  function saveButtonRefusal(s) {
    if (!s || typeof s !== "object") return "Nothing to verify.";
    const design = s.design === "comet" || s.design === "fusion" ? s.design : null;
    if (!design) return "The address form's design is not one DropshipHub has measured.";
    const intended = s.intended && typeof s.intended === "object" ? s.intended : null;
    if (!intended || Object.keys(intended).length === 0) return "Nothing was typed.";
    if (foreignFormValues(s.boxes, Object.values(intended)).length > 0) {
      return "The form holds a value DropshipHub did not type, so it may be a saved address being edited.";
    }
    const wrong = mismatchedFields(intended, s.actual);
    if (wrong.length > 0) return `These boxes do not show what DropshipHub typed: ${wrong.join(", ")}.`;
    if (matchOption([collapse(s.country?.shown)], s.country?.candidates) === null) return "The country is not the United States.";
    if (matchOption([collapse(s.state?.shown)], s.state?.candidates) === null) return "The State box does not show the customer's state.";
    const cityShown = collapse(s.city?.shown);
    const cityOk = matchOption([cityShown], [s.city?.wanted]) !== null || (s.city?.otherAccepted === true && matchOption([cityShown], ["Other"]) !== null);
    if (!cityOk) return "The City box does not show the customer's city.";
    if (s.defaultSwitch !== "off") return s.defaultSwitch === "on" ? '"Set as default" is on.' : 'The "Set as default" switch was not found, so it cannot be read as off.';
    const b = s.button && typeof s.button === "object" ? s.button : null;
    if (!b) return "The Save button was not found.";
    if (String(b.tag ?? "").toLowerCase() !== "button") return "The Save control is not a button.";
    const type = String(b.type ?? "").toLowerCase();
    if (type === "submit" || (!type && b.inForm)) return "The Save button would submit a form.";
    if (b.disabled) return "The Save button is disabled.";
    if (b.visible !== true) return "The Save button is not visible.";
    const text = collapse(b.text);
    if (!SAVE_WORDS[design].test(text)) return `The button reads "${text.slice(0, 40)}", not ${design === "comet" ? "Save" : "Confirm"}.`;
    const classes = Array.isArray(b.classes) ? b.classes.map(String) : [];
    if (design === "comet" && !classes.includes("form-button-confirm")) return "The button is not the address form's Save button.";
    const all = [...classes, ...(Array.isArray(b.ancestorClasses) ? b.ancestorClasses.map(String) : [])];
    if (all.some((c) => c === "place-order-primary-btn" || c.startsWith("pl-order-toal-container__btn-box") || PAYMENT_CLASS.test(c))) {
      return "The button is a Place order or payment control.";
    }
    return null;
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
   * Every estimate DropshipHub has for this checkout, one per currency: the
   * purchase order's own (VND on the measured account, captured from the
   * Vietnamese product page) and the shop's (the same amount converted at
   * placement). The page shows the account's currency (USD on the owner's
   * account), so the one to compare is whichever shares it.
   */
  function expectedCosts(job) {
    const own = expectedCost(job);
    const list = own ? [own] : [];
    const items = Array.isArray(job?.items) ? job.items : [];
    const shopTotal = decimal(job?.shopExpectedTotal);
    const shopCurrency = /^[A-Z]{3}$/.test(String(job?.shopCurrency ?? "")) ? job.shopCurrency : null;
    if (items.length <= 1 && shopTotal !== null && shopCurrency && !list.some((e) => e.currency === shopCurrency)) {
      list.push({ amount: shopTotal, currency: shopCurrency, scope: "order" });
    }
    return list;
  }

  /**
   * Compares the page's total with the estimate in the page's currency, as a
   * warning only. `expected` is one estimate or the list expectedCosts gives.
   * When no estimate shares the page's currency there is no verdict: the
   * amounts are shown side by side, because converting here would be a guess,
   * and a warning built on a guess is a wrong warning.
   */
  function compareTotals(expected, pageText) {
    const page = parseMoneyText(pageText);
    const list = (Array.isArray(expected) ? expected : [expected]).filter((e) => e && Number.isFinite(e.amount));
    if (list.length === 0) return { kind: "no-expectation", page };
    if (!page) return { kind: "unreadable", page: null };
    const match = page.currency ? list.find((e) => e.currency === page.currency) : null;
    if (!match) return { kind: "other-currency", page, expectations: list };
    const tolerance = Math.max(match.amount * 0.1, 0.5);
    if (page.amount > match.amount + tolerance) return { kind: "higher", page, expected: match };
    if (page.amount < match.amount - tolerance) return { kind: "lower", page, expected: match };
    return { kind: "close", page, expected: match };
  }

  // ---------------------------------------------------------------------------
  // The real total, for the app
  // ---------------------------------------------------------------------------

  const QUOTE_ROW_KINDS = [
    [/subtotal|tạm tính/i, "subtotal"],
    [/shipping|delivery|vận chuyển|phí giao/i, "shipping"],
    [/additional charges|tax|fee|charges|thuế|phí/i, "charges"],
    [/promo|coupon|discount|giảm/i, "discount"],
  ];

  function amountOf(text) {
    const parsed = parseMoneyText(text);
    return parsed ? parsed.amount : null;
  }

  /**
   * What the confirm page says the order costs, from its total row and its
   * summary rows ({ label, text } each). The currency is the total's. The
   * subtotal is passed on only when subtotal + shipping + charges is the
   * total: with a promo code applied it is not, and the app then takes the
   * goods as total minus shipping and charges, which is what was paid for them.
   */
  function quoteFromPage(input) {
    const total = parseMoneyText(input?.totalText);
    if (!total || !total.currency) return null;
    const parts = { subtotal: null, shipping: null, charges: null, discount: null };
    for (const row of Array.isArray(input?.rows) ? input.rows : []) {
      const label = String(row?.label ?? "");
      const kind = (QUOTE_ROW_KINDS.find(([pattern]) => pattern.test(label)) ?? [])[1];
      if (!kind || parts[kind] !== null) continue;
      const amount = amountOf(row?.text);
      if (amount !== null) parts[kind] = amount;
    }
    const shipping = parts.shipping ?? 0;
    const charges = parts.charges ?? 0;
    const quote = { currency: total.currency, total: total.amount, shipping, charges };
    if (parts.subtotal !== null && Math.abs(parts.subtotal + shipping + charges - total.amount) < 0.01) quote.subtotal = parts.subtotal;
    return validQuote(quote) ? quote : null;
  }

  function nonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function validQuote(quote) {
    if (!quote || typeof quote !== "object") return false;
    if (!/^[A-Z]{3}$/.test(String(quote.currency ?? ""))) return false;
    if (!nonNegative(quote.total)) return false;
    for (const key of ["subtotal", "shipping", "charges"]) {
      if (quote[key] !== undefined && quote[key] !== null && !nonNegative(quote[key])) return false;
    }
    return true;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /**
   * The quote for the whole purchase order from the quotes of its items so
   * far: each item is its own AliExpress checkout, so the purchase order's
   * total is their sum. The subtotal is summed only when every item has one.
   * null until at least one item is quoted, or when currencies differ.
   */
  function sumQuotes(quotes) {
    const list = (Array.isArray(quotes) ? quotes : []).filter((q) => validQuote(q));
    if (list.length === 0) return null;
    const currency = list[0].currency;
    if (list.some((q) => q.currency !== currency)) return null;
    const sum = (key) => round2(list.reduce((n, q) => n + (Number(q[key]) || 0), 0));
    const out = { currency, total: sum("total"), shipping: sum("shipping"), charges: sum("charges") };
    if (list.every((q) => nonNegative(q.subtotal))) out.subtotal = sum("subtotal");
    return out;
  }

  /** The body POST /api/extension/orders/:id/quote takes, with plain decimal strings. */
  function quoteBody(quote) {
    if (!validQuote(quote)) return null;
    const body = { currency: quote.currency, total: quote.total.toFixed(2), shipping: (quote.shipping ?? 0).toFixed(2), charges: (quote.charges ?? 0).toFixed(2), source: "confirm" };
    if (nonNegative(quote.subtotal)) body.subtotal = quote.subtotal.toFixed(2);
    return body;
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
  const ADDRESS_LIST_CLASS = /^(mt-switch|switcher|ae-address-item-(edit|delete)-btn|comet-radio(-\w+)?|next-radio(-\w+)?)$/i;
  const QUANTITY_OR_COUPON_CLASS = /input-number|coupon|promo/i;

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
   *   inForm, ariaChecked, containsForbidden, control, activators }.
   *
   * Classifying the clicked element alone was not enough. A click bubbles,
   * and the browser activates the nearest ancestor that has activation
   * behaviour: a <span> inside an untyped <button> in the address form
   * submits the form, and a <span> inside the "Set as default shipping
   * address" <label> ticks its box. So `activators` describes every ancestor
   * that a click could activate (buttons, inputs, labels, links, summaries,
   * ARIA buttons and checkboxes), and the click is refused when any of them
   * would be. `control` is a <label>'s labelled control, which a click on the
   * label toggles wherever in the page that control sits.
   */
  function clickRefusal(d) {
    const own = refusalOf(d, true);
    if (own) return own;
    for (const activator of Array.isArray(d.activators) ? d.activators : []) {
      // An ancestor is judged on its own descriptor and its label control;
      // its own activators list, if any, is ignored, so a malformed
      // descriptor cannot send this into a loop.
      const refusal = refusalOf(activator, true);
      if (refusal) return `The click would reach a control around it. ${refusal}`;
    }
    return null;
  }

  function refusalOf(d, withControl) {
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
    // The comet drawer's own commit-like controls: the "Set as default"
    // switch, the saved-address radios and their edit and delete icons, and
    // the quantity stepper and coupon rows of the page. None is ever needed.
    if (all.some((c) => ADDRESS_LIST_CLASS.test(c))) return "It is the default switch or a saved address's choice, edit or delete control.";
    if (all.some((c) => QUANTITY_OR_COUPON_CLASS.test(c))) return "It is a quantity or coupon control.";
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
    if (tag === "label" && withControl && d.control) {
      const refusal = refusalOf(d.control, false);
      if (refusal) return `It is the label of a control DropshipHub never clicks. ${refusal}`;
    }
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

  function isPurchaseOrderId(value) {
    return typeof value === "string" && PURCHASE_ORDER_ID.test(value);
  }

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
        shopCurrency: shortText(order.shopCurrency, 3),
        shopExpectedTotal: shortText(order.shopTotalCost, 32),
        address,
        items,
        itemIndex: 0,
        recordedOrderIds: items.map(() => []),
        // Per item: the confirm page's real total as last read, with `sent`
        // once the app has it; a changed total (the customer's address sets
        // the tax and shipping) is posted again, the same one is not.
        quotes: items.map(() => null),
        // The last automatic fill's outcome for the current item, so a
        // reload does not run a finished fill again.
        fill: null,
        payingAt: null,
        stage: "product",
        startedAt: now,
      },
    };
  }

  /** The fill outcome recorded for the job's current item, or null. */
  function fillOutcomeFor(job) {
    const fill = job?.fill;
    return fill && typeof fill === "object" && fill.itemIndex === job.itemIndex ? fill : null;
  }

  /**
   * Whether the confirm page should run the address fill by itself now.
   * "shown" is whether the page's address block already shows the customer's
   * address. Runs when nothing is recorded for this item, and again when a
   * recorded "set" is no longer shown; a fill that stopped is left for the
   * merchant's "Fill address again", so a reload cannot type into a form the
   * merchant is now correcting by hand.
   */
  function shouldAutoFill(job, shown) {
    if (!job || job.stage !== "confirm") return false;
    if (shown) return false;
    const outcome = fillOutcomeFor(job);
    return outcome === null || outcome.result === "set";
  }

  // ---------------------------------------------------------------------------
  // The AliExpress orders list, order detail and tracking pages
  //
  // The pages print the customer's address too; only what is parsed here is
  // ever read: order ids, product ids, SKU text, status, total, date, carrier
  // and tracking number. Everything takes plain values the content script has
  // already pulled out of the page, so it is unit-tested without a DOM.
  // ---------------------------------------------------------------------------

  const ALIEXPRESS_ORDER_ID = /^\d{10,24}$/;
  const TRACKING_NUMBER = /^[A-Za-z0-9-]{4,64}$/;

  /**
   * Status phrases the orders list uses. The unpaid ones come first: a card
   * read as paid can never be taken back by a later sync, while one read as
   * unpaid is advanced the next time. Then longest first, so "Awaiting
   * delivery" wins over "delivery".
   */
  const ORDER_STATUS_PHRASES = [
    "To pay",
    "Awaiting payment",
    "Awaiting confirmation",
    "Awaiting delivery",
    "Awaiting shipment",
    "Awaiting receipt",
    "Partially shipped",
    "In transit",
    "Processing",
    "Completed",
    "Cancelled",
    "Canceled",
    "Delivered",
    "Received",
    "Refunded",
    "Shipped",
    "Closed",
    "Paid",
  ];

  /**
   * The part of a card's text that holds its status: the measured card prints
   * the status first, then "Date: …", so nothing after "Date:" (or "Ref.
   * Number") is a status. A product title such as "Food Processing Machine"
   * sits after it and must not read as "Processing".
   */
  function statusScope(text) {
    const haystack = collapse(text);
    const cut = haystack.search(/Date:|Ref\.?\s*Number|Ngày/);
    return cut > 0 ? haystack.slice(0, cut) : haystack;
  }

  function orderStatusFromText(text) {
    const haystack = statusScope(text);
    for (const phrase of ORDER_STATUS_PHRASES) {
      // A whole phrase with the capitals the list uses, not the inside of a
      // longer word ("paid" in "unpaid", "To pay" in "To payment"). textContent
      // glues neighbouring elements together ("Awaiting deliveryDate: …"), so a
      // capital letter right after the phrase starts the next element's word.
      const pattern = new RegExp(`(^|[^A-Za-z0-9])${phrase.replace(/\s+/g, "\\s+")}(?=$|[^A-Za-z0-9]|[A-Z])`);
      if (pattern.test(haystack)) return phrase;
    }
    return "";
  }

  /** "…/p/order/detail.html?orderId=8190000000000001" -> "8190000000000001". */
  function orderIdFromHref(href) {
    const match = /[?&]orderId=(\d{10,24})(?!\d)/.exec(String(href ?? ""));
    return match ? match[1] : null;
  }

  /**
   * Product ids from a card's product links, in both forms: the regional id
   * the .us host uses and the global id DropshipHub stores (the regional id
   * minus 2^51). A stored id matches either way.
   */
  function productIdsFromHrefs(hrefs) {
    const ids = new Set();
    for (const href of Array.isArray(hrefs) ? hrefs : []) {
      const match = /\/item\/(\d{1,20})\.html/.exec(String(href ?? ""));
      if (!match) continue;
      ids.add(match[1]);
      const global = globalProductId(match[1]);
      if (global) ids.add(global);
      if (ids.size >= 40) break;
    }
    return [...ids];
  }

  /**
   * The text after "<label>:" on a card. The label is matched with its
   * capital, so "Total" is never the end of "Subtotal" and "Date" never the
   * end of "Update", while textContent's glued "…deliveryDate:" still counts:
   * a capital after a lowercase letter is where the next element began.
   */
  function textAfter(text, label, max) {
    const pattern = new RegExp(`(?:^|[^A-Z])${label}:?\\s*(.{1,${max}}?)\\s*(?=Ref\\.?|Order|Details|Total|Date|Track|Confirm|Pay|View|$)`);
    const match = pattern.exec(String(text ?? "").replace(/\s+/g, " "));
    return match ? collapse(match[1]) : "";
  }

  /**
   * One `.order-item` card of the orders list, from what the content script
   * read off it: the Details link, the product links, the card's own status
   * element text (may be empty) and the card's whole text. Nothing else on the
   * card is looked at, and a card without an order id is nothing. The status
   * is a known phrase in the card's status element, else a known phrase where
   * the measured card prints it (before "Date:"), else the status element's
   * own text, since that element's class has not been measured.
   */
  function parseOrderCard(input) {
    const orderId = orderIdFromHref(input?.detailsHref);
    if (!orderId) return null;
    const cardText = String(input?.cardText ?? "");
    const statusText = collapse(input?.statusText);
    const status = (orderStatusFromText(statusText) || orderStatusFromText(cardText) || statusText).slice(0, 60);
    const totalText = textAfter(cardText, "Total", 40);
    const totalMoney = parseMoneyText(totalText);
    const total = totalMoney ? collapse(/^([^\d]{0,8}\d[\d.,' ]*\d?)/.exec(totalText)?.[1] ?? totalText).slice(0, 40) : "";
    return {
      orderId,
      productIds: productIdsFromHrefs(input?.productHrefs),
      skuText: collapse(input?.skuText).slice(0, 200),
      status,
      total,
      date: textAfter(cardText, "Date", 40).slice(0, 40),
    };
  }

  /**
   * The one order on /p/order/detail.html: its id from the URL or the "Ref.
   * Number" row, and `.order-status`. No product ids: the page's own item
   * block has not been measured, and its recommendation strips carry product
   * links too, so ids read from it could match a waiting purchase order for a
   * product this order never contained. Without ids the app can only advance
   * an order it already knows by number, never record one from this page.
   */
  function parseOrderDetail(input) {
    const url = parseUrl(input?.url);
    const fromUrl = url ? url.searchParams.get("orderId") : null;
    const fromRef = /(\d{10,24})(?!\d)/.exec(String(input?.refNumberText ?? ""));
    const orderId = fromUrl && ALIEXPRESS_ORDER_ID.test(fromUrl) ? fromUrl : fromRef ? fromRef[1] : null;
    if (!orderId) return null;
    const statusText = collapse(input?.statusText);
    return {
      orderId,
      productIds: [],
      skuText: "",
      status: (orderStatusFromText(statusText) || statusText).slice(0, 60),
      total: "",
      date: "",
    };
  }

  /** The tracking page: the order id from its URL, the carrier and the tracking number. Nothing else on it is read. */
  function parseTrackingPage(input) {
    const url = parseUrl(input?.url);
    const tradeOrderId = url ? url.searchParams.get("tradeOrderId") : null;
    if (!tradeOrderId || !ALIEXPRESS_ORDER_ID.test(tradeOrderId)) return null;
    const trackingNumber = collapse(input?.mailNoText);
    if (!TRACKING_NUMBER.test(trackingNumber)) return null;
    return { tradeOrderId, trackingNumber, carrier: collapse(input?.carrierText).slice(0, 80) };
  }

  /**
   * The body POST /api/extension/orders/sync takes: only well-formed orders,
   * at most 100, plus the paying hints ({ purchaseOrderId, payingAt } of every
   * checkout job whose merchant pressed Pay now), at most 20. A hint carries
   * nothing of the customer.
   */
  function ordersSyncBody(orders, hints) {
    const list = (Array.isArray(orders) ? orders : [])
      .filter((o) => o && ALIEXPRESS_ORDER_ID.test(String(o.orderId ?? "")))
      .slice(0, 100)
      .map((o) => ({
        orderId: String(o.orderId),
        productIds: (Array.isArray(o.productIds) ? o.productIds : []).map(String).filter((id) => /^\d{1,24}$/.test(id)).slice(0, 40),
        skuText: shortText(o.skuText, 200) ?? "",
        status: shortText(o.status, 60) ?? "",
        total: shortText(o.total, 40) ?? "",
        date: shortText(o.date, 40) ?? "",
      }));
    if (list.length === 0) return null;
    const body = { orders: list };
    const hintList = (Array.isArray(hints) ? hints : [])
      .filter((h) => h && isPurchaseOrderId(h.purchaseOrderId) && Number.isInteger(h.payingAt) && h.payingAt >= 0)
      .slice(0, 20)
      .map((h) => ({ purchaseOrderId: h.purchaseOrderId, payingAt: h.payingAt }));
    if (hintList.length > 0) body.hints = hintList;
    return body;
  }

  /**
   * A `partial` sync result for the job's purchase order: the orders page
   * found the AliExpress order for the item being checked out (its product is
   * one the order covers). The number goes into that item's slot and the job
   * moves to "recorded", as if the merchant had typed it, so "Next item" or
   * "Send" follows. Null when the result is not for this job's current item,
   * or the number is already noted.
   */
  function attachOrderToJob(job, entry) {
    if (!job || !entry || entry.result !== "partial" || job.purchaseOrderId !== entry.purchaseOrderId) return null;
    if (job.stage !== "confirm" && job.stage !== "paying") return null;
    const orderId = String(entry.orderId ?? "");
    if (!ALIEXPRESS_ORDER_ID.test(orderId) || jobOrderIds(job).includes(orderId)) return null;
    const item = Array.isArray(job.items) ? job.items[job.itemIndex] : null;
    const covered = Array.isArray(entry.matchedProductIds) ? entry.matchedProductIds : [];
    if (!item || !covered.some((id) => sameProduct(id, item.externalProductId))) return null;
    const recordedOrderIds = job.items.map((_, index) => (index === job.itemIndex ? [orderId] : (job.recordedOrderIds?.[index] ?? [])));
    return { ...job, recordedOrderIds, stage: "recorded" };
  }

  /** Whether two quotes of the confirm page are the same amounts, so the app is not sent the same total twice. */
  function sameQuote(a, b) {
    if (!validQuote(a) || !validQuote(b)) return false;
    if (a.currency !== b.currency) return false;
    return ["total", "subtotal", "shipping", "charges"].every((key) => {
      const left = nonNegative(a[key]) ? round2(a[key]) : null;
      const right = nonNegative(b[key]) ? round2(b[key]) : null;
      return left === right;
    });
  }

  /** One line per synced order, for the small panel on the orders page. */
  function describeSyncResult(entry) {
    const id = String(entry?.orderId ?? "");
    const name = entry?.orderName ? String(entry.orderName) : "";
    const names = (Array.isArray(entry?.candidates) ? entry.candidates : []).map((c) => c?.orderName).filter(Boolean).join(", ");
    switch (entry?.result) {
      case "recorded": {
        // A multi-item purchase order finished from its last item carries every number.
        const ids = Array.isArray(entry.externalOrderIds) && entry.externalOrderIds.length > 1 ? entry.externalOrderIds.map(String) : [id];
        return `${name} recorded as AliExpress order${ids.length > 1 ? "s" : ""} ${ids.join(", ")}.`;
      }
      case "already":
        return `${name} is already recorded as AliExpress order ${id}${entry.closed ? " (closed on AliExpress; check it in DropshipHub)" : ""}.`;
      case "advanced":
        return `${name} (AliExpress order ${id}) is now ${String(entry.status ?? "").toLowerCase().replace(/_/g, " ")}.`;
      case "partial":
        return `${name} has several items, each its own AliExpress order. AliExpress order ${id} was noted for its item in the checkout panel; go on to the next item there, or record all its numbers in the extension's popup.`;
      case "ambiguous":
        if (entry.reason === "date-unreadable") return `AliExpress order ${id} was not recorded: its date could not be read, so it may be older than ${names || "the DropshipHub order waiting"}. Record it in the extension's popup if it is that order.`;
        if (entry.reason === "variant-differs") return `AliExpress order ${id} was not recorded: its SKU text does not name the variant ${names || "the DropshipHub order"} waits for. Record it in the extension's popup if it is that order.`;
        return `AliExpress order ${id} matches several DropshipHub orders (${names}). Record it in the extension's popup.`;
      case "unmatched":
        if (entry.closed) return `AliExpress order ${id} is closed on AliExpress, so it was not recorded.`;
        if (entry.reason === "older-than-orders") return `AliExpress order ${id} is dated before ${names || "the DropshipHub order waiting for its product"} was created, so it was not recorded.`;
        return `AliExpress order ${id}: no DropshipHub order matched.`;
      default:
        return `AliExpress order ${id}: ${String(entry?.error ?? "not synced")}.`;
    }
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
    if (status === 404) return "Not saved: this order is no longer in DropshipHub.";
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
    COMET_POSITIONS,
    COMET_TYPED,
    COMET_TEXT_BOXES,
    globalProductId,
    productIdForHost,
    sameProduct,
    isAliExpressHost,
    isUsHost,
    productPageUrl,
    isProductPage,
    productIdFromUrl,
    isConfirmPage,
    isOrdersPage,
    isOrderDetailPage,
    isTrackingPage,
    ordersPageUrl,
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
    defaultBoxState,
    foreignFormValues,
    mismatchedFields,
    cometFormStructure,
    cascadeLabels,
    chooseCascadeOption,
    cascadeMovedPastStates,
    chooseCascadeCity,
    streetKey,
    addressBlockShows,
    saveButtonRefusal,
    parseMoneyText,
    formatAmount,
    expectedCost,
    expectedCosts,
    compareTotals,
    quoteFromPage,
    validQuote,
    sumQuotes,
    sameQuote,
    quoteBody,
    clickRefusal,
    buildJob,
    fillOutcomeFor,
    shouldAutoFill,
    isPurchaseOrderId,
    isJobExpired,
    isLastItem,
    jobOrderIds,
    explainRefusal,
    orderStatusFromText,
    orderIdFromHref,
    productIdsFromHrefs,
    parseOrderCard,
    parseOrderDetail,
    parseTrackingPage,
    ordersSyncBody,
    attachOrderToJob,
    describeSyncResult,
  });
})(globalThis);
