# AliExpress product page — what the extension can rely on

Measured on a live product page (`/item/1005010026778896.html`, served from
`vi.aliexpress.com`) on 2026-09-14. AliExpress hashes its CSS class names and
changes them between releases, so everything below prefers the page's own data
model and `data-*` attributes over class names. Where a class has to be used,
match on its stable prefix (`[class*="buy-now--buynow"]`), never the hash.

Re-measure before relying on any of this for a release: open a product page and
run the snippets in the browser console.

## The product model

`window._d_c_.lifeCycleEventList[0].data` is readable only from the page's
MAIN world, which is why the extension has `page-reader.js` registered with
`"world": "MAIN"`. Content scripts in the isolated world see `undefined`.

Modules present on the measured page:

`POPUP, GLOBAL_DATA, HEADER_IMAGE_PC, PC_RATING, PRICE, SELLING_POINT_PC,
QUANTITY_PC, MIDDLE_BANNER, WISHLIST, PRICE_EXTEND, SHIPPING, SHOP_CARD_PC, DESC,
RECOMMEND_PC, TRAFFIC_IDENTIFY, BOTTOM_BAR_PC, AFTER_SALE_SERVICE_BLOCK, MIND,
PRODUCT_TITLE, PERSONAL_INFORMATION_SECURITY, PRICE_BANNER, PRODUCT_PROP_PC,
COUPON_BLOCK_PC, SKU`

### Description — `DESC`

| Field | What it is |
|---|---|
| `pcDescUrl` | HTML description (`pdp.aliexpress-media.com/.../pc/v2/en_US/desc.htm?productId=…&key=…`) |
| `nativeDescUrl` | JSON description: `{ version, moduleList: [{ type: "image", data: { url, style } }, { type: "text", data: { content } }] }` |
| `msiteDescUrl` | Mobile HTML variant |
| `descVideoUrl` | Product video, when the seller uploaded one |

A `fetch(pcDescUrl)` and `fetch(nativeDescUrl)` from the product page's own
context both returned **200 with a readable body**. The HTML is mostly `<img>`
tags carrying `slate-data-type` attributes; treat it as hostile input and
allowlist-sanitize it on the server.

### Specifications — `PRODUCT_PROP_PC`

`showedProps` is an array of `{ attrName, attrValue }` (50 entries on the
measured page). The first ~20 are real specifications (Brand Name, Model Number,
Battery Capacity, Certification, Origin…). **The rest are SEO keyword spam**
that the seller typed into the attribute name field — `"smart glasses
bluetooth"`, `"gafas inteligentes bluetooth"`, `"men sunglasses"` — and must not
reach a storefront.

### Weight

**Nowhere.** A recursive search of the whole model for weight, package,
gross weight, volume and dimensions found nothing product-related. Package
weight cannot come from the page; the app applies the merchant's default weight.

### Variants — `SKU`

```
skuProperties[]: { skuPropertyId, skuPropertyName, skuPropertyValues[]:
                   { propertyValueIdLong, propertyValueDisplayName, skuPropertyImagePath } }
skuPaths[]:      { skuIdStr, path, skuAttr, skuVal: { availQuantity, … } }
selectedSkuIdStr, selectedSkuAttr
```

Measured values:

```
skuProperties: Color (14) = 691 "Play blue light", 173 "Sunglasses", …
               Ships From (200007763) = 201441035 "CN"
skuPaths[0]:   skuIdStr "12000057945176350"
               path     "14:691;200007763:201441035"
               skuAttr  "14:691#Play blue light;200007763:201441035"
```

- Use `propertyValueIdLong`. `propertyValueId` does not exist on current pages.
- `path` separates axes with `;` and joins property and value with `:`.
- **"Ships From" is a SKU axis.** The same colour shipped from CN and from US is
  two different SKUs at two different prices and delivery times. Selecting a SKU
  by colour alone can silently order from the wrong warehouse.

## Selecting a SKU in the page

Every option is rendered as

```html
<div data-sku-col="14-691" class="sku-item--selected--ITGY_EO sku-item--image--jMUnnGA">
  <img alt="Play blue light" src="…">
</div>
```

`data-sku-col` is `<skuPropertyId>-<propertyValueIdLong>` — the same two numbers
as one `path` segment, with `-` instead of `:`. To select a SKU, split its
`path` on `;`, and click `[data-sku-col="<prop>-<value>"]` for each axis in
order. The selected option gains a class starting `sku-item--selected`; confirm
the page's `SKU.selectedSkuIdStr` afterwards rather than trusting the click.

## Quantity and purchase buttons

