# Extension / capture API

The bundled Chrome extension (`extension/`) talks to seven endpoints. All of them take
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

Since version 1.6.0 the checkout lands with the customer's address filled in and saved
(the one thing the extension commits on your AliExpress account, because that is what
ordering means), the page's real total is sent to the app, and the order number and
status are recorded from your own AliExpress orders page rather than typed by hand. You
still press Pay now yourself; the extension only watches for that click.

These endpoints carry customer names and addresses, so they send **no CORS headers**:
only the extension's own pages and background worker, which the host permission for the
app's origin exempts from CORS, can read them.

### `GET /api/extension/orders`

```json
{
  "ok": true,
  "orders": [{
    "id": "…", "orderName": "#1001", "platform": "ALIEXPRESS", "currency": "USD", "totalCost": "8.99",
    "shopCurrency": "USD", "shopTotalCost": "8.99",
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

`currency`/`totalCost` are the estimate as captured (the product page's currency, VND on the
measured account); `shopCurrency`/`shopTotalCost` are the same estimate converted to the
shop's currency at placement, or `null` when no conversion is on record. AliExpress's
checkout shows the account's currency (USD on the measured account), so the checkout panel
compares the page's total with whichever estimate shares that currency, and shows both
amounts with no verdict when neither does.

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

### `POST /api/extension/orders/:id/quote`

```json
{ "currency": "USD", "total": "93.62", "subtotal": "85.89", "shipping": "2.99", "charges": "4.74", "source": "confirm" }
```

What AliExpress's checkout page shows the purchase order costs, in the account's currency,
sent by the checkout panel once the page's address block shows the customer's address (before
that the total carries the merchant's default address's shipping and tax, which follow the
destination state) and again whenever the readable total changes; with several items, the
running sum of the items quoted so far, since each item is its own AliExpress checkout. The
extension keeps the last total sent per item and does not repeat it. Accepted while the
purchase order is `AWAITING_PLACEMENT`, `AWAITING_PAYMENT` or `PLACED` (`409` otherwise).
Sets `currency`, `itemsCost` = `subtotal` when given, else `total - shipping - charges` (never
below 0), `shippingCost` = `shipping + charges`, `totalCost` = `total`; recomputes the
shop-currency amounts at the known rate (clearing them when no rate is on record, so the
order's cost roll-up leaves the purchase order out rather than sum an old currency's figures);
stores `raw.quote = { source, at }`; writes an `order.supplier_quote` activity line ("#1001:
AliExpress shows 93.62 USD at checkout"); rolls the order's costs up and re-evaluates it. The
panel sends the subtotal only when the page's rows add up to the total; with a promo code
applied they do not, and the goods are then taken as the total less shipping and charges. The
same total sent again answers `200 { ok: true, unchanged: true }` and writes nothing, unless
the shop-currency amounts on record are stale (a rate learned since), which it refreshes.
Validation: a three-letter capital currency code, plain non-negative decimals, `source`
must be `"confirm"`.

### `POST /api/extension/orders/sync`

```json
{ "orders": [{ "orderId": "8190000000000001", "productIds": ["3256809840464144", "1005010026778896"],
               "skuText": "Play blue light", "status": "Awaiting delivery", "total": "$93.62", "date": "Sep 15, 2026" }],
  "hints": [{ "purchaseOrderId": "…", "payingAt": 1789000000000 }] }
