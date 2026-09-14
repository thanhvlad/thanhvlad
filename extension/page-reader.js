/**
 * Runs in the page's MAIN world.
 *
 * A content script shares the DOM but NOT the page's JavaScript: it lives in an
 * isolated world where `window._d_c_` — the object AliExpress hangs its entire
 * product model on — reads as undefined. Anything that needs the page's own
 * variables has to execute here instead, and hand the result across.
 *
 * The two sides talk over CustomEvents on window, carrying a JSON string rather
 * than an object: structured-cloning arbitrary objects between worlds is
 * fragile, and a string always survives.
 */
(() => {
  const REQUEST = "dropshiphub:read";
  const RESPONSE = "dropshiphub:product";
  // Sent the moment a request arrives. Reading the description takes a network
  // round trip, and without this the content script could not tell "the reader
  // is still working" from "the reader never loaded" until its timeout expired.
  const ACK = "dropshiphub:reading";

  /** How long the description may take, in total, before the product goes without one. */
  const DESCRIPTION_BUDGET_MS = 4000;
  /** The server clips descriptions at 200 000 characters; stay well inside it. */
  const MAX_DESCRIPTION_CHARS = 180000;
  const MAX_SPEC_ROWS = 40;

  /** "₫2,861,602|2861602|" -> "2861602" */
  function plainAmount(salePriceLocal, fallbackValue) {
    if (typeof salePriceLocal === "string") {
      const part = salePriceLocal.split("|")[1];
      if (part && /^\d+(\.\d+)?$/.test(part.trim())) return part.trim();
    }
    if (typeof fallbackValue === "number" && isFinite(fallbackValue)) return String(fallbackValue);
    return null;
  }

  function pageModel() {
    return window?._d_c_?.lifeCycleEventList?.[0]?.data ?? null;
  }

  function extractAliExpress(data) {
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

      // A path is "14:691;200007763:201441035" - semicolons between axes.
      const attributes = [];
      let image = null;
      for (const pair of String(row.path ?? "").split(/[;,]/)) {
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
      // Filled in by describe() once the description document has been fetched.
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

  /* -------------------------------------------------------------------------
   * The description
   *
   * The first product pushed to a real store went out with an empty
   * description: the page model does not carry the description, only links to
   * it. DESC.pcDescUrl is an HTML document and DESC.nativeDescUrl a JSON list of
   * image and text modules, both served cross-origin to the product page (a
   * fetch from this world was verified to return them). PRODUCT_PROP_PC holds
   * the specification table.
   *
   * None of this may cost the merchant the capture itself. Every step is bounded
   * by one time budget and wrapped so that a failure yields "no description",
   * never "no product". The markup is cleaned here only to keep the payload
   * small; the server treats it as hostile and allowlist-sanitizes it.
   * ----------------------------------------------------------------------- */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Only AliExpress's own hosts, over https. The model is the page's, but a url is still a url. */
  function descriptionUrl(raw) {
    if (typeof raw !== "string" || !raw) return null;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== "https:") return null;
      if (!/(^|\.)(aliexpress-media\.com|aliexpress\.com|aliexpress\.us|alicdn\.com)$/i.test(url.hostname)) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  async function fetchText(url, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), remaining);
    try {
      const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Attributes worth sending; everything else (classes, inline handlers, tracking data) is dropped here. */
  const KEEP_ATTRIBUTES = new Set(["src", "href", "alt", "title", "colspan", "rowspan"]);
  const DROP_ELEMENTS = "script,style,link,meta,iframe,frame,object,embed,noscript,template,form,input,button,select,textarea,svg,canvas,video,audio";

  function descriptionFromHtml(text) {
    if (typeof text !== "string" || !text.trim()) return "";
    if (typeof DOMParser !== "function") {
      const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
      return (body ? body[1] : text).trim();
    }
    // DOMParser builds an inert document: nothing in it runs or loads.
    const doc = new DOMParser().parseFromString(text, "text/html");
    for (const node of doc.querySelectorAll(DROP_ELEMENTS)) node.remove();
    for (const el of doc.body.querySelectorAll("*")) {
      // Lazy-loaded description images keep the real address in data-src.
      if (el.tagName === "IMG" && !el.getAttribute("src") && el.getAttribute("data-src")) {
        el.setAttribute("src", el.getAttribute("data-src"));
      }
      for (const attr of [...el.attributes]) {
        if (!KEEP_ATTRIBUTES.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
      }
    }
    return doc.body.innerHTML.trim();
  }

  function descriptionFromModules(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return "";
    }
    const modules = json?.moduleList ?? json?.data?.moduleList;
    if (!Array.isArray(modules)) return "";
    const parts = [];
    for (const module of modules) {
      if (module?.type === "image" && typeof module.data?.url === "string" && /^https:\/\//i.test(module.data.url)) {
        parts.push(`<p><img src="${escapeHtml(module.data.url)}" alt=""></p>`);
      } else if (module?.type === "text" && typeof module.data?.content === "string" && module.data.content.trim()) {
        parts.push(`<p>${escapeHtml(module.data.content.trim()).replace(/\r?\n/g, "<br>")}</p>`);
      }
    }
    return parts.join("\n");
  }

  /** A document with neither words nor pictures in it is no description. */
  function hasContent(html) {
    return /<img\b/i.test(html) || html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;
  }

  function usable(html) {
    return Boolean(html) && html.length <= MAX_DESCRIPTION_CHARS && hasContent(html);
  }

  /**
   * AliExpress appends search-keyword stuffing to the specification list: rows
   * whose "name" is a search phrase ("wireless earbuds bluetooth headphones")
   * and whose value is a comma-separated keyword list. Real attribute names are
   * short and Title Case ("Brand Name", "Material"); internal flags carry an
   * underscore ("semi_Choice"). A row is kept only when it reads like the former.
   */
  function isSpecRow(name, value) {
    if (!name || !value) return false;
    if (name.length > 40 || value.length > 160) return false;
    if (/_/.test(name) || /^choice$/i.test(name)) return false;
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;
    if (words.length >= 3 && name === name.toLowerCase()) return false;
    if (name.toLowerCase() === value.toLowerCase()) return false;
    if (value.split(",").length > 5) return false;
    if (/^(none|null|undefined|n\/a|-)$/i.test(value)) return false;
    return true;
  }

  function specificationsTable(data) {
    const props = data.PRODUCT_PROP_PC?.showedProps;
    if (!Array.isArray(props)) return "";
    const seen = new Set();
    const rows = [];
    for (const prop of props) {
      const name = String(prop?.attrName ?? "").trim();
      const value = String(prop?.attrValue ?? "").trim();
      if (!isSpecRow(name, value)) continue;
      const key = `${name.toLowerCase()} ${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(`<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`);
      if (rows.length >= MAX_SPEC_ROWS) break;
    }
    return rows.length ? `<h3>Specifications</h3>\n<table><tbody>${rows.join("")}</tbody></table>` : "";
  }

  async function describe(data) {
    const deadline = Date.now() + DESCRIPTION_BUDGET_MS;
    let description = "";

    const pcUrl = descriptionUrl(data.DESC?.pcDescUrl);
    if (pcUrl) {
      const text = await fetchText(pcUrl, deadline);
      const html = text && text.trim().startsWith("{") ? descriptionFromModules(text) : descriptionFromHtml(text);
      if (usable(html)) description = html;
    }
    // The module list is the compact form of the same content: the fallback when
    // the HTML document failed, came back empty, or is too large to send.
    if (!description) {
      const nativeUrl = descriptionUrl(data.DESC?.nativeDescUrl);
      if (nativeUrl) {
        const html = descriptionFromModules((await fetchText(nativeUrl, deadline)) ?? "");
        if (usable(html)) description = html;
      }
    }

    let specs = "";
    try {
      specs = specificationsTable(data);
    } catch {
      specs = "";
    }
    return [description, specs].filter(Boolean).join("\n");
  }

  async function read() {
    if (!/aliexpress\./i.test(location.hostname)) return null;
    let data;
    let product;
    try {
      data = pageModel();
      product = data ? extractAliExpress(data) : null;
    } catch {
      // Any shape change lands here. Returning null makes the caller send the
      // url alone, which still imports - just without the page's own data.
      return null;
    }
    if (!product) return null;
    try {
      product.descriptionHtml = await describe(data);
    } catch {
      product.descriptionHtml = "";
    }
    return product;
  }

  window.addEventListener(REQUEST, () => {
    window.dispatchEvent(new CustomEvent(ACK));
    read()
      .catch(() => null)
      .then((payload) => {
        window.dispatchEvent(new CustomEvent(RESPONSE, { detail: payload ? JSON.stringify(payload) : "" }));
      });
  });
})();
