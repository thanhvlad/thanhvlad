/* global chrome */
const status = document.getElementById("status");
const button = document.getElementById("add");
const urlBox = document.getElementById("url");
const ordersStatus = document.getElementById("orders-status");
const ordersHeading = document.getElementById("orders-heading");
const ordersList = document.getElementById("orders");
const ordersResult = document.getElementById("orders-result");
const trackingHeading = document.getElementById("tracking-heading");
const trackingStatus = document.getElementById("tracking-status");
const trackingList = document.getElementById("tracking");

document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/**
 * Every message is built with textContent. Error strings come from the server
 * and the app URL from the options page; written through innerHTML, either one
 * could inject markup into the extension's own page, which holds the token.
 */
function say(target, text, tone) {
  target.textContent = "";
  const span = document.createElement("span");
  if (tone) span.className = tone;
  span.textContent = text;
  target.append(span);
  return span;
}

function appOrigin(raw) {
  // The App URL field takes an ORIGIN. A value carrying the endpoint path makes
  // the request url double up (".../api/extension/capture/api/extension/capture")
  // and the browser reports only "Failed to fetch". Keep the origin, drop the rest.
  const value = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function isAliExpress(url) {
  return /aliexpress\.[a-z.]+\/(item|i)\/\d+/i.test(url);
}

function isCj(url) {
  return /cjdropshipping\.com\/product\//i.test(url);
}

/**
 * Runs inside the product tab (isolated world) and asks page-reader.js, which
 * the manifest injects into the page's MAIN world, for the product - the same
 * exchange the in-page panel uses. Self-contained because executeScript
 * serialises the function; it resolves to the JSON string or "".
 */
function readProductInPage() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("dropshiphub:product", onResult);
      clearTimeout(timer);
      resolve(value);
    };
    const onResult = (event) => finish(typeof event.detail === "string" ? event.detail : "");
    const timer = setTimeout(() => finish(""), 2000);
    window.addEventListener("dropshiphub:product", onResult);
    window.dispatchEvent(new CustomEvent("dropshiphub:read"));
  });
}

async function captureFromTab(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readProductInPage });
    const raw = injection?.result;
    return typeof raw === "string" && raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function settings() {
  const { appUrl, token } = await chrome.storage.sync.get(["appUrl", "token"]);
  if (!appUrl || !token) return { error: "Set the app URL and token in options." };
  const base = appOrigin(appUrl);
  if (!base) return { error: `"${appUrl}" is not a valid app URL.` };
  return { base, token };
}

// ---------------------------------------------------------------------------
// Add the product in this tab
// ---------------------------------------------------------------------------

