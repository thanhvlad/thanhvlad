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
{
  "ok": true,
  "orders": [{
    "id": "…", "orderName": "#1001", "platform": "ALIEXPRESS", "currency": "USD", "totalCost": "8.99",
    "shippingAddress": {
      "name": "Jane Doe", "firstName": "Jane", "lastName": "Doe", "company": null, "phone": "+15125550100",
      "address1": "1 Main St", "address2": null, "city": "Austin", "province": "Texas", "provinceCode": "TX",
      "zip": "78701", "country": "United States", "countryCode": "US", "taxNumber": null
    },
    "items": [{
      "title": "Wireless earbuds", "variantLabel": "Color: Black", "quantity": 2,
      "externalProductId": "1005006001", "productUrl": "https://www.aliexpress.com/item/1005006001.html",
      "externalSkuId": "12000031", "skuAttr": "14:193#Black", "unitCost": "3.50", "currency": "USD",
      "carrierCode": "CAINIAO_FULFILLMENT_STD", "carrierName": "AliExpress Standard Shipping"
    }]
  }],
  "awaitingTracking": [ "…" ]
}
```

Purchase orders waiting to be placed (`AWAITING_PLACEMENT`). `firstName` and `lastName` are
Shopify's own; only when the address has neither are they split from `name` (last word as the
surname), because AliExpress's address form has two required name boxes. `carrierCode` is the
item's chosen carrier, falling back to the purchase order's, and becomes the checkout page's
`shippingCompany`. The customer's email is never included.

### `POST /api/extension/orders/:id/placed`

```json
{ "externalOrderIds": ["8190000000000000"], "totalCost": "12.40", "currency": "USD" }
```

Records that the merchant placed the purchase order on AliExpress. `200 { ok: true, status: "AWAITING_PAYMENT", paymentUrl }`;
`200 { ok: true, alreadyRecorded: true }` when the same ids are sent again; `409` when
the purchase order is already recorded with other ids.

A purchase order is recorded once, with all its AliExpress order numbers: the endpoint does
not add numbers to one already recorded. The checkout assist therefore collects one number per
item and sends them together when the last item is recorded; sending the same list again after
a lost response gets `alreadyRecorded`.

### `POST /api/extension/orders/:id/tracking`

```json
{ "number": "LP00123456789CN", "carrier": "Cainiao" }
```

Adds a tracking number through the same path as tracking typed on the order page, so
the Shopify fulfilment and the customer notification follow the shop's own settings.

### The checkout assist

An order to place whose items are all linked to an AliExpress variant has **Start checkout**
in the popup. Page facts it relies on are in `docs/ALIEXPRESS_PAGE_MODEL.md`.

1. **Start checkout** opens a new tab on the first item's product page
   (`www.aliexpress.com/item/<id>.html`). AliExpress may redirect to a regional host;
   `aliexpress.us` uses the global id plus 2^51.
2. On the product page the extension reads the page's own product id and SKU list, checks
   that the item's SKU still exists and is in stock, and opens that host's
   `/p/trade/confirm.html` for the SKU, quantity, the customer's country and the item's
   carrier. A missing or sold-out SKU stops there with the reason in the panel.
3. On the confirm page the DropshipHub panel (top right) shows the order, "Item i of n", a
   check that the page's product, SKU, quantity and country match, DropshipHub's cost
   estimate beside the page's total (a warning only: the page shows the account's display
   currency), and every address field with a **Copy** button.
4. **Fill address** fills AliExpress's US address form: it opens "Add new address" and
   "Enter manually" if needed, chooses the country, fills first and last name, the mobile
   number without +1, the street (at most 35 characters, the rest moved to "Apt, suite,
   unit"), State, City ("Other" when AliExpress does not list the city, highlighted for you to
   check) and ZIP, then reads every box back and highlights any that does not show what it
   typed. It stops, and leaves the Copy buttons, for any other country, any form that does not
   look like the measured US form, a form that already holds another address (the edit form of
   a saved address), or a form whose "Set as default shipping address" is ticked. Nothing is
   filled until you press the button. It works with AliExpress in English or Vietnamese only;
   on a site in another language it stops with a message.
5. **You** check the address and press Confirm, then place and pay for the order on
   AliExpress. The extension never clicks Place order, Confirm, Pay, Buy now, any payment
   choice or "Set as default shipping address": every click it makes goes through one guard
   that refuses those controls, including when the element clicked sits inside one of them.
   The panel says the default box is unticked only after reading it.
6. Enter the AliExpress order number in the panel. If the page you land on after placing
   carries `orderId=` or `orderIds=` in its address, the panel shows those numbers beside the
   box with a **Use** button; they go into the box, and to DropshipHub, only on your clicks.
   With more items, **Next item** opens the next product in the same tab, and the numbers are
   sent to DropshipHub with the last item.

The checkout job, including the customer's address, lives only in the extension's
`chrome.storage.session` (memory only, cleared when the browser closes) and is removed when
the purchase order is recorded (in the panel or with the popup's "Mark as placed"), when the
app answers that it is gone (404) or already recorded with other numbers (409), when you
cancel, when the tab closes, or after four hours. It is never written to the console or handed
to the page's scripts, and the only part of it that goes into a URL is the destination country,
which AliExpress's own checkout address carries. A field you **Copy** goes to the operating
system's clipboard, which the extension cannot clear: it can outlive the checkout, for example
in Windows clipboard history.

The app URL must use `https://`; the extension refuses plain `http://` except for `localhost`
and `127.0.0.1`, because the token travels with every request.

## Installing the extension

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `extension/`.
2. Open the extension options, paste the app URL (e.g. `https://your-app.example.com`)
   and the token.
3. On an AliExpress product page press **Add to import list** in the DropshipHub panel
   (bottom left), or use the extension icon.
4. After updating `page-reader.js` or `content.js`, press *Reload* on the extension card
   and reload the AliExpress tab, or captures keep using the old reader.
5. **Version 1.5.0 adds the checkout assist** (`background.js`, `checkout-core.js`,
   `checkout.js`). Press *Reload* on the extension card in `chrome://extensions` - Chrome
   does not pick up a new background worker or content script otherwise - then reload any
   open AliExpress tabs. No new permission is asked for.
