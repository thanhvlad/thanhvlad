/* global chrome */
const status = document.getElementById("status");
const button = document.getElementById("add");
const urlBox = document.getElementById("url");
const ordersStatus = document.getElementById("orders-status");
const ordersHeading = document.getElementById("orders-heading");
const ordersList = document.getElementById("orders");

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

function renderOrders(orders) {
  ordersList.textContent = "";
  ordersHeading.textContent = `Orders to place (${orders.length})`;
  if (orders.length === 0) {
    say(ordersStatus, "Nothing waiting. Orders appear here after you send them to the supplier in DropshipHub.");
    return;
  }
  say(ordersStatus, "Open each product, choose the variant and buy it for the customer's address.");
  for (const order of orders) {
    const li = document.createElement("li");
    li.className = "order";
    const name = document.createElement("div");
    name.className = "order-name";
    const address = order.shippingAddress ?? {};
    name.textContent = `${order.orderName} · ${[address.name, address.countryCode].filter(Boolean).join(", ")}`;
    li.append(name);

    const items = document.createElement("ul");
    for (const item of order.items ?? []) {
      const row = document.createElement("li");
      row.className = "item";
      const label = `${item.quantity} × ${String(item.title ?? "").slice(0, 60)}${item.variantLabel ? ` (${item.variantLabel})` : ""}`;
      if (item.productUrl) {
        const link = document.createElement("a");
        link.textContent = label;
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
    li.append(items);
    ordersList.append(li);
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
  renderOrders(body.orders ?? []);
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