async function setUpCapture(config) {
  const tab = await currentTab();
  const url = tab?.url ?? "";
  const shown = document.createElement("small");
  shown.textContent = url ? url.slice(0, 80) : "No tab";
  urlBox.replaceChildren(shown);
  if (!isAliExpress(url) && !isCj(url)) {
    say(status, "Open an AliExpress or CJ product page to add it.", "err");
    return;
  }
  if (config.error) {
    say(status, config.error, "err");
    return;
  }
  const endpoint = `${config.base}/api/extension/capture`;
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    say(status, "Reading this page…");

    // The popup used to send the link alone, and the server then made up a
    // "Sample product" with invented prices and variants and put it on the
    // import list as if it were this AliExpress product. An AliExpress page is
    // read here exactly as the in-page panel reads it, or nothing is sent.
    const product = await captureFromTab(tab.id);
    if (!product && isAliExpress(url)) {
      say(status, "Could not read this product page. Reload it, wait until it has fully loaded, then try again - or use the DropshipHub panel in the bottom-left corner of the page.", "err");
      button.disabled = false;
      return;
    }

    say(status, "Sending…");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
        // A CJ page is not read by page-reader.js; its link goes to the server,
        // which uses the CJ API or refuses with the reason. It never invents one.
        body: JSON.stringify(product ? { url, product } : { url }),
      });
      const body = await response.json();
      if (body.ok) {
        const line = say(status, `Added: ${body.title ?? "product"}. `, "ok");
        if (body.importListUrl) {
          const link = document.createElement("a");
          link.href = body.importListUrl;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = "Open import list";
          line.after(link);
        }
      } else {
        say(status, body.error ?? "Failed", "err");
        button.disabled = false;
      }
    } catch (error) {
      // "Failed to fetch" alone hides which url was actually called; show it.
      say(status, `${error.message}. Called: ${endpoint}. Check the app URL in options - it needs the https:// prefix.`, "err");
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Orders to place
//
// The order list carries customers' addresses, so the server sends it without
// CORS headers and no web page can read it. The popup can, once the merchant
// grants this extension access to the app's origin; that access is asked for
// here, for that one origin, rather than declared for every site up front.
// ---------------------------------------------------------------------------

function openProduct(productUrl) {
  // Only a supplier page on https: the url comes from the server, and the
  // extension must not become a way to open arbitrary links.
  if (!/^https:\/\/([a-z0-9-]+\.)*aliexpress\.(com|us)\//i.test(productUrl)) return;
  chrome.tabs.create({ url: productUrl });
}

/**
 * The one description of ordering through the extension, the same words the
 * app uses. The extension lists and opens; the merchant buys and pays.
 */
const PLACEMENT_STEPS =
  "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.";

// Light checks only, so an obvious slip is caught before a round trip. The
// server validates every field again and its answer is what counts.
const ORDER_NUMBER = /^[A-Za-z0-9_-]{1,64}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,4})?$/;
const TRACKING_NUMBER = /^[A-Za-z0-9-]{4,64}$/;

function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.placeholder) node.placeholder = options.placeholder;
  return node;
}

/** A labelled input; the label is textContent, never markup. */
function field(labelText, input) {
  const label = el("label", { className: "field" });
  label.append(el("span", { text: labelText }), input);
  return label;
}

/** Splits "8190001, 8190002" into ids, or returns the reason it cannot. */
function parseOrderNumbers(raw) {
  const ids = [...new Set(raw.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))];
  if (ids.length === 0) return { error: "Enter the AliExpress order number." };
  if (ids.length > 20) return { error: "Enter at most 20 order numbers." };
  const bad = ids.find((id) => !ORDER_NUMBER.test(id) || /^mock-/i.test(id));
  if (bad) return { error: `"${bad.slice(0, 40)}" is not an AliExpress order number. Copy it from the order in your AliExpress account.` };
  return { ids };
}

