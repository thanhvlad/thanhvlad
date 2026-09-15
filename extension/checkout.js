/* global chrome, globalThis */

/**
 * The checkout assist on AliExpress pages.
 *
 * The extension lists the orders waiting to be placed and opens each product
 * on AliExpress; the merchant places and pays for the order there and records
 * the AliExpress order number. This script is the part that runs in those
 * AliExpress tabs: on the product page it checks the purchase order's variant
 * and opens the confirm page for it, and on the confirm page it shows the
 * order, the address with Copy buttons, a Fill address button and the box for
 * the order number.
 *
 * What it must never do is decided here, in code, not left to selectors:
 *
 * - Every programmatic click goes through guardedClick(), which refuses Place
 *   order, Pay, Buy now, payment choices, checkboxes, form submits and the
 *   address form's Confirm (DropshipHubCheckout.clickRefusal), judged for the
 *   clicked element and for every control around it the click would
 *   activate. No other code path clicks, submits or presses keys.
 * - Nothing is filled until the merchant presses Fill address in this panel,
 *   and nothing is filled into a form that already holds another address or
 *   has "Set as default shipping address" ticked.
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

  // ---------------------------------------------------------------------------
  // The one way this script clicks
  // ---------------------------------------------------------------------------

  const FORBIDDEN_INSIDE =
    'button.place-order-primary-btn, .pl-order-toal-container__btn-box, input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], button[type="submit"], input[type="submit"]';

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
    panel = { host, body, onUrlChange: null };
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

  const PLACE_YOURSELF = "You place and pay for this order on AliExpress yourself. DropshipHub never clicks Place order or Pay.";

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
      const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
      if (core.parseMoneyText(text)) return text.slice(0, 120);
    }
    return null;
  }

  function costBlock(job) {
    const expected = core.expectedCost(job);
    const line = el("div");
    const detail = el("div", { className: "muted" });
    const render = () => {
      const pageText = readPageTotalText();
      const verdict = core.compareTotals(expected, pageText);
      const expectation = expected
        ? `DropshipHub expects ${core.formatAmount(expected.amount, expected.currency)}${expected.scope === "item" ? " for this item's goods; shipping comes on top" : " for the order, shipping estimate included"}.`
        : "DropshipHub has no cost estimate for this order.";
      detail.textContent = `${expectation} AliExpress shows: ${pageText ?? "not readable yet"}.`;
      if (verdict.kind === "close") say(line, "The total is close to DropshipHub's estimate.", "ok");
      else if (verdict.kind === "higher") say(line, "The total is higher than DropshipHub's estimate. Check the price and shipping before you place the order.", "warn");
      else if (verdict.kind === "lower") say(line, "The total is lower than DropshipHub's estimate. Check the variant and quantity before you place the order.", "warn");
      else if (verdict.kind === "other-currency") say(line, "AliExpress shows the total in another currency, so compare it yourself.", "warn");
      else say(line, "Waiting for the page's total…", "");
      // Done only once the page's total has been read. Stopping on any
      // verdict stopped at once for an order with no estimate, and the panel
      // then said "not readable yet" until the merchant pressed the button.
      return Boolean(verdict.page);
    };
    render();
    // The total renders after the page's own data arrives; look again for a while, then stop.
    (async () => {
      for (let i = 0; i < 20 && line.isConnected; i += 1) {
        await sleep(750);
        if (render()) break;
      }
    })();
    return el("div", { className: "stack" }, [line, detail, button("Check the total again", render, "act secondary")]);
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
    if (!values.phoneMatches) notes.append(el("div", { className: "line warn", text: "The phone number has another country's code. Check it before you confirm the address." }));
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
      : "Copy it from the order in your AliExpress account once you have placed it.";
    const children = [
      el("div", { className: "muted", text: "After you place the order" }),
      el("label", { className: "field" }, [el("span", { text: "AliExpress order number(s)" }), numbers]),
    ];
    if (last) {
      children.push(el("label", { className: "check" }, [paid, el("span", { text: "I have paid for it on AliExpress" })]));
    }
    const suggestion = el("div", { className: "stack" });
    children.push(suggestion, el("div", { className: "muted", text: hint }), submit, result);

    /**
     * The page after Place order has not been measured. When an AliExpress
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
      ? "Add its tracking number in the extension once AliExpress ships it; tracking you add there is sent to Shopify."
      : "Pay for it on AliExpress within 24 hours, or AliExpress cancels it.";
    showFinished(`Recorded ${answer.orderName} as AliExpress order ${ids}. ${next}`, "ok");
  }

  function renderConfirm(job) {
    const body = freshBody();
    const values = formValues(job);
    const checks = urlChecks(job);
    const address = addressBlock(job, values);
    const fillStatus = el("div", { className: "stack" });
    const fill = button("Fill address", async () => {
      fill.disabled = true;
      fillStatus.textContent = "";
      try {
        await fillAddress(job, values, fillStatus);
      } catch {
        report(fillStatus, "The fill stopped unexpectedly. Use the Copy buttons for the remaining fields.", "err");
      } finally {
        fill.disabled = false;
        // Typing left focus in AliExpress's City search box. Keys meant for
        // the panel then went into the page's form, and Enter in a text box
        // can submit a form that has a submit button.
        if (fill.isConnected) fill.focus();
      }
    });
    const record = recordBlock(job);

    body.append(
      itemBlock(job),
      checks.node,
      costBlock(job),
      address.node,
      el("div", { className: "stack" }, [fill, fillStatus]),
      el("div", { className: "note", text: PLACE_YOURSELF }),
      record.node,
      cancelButton(),
    );
    panel.onUrlChange = () => {
      checks.render();
      record.suggest();
    };
  }

  /** The confirm stage on any other AliExpress page, where the merchant lands after Place order. */
  function renderRecordOnly(job) {
    const body = freshBody();
    const record = recordBlock(job);
    body.append(
      itemBlock(job),
      el("div", { className: "note", text: PLACE_YOURSELF }),
      record.node,
      button("Open this item's checkout again", () => ask({ type: "checkout:reopen-product" }), "act secondary"),
      cancelButton(),
    );
    panel.onUrlChange = record.suggest;
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
  // Fill address (only ever from the Fill address button)
  // ---------------------------------------------------------------------------

  function report(target, text, tone) {
    const line = el("div");
    say(line, text, tone);
    target.append(line);
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

  function addressForm() {
    return document.querySelector("form.deliver-address-form");
  }

  // The address search box is a next-select-auto-complete; it counts as select
  // 1 in the measured order whether or not it also carries next-select, and its
  // input must not be mistaken for a text box.
  const SELECT = ".next-select, .next-select-auto-complete";

  function topSelects(form) {
    return [...form.querySelectorAll(SELECT)].filter((node) => !node.parentElement?.closest(SELECT));
  }

  const NOT_TEXT = new Set(["checkbox", "radio", "hidden", "submit", "button", "image", "reset", "file"]);

  function plainInputs(form) {
    return [...form.querySelectorAll("input")].filter((input) => !NOT_TEXT.has((input.getAttribute("type") ?? "").toLowerCase()) && !input.closest(SELECT));
  }

  /**
   * Types into one of the address form's own inputs the way React expects.
   * React keeps its own copy of a controlled input's value: a value set
   * without the input event never reaches its state, and the next render puts
   * the old value back. The native setter plus input and change events is how
   * the page's own typing looks to it. Anything outside the address form - a
   * payment field above all - is refused.
   */
  function setInputValue(input, value) {
    if (!(input instanceof HTMLInputElement) || !input.closest("form.deliver-address-form")) return false;
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

  function selectShows(select, candidates) {
    const shown = select.querySelector(".next-select-values, .next-select-value")?.textContent ?? "";
    return core.matchOption([shown.trim()], candidates) !== null;
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

  async function openFormIfNeeded(status) {
    const open = addressForm();
    if (open) return open;
    const wrap = document.querySelector(".pl-address-item__new-btn-wrap");
    const add = wrap ? wrap.querySelector("button, [role='button'], a") ?? wrap : null;
    if (!add) {
      report(status, 'Open the add-address form on this page ("Add new address"), then press Fill address again.', "warn");
      return null;
    }
    const refused = guardedClick(add);
    if (refused) {
      report(status, `Click "Add new address" on the page yourself, then press Fill address again. (${refused})`, "warn");
      return null;
    }
    const form = await waitFor(addressForm, 8000);
    if (!form) report(status, "The add-address form did not open. Open it yourself, then press Fill address again.", "err");
    return form;
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
      const current = addressForm();
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

  const FIELD_LABELS = { firstName: "First name", lastName: "Last name", phone: "Mobile number", street: "Street", unit: "Apt, suite, unit", zip: "ZIP" };

  function intendedValues(values) {
    return { firstName: values.firstName, lastName: values.lastName, phone: values.phone, street: values.street, unit: values.unit, zip: values.zip };
  }

  /**
   * Stops the fill, before it changes anything, in a form that is not a new
   * address: one that already holds another address (AliExpress's edit form
   * for a saved one), or one whose "Set as default shipping address" is
   * ticked. Filling either put the customer's address over one of the
   * merchant's saved addresses, possibly their default, as soon as they
   * pressed Confirm. `requireBox` is set once the whole US form is showing,
   * where the measured form has the box; before "Enter manually" it may not be
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

  /** The open address form while it is still the measured US form, or null with the reason reported. */
  function measuredUsForm(status, when) {
    const form = addressForm();
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

  async function fillAddress(job, values, status) {
    clearMarks();
    if (!core.isConfirmPage(location.href)) {
      report(status, "Fill address works on AliExpress's checkout page only.", "err");
      return;
    }
    if (job.address.countryCode !== "US") {
      // Only the US form has been measured; other countries render other
      // fields (Vietnam: province, district, ward) in other positions.
      report(status, `DropshipHub can fill only AliExpress's US address form, and this order ships to ${values.country}. Use the Copy buttons to enter the address.`, "warn");
      return;
    }
    if (!(await fillMayContinue(job, status))) return;

    let form = await openFormIfNeeded(status);
    if (!form) return;
    // Before anything in an already open form is touched, "Enter manually"
    // and the country included.
    if (formRefusesFill(form, values, status, false)) return;
    form = await enterManuallyIfNeeded(form, status);
    if (!form) return;

    // Country first: changing it re-renders every other field.
    const countryCandidates = core.countryTitleCandidates(job.address.countryCode);
    const countrySelect = topSelects(form)[0];
    if (!countrySelect) {
      report(status, "The form has no Country/region list. Use the Copy buttons.", "warn");
      return;
    }
    if (!selectShows(countrySelect, countryCandidates)) {
      if (!(await fillMayContinue(job, status))) return;
      const chosen = await chooseInSelect(countrySelect, countryCandidates[0], (titles) => core.matchOption(titles, countryCandidates), 5000);
      if (chosen.error) {
        report(status, chosen.error === "no-option" ? `"${countryCandidates[0]}" is not in the Country/region list. Choose it yourself, then press Fill address again.` : chosen.error, "warn");
        return;
      }
      await waitFor(() => {
        const current = addressForm();
        const select = current ? topSelects(current)[0] : null;
        return select && selectShows(select, countryCandidates);
      }, 3000);
      await sleep(500);
      form = addressForm();
      if (!form) {
        report(status, "The address form closed while the country changed. Open it again and press Fill address.", "err");
        return;
      }
      form = await enterManuallyIfNeeded(form, status);
      if (!form) return;
    }

    form = measuredUsForm(status, "before filling anything else");
    if (!form) return;
    // Again on the whole form: the default box is rendered by now, and a
    // country change may have brought back a saved address's values.
    if (formRefusesFill(form, values, status, true)) return;

    const flags = [];
    if (!(await fillMayContinue(job, status))) return;
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

    if (!(await fillMayContinue(job, status))) return;
    const stateCandidates = core.stateTitleCandidates(job.address.province, job.address.provinceCode);
    const stateSelect = topSelects(addressForm() ?? form)[2];
    const state = stateCandidates.length && stateSelect
      ? await chooseInSelect(stateSelect, stateCandidates[0], (titles) => core.matchOption(titles, stateCandidates), 5000)
      : { error: "no-option" };
    if (state.error) {
      flags.push(stateSelect);
      report(status, state.error === "no-option" ? `"${values.state || job.address.province || "the state"}" is not in the State list. Choose the state and city yourself.` : state.error, "warn");
    } else {
      if (!(await fillMayContinue(job, status))) return;
      const citySelect = topSelects(addressForm() ?? form)[3];
      let cityOk = false;
      let cityOther = false;
      if (citySelect && values.city) {
        // The city list loads for the chosen state; the exact title is waited for.
        const city = await chooseInSelect(citySelect, values.city, (titles) => core.matchOption(titles, [values.city]), 6000);
        if (!city.error) {
          cityOk = true;
        } else if (city.error === "no-option") {
          if (!(await fillMayContinue(job, status))) return;
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
    const current = addressForm();
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
    finishFill(status, flags, !state.error && wrong.length === 0);
  }

  function finishFill(status, flags, filledAll) {
    const form = addressForm();
    const scope = form?.closest("[role='dialog'], .next-dialog") ?? form;
    const confirm = scope ? [...scope.querySelectorAll("button")].find((b) => /^(confirm|xác nhận)$/i.test((b.textContent ?? "").trim())) : null;
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
    report(
      status,
      `${filledAll ? "Address filled." : "Address partly filled."} Check every field against the address above${flags.some(Boolean) ? ", especially the highlighted ones" : ""}, then press Confirm on AliExpress yourself. ${boxLine}`,
      filledAll && !flags.some(Boolean) && box === "unticked" ? "ok" : "warn",
    );
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
