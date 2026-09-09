/* global chrome */

/**
 * Puts an "Add to DropshipHub" control on the supplier's own product page, so
 * the merchant never has to open the toolbar popup.
 *
 * It is deliberately a fixed panel in the bottom-left corner rather than a
 * button spliced into the buy box. Anchoring into AliExpress markup meant
 * hunting class names that carry a per-build hash, and it put this button in
 * the same container DSers injects into, where the two compete for the same
 * spot and one of them loses. A corner of the viewport belongs to nobody.
 */

const ENDPOINT = "/api/extension/capture";
const HOST_ID = "dropshiphub-capture-host";

function isProductPage() {
  const url = location.href;
  return /aliexpress\.[a-z.]+\/(item|i)\/\d+/i.test(url) || /cjdropshipping\.com\/product\//i.test(url);
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

function build() {
  const host = document.createElement("div");
  host.id = HOST_ID;
  // Shadow DOM so the supplier's stylesheet cannot reach in and restyle this.
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      position: fixed; left: 20px; bottom: 20px; z-index: 2147483647;
      width: 250px;
    }
    .card {
      background: #fff; border-radius: 12px; padding: 12px;
      box-shadow: 0 6px 28px rgba(0,0,0,.24);
      font: 500 14px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1a1a1a;
    }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase;
      color: #6b7280; margin-bottom: 8px;
    }
    .close {
      border: 0; background: none; cursor: pointer; color: #6b7280;
      font-size: 16px; line-height: 1; padding: 0 2px;
    }
    button.go {
      display: block; width: 100%; box-sizing: border-box;
      padding: 11px 14px; border: 0; border-radius: 8px; cursor: pointer;
      background: #1f6feb; color: #fff; font: inherit; font-weight: 600;
    }
    button.go:hover:not(:disabled) { background: #1a5fd0; }
    button.go:disabled { opacity: .55; cursor: default; }
    .msg { margin-top: 8px; font-size: 12.5px; word-break: break-word; }
    .ok { color: #1a7f37; }
    .err { color: #b3261e; }
    .msg a { color: inherit; }
  `;

  const card = document.createElement("div");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "head";
  const label = document.createElement("span");
  label.textContent = "DropshipHub";
  const close = document.createElement("button");
  close.className = "close";
  close.title = "Hide until the next page load";
  close.textContent = "×";
  close.addEventListener("click", () => host.remove());
  head.append(label, close);

  const button = document.createElement("button");
  button.className = "go";
  button.textContent = "Add to import list";

  const msg = document.createElement("div");
  msg.className = "msg";

  card.append(head, button, msg);
  root.append(style, card);

  button.addEventListener("click", () => send(button, msg));
  return host;
}

/* ---------------------------------------------------------------------------
 * Reading the product off the page
 *
 * This script cannot do it. A content script shares the DOM but NOT the page's
 * JavaScript: `window._d_c_`, where AliExpress keeps its whole product model,
 * is undefined from here. page-reader.js runs in the MAIN world and does the
 * reading; the two talk over CustomEvents carrying a JSON string, because
 * structured-cloning arbitrary objects across worlds is fragile and a string
 * always survives.
 * ------------------------------------------------------------------------- */

const READ_REQUEST = "dropshiphub:read";
const READ_RESPONSE = "dropshiphub:product";

/** Ask the main-world reader for this page's product. null when it cannot. */
function requestProduct(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(READ_RESPONSE, onResult);
      clearTimeout(timer);
      resolve(value);
    };
    const onResult = (event) => {
      const raw = typeof event.detail === "string" ? event.detail : "";
      if (!raw) return finish(null);
      try {
        finish(JSON.parse(raw));
      } catch {
        finish(null);
      }
    };
    // No reader present (page-reader.js failed to inject) means no answer ever
    // arrives, so the timeout is what keeps the button from hanging.
    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener(READ_RESPONSE, onResult);
    window.dispatchEvent(new CustomEvent(READ_REQUEST));
  });
}

async function send(button, msg) {
  button.disabled = true;
  msg.className = "msg";
  msg.textContent = "Sending…";

  const { appUrl, token } = await chrome.storage.sync.get(["appUrl", "token"]);
  if (!appUrl || !token) {
    msg.className = "msg err";
    msg.textContent = "Set the app URL and token in the extension options first.";
    button.disabled = false;
    return;
  }

  const base = appOrigin(appUrl);
  if (!base) {
    msg.className = "msg err";
    msg.textContent = `"${appUrl}" is not a valid app URL. Fix it in the extension options.`;
    button.disabled = false;
    return;
  }
  const endpoint = `${base}${ENDPOINT}`;
  const captured = await requestProduct();
  msg.textContent = captured ? "Sending this page's product…" : "Could not read this page; sending the link…";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(captured ? { url: location.href, product: captured } : { url: location.href }),
    });
    const body = await response.json();
    if (body.ok) {
      msg.className = "msg ok";
      msg.textContent = captured
        ? `Added from this page: ${body.title ?? "product"}.`
        : `Added by link only - the page could not be read, so the supplier account decided what was imported: ${body.title ?? "product"}.`;
      if (!captured) msg.className = "msg err";
      if (body.importListUrl) {
        const a = document.createElement("a");
        a.href = body.importListUrl;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = " Open import list";
        msg.append(a);
      }
      button.textContent = "Added";
    } else {
      msg.className = "msg err";
      msg.textContent = body.error ?? "Failed";
      button.disabled = false;
    }
  } catch (error) {
    msg.className = "msg err";
    msg.textContent = `${error.message} — called ${endpoint}`;
    button.disabled = false;
  }
}

function mount() {
  if (!isProductPage()) {
    document.getElementById(HOST_ID)?.remove();
    return;
  }
  if (document.getElementById(HOST_ID)) return;
  document.body.appendChild(build());
}

/**
 * AliExpress swaps product pages client-side without a reload, so re-mount on
 * url changes. Poll rather than observe the DOM: this page mutates constantly,
 * and a MutationObserver on it fires thousands of times for no benefit here.
 */
function start() {
  mount();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    document.getElementById(HOST_ID)?.remove();
    mount();
  }, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
