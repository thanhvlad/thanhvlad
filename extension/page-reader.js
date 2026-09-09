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
      // The page's own description lives behind a separate request; the import
      // list lets the merchant edit copy anyway, so leave it for them.
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

  function read() {
    try {
      if (/aliexpress\./i.test(location.hostname)) return extractAliExpress();
    } catch {
      // Any shape change lands here. Returning null makes the caller send the
      // url alone, which still imports - just without the page's own data.
    }
    return null;
  }

  window.addEventListener(REQUEST, () => {
    let payload = null;
    try {
      payload = read();
    } catch {
      payload = null;
    }
    window.dispatchEvent(
      new CustomEvent(RESPONSE, { detail: payload ? JSON.stringify(payload) : "" }),
    );
  });
})();