| Element | Selector |
|---|---|
| Quantity | `input.comet-v2-input-number-input` inside `[class*="quantity--picker"]` — a React-controlled input: set it with the native value setter and dispatch `input`, or press its + button |
| Buy now | `button[class*="buy-now--buynow"]` |
| Add to cart | `button[class*="add-to-cart--addtocart"]` |

## Regional sites and product ids

Measured 2026-09-15 on the owner's logged-in account. Opening
`www.aliexpress.com/item/1005010026778896.html` from a US-routed account
redirected to `www.aliexpress.us/item/3256809840464144.html?gatewayAdapt=glo2usa4itemAdapt`.
The US id is the global id plus 2^51:

```
1005010026778896 + 2251799813685248 = 3256809840464144
```

The US page's model reports the US id as its `productId`, and `data-sku-col`,
`skuPaths` and `selectedSkuAttr` are identical to the global page. Anything
the extension builds from a stored product id must use the id of the host it
is on. The account's display currency followed the account (VND), not the host.

## Checkout: the confirm page

"Buy now" does not create anything; it navigates to a confirm page whose URL
carries the whole selection:

```
https://www.aliexpress.us/p/trade/confirm.html
  ?objectId=3256809840464144           product id for this host
  &skuId=12000057945176350             skuIdStr
  &skuAttr=14:691#Play blue light;200007763:201441035   (URL-encoded selectedSkuAttr)
  &quantity=1
  &countryCode=US
  &shippingCompany=CAINIAO_FULFILLMENT_STD
  &provinceCode=&cityCode=
  &from=aliexpress&aeOrderFrom=main_detail
```

So the extension does not need to click SKU options on the product page at
all: it can open the confirm page directly for the SKU, quantity, destination
country and carrier a purchase order already records. The SKU-selection notes
above remain the fallback.

Page structure (class names on this page are stable BEM with a `pl-` prefix,
unlike the hashed product page):

| Part | Selector |
|---|---|
| Address block | `.pl-address-item-container` (title `.pl-address-item__title`) |
| "Add new address" | inside `.pl-address-item__new-btn-wrap` |
| Item block | `.pl-block-container` |
| Quantity stepper | `.comet-input-number` |
| Summary rows | `.pl-summary-container`, `.pl-summary__item-pc` |
| Total row | `.pl-order-toal-container__item` (sic: "toal") |
| Place order | `button.place-order-primary-btn` inside `.pl-order-toal-container__btn-box` |

The page has no order-note or "message to seller" field; the address form's
"Delivery instructions" is the only free-text field that travels with an order.
Its init data is exposed as the function `window.__INIT_DATA_CALLBACK__`, not
as a readable object.

**The extension never clicks Pay now / Place order** (`button.place-order-primary-btn`,
anything inside `.pl-order-toal-container__btn-box`): on the owner's account it
charges a saved card at once. It also never touches payment methods (any
ancestor class matching pay/payment/wallet/billing), coupons, the quantity
stepper, the address list's edit and delete icons, radios, or the "Set as
default" switch. **Save/Confirm on the add-new-address form is clicked only
through the verified path** (`saveAddressForm` in `extension/checkout.js`,
judged by `DropshipHubCheckout.saveButtonRefusal`): the form must be the
add-new-address form (every text box empty or holding a value the extension
typed), every typed box must read back exactly the intended value, State and
City must show the intended values (or City "Other" with the merchant told),
the country must show the United States and the default switch/box must be
off. Otherwise nothing is saved: the boxes are highlighted and the merchant is
asked to check and press Save themselves. Saving the customer's address into
the merchant's AliExpress address book is what placing the order means.

## Checkout: the address form (US)

The account measured had no saved address, so the block showed only "Add new
address". That opens a modal whose form is `form.deliver-address-form`, built
from Alibaba Fusion (`next-*`) components. No input has a `name` or `id`;
placeholders are localized, so locate fields by their position in the form
first and by placeholder only as a check.

Default view: Country/region select, First name*, Last name*, a phone country
code box (`+1`) and Mobile number*, an address search autocomplete, and an
"Enter manually" link. After "Enter manually":

| Order | Field | Kind | Notes |
|---|---|---|---|
| select 0 | Country/region | `next-select` (searchable) | changing it re-renders the rest for that country |
| text | First name* | input | |
| text | Last name* | input | the payload must carry first and last name separately |
| text | phone country code | input, prefilled `+1` | |
| text | Mobile number* | input | national number, without the country code |
| select 1 | Search by address | `next-select-auto-complete` | skip when entering manually |
| text | Street* | input | **5 to 35 characters, including the house number** |
| text | Apt, suite, unit, etc (optional) | input | where the rest of a long street line goes |
| select 2 | State | `next-select` (searchable), 51 options | options are full names (`li[role=option][title="California"]`), defaults to Alabama |
| select 3 | City | `next-select` (searchable) | options depend on the state (787 for Alabama); the last option is always **"Other"** |
| text | ZIP | input | placeholder "E.g., 20001 or 20001-0000" |
| text | Delivery instructions | input | optional |
| checkbox | Set as default shipping address | | leave unticked |
| buttons | Confirm / Cancel | | Escape closes the whole modal without saving |

