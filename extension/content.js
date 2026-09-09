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
 * AliExpress hangs the whole product model on window._d_c_, under
 * lifeCycleEventList[0].data as a map of modules (PRODUCT_TITLE, SKU, PRICE,
 * HEADER_IMAGE_PC, ...). Everything the import list needs is there, which is
 * why this can import a real product with no supplier API account: the
 * merchant's own page load already did the fetching.
 *
 * Every read is defensive. When anything is missing the function returns null
 * and the caller falls back to sending just the url, which is the old
 * behaviour - a changed page shape degrades the import, it does not break it.
 * ------------------------------------------------------------------------- */

/** "₫2,861,602|2861602|" -> "2861602" */
function plainAmount(salePriceLocal, fallbackValue) {
  if (typeof salePriceLocal === "string") {
    const part = salePriceLocal.split("|")[1];
    if (part && /^\d+(\.\d+)?$/.test(part.trim())) return part.trim();
  }
  if (typeof fallbackValue === "number" && isFinite(fallbackValue)) return String(fallbackValue);
  return null;
}

function extractAliExpress() {
  const data = window?._d_c_?.lifeCycleEventList?.[0]?.data;
  if (!data) return null;

  const info = data.GLOBAL_DATA?.globalData?.productInfo;
  const externalId = String(info?.productId ?? "").trim();
  const title = String(data.PRODUCT_TITLE?.text ?? "").trim();
  if (!externalId || !title) return null;

  const header = data.HEADER_IMAGE_PC ?? {};
  const images = [
    ...(Array.isArray(header.imagePathList) ? header.imagePathList : []),
    ...(Array.isArray(header.mainImages) ? header.mainImages.map((m) => m?.imageUrl) : []),
  ].filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));

  // skuProperties describes the option axes; skuPaths is one row per buyable
  // combination, keyed into PRICE.skuPriceInfoMap by its string id.
  const props = Array.isArray(data.SKU?.skuProperties) ? data.SKU.skuProperties : [];
  const optionNames = props.map((p) => String(p?.skuPropertyName ?? "").trim()).filter(Boolean);

  const valueLookup = new Map();
  for (const p of props) {
    for (const v of p?.skuPropertyValues ?? []) {
      // skuPaths carry "propertyId:valueId" pairs, and the value id lives on
      // propertyValueIdLong - NOT propertyValueId, which does not exist here.
      // Getting this wrong costs every variant its option names silently.
      const valueId = v.propertyValueIdLong ?? v.propertyValueId;
      if (valueId == null) continue;
      valueLookup.set(`${p.skuPropertyId}:${valueId}`, {
        name: String(p.skuPropertyName ?? "").trim(),
        // Display name is what the buyer sees on the page ("OM807"); the raw
        // propertyValueName can be an unrelated internal label ("Red").
        value: String(v.propertyValueDisplayName ?? v.propertyValueName ?? "").trim(),
        image: typeof v.skuPropertyImagePath === "string" ? v.skuPropertyImagePath : null,
      });
    }
  }

  const priceMap = data.PRICE?.skuPriceInfoMap ?? {};
  const paths = Array.isArray(data.SKU?.skuPaths) ? data.SKU.skuPaths : [];

  let currency = null;
  const variants = [];
  for (const row of paths) {
    const skuId = String(row?.skuIdStr ?? row?.skuId ?? "").trim();
    if (!skuId) continue;
    const price = priceMap[skuId] ?? data.PRICE?.targetSkuPriceInfo;
    const amount = plainAmount(price?.salePriceLocal, price?.originalPrice?.value);
    if (!amount) continue;
    if (!currency && price?.originalPrice?.currency) currency = String(price.originalPrice.currency);

    const attributes = [];
    let image = null;
    for (const pair of String(row.path ?? "").split(",")) {
      const hit = valueLookup.get(pair.trim());
      if (!hit || !hit.name || !hit.value) continue;
      attributes.push({ name: hit.name, value: hit.value });
      if (!image && hit.image) image = hit.image;
    }

    const original = plainAmount(null, price?.originalPrice?.value);
    variants.push({
      externalSkuId: skuId,
      skuAttr: typeof row.skuAttr === "string" ? row.skuAttr : null,
      attributes,
      image,
      price: amount,
      originalPrice: original && original !== amount ? original : null,
      stock: Number.isFinite(row.skuStock) ? row.skuStock : 0,
      isAvailable: row.salable !== false,
    });
  }
  if (!variants.length || !currency) return null;

  const seller = data.SHOP_CARD_PC?.sellerInfo ?? {};
  const storeName = [seller.storeName, seller.companyName, data.SHOP_CARD_PC?.storeName]
    .find((v) => typeof v === "string" && v.trim());

  return {
    externalId,
    title,
    // The page's own description lives behind a separate request; the import
    // list lets the merchant edit copy anyway, so seed it from what is on hand.
    descriptionHtml: "",
    url: String(info?.detailUrl || location.href).split("?")[0],
    images: [...new Set(images)].slice(0, 30),
    currency,
    optionNames,
    variants: variants.slice(0, 300),
    storeName: storeName ? storeName.trim().slice(0, 200) : null,
    categoryId: info?.categoryId != null ? String(info.categoryId) : null,
    shipsFrom: [],
  };
}

/** Returns the page's product, or null when this page is not one we can read. */
function extractProduct() {
  try {
    if (/aliexpress\./i.test(location.hostname)) return extractAliExpress();
  } catch {
    // Any shape change lands here; falling through sends the url alone.
  }
  return null;
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
  const captured = extractProduct();
  if (!captured) msg.textContent = "Sending the link (could not read this page)…";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(captured ? { url: location.href, product: captured } : { url: location.href }),
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
