/* global chrome */

/**
 * Injects an "Add to DropshipHub" button onto the supplier's own product page,
 * next to the buy box, so the merchant never has to open the toolbar popup.
 *
 * AliExpress rewrites its markup often and renders the buy box asynchronously,
 * so this deliberately does not depend on one selector: it tries a list of
 * anchors, re-tries on DOM mutations, and falls back to a floating button
 * pinned to the viewport. A changed class name costs the button its position,
 * never its existence.
 */

const ENDPOINT = "/api/extension/capture";
const HOST_ID = "dropshiphub-capture-host";

const ANCHORS = [
  // AliExpress, newest first
  '[class*="ProductAction"]',
  '[class*="product-action"]',
  ".pdp-body-top-right",
  '[class*="BuyNow"]',
  '[class*="addToCart"]',
  // CJ Dropshipping
  ".product-detail-buy",
  '[class*="detail-buy"]',
];

function isProductPage() {
  const url = location.href;
  return /aliexpress\.[a-z.]+\/(item|i)\/\d+/i.test(url) || /cjdropshipping\.com\/product\//i.test(url);
}

function buildButton() {
  const host = document.createElement("div");
  host.id = HOST_ID;
  // Shadow DOM so the supplier's stylesheet cannot reach in and restyle this.
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .wrap { font: 500 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 10px 0; }
    button {
      display: block; width: 100%; box-sizing: border-box;
      padding: 11px 16px; border: 0; border-radius: 8px; cursor: pointer;
      background: #1f6feb; color: #fff; font: inherit; font-weight: 600;
    }
    button:hover:not(:disabled) { background: #1a5fd0; }
    button:disabled { opacity: .55; cursor: default; }
    .msg { margin-top: 6px; font-size: 12.5px; min-height: 1.2em; }
    .ok { color: #1a7f37; }
    .err { color: #b3261e; }
    .msg a { color: inherit; }
    :host(.floating) { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: 232px;
      background: #fff; padding: 10px 12px; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.22); }
  `;

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const button = document.createElement("button");
  button.textContent = "Add to DropshipHub";
  const msg = document.createElement("div");
  msg.className = "msg";
  wrap.append(button, msg);
  root.append(style, wrap);

  button.addEventListener("click", () => send(button, msg));
  return host;
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
    msg.textContent = `"${appUrl}" is not a valid app URL. Set it in the extension options.`;
    button.disabled = false;
    return;
  }
  const endpoint = `${base}${ENDPOINT}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: location.href }),
    });
    const body = await response.json();
    if (body.ok) {
      msg.className = "msg ok";
      msg.textContent = `Added: ${body.title ?? "product"}.`;
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
    msg.textContent = `${error.message} — called ${endpoint}. Check the app URL in the extension options.`;
    button.disabled = false;
  }
}

function place() {
  if (!isProductPage()) return true;
  if (document.getElementById(HOST_ID)) return true;

  const host = buildButton();
  for (const selector of ANCHORS) {
    const anchor = document.querySelector(selector);
    if (anchor) {
      anchor.prepend(host);
      return true;
    }
  }
  // No anchor matched — the page markup changed, or it has not rendered yet.
  // Pin it to the viewport so the merchant still has the button.
  host.classList.add("floating");
  document.body.appendChild(host);
  return false;
}

/**
 * The buy box arrives after first paint, and AliExpress swaps product pages
 * client-side without a reload. Watch for both, and stop observing once the
 * button has a real anchor.
 */
function start() {
  if (place()) return;

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById(HOST_ID)?.remove();
    }
    // Re-place if the anchor has appeared, replacing the floating fallback.
    const existing = document.getElementById(HOST_ID);
    if (existing?.classList.contains("floating")) {
      for (const selector of ANCHORS) {
        const anchor = document.querySelector(selector);
        if (anchor) {
          existing.remove();
          break;
        }
      }
    }
    if (place()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Stop watching after 30s either way; an endless observer on a page this
  // busy is a real CPU cost, and the floating fallback is already in place.
  setTimeout(() => observer.disconnect(), 30000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