Every `next-select` has `next-has-search`: its input is not read-only, so a
value is chosen by opening the select, typing to filter, and clicking the
`li[role=option]` whose `title` matches. The menu is a `ul.next-select-menu`
rendered outside the form. Text inputs are React-controlled: set them with the
native value setter and dispatch `input` and `change`.

## Checkout on `www.aliexpress.us` in English: the "comet" design (measured 2026-09-15)

The owner's account is US-routed. Opened from that account in English, the
confirm page and its address forms are **not** the Fusion (`next-*`) design
documented above: the page-level selectors (`pl-*`) are the same, but the
address drawer, its form and its drop-downs are a different component set
("comet"/"mt-form"). The extension has to detect which one is on the page.

Facts that apply to both designs:

- Opening `/p/trade/confirm.html?objectId=…` directly in a fresh tab fails
  with "Query product info failed, query param orderLine DTO is empty". It
  works once the product page (`/item/<id>.html`) has loaded in that tab
  first, which is the order the extension already uses.
- The page's currency follows the account's site setting: this account
  showed **USD** (`Total$93.62`), while the price the extension captured from
  the Vietnamese product page was in VND. The same SKU was $85.89 here against
  1,724,188 VND (about $66) in the capture, so a VND estimate cannot be
  compared with this page, and the captured price is not the price paid.
- With a card saved on the account, `button.place-order-primary-btn` reads
  **"Pay now" and charges the card at once**. There is no separate
  "place, then pay" step. It sits in `.pl-order-toal-container__btn-box`.
- Payment method block: `.placeorder-page-payment-container`, whose "Change"
  is `button.comet-btn-link.chosen-channel--chosen-channel-change-btn`. Every
  class on that path contains `payment`, so the click guard refuses it.
- Summary rows `.pl-summary__item-pc`: Subtotal, Promo codes, Shipping fee,
  Additional charges (tax); total row `.pl-order-toal-container__item`.

### Address block with a saved address

`.pl-address-item-container` shows the selected saved address (name, phone,
street, city) and a **"Change"** link: `span.pl-address-item__arrrow > a`
(sic "arrrow"; the `<a>` has no href and no classes). With no saved address
the block shows only `.pl-address-item__new-btn-wrap` "Add new address"
instead (measured earlier). The extension must handle both.

"Change" opens a right-hand drawer `.comet-drawer.comet-drawer-right.pl-address-model-cls`
(`.comet-drawer-content > .comet-drawer-header.pl-modal-header-cls + .comet-drawer-body`)
titled "Shipping address": `.cm-address-list` of `.ae-address-item-wrapper`
items, each with a `label.comet-radio` (+ `comet-radio-checked`,
`input.comet-radio-input[type=radio]`), a "Default" tag, an edit pencil
`.ae-address-item-edit-btn` and a delete `.ae-address-item-delete-btn`, and
at the bottom **`button.add-address`** (`comet-btn comet-btn-primary`,
`type="button"`, text "Add new address").

### The add-address drawer form

The same drawer switches to "Add new address" (header
`.comet-drawer-title`, a back arrow `.c-left-btn > .comet-icon-arrowleft`
that returns to the list; **Escape does not close it**). There is **no
`<form>` element**: the form is `div.mt-form.deliver-address-form` inside
`.deliver-address-wrap`, so `form.deliver-address-form` matches nothing.
Every field is `input.one-textinput[type=text]` inside a `.mt-form-item`
whose wrapper class says what it is: `.default-input-wrap` (text),
`.default-select-wrap` (a select rendered as an input plus an `.icon-arrow`),
`.search-input-wrap` (the address search, `input.autocomplete-input[role=combobox]`).
Inputs carry no `name`, `id` or `placeholder`; the label is floating text
inside the item ("First name*"). Locate fields by their index among the
form's inputs:

