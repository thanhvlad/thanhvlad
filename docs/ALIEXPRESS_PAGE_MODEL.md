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

**The extension must never click Place order, and never click Confirm on the
address form on the merchant's behalf.** Both commit the merchant's account.

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

## Not yet measured

- The page shown after Place order, and whether its URL carries the new order
  id(s). The existing payment link helper assumes
  `www.aliexpress.com/p/order/detail.html?orderId=<id>`. Measuring it means
  placing a real order.
- Address forms for countries other than the US (Vietnam, for instance, uses
  province / district / ward).
- The order list and order detail pages where tracking numbers appear.
