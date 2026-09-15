/* global chrome, globalThis */

/**
 * The checkout assist on AliExpress pages.
 *
 * The extension lists the orders waiting to be placed and opens each product
 * on AliExpress. This script runs in those tabs: on the product page it checks
 * the purchase order's variant and opens the confirm page for it; on the
 * confirm page it fills the customer's address by itself as soon as the page
 * is ready, saves it to the merchant's AliExpress address book once every box
 * reads back as intended, sends the page's real total to the app once that
 * address is set (and again when it changes), and shows the order beside the
 * page's total. The merchant presses Pay now. The click
 * on Pay now is observed (never made) and the orders page then records the
 * AliExpress order number (orders.js).
 *
 * What it must never do is decided here, in code, not left to selectors:
 *
 * - Every programmatic click goes through guardedClick(), which refuses Pay
 *   now / Place order, Buy now, payment choices, the address list's radios,
 *   edit and delete icons, the "Set as default" switch, the quantity stepper,
 *   coupons, checkboxes, form submits and every control whose label commits
 *   something (DropshipHubCheckout.clickRefusal), judged for the clicked
 *   element and for every control around it the click would activate.
 * - The ONE exception is saveAddressForm(): Save (comet) or Confirm (Fusion)
 *   on the add-new-address form, clicked only after every box, State, City,
 *   the country and the default switch have been read back as intended
 *   (DropshipHubCheckout.saveButtonRefusal). Otherwise the boxes are
 *   highlighted and the merchant is asked to check and save themselves.
 * - Nothing is typed into a form that already holds another address, or has
 *   "Set as default" on, and never into the cascade modal's search box.
 * - The customer's data stays in this isolated world and the background
 *   worker's session storage: never logged, never put in a URL, never sent to
 *   the page's MAIN world (the SKU request to page-reader.js carries nothing).
 * - The panel is built with textContent inside a closed shadow root, so
 *   neither AliExpress's markup nor its scripts can reach the address in it.
 *
 * Page structure is from docs/ALIEXPRESS_PAGE_MODEL.md.
 */