| Index | Field | Kind | Notes |
|---|---|---|---|
| 0 | Country/region | select | shows "United States" |
| 1 | First name* | text | |
| 2 | Last name* | text | |
| 3 | Country code | text, prefilled `+1` | |
| 4 | Mobile number* | text | national number |
| 5 | Search by address | combobox | leave alone |
| — | "Enter manually" | `div.text-button-container` (not a button) | reveals 6–11 |
| 6 | Street* | text | help text "Please enter an address with 5-35 characters including building number" |
| 7 | Apt, suite, unit, etc (optional） | text | full-width `）` in the label |
| 8 | State/Province* | select (cascade modal) | |
| 9 | City* | select (cascade modal) | |
| 10 | ZIP | text | label "E.g., 20001 or 20001-0000" |
| 11 | Delivery Instructions | text | optional |

Before "Enter manually" only inputs 0–5 exist. Below the fields: **"Set as
default"** is a switch `div.mt-switch.switcher` (on = `mt-switch--checked`
and knob `mt-switch-knob--large-checked`; off = neither; no `<input>`), and
**`button.form-button-confirm`** (`type="button"`, text **"Save"**) saves the
address to the account and selects it.

Text inputs are React-controlled and accept the native value setter followed
by `input` and `change` events; the value survives blur and shows
`form-item-state-success` on the item.

### State and City: one cascade modal

Clicking the State (or City) input opens a bottom sheet
`.mt-drawer-modal.mt-modal.mt-modal--bottom` titled "Select address"
(`.drawer-cascade-header` with `span.mt-icon-close`; steps in
`.drawer-cascade-steps` / `.mt-step-item`). It has a search box
("Search by ZIP code, street, or address") that runs an address search and
hides the list while it has text: **do not type in it.** The list is
`.drawer-list-wrap > .drawer-cascade-list > div.group-item > span.item-label`;
at the state level it holds 71 items (letter headers plus the states,
"Alabama" first, "Wyoming" last). A `mousedown`, `mouseup` and `click()` on a
state's `div.group-item` moves the same modal to "Select city" (Texas: 2,369
cities, alphabetical, **"Other" last**, "Austin" present); the same on a city
closes the modal and fills **both** the State and City inputs. The State
input stays empty until the city is chosen.

### The orders list and order detail

`/p/order/index.html` (tabs View all / To pay / Processing / Processed /
Completed; `window.__INIT_DATA_CALLBACK__` present) lists `.order-item`
cards. Each carries the status ("Awaiting delivery"), "Date: …",
"Ref. Number: <order id>", a "Details" link
`a[href*="/p/order/detail.html?orderId="]`, product links
`a[href*="/item/<id>.html"]` (regional ids; subtract 2^51 for the global id
when above it), the SKU text ("Mix 10pcs"), "Total:$12.50" and the buttons
"Confirm received" / "Track status" (or "Pay now" under To pay). This page is
the source for automatic order-number and status sync.

The "Details" link opens `www.aliexpress.com/p/order/detail.html?orderId=<id>`
(the .com host even from .us). It shows `.order-status` ("Awaiting
delivery"), `.service-progress-node-info` nodes ("Paid", "Refund" deadline),
the customer's address in `.order-detail-info`, and an
`.order-detail-order-info` block of `.info-row`s: "Ref. Number: <id> Copy",
"Order placed on:", "Paid on:", "Shipment completed on:", "Payment method:".
Its logistics line ("Awaiting flight") links to
`/p/tracking/index.html?tradeOrderId=<id>`, whose classes are hashed
(`logistic-info-v2--<name>--<hash>`), so match on the name part:
`[class*="logistic-info-v2--carrierTitle"]` is the carrier ("AliExpress
Selection Standard Fast for Special Goods"),
`[class*="logistic-info-v2--mailNoValue"]` the tracking number (measured:
`SWX` plus 18 digits), `[class*="logistic-info-v2--nodeTitle"]` /
`--nodeDesc` / `--nodeTime` the events ("In transit" / "Awaiting flight").
The page also prints the customer's street and a masked name, so a sync
script must read only the carrier, the number and the order id.

## Not yet measured

- The page shown after Pay now, and whether its URL carries the new order
  id(s). The existing payment link helper assumes
  `www.aliexpress.com/p/order/detail.html?orderId=<id>`. Measuring it means
  placing a real order. The extension therefore observes the merchant's click
  on Pay now (capture-phase listener, never prevented or made) and records the
  order number from the orders list instead.
- The orders list card's own status and SKU elements. The sync script reads
  the card's `[class*="status"]` and `[class*="sku"]` elements when present
  and otherwise takes the status phrase ("Awaiting delivery", "To pay", …),
  "Total:" and "Date:" from the card's text, which was measured.
- The value the comet form's Country/region select-as-input reports. The
  documentation above says it shows "United States"; the fill reads
  `inputs[0].value` and stops, asking the merchant to choose the country, when
  it does not read as the United States.
- Address forms for countries other than the US (Vietnam, for instance, uses
  province / district / ward).
