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

## Not yet measured

The checkout (`Buy now` → confirm order) page, its address form and the order
result page that carries the new AliExpress order id. Measuring them needs a
logged-in AliExpress account, and nothing on those pages may be submitted or
filled with real customer data while measuring.