(() => {
  const core = globalThis.DropshipHubCheckout;
  if (!core || window.top !== window) return;

  const HOST_ID = "dropshiphub-checkout-host";
  const SKU_REQUEST = "dropshiphub:read-skus";
  const SKU_RESPONSE = "dropshiphub:skus";

  let panel = null;
  let lastUrl = location.href;
  let productCheckFor = null;
  // The automatic fill runs once per item per page load; a reload consults
  // the outcome recorded in the job instead (core.shouldAutoFill).
  let autoFillFor = null;
  let payObserverInstalled = false;
  let payObserverJob = null;

  const RELOADED = "The extension was reloaded or updated. Reload this page.";

  function ask(message) {
    try {
      return chrome.runtime
        .sendMessage(message)
        .then((answer) => answer ?? { ok: false, error: "The extension did not answer. Reload this page." })
        .catch(() => ({ ok: false, error: RELOADED }));
    } catch {
      // Once the extension is reloaded, sendMessage throws at once ("Extension
      // context invalidated") instead of returning a rejected promise, so the
      // .catch above never ran and Cancel, Record and the page poll failed
      // without a word.
      return Promise.resolve({ ok: false, error: RELOADED });
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Polls `probe` until it returns something truthy or `timeoutMs` passes. Never unbounded. */
  async function waitFor(probe, timeoutMs, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try {
        value = probe();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  function collapse(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------------
  // The one way this script clicks (plus saveAddressForm, the verified exception)
  // ---------------------------------------------------------------------------

  const FORBIDDEN_INSIDE =
    'button.place-order-primary-btn, .pl-order-toal-container__btn-box, input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"], button[type="submit"], input[type="submit"], .mt-switch, .ae-address-item-edit-btn, .ae-address-item-delete-btn, .comet-input-number';

  /**
   * Elements a click can activate or toggle when it bubbles up to them. The
   * browser activates the nearest of these around the clicked node: a span
   * inside an untyped button in a form submits that form, and a span inside a
   * label ticks the label's checkbox.
   */
  const ACTIVATORS =
    'button, input, label, select, textarea, summary, a[href], area, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitemcheckbox"], [role="menuitemradio"], [aria-checked]';

  function describeElement(element, withControl) {
    const ancestorClasses = [];
    for (let node = element.parentElement; node; node = node.parentElement) ancestorClasses.push(...node.classList);
    return {
      tag: element.tagName,
      type: element.getAttribute("type"),
      role: element.getAttribute("role"),
      classes: [...element.classList],
      ancestorClasses,
      text: (element.textContent ?? "").trim().slice(0, 200),
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      inForm: Boolean(element.closest("form")),
      ariaChecked: element.hasAttribute("aria-checked"),
      containsForbidden: Boolean(element.querySelector(FORBIDDEN_INSIDE)),
      // A label toggles its control even when the control sits elsewhere in
      // the page (label for="…"), where containsForbidden cannot see it.
      control: withControl && element instanceof HTMLLabelElement && element.control ? describeElement(element.control, false) : null,
    };
  }

  /**
   * The element itself plus every ancestor a click on it could activate, all
   * the way up to the document, so the guard judges what the click would
   * actually do and not only the node it lands on.
   */
  function describeForGuard(element) {
    const activators = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.matches(ACTIVATORS)) activators.push(describeElement(node, true));
    }
    return { ...describeElement(element, true), activators };
  }

  /**
   * Clicks `element` unless the guard refuses it. Returns the refusal reason,
   * or null when the click was made. Refusal is the safe failure: the fill
   * stops and the merchant is told to do that step themselves.
   */
  function guardedClick(element) {
    if (!(element instanceof Element) || !element.isConnected) return "The element is no longer on the page.";
    const refusal = core.clickRefusal(describeForGuard(element));
    if (refusal) return refusal;
    for (const type of ["mousedown", "mouseup"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
    element.click();
    return null;
  }

  // ---------------------------------------------------------------------------
  // Panel building blocks (textContent only)
  // ---------------------------------------------------------------------------

  const STYLES = `
    :host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 340px; }
    .card { background: #fff; color: #202223; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.28);
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
    .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #e1e3e5;
      font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: #6d7175; }
    .head button { border: 0; background: none; cursor: pointer; color: #6d7175; font-size: 16px; line-height: 1; padding: 0 4px; }
    .body { padding: 10px 12px 12px; overflow: auto; display: grid; gap: 10px; }
    .body[hidden] { display: none; }
    h3 { margin: 0; font-size: 14px; }
    .muted { color: #6d7175; font-size: 12px; }
    .item { background: #f6f6f7; border-radius: 8px; padding: 8px; }
    .line { font-size: 12.5px; }
    .ok { color: #1a7f37; } .warn { color: #8a6116; } .err { color: #b3261e; }
    .rows { display: grid; gap: 4px; }
    .row { display: grid; grid-template-columns: 92px 1fr auto; gap: 6px; align-items: center; }
    .row span { font-size: 11.5px; color: #6d7175; }
    .row input { font: inherit; font-size: 12.5px; padding: 3px 6px; border: 1px solid #c9cccf; border-radius: 6px; min-width: 0; background: #fafbfb; color: #202223; }
    .row input.flag { border-color: #b98900; background: #fff5ea; }
    button.act { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; background: #008060; color: #fff; }
    button.act:disabled { background: #c9cccf; cursor: default; }
    button.act.secondary { background: #f1f2f3; color: #202223; }
    button.act.danger { background: none; color: #b3261e; padding: 4px 0; text-align: left; }
    button.copy { font: inherit; font-size: 11.5px; border: 1px solid #c9cccf; background: #fff; border-radius: 6px; padding: 2px 6px; cursor: pointer; }
    .stack { display: grid; gap: 6px; }
    .note { border-left: 3px solid #2c6ecb; padding: 4px 8px; background: #f2f7fe; font-size: 12px; }
    label.field { display: grid; gap: 2px; font-size: 12px; color: #6d7175; }
    label.field input { font: inherit; color: #202223; padding: 6px 8px; border: 1px solid #c9cccf; border-radius: 6px; }
    label.check { display: flex; gap: 6px; align-items: center; font-size: 12px; }
    details { font-size: 12px; } summary { cursor: pointer; color: #2c6ecb; font-weight: 600; }
    ul { margin: 0; padding-left: 16px; }
  `;

  function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
    if (options.type) node.type = options.type;
    if (options.placeholder) node.placeholder = options.placeholder;
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function say(target, text, tone) {
    target.className = `line${tone ? ` ${tone}` : ""}`;
    target.textContent = text;
  }

  function button(text, onClick, className = "act") {
    const node = el("button", { className, text, type: "button" });
    node.addEventListener("click", (event) => {
      // Only the merchant's own click counts. The closed shadow root already
      // keeps the page's scripts away from these buttons; this also stops a
      // synthetic click from ever filling an address or sending order numbers.
      if (!event.isTrusted) return;
      onClick(event);
    });
    return node;
  }

  function mountPanel() {
    if (panel && panel.host.isConnected) return panel;
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    const body = el("div", { className: "body" });
    const toggle = el("button", { text: "–", type: "button" });
    toggle.title = "Collapse";
    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? "+" : "–";
      toggle.title = body.hidden ? "Expand" : "Collapse";
    });
    const head = el("div", { className: "head" }, [el("span", { text: "DropshipHub checkout" }), toggle]);
    root.append(style, el("div", { className: "card" }, [head, body]));
    (document.body ?? document.documentElement).append(host);
    panel = { host, body, onUrlChange: null, view: 0 };
    return panel;
  }

  function clearPanel() {
    panel?.host.remove();
    panel = null;
  }

  /** Empties the panel for a new view and returns its body. */
  function freshBody() {
    const { body } = mountPanel();
    body.textContent = "";
    body.hidden = false;
    panel.onUrlChange = null;
    panel.view += 1;
    return body;
  }

  function itemBlock(job) {
    const item = job.items[job.itemIndex];
    const count = job.items.length;
    return el("div", { className: "stack" }, [
      el("h3", { text: `${job.orderName} · Item ${job.itemIndex + 1} of ${count}` }),
      el("div", { className: "item" }, [
        el("div", { text: item.title }),
        item.variantLabel ? el("div", { className: "muted", text: item.variantLabel }) : null,
        el("div", { className: "muted", text: `Quantity ${item.quantity}` }),
      ]),
    ]);
  }

  const PAY_YOURSELF =
    "You press Pay now on AliExpress yourself: DropshipHub never presses it. Once you have paid, open your AliExpress orders and DropshipHub records the order number by itself.";

  function cancelButton() {
    return button(
      "Cancel this checkout",
      async () => {
        await ask({ type: "checkout:cancel" });
        showFinished("Checkout cancelled. Nothing was recorded in DropshipHub, and its address was cleared from the extension.", "");
      },
      "act danger",
    );
  }

  function showFinished(text, tone) {
    const body = freshBody();
    const message = el("div");
    say(message, text, tone);
    body.append(message, button("Close", clearPanel, "act secondary"));
  }

  /** A collapsed block under the panel's main content. */
  function disclosure(summaryText, content) {
    const details = el("details");
    details.append(el("summary", { text: summaryText }), content);
    return details;
  }

  // ---------------------------------------------------------------------------
  // Stage "product": check the variant, then open the confirm page
  // ---------------------------------------------------------------------------

  /** One synchronous read from page-reader.js; the page model may still be loading. */
  function requestSkusOnce(timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      const onResult = (event) => {
        window.removeEventListener(SKU_RESPONSE, onResult);
        clearTimeout(timer);
        try {
          resolve(typeof event.detail === "string" && event.detail ? JSON.parse(event.detail) : null);
        } catch {
          resolve(null);
        }
      };
      timer = setTimeout(() => {
        window.removeEventListener(SKU_RESPONSE, onResult);
        resolve(null);
      }, timeoutMs);
      window.addEventListener(SKU_RESPONSE, onResult);
      window.dispatchEvent(new CustomEvent(SKU_REQUEST));
    });
  }

  async function readSkus() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const answer = await requestSkusOnce(800);
      if (answer && /^\d+$/.test(String(answer.productId)) && Array.isArray(answer.skus) && answer.skus.length > 0) return answer;
      await sleep(1000);
    }
    return null;
  }

  function renderWaiting(job) {
    const body = freshBody();
    const message = el("div");
    say(message, `Waiting for item ${job.itemIndex + 1}'s product page. If AliExpress asked you to sign in, sign in, then open the product again.`, "");
    body.append(
      itemBlock(job),
      message,
      button("Open the product page", () => ask({ type: "checkout:reopen-product" }), "act secondary"),
      cancelButton(),
    );
  }

  async function renderProductStage(job) {
    const item = job.items[job.itemIndex];
    const body = freshBody();
    const status = el("div");
    const actions = el("div", { className: "stack" });
    body.append(itemBlock(job), status, actions, cancelButton());

    if (!core.sameProduct(core.productIdFromUrl(location.href), item.externalProductId)) {
      say(status, `This page is not the product for item ${job.itemIndex + 1}.`, "err");
      actions.append(button("Open the right product", () => ask({ type: "checkout:reopen-product" }), "act secondary"));
      return;
    }
    if (productCheckFor === location.pathname) return;
    productCheckFor = location.pathname;

    say(status, "Checking that this product still offers the variant…");
    const page = await readSkus();
    if (!page || !core.sameProduct(page.productId, item.externalProductId)) {
      productCheckFor = null;
      say(status, "Could not read this product page. Wait until it has fully loaded, then press Check again.", "err");
      actions.append(button("Check again", () => renderProductStage(job), "act secondary"));
      return;
    }

    const availability = core.skuAvailability(page.skus, item.externalSkuId, item.quantity);
    if (!availability.ok) {
      const why = {
        missing: "This product no longer offers the variant DropshipHub has for this item.",
        "out-of-stock": "This variant is out of stock on AliExpress.",
        "not-enough": `Only ${availability.available} of this variant are left, and the order needs ${item.quantity}.`,
      }[availability.reason];
      say(status, `${why} The checkout page was not opened. Choose another variant or supplier for this product in DropshipHub, or cancel this checkout.`, "err");
      return;
    }

    const url = core.buildConfirmUrl({
      origin: location.origin,
      // The id this host uses, read from the page: on aliexpress.us it is the
      // global id plus 2^51, and a stored global id there opens nothing.
      objectId: page.productId,
      skuId: item.externalSkuId,
      skuAttr: availability.skuAttr ?? item.skuAttr ?? "",
      quantity: item.quantity,
      countryCode: job.address.countryCode,
      shippingCompany: item.carrierCode,
    });
    if (!url) {
      say(status, "The checkout page address could not be built for this item. Place it from the product page yourself.", "err");
      return;
    }
    say(status, "The variant is available. Opening the checkout page…", "ok");
    const answer = await ask({ type: "checkout:open-confirm", url });
    if (!answer.ok) {
      productCheckFor = null;
      say(status, answer.error, "err");
    }
  }

  // ---------------------------------------------------------------------------
  // Stage "confirm": the checkout panel
  // ---------------------------------------------------------------------------

  function readPageTotalText() {
    const rows = [...document.querySelectorAll(".pl-order-toal-container__item")];
    for (const row of rows.reverse()) {
      const text = collapse(row.textContent);
      if (core.parseMoneyText(text)) return text.slice(0, 120);
    }
    return null;
  }

  /** The summary rows (Subtotal, Shipping fee, Additional charges, Promo codes) as label + text. */
  function readSummaryRows() {
    return [...document.querySelectorAll(".pl-summary__item-pc")].map((row) => ({
      label: collapse(row.firstElementChild?.textContent ?? row.textContent).slice(0, 80),
      text: collapse(row.textContent).slice(0, 120),
    }));
  }

  function describeExpectation(expectations) {
    if (expectations.length === 0) return "DropshipHub has no cost estimate for this order.";
    const amounts = expectations.map((e) => core.formatAmount(e.amount, e.currency)).join(" / ");
    const scope = expectations[0].scope === "item" ? " for this item's goods; shipping comes on top" : " for the order, shipping estimate included";
    return `DropshipHub expects ${amounts}${scope}.`;
  }

  /**
   * The page's total beside DropshipHub's estimate, and the real total for
   * the app. The total is sent only while the page shows the customer's
   * address and the page is this item's checkout: before the address is set
   * the total carries the merchant's default address's shipping and tax
   * (US sales tax follows the destination state). It is sent again whenever
   * it changes (the worker and the app both ignore a repeat), and `again()`
   * re-reads it for a while once the address has just been set.
   */
  function costBlock(job, gate) {
    const expectations = core.expectedCosts(job);
    const line = el("div");
    const detail = el("div", { className: "muted" });
    const quoteLine = el("div");
    let lastQuoteKey = null;
    let loop = 0;
    const render = () => {
      const pageText = readPageTotalText();
      const verdict = core.compareTotals(expectations, pageText);
      detail.textContent = `${describeExpectation(expectations)} AliExpress shows: ${pageText ?? "not readable yet"}.`;
      if (verdict.kind === "close") say(line, "The total is close to DropshipHub's estimate.", "ok");
      else if (verdict.kind === "higher") say(line, "The total is higher than DropshipHub's estimate. Check the price and shipping before you pay.", "warn");
      else if (verdict.kind === "lower") say(line, "The total is lower than DropshipHub's estimate. Check the variant and quantity before you pay.", "warn");
      else if (verdict.kind === "other-currency") say(line, "AliExpress shows the total in a currency DropshipHub has no estimate in, so the two amounts are shown side by side.", "");
      else if (verdict.kind === "no-expectation" && verdict.page) say(line, "", "");
      else say(line, "Waiting for the page's total…", "");
      if (verdict.page && gate.pageMatches() && gate.addressSet()) {
        const quote = core.quoteFromPage({ totalText: pageText, rows: readSummaryRows() });
        const key = quote ? JSON.stringify(quote) : null;
        if (key && key !== lastQuoteKey) {
          lastQuoteKey = key;
          sendQuote(quote, quoteLine);
        }
      } else if (verdict.page && !lastQuoteKey) {
        say(quoteLine, gate.pageMatches() ? "The real price goes to DropshipHub once the customer's address is set on this page." : "The real price is not sent: this page does not match the order.", "");
      }
      // Done only once the page's total has been read. Stopping on any
      // verdict stopped at once for an order with no estimate, and the panel
      // then said "not readable yet" until the merchant pressed the button.
      return Boolean(verdict.page);
    };
    // The total renders after the page's own data arrives, and again after
    // the address is set; look for a while, then stop. A newer watch ends an
    // older one.
    const watch = async (untilReadable) => {
      const mine = ++loop;
      for (let i = 0; i < 20 && line.isConnected && loop === mine; i += 1) {
        await sleep(750);
        if (render() && untilReadable) break;
      }
    };
    render();
    watch(true);
    return {
      node: el("div", { className: "stack" }, [line, detail, quoteLine, button("Check the total again", render, "act secondary")]),
      again: () => {
        render();
        watch(false);
      },
    };
  }

  /**
   * The page's real total goes to the app: the captured price was in the
   * product page's currency (VND on the measured account) and the checkout
   * charges the account's (USD), so the estimate is not the price paid. The
   * worker keeps the last total sent in the job and skips a repeat.
   */
  async function sendQuote(quote, target) {
    const answer = await ask({ type: "checkout:quote", quote });
    if (answer.ok) say(target, answer.alreadySent || answer.unchanged ? "The real price is on record in DropshipHub." : "The real price was sent to DropshipHub.", "ok");
    else if (answer.error && answer.error !== RELOADED) say(target, `The real price was not sent to DropshipHub: ${answer.error}`, "warn");
  }

  /** Whether this confirm page is the checkout of the job's current item: its product, SKU, quantity and destination. */
  function pageMatchesItem(job) {
    return core.confirmUrlMismatches(location.href, job.items[job.itemIndex], job.address.countryCode).length === 0;
  }

  function urlChecks(job) {
    const box = el("div", { className: "stack" });
    const render = () => {
      box.textContent = "";
      const problems = core.confirmUrlMismatches(location.href, job.items[job.itemIndex], job.address.countryCode);
      if (problems.length === 0) {
        box.append(el("div", { className: "line ok", text: "Product, variant, quantity and destination on this page match the order." }));
      } else {
        const list = el("ul");
        for (const problem of problems) list.append(el("li", { text: problem }));
        box.append(el("div", { className: "line err", text: "This checkout page does not match the order:" }), el("div", { className: "line err" }, [list]));
      }
    };
    render();
    return { node: box, render };
  }

  /** The values the address form takes, shared by the Copy rows and the fill. */
  function formValues(job) {
    const a = job.address;
    const us = a.countryCode === "US";
    const street = us ? core.splitStreet(a.address1, a.address2) : { street: a.address1 ?? "", unit: a.address2 ?? "", moved: "", tooShort: false };
    const phone = us ? core.nationalPhone(a.phone, "+1") : { number: a.phone ?? "", matchesDialCode: true };
    return {
      firstName: a.firstName ?? "",
      lastName: a.lastName ?? "",
      phone: phone.number,
      phoneMatches: phone.matchesDialCode,
      street: street.street,
      unit: street.unit,
      moved: street.moved,
      streetTooShort: street.tooShort,
      city: a.city ?? "",
      state: us ? core.usStateName(a.provinceCode) ?? a.province ?? "" : a.province ?? a.provinceCode ?? "",
      zip: a.zip ?? "",
      country: core.countryName(a.countryCode) ?? a.country ?? a.countryCode,
      company: a.company ?? "",
      taxNumber: a.taxNumber ?? "",
    };
  }

  function addressBlock(job, values) {
    const rows = el("div", { className: "rows" });
    const inputs = {};
    const fields = [
      ["firstName", "First name"],
      ["lastName", "Last name"],
      ["phone", job.address.countryCode === "US" ? "Mobile (no +1)" : "Phone"],
      ["street", "Street"],
      ["unit", "Apt, suite, unit"],
      ["city", "City"],
      ["state", "State"],
      ["zip", "ZIP"],
      ["country", "Country"],
      ["company", "Company"],
      ["taxNumber", "Tax number"],
    ];
    for (const [key, label] of fields) {
      const value = values[key] ?? "";
      if (!value && (key === "company" || key === "taxNumber")) continue;
      const input = el("input", { type: "text" });
      input.readOnly = true;
      input.value = value;
      inputs[key] = input;
      const copy = button(
        "Copy",
        async () => {
          try {
            await navigator.clipboard.writeText(value);
            copy.textContent = "Copied";
          } catch {
            // The page's permissions policy can block the clipboard; the value
            // is selected instead, so Ctrl+C copies it.
            input.focus();
            input.select();
            copy.textContent = "Ctrl+C";
          }
          setTimeout(() => (copy.textContent = "Copy"), 1500);
        },
        "copy",
      );
      rows.append(el("div", { className: "row" }, [el("span", { text: label }), input, copy]));
    }
    const notes = el("div", { className: "stack" });
    if (values.moved) notes.append(el("div", { className: "line warn", text: `The street line is longer than AliExpress's ${core.STREET_MAX} characters, so "${values.moved}" moved to Apt, suite, unit.` }));
    if (values.streetTooShort) notes.append(el("div", { className: "line warn", text: "The street line is shorter than the 5 characters AliExpress requires." }));
    if (!values.phoneMatches) notes.append(el("div", { className: "line warn", text: "The phone number has another country's code. Check it before you pay." }));
    if (!values.firstName || !values.lastName) notes.append(el("div", { className: "line warn", text: "The order has no separate first and last name. Enter them yourself." }));
    return { node: el("div", { className: "stack" }, [el("div", { className: "muted", text: "Shipping address" }), rows, notes]), inputs };
  }

  function recordBlock(job, options = {}) {
    const last = core.isLastItem(job);
    const numbers = el("input", { type: "text", placeholder: "e.g. 8190000000000000" });
    const paid = el("input", { type: "checkbox" });
    paid.checked = true;
    const result = el("div");
    const submit = button(last ? "Record and send to DropshipHub" : "Record this item's order number", async () => {
      const parsed = core.parseOrderNumbers(numbers.value);
      if (parsed.error) {
        say(result, parsed.error, "err");
        return;
      }
      submit.disabled = true;
      say(result, last ? "Sending to DropshipHub…" : "Saving…");
      const answer = await ask({ type: "checkout:record", ids: parsed.ids, paid: paid.checked });
      submit.disabled = false;
      if (!answer.ok) {
        if (answer.ended) showEnded(answer);
        else say(result, answer.error, "err");
        return;
      }
      if (answer.done) {
        showRecorded(answer);
        return;
      }
      await refresh(true);
    });

    const hint = job.items.length > 1
      ? "Each item is its own AliExpress order. The order numbers are sent to DropshipHub together when you record the last item."
      : "Only needed if your AliExpress orders page did not record it by itself. Copy it from the order in your AliExpress account.";
    const children = [
      el("label", { className: "field" }, [el("span", { text: "AliExpress order number(s)" }), numbers]),
    ];
    if (last) {
      children.push(el("label", { className: "check" }, [paid, el("span", { text: "I have paid for it on AliExpress" })]));
    }
    const suggestion = el("div", { className: "stack" });
    children.push(suggestion, el("div", { className: "muted", text: hint }), submit, result);

    /**
     * The page after Pay now has not been measured. When an AliExpress
     * address carries long numeric order ids, they are shown beside the box
     * for the merchant to check, and go into it only when the merchant presses
     * Use. The address is whatever link was followed, so the suggestion is
     * only as good as that link; typing it into the box made it look like a
     * number DropshipHub had confirmed.
     */
    const suggest = () => {
      suggestion.textContent = "";
      const ids = core.orderIdsFromUrl(location.href);
      if (ids.length === 0) return;
      const text = ids.join(", ");
      suggestion.append(
        el("div", { className: "line warn", text: `This page's address carries order number ${text}. Check it against your AliExpress orders before you use it.` }),
        button(`Use ${text}`, () => {
          numbers.value = text;
          numbers.focus();
        }, "act secondary"),
      );
    };
    if (options.suggest !== false) suggest();
    return { node: el("div", { className: "stack" }, children), suggest };
  }

  /** The app refused for good (order gone, or recorded with other numbers), and the worker dropped the job. */
  function showEnded(answer) {
    showFinished(`${answer.error} This checkout has ended, and its address was cleared from the extension.`, "err");
  }

  function showRecorded(answer) {
    const ids = (answer.externalOrderIds ?? []).join(", ");
    if (answer.alreadyRecorded) {
      showFinished(`${answer.orderName} was already recorded as AliExpress order ${ids}. Nothing changed.`, "ok");
      return;
    }
    const next = answer.status === "PAID"
      ? "Its tracking number is recorded when you open the order's tracking page on AliExpress, or in the extension; tracking is sent to Shopify."
      : "Pay for it on AliExpress within 24 hours, or AliExpress cancels it.";
    showFinished(`Recorded ${answer.orderName} as AliExpress order ${ids}. ${next}`, "ok");
  }

  /** "Open my AliExpress orders": the worker navigates this tab to the orders list on the current host. */
  function openOrdersButton() {
    return button("Open my AliExpress orders", () => ask({ type: "checkout:open-orders" }), "act secondary");
  }

  function renderConfirm(job) {
    const body = freshBody();
    const values = formValues(job);
    const checks = urlChecks(job);
    const address = addressBlock(job, values);
    const fillStatus = el("div", { className: "stack" });
    // What the total's sender checks before every send: the page is this
    // item's checkout, and its address block shows the customer's address.
    const gate = {
      pageMatches: () => pageMatchesItem(job),
      addressSet: () => {
        const block = document.querySelector(".pl-address-item-container");
        return Boolean(block && core.addressBlockShows(block.textContent, values));
      },
    };
    const cost = costBlock(job, gate);
    const fill = button("Fill address again", () => runFill(job, values, fillStatus, fill, cost.again), "act secondary");
    const record = recordBlock(job);

    body.append(
      itemBlock(job),
      checks.node,
      cost.node,
      el("div", { className: "stack" }, [el("div", { className: "muted", text: "Address" }), fillStatus, fill]),
      el("div", { className: "note", text: PAY_YOURSELF }),
      disclosure("Customer address (copy by hand)", address.node),
      disclosure("Enter the order number yourself", record.node),
      cancelButton(),
    );
    panel.onUrlChange = () => {
      checks.render();
      record.suggest();
    };
    observePayClick(job);
    autoFill(job, values, fillStatus, fill, cost.again);
  }

  /**
   * The address fill, run by itself as soon as the confirm page is ready.
   * Skipped when the page is not this item's checkout, when the page's
   * address block already shows the customer's address, and when the job
   * records a fill that stopped (the merchant may be correcting the form by
   * hand, and "Fill address again" is there). `afterSet` re-reads the total
   * once the address is set.
   */
  async function autoFill(job, values, status, fillButton, afterSet) {
    const key = `${job.purchaseOrderId}:${job.itemIndex}`;
    if (autoFillFor === key) {
      // The view was rebuilt in the same page (back from "paying", say): the
      // outcome on record is shown rather than the fill run again.
      const outcome = core.fillOutcomeFor(job);
      if (outcome?.result === "set") report(status, "Address set. Check the total, then press Pay now on AliExpress yourself.", "ok");
      else if (outcome) report(status, `The last fill stopped: ${outcome.reason} Check the form, or press Fill address again.`, "warn");
      return;
    }
    autoFillFor = key;
    if (!pageMatchesItem(job)) {
      report(status, "This checkout page does not match the order (see the check above), so the address was not filled and the total is not sent.", "warn");
      status.append(button("Open this item's checkout again", () => ask({ type: "checkout:reopen-product" }), "act secondary"));
      return;
    }
    const view = panel.view;
    report(status, "Waiting for the page's address block…");
    // An account with a saved address shows the block; one with none may show
    // only "Add new address" (.pl-address-item__new-btn-wrap). Either means
    // the page is ready for the fill.
    const ready = await waitFor(() => document.querySelector(".pl-address-item-container") ?? document.querySelector(".pl-address-item__new-btn-wrap"), 20000);
    if (panel?.view !== view) return;
    status.textContent = "";
    if (!ready) {
      report(status, "The page's address block has not appeared. Once it has, press Fill address again.", "warn");
      return;
    }
    const block = document.querySelector(".pl-address-item-container");
    const shown = Boolean(block && core.addressBlockShows(block.textContent, values));
    if (shown) {
      report(status, "The address on this page is the customer's. Check the total, then press Pay now on AliExpress yourself.", "ok");
      const outcome = core.fillOutcomeFor(job);
      if (!outcome || outcome.result !== "set") await ask({ type: "checkout:fill-result", result: "set", reason: "The page already showed the address." });
      afterSet?.();
      return;
    }
    if (!core.shouldAutoFill(job, shown)) {
      const outcome = core.fillOutcomeFor(job);
      report(status, `The last fill stopped: ${outcome?.reason ?? "see the form."} Check the form, or press Fill address again.`, "warn");
      return;
    }
    await runFill(job, values, status, fillButton, afterSet);
  }

  /** One fill, from the automatic run or the button, with its outcome recorded in the job. */
  async function runFill(job, values, status, fillButton, afterSet) {
    fillButton.disabled = true;
    status.textContent = "";
    let outcome = { result: "failed", reason: "The fill stopped unexpectedly." };
    try {
      outcome = await fillAddress(job, values, status);
    } catch {
      report(status, "The fill stopped unexpectedly. Use the Copy buttons for the remaining fields.", "err");
    } finally {
      fillButton.disabled = false;
      // Typing left focus in AliExpress's form. Keys meant for the panel then
      // went into the page's form, and Enter in a text box can submit a form
      // that has a submit button.
      if (fillButton.isConnected) fillButton.focus();
    }
    await ask({ type: "checkout:fill-result", result: outcome.result, reason: outcome.reason });
    // The saved address changes the page's shipping and tax: the total is read again.
    if (outcome.result === "set") afterSet?.();
  }

  /**
   * Observes the merchant's own click on Pay now, so the job moves to
   * "paying" and the orders page can record the order number afterwards. It
   * only listens: it never prevents, delays or makes that click. The job is
   * moved only when the page is this item's checkout: a Pay now on another
   * product's confirm page in the same tab (a later Buy now, say) is not this
   * item being paid for, and the orders page would then take that order for
   * it. The listener is installed once per page; `payObserverJob` is the job
   * the confirm view was last rendered with.
   */
  function observePayClick(job) {
    payObserverJob = job;
    if (payObserverInstalled) return;
    payObserverInstalled = true;
    document.addEventListener(
      "click",
      (event) => {
        if (!event.isTrusted || !(event.target instanceof Element)) return;
        if (!event.target.closest("button.place-order-primary-btn")) return;
        if (!payObserverJob || !pageMatchesItem(payObserverJob)) return;
        ask({ type: "checkout:paying" }).then((answer) => {
          if (answer.ok) refresh(true);
        });
      },
      true,
    );
  }

  /** The confirm stage on any other AliExpress page, where the merchant may have landed after Pay now. */
  function renderRecordOnly(job) {
    const body = freshBody();
    const record = recordBlock(job);
    body.append(
      itemBlock(job),
      el("div", { className: "note", text: PAY_YOURSELF }),
      openOrdersButton(),
      disclosure("Enter the order number yourself", record.node),
      button("Open this item's checkout again", () => ask({ type: "checkout:reopen-product" }), "act secondary"),
      cancelButton(),
    );
    panel.onUrlChange = record.suggest;
  }

  /**
   * Stage "paying": Pay now was pressed. The orders page records the order
   * number and the worker drops the job; until then this view polls so it
   * disappears by itself once that has happened.
   */
  function renderPaying(job) {
    const body = freshBody();
    const view = panel.view;
    const record = recordBlock(job);
    const line = el("div");
    say(line, "Payment started on AliExpress. When it is done, open your AliExpress orders and DropshipHub records the order number by itself.", "ok");
    body.append(itemBlock(job), line);
    if (core.isOrdersPage(location.href)) {
      body.append(el("div", { className: "muted", text: "Looking for the new order in this list… If AliExpress has not listed it yet, reload this page in a moment." }));
    } else {
      body.append(openOrdersButton());
    }
    body.append(
      disclosure("Enter the order number yourself", record.node),
      button("I have not paid yet: back to the checkout", async () => {
        const answer = await ask({ type: "checkout:not-paid" });
        if (answer.ok) refresh(true);
      }, "act secondary"),
      cancelButton(),
    );
    panel.onUrlChange = record.suggest;
    (async () => {
      while (panel && panel.view === view) {
        await sleep(3000);
        if (!panel || panel.view !== view) return;
        const answer = await ask({ type: "checkout:get" });
        if (answer.error === RELOADED) return;
        if (!answer.ok || !answer.job) {
          clearPanel();
          return;
        }
        if (answer.job.stage !== "paying") {
          refresh();
          return;
        }
      }
    })();
  }

  function renderRecorded(job) {
    const body = freshBody();
    const ids = job.recordedOrderIds[job.itemIndex] ?? [];
    body.append(itemBlock(job), el("div", { className: "line ok", text: `Recorded for this item: AliExpress order ${ids.join(", ")}.` }));
    if (!core.isLastItem(job)) {
      body.append(
        el("div", { className: "muted", text: "The numbers are sent to DropshipHub when the last item is recorded." }),
        button(`Next item (${job.itemIndex + 2} of ${job.items.length})`, async () => {
          const answer = await ask({ type: "checkout:next" });
          if (!answer.ok) showFinished(answer.error, "err");
        }),
      );
    } else {
      const paid = el("input", { type: "checkbox" });
      paid.checked = true;
      const result = el("div");
      say(result, "Not yet saved in DropshipHub.", "warn");
      const send = button("Send to DropshipHub again", async () => {
        send.disabled = true;
        say(result, "Sending to DropshipHub…");
        const answer = await ask({ type: "checkout:send", paid: paid.checked });
        send.disabled = false;
        if (answer.ok) showRecorded(answer);
        else if (answer.ended) showEnded(answer);
        else say(result, answer.error, "err");
      });
      body.append(result, el("label", { className: "check" }, [paid, el("span", { text: "I have paid for it on AliExpress" })]), send);
    }
    body.append(el("div", { className: "muted", text: "Wrong number? Enter it again:" }), recordBlock(job, { suggest: false }).node, cancelButton());
  }

  // ---------------------------------------------------------------------------
  // The address fill: shared parts
  // ---------------------------------------------------------------------------

  function report(target, text, tone) {
    const line = el("div");
    say(line, text, tone);
    target.append(line);
  }

  /** The fill's outcome, recorded in the job: "set", "partial" (typed, not saved) or "failed" (nothing or little typed). */
  function outcome(result, reason) {
    return { result, reason: String(reason ?? "").slice(0, 300) };
  }

  const marked = new Set();

  /** Outlines a page element for the merchant's attention. Never clicks it. */
  function mark(element, color) {
    if (!element) return;
    element.style.outline = `3px solid ${color}`;
    element.style.outlineOffset = "2px";
    marked.add(element);
  }

  function clearMarks() {
    for (const element of marked) {
      element.style.outline = "";
      element.style.outlineOffset = "";
    }
    marked.clear();
  }

  /**
   * The address form on the page, only while it is shown. A drawer that hides
   * its form (no client rects) rather than removing it still holds the boxes:
   * a hidden form is nothing to type into, and after Save it is not "still
   * open".
   */
  function fusionForm() {
    // The Fusion design's form: a real <form> built from next-* components.
    return [...document.querySelectorAll("form.deliver-address-form")].find(isVisible) ?? null;
  }

  function cometForm() {
    // The comet design's form: a div.mt-form inside the address drawer; there is no <form>.
    return [...document.querySelectorAll(".deliver-address-form")].find((node) => !(node instanceof HTMLFormElement) && isVisible(node)) ?? null;
  }

  /** Whichever address form is open, with its design, or null. */
  function openAddressForm() {
    const fusion = fusionForm();
    if (fusion) return { design: "fusion", form: fusion };
    const comet = cometForm();
    if (comet) return { design: "comet", form: comet };
    return null;
  }

  function addressFormOf(design) {
    return design === "comet" ? cometForm() : fusionForm();
  }

  const NOT_TEXT = new Set(["checkbox", "radio", "hidden", "submit", "button", "image", "reset", "file"]);

  /**
   * Types into one of the address form's own inputs the way React expects.
   * React keeps its own copy of a controlled input's value: a value set
   * without the input event never reaches its state, and the next render puts
   * the old value back. The native setter plus input and change events is how
   * the page's own typing looks to it. Anything outside the address form (a
   * payment field, the cascade modal's search box) is refused, as is any box
   * that is not a text box.
   */
  function setInputValue(input, value) {
    if (!(input instanceof HTMLInputElement) || !input.closest(".deliver-address-form")) return false;
    if (NOT_TEXT.has((input.getAttribute("type") ?? "").toLowerCase())) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function isVisible(node) {
    return node.getClientRects().length > 0;
  }

  const FIELD_LABELS = { firstName: "First name", lastName: "Last name", phone: "Mobile number", street: "Street", unit: "Apt, suite, unit", zip: "ZIP" };

  function intendedValues(values) {
    return { firstName: values.firstName, lastName: values.lastName, phone: values.phone, street: values.street, unit: values.unit, zip: values.zip };
  }

  /**
   * Whether the fill may go on to its next step. A step waits seconds for
   * AliExpress, and meanwhile the merchant can press Cancel or the page can
   * move on; the fill used to keep typing the customer's address into the form
   * after the checkout holding it had been cancelled.
   */
  async function fillMayContinue(job, status) {
    const answer = await ask({ type: "checkout:get" });
    const current = answer.ok ? answer.job : null;
    if (!current || current.stage !== "confirm" || current.purchaseOrderId !== job.purchaseOrderId || current.itemIndex !== job.itemIndex) {
      report(status, "This checkout was cancelled or has moved on, so the fill stopped.", "warn");
      return false;
    }
    if (!core.isConfirmPage(location.href)) {
      report(status, "The page changed, so the fill stopped.", "warn");
      return false;
    }
    return true;
  }

  /**
   * Opens the add-address form when none is open: "Add new address" when the
   * account has no saved address, else "Change" on the saved address and then
   * the list's "Add new address" button. Returns { design, form } or null.
   */
  async function openFormIfNeeded(status) {
    const open = openAddressForm();
    if (open) return open;
    const wrap = document.querySelector(".pl-address-item__new-btn-wrap");
    if (wrap) {
      const add = wrap.querySelector("button, [role='button'], a") ?? wrap;
      const refused = guardedClick(add);
      if (refused) {
        report(status, `Click "Add new address" on the page yourself, then press Fill address again. (${refused})`, "warn");
        return null;
      }
    } else {
      // The measured "Change" control is the <a> inside the span (no href, no
      // classes). One selector list would return the span, which precedes its
      // own child in tree order, and a click on the span never reaches the
      // anchor's handler.
      const change = document.querySelector("span.pl-address-item__arrrow a") ?? document.querySelector("span.pl-address-item__arrrow");
      if (!change) {
        report(status, 'Open the add-address form on this page ("Add new address", or "Change" and then "Add new address"), then press Fill address again.', "warn");
        return null;
      }
      const refusedChange = guardedClick(change);
      if (refusedChange) {
        report(status, `Click "Change" beside the address yourself, then press Fill address again. (${refusedChange})`, "warn");
        return null;
      }
      const drawer = await waitFor(() => [...document.querySelectorAll(".comet-drawer.pl-address-model-cls")].find(isVisible), 8000);
      if (!drawer) {
        report(status, "The address list did not open. Open it yourself, press Add new address, then press Fill address again.", "err");
        return null;
      }
      const add = await waitFor(() => drawer.querySelector("button.add-address"), 5000);
      if (!add) {
        report(status, 'Could not find "Add new address" in the address list. Press it yourself, then press Fill address again.', "warn");
        return null;
      }
      const refusedAdd = guardedClick(add);
      if (refusedAdd) {
        report(status, `Press "Add new address" in the list yourself, then press Fill address again. (${refusedAdd})`, "warn");
        return null;
      }
    }
    const form = await waitFor(openAddressForm, 8000);
    if (!form) report(status, "The add-address form did not open. Open it yourself, then press Fill address again.", "err");
    return form;
  }

  async function fillAddress(job, values, status) {
    clearMarks();
    if (!core.isConfirmPage(location.href)) {
      report(status, "Fill address works on AliExpress's checkout page only.", "err");
      return outcome("failed", "Not on the checkout page.");
    }
    if (!pageMatchesItem(job)) {
      // A later navigation in this tab (Buy now on another product, say)
      // lands on a confirm page that is not this item's; the customer's
      // address must not be saved into that checkout.
      report(status, "This checkout page does not match the order (see the check above), so nothing was filled. Open this item's checkout again.", "err");
      return outcome("failed", "The page does not match the item.");
    }
    if (job.address.countryCode !== "US") {
      // Only the US form has been measured; other countries render other
      // fields (Vietnam: province, district, ward) in other positions.
      const reason = `DropshipHub can fill only AliExpress's US address form, and this order ships to ${values.country}.`;
      report(status, `${reason} Use the Copy buttons to enter the address.`, "warn");
      return outcome("failed", reason);
    }
    if (!(await fillMayContinue(job, status))) return outcome("failed", "The checkout moved on.");

    const open = await openFormIfNeeded(status);
    if (!open) return outcome("failed", "The add-address form did not open.");
    return open.design === "comet" ? fillCometForm(job, values, status, open.form) : fillFusionForm(job, values, status, open.form);
  }

  // ---------------------------------------------------------------------------
  // The comet form (www.aliexpress.us in English): boxes by position, one
  // cascade modal for State and City
  // ---------------------------------------------------------------------------

  const COMET = core.COMET_POSITIONS;

  function cometInputs(form) {
    return [...form.querySelectorAll("input")];
  }

  /**
   * The drawer around the comet form, where "Set as default" and Save sit.
   * The drawer is the widest measured container: whether the switch and the
   * Save button sit inside `.deliver-address-wrap` or in the drawer's footer
   * has not been measured, and looking only in the wrap could miss them.
   */
  function cometScope(form) {
    return form.closest(".comet-drawer") ?? form.closest(".deliver-address-wrap") ?? form.parentElement ?? form;
  }

  /**
   * The "Set as default" switch, for reading only: nothing here clicks or sets
   * it. The measured switch carries the `switcher` class beside the switch
   * class; the bare switch class is the fallback, so another switch
   * AliExpress adds to the drawer cannot be read in its place while the
   * measured one is there.
   */
  function cometSwitch(form) {
    const scope = cometScope(form);
    return scope.querySelector(".mt-switch.switcher") ?? scope.querySelector(".mt-switch");
  }

  function cometSwitchState(form) {
    const node = cometSwitch(form);
    if (!node) return "missing";
    const on = [...node.classList].some((c) => /--checked$|(^|-)checked$/i.test(c)) || node.getAttribute("aria-checked") === "true";
    return on ? "on" : "off";
  }

  function cometSnapshot(form) {
    return { inputs: cometInputs(form).map((input) => ({ type: input.getAttribute("type") ?? "", role: input.getAttribute("role") ?? "", value: input.value })) };
  }

  /**
   * Stops the fill, before it changes anything, in a form that is not a new
   * address: one whose boxes hold something DropshipHub did not type (the
   * edit form of a saved address), or whose "Set as default" switch is on.
   * `requireSwitch` is set once the whole form is showing.
   */
  function cometRefusesFill(form, values, status, requireSwitch) {
    const inputs = cometInputs(form);
    const boxes = core.COMET_TEXT_BOXES.filter((i) => i < inputs.length).map((i) => inputs[i]);
    const foreign = core.foreignFormValues(boxes.map((box) => box.value), Object.values(intendedValues(values)));
    if (foreign.length > 0) {
      for (const index of foreign) mark(boxes[index], "#b3261e");
      report(status, "This form already holds an address DropshipHub did not enter (highlighted), so nothing was filled. It may be a saved address being edited. Go back, press Add new address, then press Fill address again.", "warn");
      return true;
    }
    const state = cometSwitchState(form);
    if (state === "on") {
      mark(cometSwitch(form), "#b3261e");
      report(status, '"Set as default" is on for this form (highlighted), so nothing was filled. Switch it off yourself, then press Fill address again.', "warn");
      return true;
    }
    if (state === "missing" && requireSwitch) {
      report(status, 'Could not find "Set as default" on the form, so nothing was filled. AliExpress may have changed the form. Use the Copy buttons.', "warn");
      return true;
    }
    return false;
  }

  async function cometEnterManually(form, status) {
    if (cometInputs(form).length >= COMET.count) return form;
    const link = [...cometScope(form).querySelectorAll("div.text-button-container")].find((node) => /^(enter manually|nhập thủ công)$/i.test(collapse(node.textContent)));
    if (!link) {
      report(status, 'Could not find "Enter manually" on the form. Press it yourself, then press Fill address again.', "warn");
      return null;
    }
    const refused = guardedClick(link);
    if (refused) {
      report(status, `Press "Enter manually" on the form yourself, then press Fill address again. (${refused})`, "warn");
      return null;
    }
    const ready = await waitFor(() => {
      const current = cometForm();
      return current && cometInputs(current).length >= COMET.count ? current : null;
    }, 5000);
    if (!ready) report(status, 'The street boxes did not appear after "Enter manually". Use the Copy buttons.', "warn");
    return ready;
  }

  function visibleCascadeModal() {
    return [...document.querySelectorAll(".mt-drawer-modal")].find(isVisible) ?? null;
  }

  /** The cascade modal's options: every div.group-item with its span.item-label text. */
  function cascadeItems(modal) {
    const items = [...modal.querySelectorAll(".group-item")].map((item) => ({ item, label: collapse(item.querySelector("span.item-label")?.textContent ?? item.textContent) }));
    return { items, labels: items.map((entry) => entry.label) };
  }

  function cascadeItem(modal, label) {
    return cascadeItems(modal).items.find((entry) => entry.label === label)?.item ?? null;
  }

  /** Closes the cascade modal with its own close icon, so a half-chosen state is not left behind. */
  function closeCascade() {
    const modal = visibleCascadeModal();
    const close = modal?.querySelector(".drawer-cascade-header span.mt-icon-close, span.mt-icon-close");
    if (close) guardedClick(close);
  }

  /**
   * Chooses State and City in the one cascade modal: clicking the State box
   * opens "Select address" at the state level (letter headers plus states),
   * a state moves the same modal to its cities ("Other" last), and a city
   * closes it and fills both boxes. Nothing is ever typed into the modal's
   * search box: it hides the list while it has text.
   */
  async function chooseInCascade(job, form, values, stateCandidates, status) {
    const stateBox = cometInputs(form)[COMET.state];
    if (!stateBox) return { error: "The State box was not found." };
    const refused = guardedClick(stateBox);
    if (refused) return { error: `DropshipHub did not open the State list: ${refused}` };
    const modal = await waitFor(visibleCascadeModal, 6000);
    if (!modal) return { error: "The State list did not open. Choose the state and city yourself." };
    const stateLabels = await waitFor(() => {
      const current = visibleCascadeModal();
      const labels = current ? cascadeItems(current).labels : [];
      return labels.length > 0 ? labels : null;
    }, 6000);
    if (!stateLabels) {
      closeCascade();
      return { error: "The State list stayed empty. Choose the state and city yourself." };
    }
    const stateLabel = core.chooseCascadeOption(stateLabels, stateCandidates);
    if (!stateLabel) {
      closeCascade();
      return { error: `"${stateCandidates[0] ?? (values.state || "the state")}" is not in AliExpress's State list. Choose the state and city yourself.` };
    }
    const refusedState = guardedClick(cascadeItem(visibleCascadeModal() ?? modal, stateLabel));
    if (refusedState) {
      closeCascade();
      return { error: `DropshipHub did not choose the state: ${refusedState}` };
    }
    // The modal has moved to the city level only when its steps name the
    // chosen state, or the state list's letter headers are gone. "The labels
    // changed" was not enough: the state list re-rendering (a header
    // collapsing, an item scrolled in) read as the city list, and the
    // customer's city was then looked for among states.
    const cityLabels = await waitFor(() => {
      const current = visibleCascadeModal();
      if (!current) return null;
      const labels = cascadeItems(current).labels;
      if (labels.length === 0) return null;
      const steps = collapse(current.querySelector(".drawer-cascade-steps")?.textContent);
      return core.cascadeMovedPastStates(labels, steps, stateLabel) ? labels : null;
    }, 8000);
    if (!cityLabels) {
      closeCascade();
      return { error: `The city list did not appear after choosing ${stateLabel}. Choose the state and city yourself.` };
    }
    const city = core.chooseCascadeCity(cityLabels, values.city);
    if (!city) {
      closeCascade();
      return { error: `Could not choose "${values.city}" in the City list, and it has no "Other". Choose the state and city yourself.` };
    }
    if (!(await fillMayContinue(job, status))) {
      closeCascade();
      return { error: "The checkout moved on." };
    }
    const refusedCity = guardedClick(cascadeItem(visibleCascadeModal() ?? modal, city.label));
    if (refusedCity) {
      closeCascade();
      return { error: `DropshipHub did not choose the city: ${refusedCity}` };
    }
    const filled = await waitFor(() => {
      if (visibleCascadeModal()) return null;
      const current = cometForm();
      const inputs = current ? cometInputs(current) : [];
      return inputs.length === COMET.count && collapse(inputs[COMET.state].value) && collapse(inputs[COMET.city].value) ? true : null;
    }, 8000);
    if (!filled) return { error: "State and City did not fill after the choice. Choose them yourself." };
    return { state: stateLabel, city: city.label, cityOther: city.isOther };
  }

  async function fillCometForm(job, values, status, form) {
    const countryCandidates = core.countryTitleCandidates(job.address.countryCode);
    let inputs = cometInputs(form);
    if (inputs.length < COMET.search + 1) {
      report(status, `The form has ${inputs.length} boxes, fewer than the US address form. AliExpress may have changed the form. Use the Copy buttons.`, "warn");
      return outcome("failed", "The form has too few boxes.");
    }
    // Country first: changing it re-renders the form for another country,
    // and doing that here has not been measured, so the fill stops instead.
    const country = collapse(inputs[COMET.country].value);
    if (core.matchOption([country], countryCandidates) === null) {
      mark(inputs[COMET.country], "#b98900");
      const reason = `The Country/region box shows "${country || "nothing"}", not the United States.`;
      report(status, `${reason} Choose United States yourself (highlighted), then press Fill address again.`, "warn");
      return outcome("failed", reason);
    }
    if (cometRefusesFill(form, values, status, false)) return outcome("failed", "The form is not a new address.");
    form = await cometEnterManually(form, status);
    if (!form) return outcome("failed", 'The street boxes did not appear after "Enter manually".');

    const structure = core.cometFormStructure(cometSnapshot(form), countryCandidates);
    if (!structure.ok) {
      report(status, `Stopped before typing: ${structure.reason} AliExpress may have changed the form. Use the Copy buttons.`, "warn");
      return outcome("failed", structure.reason);
    }
    if (cometRefusesFill(form, values, status, true)) return outcome("failed", "The form is not a new address.");
    if (!(await fillMayContinue(job, status))) return outcome("failed", "The checkout moved on.");

    const intended = intendedValues(values);
    inputs = cometInputs(form);
    const typedInto = Object.fromEntries(Object.entries(core.COMET_TYPED).map(([key, index]) => [key, inputs[index]]));
    for (const [key, input] of Object.entries(typedInto)) setInputValue(input, intended[key]);
    // Delivery Instructions (box 12) stays empty; the search box (6) and the
    // "Set as default" switch are never touched.
    const flags = [];
    if (!values.firstName) flags.push(typedInto.firstName);
    if (!values.lastName) flags.push(typedInto.lastName);
    if (!values.phoneMatches) flags.push(typedInto.phone);
    if (values.moved || values.streetTooShort) flags.push(typedInto.street, typedInto.unit);

    if (!(await fillMayContinue(job, status))) return outcome("partial", "The checkout moved on.");
    const stateCandidates = core.stateTitleCandidates(job.address.province, job.address.provinceCode);
    const cascade = await chooseInCascade(job, form, values, stateCandidates, status);
    if (cascade.error) {
      const current = cometForm();
      const now = current ? cometInputs(current) : [];
      flags.push(now[COMET.state], now[COMET.city]);
      for (const node of flags) mark(node, "#b98900");
      report(status, `${cascade.error} Then press Save on the form yourself.`, "warn");
      return outcome("partial", cascade.error);
    }
    if (cascade.cityOther) {
      report(status, `"${values.city}" is not in AliExpress's city list for ${cascade.state}, so "Other" was chosen. The saved address shows "Other" as the city; check it before you pay.`, "warn");
    }

    // Read every box back once React has had a render to put an old value
    // back, by position on the form as it is now.
    await sleep(400);
    const current = cometForm();
    const now = current ? cometInputs(current) : [];
    if (!current || now.length !== COMET.count) {
      report(status, "The address form changed after typing. Check it and press Save yourself.", "warn");
      return outcome("partial", "The address form changed after typing.");
    }
    const actual = Object.fromEntries(Object.entries(core.COMET_TYPED).map(([key, index]) => [key, now[index].value]));
    const wrong = core.mismatchedFields(intended, actual);
    if (wrong.length > 0) {
      for (const key of wrong) flags.push(now[core.COMET_TYPED[key]]);
      for (const node of flags) mark(node, "#b98900");
      const reason = `These boxes do not show what DropshipHub typed: ${wrong.map((key) => FIELD_LABELS[key]).join(", ")}.`;
      report(status, `${reason} Enter them yourself with the Copy buttons, then press Save.`, "warn");
      return outcome("partial", reason);
    }
    for (const node of flags) mark(node, "#b98900");
    return saveAddressForm({ design: "comet", form: current, job, values, intended, countryCandidates, stateCandidates, cityOther: cascade.cityOther === true, status });
  }

  // ---------------------------------------------------------------------------
  // The Fusion form (next-* components): the fallback design
  // ---------------------------------------------------------------------------

  // The address search box is a next-select-auto-complete; it counts as select
  // 1 in the measured order whether or not it also carries next-select, and its
  // input must not be mistaken for a text box.
  const SELECT = ".next-select, .next-select-auto-complete";

  function topSelects(form) {
    return [...form.querySelectorAll(SELECT)].filter((node) => !node.parentElement?.closest(SELECT));
  }

  function plainInputs(form) {
    return [...form.querySelectorAll("input")].filter((input) => !NOT_TEXT.has((input.getAttribute("type") ?? "").toLowerCase()) && !input.closest(SELECT));
  }

  function visibleMenus() {
    return [...document.querySelectorAll(".next-select-menu")].filter(isVisible);
  }

  /**
   * The menus a select names as its own through aria-controls or aria-owns,
   * on its root or anything inside it. Whether Fusion sets these has not been
   * measured; when it does, those menus are the only ones used.
   */
  function linkedMenus(select) {
    const ids = new Set();
    for (const node of [select, ...select.querySelectorAll("[aria-controls], [aria-owns]")]) {
      for (const attribute of ["aria-controls", "aria-owns"]) {
        for (const id of (node.getAttribute(attribute) ?? "").split(/\s+/)) if (id) ids.add(id);
      }
    }
    return [...ids].map((id) => document.getElementById(id)).filter(Boolean);
  }

  /**
   * The options of `select`'s own menu. Every select's menu is rendered
   * outside the form and may stay in the page, still laid out, while it
   * animates closed. Looking at every visible menu once no new one had
   * appeared for two seconds could click the State list's "Washington", left
   * over from the step before, as the City of a DC order. So the menu is the
   * one the select links to when it links one, and otherwise one that was not
   * visible when `before` was taken, just before this select was clicked. A
   * menu element the select reuses was hidden at that moment, so it counts as
   * new, and no fallback to "any visible menu" is needed.
   */
  function optionsFor(select, before) {
    const linked = linkedMenus(select);
    const menus = linked.length > 0 ? linked.filter(isVisible) : visibleMenus().filter((menu) => !before.has(menu));
    return menus.flatMap((menu) => [...menu.querySelectorAll('li[role="option"]')]).filter(isVisible);
  }

  function optionTitle(li) {
    return li.getAttribute("title") || (li.textContent ?? "").trim();
  }

  function selectText(select) {
    return collapse(select?.querySelector(".next-select-values, .next-select-value")?.textContent ?? "");
  }

  function selectShows(select, candidates) {
    return core.matchOption([selectText(select)], candidates) !== null;
  }

  /**
   * Opens a searchable select, types `typed` to filter it, and clicks the
   * option `pick` names. Returns { title } or { error }.
   */
  async function chooseInSelect(select, typed, pick, timeoutMs) {
    // In Fusion Next the select's root carries next-select-trigger itself, so
    // a descendant search alone normally finds nothing.
    const trigger = select.matches(".next-select-trigger")
      ? select
      : select.querySelector(".next-select-trigger") ?? select.querySelector(".next-select-inner") ?? select;
    const before = new Set(visibleMenus());
    const refused = guardedClick(trigger);
    if (refused) return { error: `DropshipHub did not open the list: ${refused}` };
    const search = select.querySelector("input");
    if (search) setInputValue(search, typed);
    const option = await waitFor(() => {
      const options = optionsFor(select, before);
      const title = pick(options.map(optionTitle));
      return title === null ? null : options.find((li) => optionTitle(li) === title);
    }, timeoutMs);
    if (!option) return { error: "no-option", search, before };
    const refusedOption = guardedClick(option);
    if (refusedOption) return { error: `DropshipHub did not choose the option: ${refusedOption}` };
    return { title: optionTitle(option) };
  }

  async function enterManuallyIfNeeded(form, status) {
    if (plainInputs(form).length >= 8) return form;
    const scope = form.closest("[role='dialog'], .next-dialog") ?? form;
    const candidates = [...scope.querySelectorAll("a, button, span, div, [role='button']")].filter((node) =>
      /^(enter manually|nhập thủ công)$/i.test((node.textContent ?? "").trim()),
    );
    const link = candidates.find((node) => !candidates.some((other) => other !== node && node.contains(other)));
    if (!link) {
      report(status, 'Could not find "Enter manually" on the form. Use the Copy buttons.', "warn");
      return null;
    }
    // The text usually sits in a span inside the real control. The guard is
    // handed that control, so it judges the button itself (an untyped button
    // in the form would submit it) rather than the harmless-looking span.
    const refused = guardedClick(link.closest("button, a, [role='button']") ?? link);
    if (refused) {
      report(status, `Click "Enter manually" on the form yourself, then press Fill address again. (${refused})`, "warn");
      return null;
    }
    const ready = await waitFor(() => {
      const current = fusionForm();
      return current && plainInputs(current).length >= 8 ? current : null;
    }, 5000);
    if (!ready) report(status, 'The street boxes did not appear after "Enter manually". Use the Copy buttons.', "warn");
    return ready;
  }

  const DEFAULT_BOX = 'input[type="checkbox"], [role="checkbox"], .next-checkbox-wrapper';

  /** The address dialog's checkbox-like nodes, for reading only: nothing here sets or clicks them. */
  function defaultBoxNodes(form) {
    const scope = form.closest("[role='dialog'], .next-dialog") ?? form;
    return [...scope.querySelectorAll(DEFAULT_BOX)];
  }

  function readDefaultBox(nodes) {
    return core.defaultBoxState(
      nodes.map((node) => ({
        checked: node instanceof HTMLInputElement ? node.checked : null,
        ariaChecked: node.getAttribute("aria-checked"),
        classes: [...node.classList],
      })),
    );
  }

  /**
   * Stops the fill, before it changes anything, in a form that is not a new
   * address: one that already holds another address (AliExpress's edit form
   * for a saved one), or one whose "Set as default shipping address" is
   * ticked. Filling either put the customer's address over one of the
   * merchant's saved addresses, possibly their default, as soon as it was
   * saved. `requireBox` is set once the whole US form is showing, where the
   * measured form has the box; before "Enter manually" it may not be
   * rendered yet.
   */
  function formRefusesFill(form, values, status, requireBox) {
    const inputs = plainInputs(form);
    const foreign = core.foreignFormValues(inputs.map((input) => input.value), Object.values(intendedValues(values)));
    if (foreign.length > 0) {
      for (const index of foreign) mark(inputs[index], "#b3261e");
      report(status, "This form already holds an address DropshipHub did not enter (highlighted), so nothing was filled. It may be a saved address being edited. Close it without saving, press Add new address, then press Fill address again.", "warn");
      return true;
    }
    const boxes = defaultBoxNodes(form);
    const box = readDefaultBox(boxes);
    if (box === "ticked") {
      for (const node of boxes) mark(node, "#b3261e");
      report(status, '"Set as default shipping address" is ticked on this form (highlighted), so nothing was filled. Untick it yourself, or close this form and use Add new address, then press Fill address again.', "warn");
      return true;
    }
    if (box === "missing" && requireBox) {
      report(status, 'Could not find "Set as default shipping address" on the form, so nothing was filled. AliExpress may have changed the form. Use the Copy buttons.', "warn");
      return true;
    }
    return false;
  }

  /** The open Fusion form while it is still the measured US form, or null with the reason reported. */
  function measuredUsForm(status, when) {
    const form = fusionForm();
    if (!form) {
      report(status, "The address form closed, so the fill stopped. Open it again and press Fill address.", "err");
      return null;
    }
    const structure = core.usFormStructure({
      plainInputs: plainInputs(form).map((input) => ({ placeholder: input.getAttribute("placeholder") ?? "", value: input.value })),
      selectCount: topSelects(form).length,
    });
    if (!structure.ok) {
      report(status, `Stopped ${when}: ${structure.reason} AliExpress may have changed the form. Use the Copy buttons.`, "warn");
      return null;
    }
    return form;
  }

  async function fillFusionForm(job, values, status, form) {
    // Before anything in an already open form is touched, "Enter manually"
    // and the country included.
    if (formRefusesFill(form, values, status, false)) return outcome("failed", "The form is not a new address.");
    form = await enterManuallyIfNeeded(form, status);
    if (!form) return outcome("failed", 'The street boxes did not appear after "Enter manually".');

    // Country first: changing it re-renders every other field.
    const countryCandidates = core.countryTitleCandidates(job.address.countryCode);
    const countrySelect = topSelects(form)[0];
    if (!countrySelect) {
      report(status, "The form has no Country/region list. Use the Copy buttons.", "warn");
      return outcome("failed", "The form has no Country/region list.");
    }
    if (!selectShows(countrySelect, countryCandidates)) {
      if (!(await fillMayContinue(job, status))) return outcome("failed", "The checkout moved on.");
      const chosen = await chooseInSelect(countrySelect, countryCandidates[0], (titles) => core.matchOption(titles, countryCandidates), 5000);
      if (chosen.error) {
        const reason = chosen.error === "no-option" ? `"${countryCandidates[0]}" is not in the Country/region list.` : chosen.error;
        report(status, `${reason} Choose it yourself, then press Fill address again.`, "warn");
        return outcome("failed", reason);
      }
      await waitFor(() => {
        const current = fusionForm();
        const select = current ? topSelects(current)[0] : null;
        return select && selectShows(select, countryCandidates);
      }, 3000);
      await sleep(500);
      form = fusionForm();
      if (!form) {
        report(status, "The address form closed while the country changed. Open it again and press Fill address.", "err");
        return outcome("failed", "The address form closed while the country changed.");
      }
      form = await enterManuallyIfNeeded(form, status);
      if (!form) return outcome("failed", 'The street boxes did not appear after "Enter manually".');
    }

    form = measuredUsForm(status, "before filling anything else");
    if (!form) return outcome("failed", "The form is not the measured US form.");
    // Again on the whole form: the default box is rendered by now, and a
    // country change may have brought back a saved address's values.
    if (formRefusesFill(form, values, status, true)) return outcome("failed", "The form is not a new address.");

    const flags = [];
    if (!(await fillMayContinue(job, status))) return outcome("failed", "The checkout moved on.");
    // The text boxes are typed while the form is exactly the measured one.
    // What "Other" in City adds to the form has not been measured, so typing
    // them after the drop-downs could find the form changed and type nothing.
    // Instead every box is read back after State and City, which catches a
    // value those choices, or a React re-render, cleared or put back.
    const intended = intendedValues(values);
    const [firstNameBox, lastNameBox, , mobileBox, streetBox, unitBox, zipBox] = plainInputs(form);
    const typedInto = { firstName: firstNameBox, lastName: lastNameBox, phone: mobileBox, street: streetBox, unit: unitBox, zip: zipBox };
    for (const [key, input] of Object.entries(typedInto)) setInputValue(input, intended[key]);
    // Delivery instructions (the eighth box) stays empty, and "Set as default
    // shipping address" is never touched.
    if (!values.firstName) flags.push(typedInto.firstName);
    if (!values.lastName) flags.push(typedInto.lastName);
    if (!values.phoneMatches) flags.push(typedInto.phone);
    if (values.moved || values.streetTooShort) flags.push(typedInto.street, typedInto.unit);

    if (!(await fillMayContinue(job, status))) return outcome("partial", "The checkout moved on.");
    const stateCandidates = core.stateTitleCandidates(job.address.province, job.address.provinceCode);
    const stateSelect = topSelects(fusionForm() ?? form)[2];
    const state = stateCandidates.length && stateSelect
      ? await chooseInSelect(stateSelect, stateCandidates[0], (titles) => core.matchOption(titles, stateCandidates), 5000)
      : { error: "no-option" };
    let cityOther = false;
    if (state.error) {
      flags.push(stateSelect);
      report(status, state.error === "no-option" ? `"${values.state || job.address.province || "the state"}" is not in the State list. Choose the state and city yourself.` : state.error, "warn");
    } else {
      if (!(await fillMayContinue(job, status))) return outcome("partial", "The checkout moved on.");
      const citySelect = topSelects(fusionForm() ?? form)[3];
      let cityOk = false;
      if (citySelect && values.city) {
        // The city list loads for the chosen state; the exact title is waited for.
        const city = await chooseInSelect(citySelect, values.city, (titles) => core.matchOption(titles, [values.city]), 6000);
        if (!city.error) {
          cityOk = true;
        } else if (city.error === "no-option") {
          if (!(await fillMayContinue(job, status))) return outcome("partial", "The checkout moved on.");
          if (city.search) setInputValue(city.search, "Other");
          const other = await waitFor(() => optionsFor(citySelect, city.before).find((li) => core.chooseCityOption([optionTitle(li)], values.city)?.isOther), 3000);
          // guardedClick answers null when it clicked.
          if (other && guardedClick(other) === null) cityOther = true;
        } else {
          report(status, city.error, "warn");
        }
      }
      if (!cityOk) flags.push(citySelect);
      if (cityOther) {
        report(status, `"${values.city}" is not in AliExpress's city list for ${state.title}, so "Other" was chosen. Check the city field (highlighted).`, "warn");
      } else if (!cityOk) {
        report(status, `Could not choose "${values.city}" in the City list. Choose it yourself (highlighted), or "Other".`, "warn");
      }
    }

    // Read every box back once React has had a render to put an old value
    // back. A box that was replaced rather than updated is looked up again by
    // position, but only while the form still has the measured 8 boxes;
    // otherwise it counts as not showing the value.
    await sleep(400);
    const current = fusionForm();
    const nowShown = current && plainInputs(current).length === 8 ? plainInputs(current) : [];
    const positions = { firstName: 0, lastName: 1, phone: 3, street: 4, unit: 5, zip: 6 };
    const boxFor = (key) => (typedInto[key]?.isConnected ? typedInto[key] : nowShown[positions[key]] ?? null);
    const actual = Object.fromEntries(Object.keys(typedInto).map((key) => [key, boxFor(key)?.value ?? null]));
    const wrong = core.mismatchedFields(intended, actual);
    if (wrong.length > 0) {
      for (const key of wrong) flags.push(boxFor(key));
      report(status, `These boxes do not show what DropshipHub typed: ${wrong.map((key) => FIELD_LABELS[key]).join(", ")}. Enter them yourself with the Copy buttons.`, "warn");
    }
    for (const node of flags) mark(node, "#b98900");
    if (state.error || wrong.length > 0 || !current) return finishFusionByHand(status, flags);
    return saveAddressForm({ design: "fusion", form: current, job, values, intended, countryCandidates, stateCandidates, cityOther, status });
  }

  /** A Fusion fill that could not be verified: the merchant checks and presses Confirm. */
  function finishFusionByHand(status, flags) {
    const form = fusionForm();
    const confirm = fusionConfirmButton(form);
    if (confirm) {
      mark(confirm, "#2c6ecb");
      confirm.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // Said only after reading the box: the fill never touches it, but that is
    // not the same as knowing it is unticked when the merchant presses Confirm.
    const boxes = form ? defaultBoxNodes(form) : [];
    const box = readDefaultBox(boxes);
    let boxLine = '"Set as default shipping address" was left unticked.';
    if (box === "ticked") {
      for (const node of boxes) mark(node, "#b3261e");
      boxLine = '"Set as default shipping address" is ticked (highlighted). Untick it yourself before you press Confirm.';
    } else if (box === "missing") {
      boxLine = 'DropshipHub could not read "Set as default shipping address". Make sure it is unticked before you press Confirm.';
    }
    const reason = "Address partly filled.";
    report(status, `${reason} Check every field against the address${flags.some(Boolean) ? ", especially the highlighted ones" : ""}, then press Confirm on AliExpress yourself. ${boxLine}`, "warn");
    return outcome("partial", reason);
  }

  function fusionConfirmButton(form) {
    const scope = form?.closest("[role='dialog'], .next-dialog") ?? form;
    return scope ? [...scope.querySelectorAll("button")].find((b) => /^(confirm|xác nhận)$/i.test(collapse(b.textContent))) ?? null : null;
  }

  // ---------------------------------------------------------------------------
  // Saving the address: the one verified exception to the click guard
  // ---------------------------------------------------------------------------

  /** The Save/Confirm control as saveButtonRefusal judges it: a button that is hidden is refused like a missing one. */
  function describeButton(node) {
    return node ? { ...describeElement(node, false), disabled: node.disabled === true, visible: isVisible(node) } : null;
  }

  /** What saveButtonRefusal judges, read from the comet form as it is now. */
  function cometSaveSnapshot(form, values, intended, countryCandidates, stateCandidates, cityOther) {
    const inputs = cometInputs(form);
    const value = (index) => inputs[index]?.value ?? "";
    const button = cometScope(form).querySelector("button.form-button-confirm");
    return {
      design: "comet",
      boxes: core.COMET_TEXT_BOXES.map(value),
      intended,
      actual: Object.fromEntries(Object.entries(core.COMET_TYPED).map(([key, index]) => [key, value(index)])),
      country: { shown: value(COMET.country), candidates: countryCandidates },
      state: { shown: value(COMET.state), candidates: stateCandidates },
      city: { shown: value(COMET.city), wanted: values.city, otherAccepted: cityOther },
      defaultSwitch: cometSwitchState(form),
      button: describeButton(button),
      node: button,
      boxNodes: core.COMET_TEXT_BOXES.map((index) => inputs[index]),
    };
  }

  /** The same, for the Fusion form. */
  function fusionSaveSnapshot(form, values, intended, countryCandidates, stateCandidates, cityOther) {
    const inputs = plainInputs(form);
    const selects = topSelects(form);
    const positions = { firstName: 0, lastName: 1, phone: 3, street: 4, unit: 5, zip: 6 };
    const box = readDefaultBox(defaultBoxNodes(form));
    const button = fusionConfirmButton(form);
    return {
      design: "fusion",
      boxes: inputs.map((input) => input.value),
      intended,
      actual: Object.fromEntries(Object.entries(positions).map(([key, index]) => [key, inputs[index]?.value ?? ""])),
      country: { shown: selectText(selects[0]), candidates: countryCandidates },
      state: { shown: selectText(selects[2]), candidates: stateCandidates },
      city: { shown: selectText(selects[3]), wanted: values.city, otherAccepted: cityOther },
      defaultSwitch: box === "unticked" ? "off" : box === "ticked" ? "on" : "missing",
      button: describeButton(button),
      node: button,
      boxNodes: inputs,
    };
  }

  /**
   * Saves the add-new-address form: Save (comet) or Confirm (Fusion). This
   * is the ONE place that clicks a commit control, and it does so only when
   * core.saveButtonRefusal finds every box holding exactly what was typed (so
   * the form is a new address, not a saved one being edited), State and City
   * showing the customer's (or City "Other" with the merchant told), the
   * country the United States, and "Set as default" off. Anything else
   * highlights the form and asks the merchant to check and save themselves.
   * After the click it waits for the drawer to close and the page's address
   * block to show the customer's name and house number. The checkout is
   * checked once more first: cancelled during the read-back, the address
   * would otherwise still be committed to the merchant's address book. From
   * the snapshot to the click nothing waits, so what was verified is what is
   * saved.
   */
  async function saveAddressForm({ design, form, job, values, intended, countryCandidates, stateCandidates, cityOther, status }) {
    if (!(await fillMayContinue(job, status))) return outcome("partial", "The checkout moved on.");
    const snapshot = design === "comet"
      ? cometSaveSnapshot(form, values, intended, countryCandidates, stateCandidates, cityOther)
      : fusionSaveSnapshot(form, values, intended, countryCandidates, stateCandidates, cityOther);
    const saveWord = design === "comet" ? "Save" : "Confirm";
    const refusal = core.saveButtonRefusal(snapshot);
    if (refusal) {
      for (const node of snapshot.boxNodes) mark(node, "#b98900");
      if (snapshot.node) mark(snapshot.node, "#2c6ecb");
      const reason = `Not saved by DropshipHub: ${refusal}`;
      report(status, `${reason} Check the highlighted boxes against the customer's address, then press ${saveWord} yourself.`, "warn");
      return outcome("partial", reason);
    }
    report(status, "Every box reads back as intended. Saving the address…");
    const button = snapshot.node;
    for (const type of ["mousedown", "mouseup"]) {
      button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
    button.click();

    const shown = await waitFor(() => {
      if (addressFormOf(design)) return null;
      const block = document.querySelector(".pl-address-item-container");
      return block && core.addressBlockShows(block.textContent, values) ? block : null;
    }, 10000);
    if (shown) {
      report(status, "Address set. Check the total, then press Pay now on AliExpress yourself.", "ok");
      return outcome("set", "Address set.");
    }
    if (addressFormOf(design)) {
      const reason = `AliExpress did not accept the address: the form is still open after ${saveWord}.`;
      report(status, `${reason} Read AliExpress's message on the form, correct the box it names, then press ${saveWord} yourself.`, "warn");
      return outcome("partial", reason);
    }
    const reason = "The form closed, but the page's address block does not show the customer's name and house number yet.";
    report(status, `${reason} Check the address shown on the page before you pay; press Fill address again if it is not the customer's.`, "warn");
    return outcome("partial", reason);
  }

  // ---------------------------------------------------------------------------
  // Which view, for which page
  // ---------------------------------------------------------------------------

  async function refresh(force = false) {
    const answer = await ask({ type: "checkout:get" });
    const job = answer.ok ? answer.job : null;
    if (!job) {
      // A finished or cancelled checkout leaves its own message up until closed.
      if (force || (panel && panel.onUrlChange)) clearPanel();
      return;
    }
    const url = location.href;
    if (job.stage === "product") {
      if (core.isProductPage(url)) await renderProductStage(job);
      else renderWaiting(job);
    } else if (job.stage === "confirm") {
      if (core.isConfirmPage(url)) renderConfirm(job);
      else renderRecordOnly(job);
    } else if (job.stage === "paying") {
      renderPaying(job);
    } else if (job.stage === "recorded") {
      renderRecorded(job);
    } else {
      clearPanel();
    }
  }

  function start() {
    refresh();
    // AliExpress changes pages client-side. Polling the address is cheaper
    // than observing a page that mutates constantly. A change of query string
    // alone keeps the view: it only re-runs the checks and the order-number
    // suggestion, so a fill in progress is not wiped by a re-render, and a
    // product check already under way is not started a second time.
    setInterval(() => {
      if (location.href === lastUrl) return;
      const before = new URL(lastUrl);
      lastUrl = location.href;
      if (before.origin === location.origin && before.pathname === location.pathname) {
        panel?.onUrlChange?.();
        return;
      }
      productCheckFor = null;
      refresh();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