```

The orders the merchant's AliExpress orders list shows (or the one order of a detail page,
which carries no `productIds`: its item block is unmeasured and its recommendation strips
link products too), sent by `extension/orders.js`. `hints` names every checkout job whose
merchant pressed Pay now, with the time of the click; it carries nothing of the customer. For
each order, in order:

- A purchase order of this shop already recorded with that AliExpress order id (the
  `externalOrderId` column or `raw.externalOrderIds`) has its status advanced from the
  AliExpress status, never backwards, with the existing rank rules: To pay / Awaiting payment
  → `AWAITING_PAYMENT` (with the 24-hour deadline when none is stored); Awaiting shipment /
  Processing / Paid → `PAID`; Awaiting delivery / Shipped → `SHIPPED`; Completed / Received →
  `DELIVERED`. Closed / Cancelled is reported (`closed: true`) but never applied. Result
  `advanced`, or `already` when nothing changed.
- An unknown order that is Closed / Cancelled on AliExpress is never recorded: result
  `unmatched` with `closed: true`.
- Otherwise the candidates are this shop's AliExpress purchase orders in
  `AWAITING_PLACEMENT` (placement mode extension) created within the last 14 days with an
  item whose `externalProductId` is one of `productIds` (both the regional id and the global
  id, regional minus 2^51, are tried). None: `unmatched`. The orders list shows the account's
  whole history, so an unrecorded older order for the same product must never be taken for
  the new one:
  - the card's `date` must read as a calendar day ("Sep 15, 2026", "15 Sep 2026", ISO,
    "15 thg 9, 2026", or a numeric date whose order is beyond doubt); otherwise result
    `ambiguous` with `reason: "date-unreadable"` and the candidates, nothing recorded;
  - candidates created after that day (in the shop's timezone) are dropped; when none is
    left, result `unmatched` with `reason: "older-than-orders"` and the candidates;
  - with several candidates left, the one whose item's variant words (the skuAttr values, the
    supplier variant's attribute values) all appear in `skuText` is taken, else the one a
    hint names whose Pay now was pressed on the card's day (or the day before); otherwise
    result `ambiguous` with the candidates, nothing recorded;
  - a candidate whose variant values are known and none of which the (non-empty) `skuText`
    names is not recorded: result `ambiguous` with `reason: "variant-differs"`;
  - a candidate with several items is not recorded either, since each item is its own
    AliExpress checkout and the placed endpoint records a purchase order once with all its
    numbers: result `partial` with `purchaseOrderId`, `orderName` and `matchedProductIds`
    (the purchase order's product ids the card covers) and `paid`. The extension notes the
    number on that item in its checkout job (any tab) and the job moves to "recorded"; once
    the last item has its number the extension sends them together through `POST …/placed`
    by itself (`paid` only when every number reads as paid on the page) and reports the
    purchase order as recorded.
  - The one single-item candidate left is recorded through the same code path as
    `POST …/placed` (`externalOrderIds = [orderId]`, `paid` only when the status reads as paid
    or later; an unreadable status counts as unpaid and keeps the 24-hour deadline), which
    sets the payment link and deadline, tags the Shopify order and writes the log. An order
    first seen already shipped moves on to `SHIPPED` at once. Result `recorded`.

```json
{ "ok": true, "results": [{ "orderId": "8190000000000001", "result": "recorded", "purchaseOrderId": "…", "orderName": "#1001", "status": "PAID" }] }
```

Idempotent and safe to repeat: the same list again records nothing twice, and a purchase
order that was not recorded (ambiguous, partial, older, closed) can still be recorded by hand
in the popup's "Mark as placed" or the checkout panel. Validation: `orderId` 10–24 digits,
`productIds` digits (at most 40), text fields capped, at most 100 orders and 20 hints per
call, 30 calls per minute per shop.

### `POST /api/extension/orders/sync-tracking`

```json
{ "tradeOrderId": "8190000000000001", "trackingNumber": "SWX000000000000000001", "carrier": "AliExpress Selection Standard" }
```

Sent by `extension/orders.js` from an AliExpress tracking page. Finds the purchase order by
the AliExpress order id and, unless it already has that tracking number, adds it through the
same path as the popup's "Add tracking" and the order page. Answers
`{ ok: true, result: "added" | "known" | "cancelled" | "unmatched", orderName?, number? }`;
`cancelled` is a purchase order cancelled in DropshipHub, to which nothing is added.

### The checkout assist

An order to place whose items are all linked to an AliExpress variant has **Start checkout**
in the popup, and its purchase order has **Order on AliExpress with the extension** on the
order page in DropshipHub. Page facts it relies on are in `docs/ALIEXPRESS_PAGE_MODEL.md`.

1. **Start checkout** (or the order page's button) opens a new tab on the first item's product
   page (`www.aliexpress.com/item/<id>.html`). AliExpress may redirect to a regional host;
   `aliexpress.us` uses the global id plus 2^51. Started from the order page, the checkout tab
   opens beside that tab and is put in its tab group (`chrome.tabs.group`, the extension's
   `tabGroups` permission): Chrome does not do that by itself from `openerTabId`, and the new
   tab was hard to find next to the app's.
2. On the product page the extension reads the page's own product id and SKU list, checks
   that the item's SKU still exists and is in stock, and opens that host's
   `/p/trade/confirm.html` for the SKU, quantity, the customer's country and the item's
   carrier. A missing or sold-out SKU stops there with the reason in the panel.
3. On the confirm page the DropshipHub panel (top right) shows the order, "Item i of n", a
   check that the page's product, SKU, quantity and country match, and DropshipHub's cost
   estimates (captured currency and shop currency) beside the page's total: a verdict against
   the estimate in the page's currency, or both amounts side by side when neither shares it.
   Once the page's address block shows the customer's address and the total is readable, the
   total is sent to the app (`…/quote`, above) and the panel says so; it is read again for a
   while after the address is set and sent again when it changes. When the page's product,
   SKU, quantity or destination does not match the item (a later navigation in the tab, say)
   nothing is filled and nothing is sent. The customer's address, with **Copy** buttons, sits
   in a collapsed block for the rare case something has to be entered by hand. The panel
   keeps watching the page while it is open, so it re-reads the total when the page's address
   block changes and notices the page dying under it: when AliExpress answers with its own
   error page ("Oops! Something went wrong. Please refresh the page and try again.", or
   "Query product info failed…", or a page left with none of its `pl-*` markup after the
   wait) the panel shows that instead of the confirm view and fills, quotes and saves
   nothing. It reopens that item's checkout by itself once (product page first, which is what
   AliExpress needs before a confirm page), and after that only when you press **Open this
   item's checkout again**.
4. **The address is filled by itself** once the confirm page is really rendered: an address
   area (`.pl-address-item-container`, or `.pl-address-item__new-btn-wrap` on an account with
   no saved address) **and** either the total row (`.pl-order-toal-container__item`) or the
   page's Pay now button (`button.place-order-primary-btn`, read, never clicked). The panel
   says the page is still loading meanwhile and waits up to 25 s, for the automatic fill and
   for **Fill address again** alike; on the live account the fill started while the page was
   still building and gave up on a drawer that opened a moment later. If the address block
   already shows the customer's last name and house number the fill is skipped and the panel
   says the address is set. Otherwise the extension opens the add-address form ("Add new
   address", or "Change" - the `<a>` inside `span.pl-address-item__arrrow` - and then the
   drawer's "Add new address"), presses "Enter manually" if needed, and detects which of the
   two measured designs is on the page. Each of those steps is clicked once, waited for
   (15 s for the drawer, 10 s for the form), then clicked and waited for once more before it
   gives up; both attempts go through the same click guard, so a retry can reach nothing the
   guard refuses:
   - the **comet** form (`www.aliexpress.us` in English: `div.mt-form.deliver-address-form`,
     twelve inputs located by position, one "Select address" cascade modal for State and
     City) - the fill stops unless the Country/region box already shows the United States;
   - the **Fusion** form (`form.deliver-address-form` with `next-select` drop-downs), the
     earlier design, kept as the fallback.

   It types first and last name, the mobile number without +1, the street (at most 35
   characters, the rest moved to "Apt, suite, unit"), ZIP, then chooses State and City
   ("Other" when AliExpress does not list the city, with the panel saying so), reads every box
   back, and **saves the form** only when everything reads back as intended: every text box
   empty or holding exactly what it typed (so the form is a new address, not a saved one being
   edited), State and City showing the customer's, the country the United States, and "Set as
   default" off. Otherwise it highlights the boxes and asks you to check and press Save
   yourself. After a save it waits for the drawer to close and the address block to show the
   customer's name and house number, then reports "Address set. Check the total, then press
   Pay now on AliExpress yourself." The outcome is recorded in the job, so a page reload does
   not run a finished fill again; a fill that stopped ("partial" or "failed") is not run
   again by itself either, because you may be correcting the form by hand: after a reload the
   panel shows why it stopped, and **Fill address again** retries. The checkout is checked
   once more right before Save is clicked, so a checkout cancelled during the read-back is
   not committed. It stops, with the reason, for any other country, any form that does not
   look like the measured forms, a form that already holds another address, or a form whose
   default switch is on. It works with AliExpress in English or Vietnamese only.
5. **You** press Pay now. The extension never clicks Pay now / Place order, Buy now, any
   payment choice, coupon, the quantity stepper, the address list's radios, edit or delete
   icons, or "Set as default": every click it makes goes through one guard that refuses those
   controls, including when the element clicked sits inside one of them, and Save on the
   add-address form is the one deliberate exception, made only through the verified path
   above. Your click on Pay now is observed (a capture-phase listener that never prevents or
   makes it) and the job moves to "paying".
6. The panel then says "Payment started on AliExpress. When it is done, open your AliExpress
   orders and DropshipHub records the order number by itself", with **Open my AliExpress
   orders**. On the orders list `extension/orders.js` reads every order card and sends it to
   `…/sync` (above), with the paying hints of the open checkout jobs; a small panel (bottom
   right) reports "#1001 recorded as AliExpress order 8190…", why an order was not recorded
   (its date could not be read, it is dated before the order waiting for its product, it is
   closed, its SKU text names another variant, or several orders wait for the same product -
   record it in the popup then), or "no DropshipHub order matched". The checkout job is
   dropped as soon as its purchase order is recorded. For a purchase order with several
   items the sync answers `partial` and the number is noted on the item being checked out;
   the panel shows it as recorded and **Next item** opens the next product in the same tab;
   when the last item's number arrives the extension sends them all to the app by itself
   and the orders page reports the purchase order as recorded. On a tracking page the carrier
   and tracking number go to `…/sync-tracking` and are added to the purchase order. Entering
   the order number by hand stays available in a collapsed block of the panel, and in the
   popup's "Mark as placed".

**What is read from which page, and nothing else:** the confirm page's address block text
(to see whether the customer's address is set), address form boxes (to verify the fill),
summary and total rows; the orders list's cards: AliExpress order ids, product ids, SKU
text, status, totals and dates; an order detail page's "Ref. Number" row and status (never
its product links); a tracking page's order id (from its address), carrier and tracking
number. The orders list, order detail and tracking pages also print the customer's address
and a masked name; the extension never reads those, and only order ids, product ids, SKU
text, status, totals, dates, carriers and tracking numbers are sent to the app from them,
plus the paying hints (a purchase order id and the time Pay now was pressed, from the
extension's own jobs).

The checkout job, including the customer's address, lives only in the extension's
`chrome.storage.session` (memory only, cleared when the browser closes) and is removed when
the purchase order is recorded (by the orders page's sync, in the panel, or with the popup's
"Mark as placed"), when the app answers that it is gone (404) or already recorded with other
numbers (409), when you cancel, when the tab closes, or after four hours. It is never written
to the console or handed to the page's scripts, and the only part of it that goes into a URL
is the destination country, which AliExpress's own checkout address carries. A field you
**Copy** goes to the operating system's clipboard, which the extension cannot clear: it can
outlive the checkout, for example in Windows clipboard history.

### The order page's "Order on AliExpress with the extension" button

Once you have allowed the extension on the app's origin (the popup's **Allow access**), the
extension registers a bridge script (`extension/app-bridge.js`) for that origin. The order
page in DropshipHub then shows **Order on AliExpress with the extension** beside a purchase
order waiting to be placed. Pressing it posts `{ source: "dropshiphub", type:
"checkout:start", purchaseOrderId }` to the page's own window; the bridge relays the id to
the extension, which fetches the order from `GET /api/extension/orders` with your token and
starts the checkout exactly as the popup's Start checkout does. Only the purchase order's id
crosses from the page; the bridge answers `{ source: "dropshiphub-extension", type: "ready"
| "checkout:started" | "checkout:error" }`. When no "ready" arrives within 1.5 s the page
says the extension is not installed or has no access to the site, with a link to the
settings page.

**Inside the Shopify admin** the app is a cross-origin iframe of
`https://admin.shopify.com`, and Chrome did not run the script registered for the app's
origin in that frame (measured 1.6.0: the button said the extension had no access there,
while the same bridge answered on the app's origin opened as a top-level page). Since 1.6.1
the popup's **Allow access** asks for `https://admin.shopify.com/*` as well, plainly, "so
the Order button works inside the Shopify admin"; a merchant who allows only the app's own
site keeps everything else, just not that button inside the admin. With the admin origin
granted the worker registers the same `app-bridge.js` in the admin's **top frame only**
(`allFrames: false`), where it works as a relay: the app page also posts its message to
`window.parent` (addressed to the admin's origin, taken from `document.referrer`, never
`"*"`), the relay accepts it only from a frame whose origin is the configured app origin
(`chrome.storage.sync`'s `appUrl`, the only setting it reads), answers back to that frame at
that origin, and tells the worker which origin it accepted. The worker still refuses
anything else: `checkout:start-by-id` is taken from a sender frame on the app's origin, or
from the admin page when the origin it names is the stored app origin - never from "any
sender". The page accepts answers from its own window or from its parent, with the same
`source: "dropshiphub-extension"` check and the same 1.5 s / 20 s timeouts.

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
6. **Version 1.6.0** fills and saves the address by itself, sends the real total, records
   the order number and tracking from your AliExpress orders and tracking pages
   (`orders.js`) and adds the order page's button (`app-bridge.js`, registered for the app's
   origin once you press **Allow access** in the popup; press it once more after updating
   if the button says the extension has no access). Press *Reload* on the extension card,
   then reload any open AliExpress tabs. No new permission is asked for.
7. **Version 1.6.1** is the fix-up after the first live checkout: the fill waits for the
   confirm page to be rendered (up to 25 s) before it opens anything, tries the address
   drawer and its "Add new address" twice, shows AliExpress's own error page ("Oops!
   Something went wrong…") for what it is and offers to open the item's checkout again
   instead of a confirm panel over a dead page, keeps watching the page while it is open,
   and makes the order page's button work inside the Shopify admin. It adds the
   **`tabGroups`** permission - the only one - so the checkout tab joins the tab group of
   the tab that started it; Chrome does not do that by itself from `openerTabId`. Press
   *Reload* on the extension card, then open the popup once and press **Allow access**
   again to grant `https://admin.shopify.com` for the order page's button.