async function postJson(config, path, body) {
  const response = await fetch(`${config.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const answer = await response.json().catch(() => ({}));
  return { status: response.status, answer };
}

/** The server's refusal in plain words, for any answer that is not a success. */
function explainRefusal(status, answer, what) {
  const reason = typeof answer.error === "string" ? answer.error : "";
  if (status === 400) return `Not saved. Check what you entered: ${reason}`;
  if (status === 401) return "Not saved: the app refused the token. Check the token in options.";
  if (status === 404) return `Not saved: this ${what} is no longer in DropshipHub. The list below is up to date.`;
  if (status === 409) return `Not saved: ${reason}`;
  if (status === 413) return "Not saved: what you entered is too long.";
  if (status === 429) return `Not saved: ${reason || "too many requests. Try again in a minute."}`;
  return `Not saved: the app answered ${status}${reason ? ` (${reason})` : ""}.`;
}

function renderPlaceForm(config, order) {
  const form = el("form", { className: "action" });
  const numbers = el("input", { type: "text", placeholder: "e.g. 8190000000000000" });
  const total = el("input", { type: "text", placeholder: order.totalCost ? `estimate ${order.totalCost}` : "optional" });
  total.inputMode = "decimal";
  const paid = el("input", { type: "checkbox" });
  paid.checked = true;
  const paidLabel = el("label", { className: "check" });
  paidLabel.append(paid, el("span", { text: "I have paid for it on AliExpress" }));
  const submit = el("button", { text: "Mark as placed", type: "submit" });
  const result = el("div", { className: "result" });

  form.append(
    field("AliExpress order number(s)", numbers),
    field(`Total paid in ${order.currency ?? "the order's currency"} (optional)`, total),
    paidLabel,
    submit,
    result,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const parsed = parseOrderNumbers(numbers.value);
    if (parsed.error) {
      say(result, parsed.error, "err");
      return;
    }
    const amount = total.value.trim();
    if (amount && !AMOUNT.test(amount)) {
      say(result, "Enter the total as a plain number, like 12.40, or leave it empty.", "err");
      return;
    }

    submit.disabled = true;
    say(result, "Saving…");
    try {
      const body = { externalOrderIds: parsed.ids, paid: paid.checked };
      // The total is only meaningful in the purchase order's own currency;
      // the server keeps the estimate when the currencies differ.
      if (amount) Object.assign(body, { totalCost: amount, currency: order.currency });
      const { status, answer } = await postJson(config, `/api/extension/orders/${encodeURIComponent(order.id)}/placed`, body);
      if (status === 200 && answer.ok && answer.alreadyRecorded) {
        await refreshOrders(config, `${order.orderName} was already recorded as AliExpress order ${answer.externalOrderId}. Nothing changed.`, "ok");
      } else if (status === 200 && answer.ok) {
        const next = answer.status === "PAID"
          ? "Add its tracking number below once AliExpress ships it."
          : "Pay for it on AliExpress within 24 hours, or AliExpress cancels it.";
        await refreshOrders(config, `Recorded ${order.orderName} as AliExpress order ${answer.externalOrderId}. ${next}`, "ok");
      } else {
        const refusal = explainRefusal(status, answer, "order");
        if (status === 404 || status === 409) {
          // The entry is out of date; the refreshed list replaces this form,
          // so the reason goes to the line above the lists.
          await refreshOrders(config, refusal, "err");
        } else {
          say(result, refusal, "err");
          submit.disabled = false;
        }
      }
    } catch (error) {
      say(result, `Not saved: ${error.message}. Check the app URL in options.`, "err");
      submit.disabled = false;
    }
  });
  return form;
}

function renderTrackingForm(config, po) {
  const form = el("form", { className: "action" });
  const number = el("input", { type: "text", placeholder: "e.g. LP00123456789CN" });
  const carrier = el("input", { type: "text", placeholder: "optional" });
  const submit = el("button", { text: "Add tracking", type: "submit" });
  const result = el("div", { className: "result" });
  form.append(field("Tracking number", number), field("Carrier", carrier), submit, result);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = number.value.trim();
    if (!TRACKING_NUMBER.test(value)) {
      say(result, "Enter the tracking number as it appears on AliExpress: letters, digits and dashes, at least 4 characters.", "err");
      return;
    }
    const carrierName = carrier.value.trim();
    if (carrierName.length > 80) {
      say(result, "The carrier name is too long.", "err");
      return;
    }

    submit.disabled = true;
    say(result, "Saving…");
    try {
      const body = carrierName ? { number: value, carrier: carrierName } : { number: value };
      const { status, answer } = await postJson(config, `/api/extension/orders/${encodeURIComponent(po.id)}/tracking`, body);
      if (status === 200 && answer.ok) {
        const when = answer.syncDeferred ? "It is sent to Shopify on the next tracking sync." : "DropshipHub sends it to Shopify.";
        await refreshOrders(config, `Saved tracking ${answer.number} for ${po.orderName}. ${when}`, "ok");
      } else {
        const refusal = explainRefusal(status, answer, "supplier order");
        if (status === 404 || status === 409) {
          // The entry is out of date; the refreshed list replaces this form,
          // so the reason goes to the line above the lists.
          await refreshOrders(config, refusal, "err");
        } else {
          say(result, refusal, "err");
          submit.disabled = false;
        }
      }
    } catch (error) {
      say(result, `Not saved: ${error.message}. Check the app URL in options.`, "err");
      submit.disabled = false;
    }
  });
  return form;
}

/** A collapsed control under a list entry, so the list stays scannable. */
function disclosure(summaryText, content) {
  const details = el("details");
  details.append(el("summary", { text: summaryText }), content);
  return details;
}

function renderOrders(config, orders, awaitingTracking) {
  ordersList.textContent = "";
  trackingList.textContent = "";
  ordersHeading.textContent = `Orders to place (${orders.length})`;
  trackingHeading.textContent = `Waiting for tracking (${awaitingTracking.length})`;

  if (orders.length === 0) {
    say(ordersStatus, "Nothing waiting. Orders appear here after you send them to the supplier in DropshipHub.");
  } else {
    say(ordersStatus, PLACEMENT_STEPS);
  }
  for (const order of orders) {
    const li = el("li", { className: "order" });
    const address = order.shippingAddress ?? {};
    li.append(el("div", { className: "order-name", text: `${order.orderName} · ${[address.name, address.countryCode].filter(Boolean).join(", ")}` }));

    const items = el("ul");
    for (const item of order.items ?? []) {
      const row = el("li", { className: "item" });
      const label = `${item.quantity} × ${String(item.title ?? "").slice(0, 60)}${item.variantLabel ? ` (${item.variantLabel})` : ""}`;
      if (item.productUrl) {
        const link = el("a", { text: label });
        link.addEventListener("click", (e) => {
          e.preventDefault();
          openProduct(item.productUrl);
        });
        row.append(link);
      } else {
        row.textContent = label;
      }
      items.append(row);
    }
    li.append(items, disclosure("Mark as placed", renderPlaceForm(config, order)));
    ordersList.append(li);
  }

  trackingStatus.textContent = "";
  if (awaitingTracking.length === 0) {
    say(trackingStatus, "No placed order is waiting for a tracking number.");
  }
  for (const po of awaitingTracking) {
    const li = el("li", { className: "order" });
    const ids = Array.isArray(po.externalOrderIds) ? po.externalOrderIds.join(", ") : "";
    li.append(el("div", { className: "order-name", text: `${po.orderName}${ids ? ` · AliExpress ${ids}` : ""}` }));
    li.append(disclosure("Add tracking", renderTrackingForm(config, po)));
    trackingList.append(li);
  }
}

async function loadOrders(config) {
  const response = await fetch(`${config.base}/api/extension/orders`, {
    headers: { Authorization: `Bearer ${config.token}` },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    say(ordersStatus, body.error ?? `The app answered ${response.status}.`, "err");
    return;
  }
  renderOrders(config, Array.isArray(body.orders) ? body.orders : [], Array.isArray(body.awaitingTracking) ? body.awaitingTracking : []);
}

/**
 * Reload both lists after a change, keeping the outcome on screen: the entry
 * that carried the form is gone once it moves on, so its message goes to the
 * shared line above the lists.
 */
async function refreshOrders(config, message, tone) {
  if (message) say(ordersResult, message, tone);
  await loadOrders(config).catch((error) => say(ordersStatus, `${error.message}. Check the app URL in options.`, "err"));
}

async function setUpOrders(config) {
  if (config.error) {
    say(ordersStatus, config.error, "err");
    return;
  }
  const origins = [`${config.base}/*`];
  const granted = await chrome.permissions.contains({ origins }).catch(() => false);
  if (!granted) {
    ordersStatus.textContent = "";
    const note = document.createElement("small");
    note.textContent = `To list orders, allow this extension to read ${config.base}. You may need to open this popup again afterwards.`;
    const allow = document.createElement("button");
    allow.className = "secondary";
    allow.textContent = "Allow access";
    allow.addEventListener("click", async () => {
      // Must run inside the click: Chrome only shows the prompt for a user gesture.
      const ok = await chrome.permissions.request({ origins }).catch(() => false);
      if (!ok) {
        say(ordersStatus, "Access was not granted, so orders cannot be listed.", "err");
        return;
      }
      say(ordersStatus, "Loading…");
      await loadOrders(config).catch((error) => say(ordersStatus, error.message, "err"));
    });
    ordersStatus.append(note, allow);
    return;
  }
  await loadOrders(config).catch((error) => say(ordersStatus, `${error.message}. Check the app URL in options.`, "err"));
}

(async () => {
  const config = await settings();
  await Promise.all([setUpCapture(config), setUpOrders(config)]);
})();
