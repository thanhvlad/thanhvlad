# Extension / capture API

The bundled Chrome extension (`extension/`) talks to four endpoints. All of them take
`Authorization: Bearer <token>`; generate the token in the app under
**Settings → Advanced → Browser extension / API**. Rotating the token invalidates the
previous one; revoking disables the endpoints for that shop.

## `POST /api/extension/capture`

Adds one or more supplier products to the shop's import list. Used by the extension's
panel on the product page and usable from any script.

### Request

A link alone, which the server resolves through the supplier account:

```json
{ "url": "https://www.aliexpress.com/item/1005006001.html" }
```

or several links:

```json
{ "urls": ["https://www.aliexpress.com/item/1005006001.html", "1005006002"], "pricingRuleId": "optional" }
```

or, what the extension sends, one link plus the product it read off that page, which
imports with no supplier API call at all:

```json
{
  "url": "https://www.aliexpress.com/item/1005006001.html",
  "product": {
    "externalId": "1005006001",
    "title": "Cotton tee",
    "descriptionHtml": "<p>Soft cotton.</p>\n<h3>Specifications</h3>\n<table><tbody><tr><th>Material</th><td>Cotton</td></tr></tbody></table>",
    "url": "https://www.aliexpress.com/item/1005006001.html",
    "images": ["https://ae01.alicdn.com/kf/a.jpg"],
    "currency": "USD",
    "optionNames": ["Color"],
    "variants": [
      { "externalSkuId": "12000001", "skuAttr": "14:691", "attributes": [{ "name": "Color", "value": "Black" }], "image": null, "price": "3.5", "originalPrice": "5", "stock": 20, "isAvailable": true }
    ],
    "variantCount": 1,
    "storeName": "Example Store",
    "categoryId": "200000",
    "shipsFrom": []
  }
}
```

Up to 25 references per call; a `product` is honoured only when exactly one link is
sent, so one capture cannot be filed against unrelated links. AliExpress URLs/IDs and
CJ product URLs are recognised. The platform and product id always come from the
server's reading of the link, never from the payload.

#### `product.descriptionHtml`

The page model carries no description, only links to it. The extension fetches
AliExpress's description document (`DESC.pcDescUrl`, falling back to the image and text
modules at `DESC.nativeDescUrl`), strips scripts, styles, embeds and most attributes,
and appends an escaped **Specifications** table built from the page's attribute list
with keyword-stuffing rows, internal flags and "NONE" values left out. The whole fetch
has a four-second budget; if it fails the product is still captured, with an empty
description.

On the server the field is hostile input:

- it is **clipped at 200 000 characters** rather than rejected, so an oversized
  supplier description does not cost the merchant the whole capture (a value over
  1 000 000 characters, or a request body over 512 KB, is still refused);
- it is **allowlist-sanitized** (`app/lib/sanitize-html.server.ts`) before it is stored:
  no event handlers, `javascript:`/`data:` URLs, `srcset`, `svg`, `iframe` or CSS
  `url()`; images must be absolute http(s).

The extension keeps its own copy under 180 000 characters.

#### `product.variants` and `variantCount`

The extension sends at most **250 variants**. Shopify products may have up to 2048
variants, but the Admin API documents a limit of 250 elements for any input array, and
a capture larger than that would import and then fail at push. `variantCount` is how
many buyable variants the page offered; when it is larger than `variants.length`, the
panel tells the merchant how many were left out. The server ignores `variantCount` and
refuses more than 300 variants.

### Response

```json
{
  "ok": true,
  "url": "https://www.aliexpress.com/item/1005006001.html",
  "importedProductId": "cm…",
  "title": "Wireless Bluetooth Earbuds Pro…",
  "platform": "ALIEXPRESS",
  "results": [ { "url": "…", "ok": true, "importedProductId": "…", "title": "…" } ],
  "importListUrl": "https://<shop>.myshopify.com/admin/apps/<api-key>/app/import"
}
```

Errors: `401` missing/invalid token, `400` bad body, `429` rate limited, per-item
`ok:false` with `error` (a rejected `product` names the field that failed).

CORS is open (`*`) on this endpoint only, so the panel can call from the supplier's
origin; the bearer token is the only credential and should be treated like a password.

## Ordering on AliExpress

The Chrome extension lists the orders waiting to be placed and opens each product on
AliExpress. You place and pay for the order there, then record the AliExpress order
number in the extension; tracking you add there is sent to Shopify. The extension never
places or pays for an order by itself.

These endpoints carry customer names and addresses, so they send **no CORS headers**:
only the extension's own popup, which the host permission for the app's origin exempts
from CORS, can read them.

### `GET /api/extension/orders`

```json
{ "ok": true, "orders": [{ "id": "…", "orderName": "#1001", "shippingAddress": { "…": "…" }, "items": [ "…" ] }] }
```

Purchase orders waiting to be placed (`AWAITING_PLACEMENT`).

### `POST /api/extension/orders/:id/placed`

```json
{ "externalOrderIds": ["8190000000000000"], "totalCost": "12.40", "currency": "USD" }
```

Records that the merchant placed the purchase order on AliExpress. `200 { ok: true, status: "AWAITING_PAYMENT", paymentUrl }`;
`200 { ok: true, alreadyRecorded: true }` when the same ids are sent again; `409` when
the purchase order is already recorded with other ids.

### `POST /api/extension/orders/:id/tracking`

```json
{ "number": "LP00123456789CN", "carrier": "Cainiao" }
```

Adds a tracking number through the same path as tracking typed on the order page, so
the Shopify fulfilment and the customer notification follow the shop's own settings.

## Installing the extension

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `extension/`.
2. Open the extension options, paste the app URL (e.g. `https://your-app.example.com`)
   and the token.
3. On an AliExpress product page press **Add to import list** in the DropshipHub panel
   (bottom left), or use the extension icon.
4. After updating `page-reader.js` or `content.js`, press *Reload* on the extension card
   and reload the AliExpress tab, or captures keep using the old reader.
