# Going live with AliExpress

You already have an AliExpress account. This is what the app needs from it, in
order, and what each piece is actually used for.

*Tiếng Việt: xem [phần cuối](#hướng-dẫn-tiếng-việt).*

---

## 1. Create an app on the AliExpress Open Platform

1. Sign in at <https://openservice.aliexpress.com> with your AliExpress account.
2. Create an application and request the **Dropshipping (DS)** solution. Ask for these
   API groups: `aliexpress.ds.*`, `aliexpress.trade.ds.*`, `aliexpress.logistics.*`.
   Approval is manual and usually takes a few days.
3. Copy the **App Key** and **App Secret**.
4. Set the callback / redirect URL to exactly:

   ```
   https://<your-app-domain>/app/suppliers/callback/aliexpress
   ```

5. Optional but recommended: create an **affiliate tracking id** in the AliExpress
   Portals/affiliate console. Without one, keyword search falls back to the DS
   recommendation feed (see [Search](#search) below).

## 2. Configure the app

```bash
SUPPLIER_DRIVER=live
ALIEXPRESS_APP_KEY=your-app-key
ALIEXPRESS_APP_SECRET=your-app-secret
ALIEXPRESS_REDIRECT_URI=https://<your-app-domain>/app/suppliers/callback/aliexpress
ALIEXPRESS_API_BASE=https://api-sg.aliexpress.com/sync
ALIEXPRESS_AUTH_BASE=https://api-sg.aliexpress.com/oauth
ALIEXPRESS_TRACKING_ID=your-tracking-id     # optional
ENCRYPTION_KEY=$(openssl rand -base64 32)   # encrypts the token at rest
```

Restart the app and the worker.

## 3. Connect your account

**Suppliers → AliExpress → Connect with AliExpress.** The consent screen opens at the
top level (not inside the Shopify iframe), you approve, and AliExpress returns to the
callback URL. The app then:

- exchanges the code for an access token and refresh token, encrypted before storage;
- calls `aliexpress.ds.add.info` to register your Shopify store with the dropshipping
  programme, which AliExpress requires before its order APIs work. If that call fails
  it is recorded in Activity and the account still connects — check it before ordering.

Press **Test** on the account to confirm the token works. If AliExpress later rejects
the token, the account shows **Reconnect needed**, you get a notification, and orders
stop rather than failing one by one.

---

## What the app calls, and why

| Purpose | Method |
| --- | --- |
| Product detail, variants, stock | `aliexpress.ds.product.get` |
| Keyword search | `aliexpress.affiliate.product.query` (needs a tracking id) |
| Browse without a keyword | `aliexpress.ds.recommend.feed.get` |
| Search by image | `aliexpress.ds.image.search` |
| Shipping quotes | `aliexpress.ds.freight.query` |
| Place an order | `aliexpress.ds.order.create` |
| Order status and costs | `aliexpress.trade.ds.order.get` |
| Tracking numbers and events | `aliexpress.ds.order.tracking.get` |
| Register the store | `aliexpress.ds.add.info` |

Requests are signed HMAC-SHA256 over the parameters sorted by key and concatenated as
`key + value`, uppercased. The REST endpoints used for tokens prefix the API path to
that string; the `/sync` gateway does not.

AliExpress has renamed most of these parameters at least once, and a wrong name is
invisible: the gateway answers HTTP 200 with an empty result rather than an error, so
the app would show "no shipping options" or "no tracking" instead of a problem. The
spellings that matter, all pinned by `tests/services/aliexpress-parsing.test.ts`:

- **Freight** takes one parameter, `queryDeliveryReq`, holding a JSON string whose
  keys are camelCase (`productId`, `selectedSkuId`, `shipToCountry`, and `quantity`
  as a *string*). It has no ship-from input — each option reports its own
  `ship_from_country`. Options come back at `result.delivery_options.delivery_option_d_t_o`.
  The cost field, `shipping_fee_cent`, is misnamed: it is a decimal string in major
  units (`"13.57"`, alongside a `shipping_fee_format` of `"13,57€"`), and it is absent
  altogether on a free option. The legacy `aliexpress.logistics.buyer.freight.calculate`
  shape is still parsed as a fallback, where `freight.cent` really is cents.
- **Order detail** takes `single_order_query`, a JSON object `{"order_id": <number>}`,
  not a flat `order_id`, and wraps its lists under `aeop_child_order_info` and
  `aeop_order_logistics_info`. A single child order or shipment arrives as a bare
  object rather than a one-element array.
- **Tracking** takes `ae_order_id` and a required `language`; both names changed in a
  2026 revision and the older spellings simply stop returning data. A not-yet-shipped
  order answers `ret: false` / `code: "1001"` — a state, not an error — so the app
  keeps the tracking number it already has from the order detail.

### The `sku_attr` trap

Order creation takes **`sku_attr`** — the attribute string, e.g.
`14:350853#Black;5:361386` — not the numeric `sku_id`. Freight quotes take the
numeric `sku_id`. The app stores both on every supplier variant and sends the right
one to each call. When a product response omits `sku_attr`, the app rebuilds it from
the SKU's `propertyId:valueId` pairs — joining the readable values ("Red;XL") would
produce a string AliExpress rejects with `SKU_NOT_EXIST`. If a product was imported before this was fixed, re-import it (open
the product, paste the supplier link again) so the attribute string is captured;
otherwise placing the order fails with a clear message telling you to do exactly that.

### Search

Keyword search lives on the affiliate surface, not the DS surface. With
`ALIEXPRESS_TRACKING_ID` set you get real keyword search. Without it the app browses
the DS recommendation feed and filters locally, and says so in a banner — usable, but
narrow. Importing by URL or ID always works either way, as does image search.

### Addresses

Address fields are transliterated to ASCII and postal codes stripped of spaces before
submission, because AliExpress validates against a Latin character set and rejects a
spaced code. The customs identifier goes in exactly one country-specific slot — `cpf`
for Brazil, `rut_no` for Chile, `foreigner_passport_no` (with `is_foreigner`) for
Korea, `vat_no` for Italy, Spain and Türkiye — alongside the generic `tax_number`.

### Payment

AliExpress does not let an app charge your account, so the app never tries. It places
the order unpaid (`try_to_pay: "false"`) and gives you a deep link to pay it:

- **Payments** page: every unpaid supplier order with its total, a 24-hour countdown,
  a **Pay** button that opens that exact order on AliExpress, and **Open unpaid list**
  for paying several in one visit.
- After paying, **Check payment status** reads the status back; the scheduled job does
  the same every 20 minutes, so orders usually move on their own.
- **Unpaid AliExpress orders are cancelled after 24 hours.** The app warns you six
  hours out and marks anything past the deadline.

### Order errors you may see

The app translates AliExpress's error codes into advice, for example:

| Code | What it means |
| --- | --- |
| `B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL` | The address was rejected. Check province, postal code, phone and any customs id. |
| `INVENTORY_HOLD_ERROR` | The SKU sold out while the order was being placed. |
| `DELIVERY_METHOD_NOT_EXIST` | Your preferred carrier is not offered for that destination. |
| `REPEATED_ORDER_ERROR` | AliExpress saw it as a duplicate — check your AliExpress order list before retrying. |
| `A006_INVALID_ACCOUNT_INFO` | Your AliExpress profile is incomplete. |

---

### Ordering the same goods twice

Two things stop it, and both matter:

- Each purchase order carries a stable reference derived from the Shopify order, the
  platform and the exact lines it covers. It is sent as `out_order_id` and it does not
  change when you retry, so AliExpress can recognise the retry as the same order.
- The transport never retries order creation. A read that times out says nothing about
  whether AliExpress committed the order, so the app records the purchase order as
  **unconfirmed** rather than failed, tells you to check your AliExpress order list, and
  refuses to retry a purchase order that already has an AliExpress order id.

Placing an order is also serialised per Shopify order, so the scheduled auto-place and
your own "Order now" click cannot both decide the order is unplaced.

---

## Verification status

The adapter was written against the published DS API surface and the official SDK type
definitions, not against a live merchant account: this environment has no network
access to AliExpress. Method names, parameter names, signing and response shapes come
from those sources. Field mappings for less common responses may still need a small
adjustment once you connect a real account — the Activity log records the exact request
and error for anything that does not match, which is enough to fix it.

What *is* verified here:

- **The request signature** is pinned by a test against fixed expected values, for both
  gateways, including the code-point key ordering AliExpress uses. Every live call fails
  if this is wrong by one character, and the failure reads like a permissions problem.
- **Every Shopify GraphQL document** in the app is validated against Shopify's real
  Admin schema for the API version the app pins.
- **Everything downstream of the adapter** — import, mapping, pricing, the order
  pipeline, fulfilment, tracking sync, reports — is covered by an integration suite that
  runs against a real PostgreSQL database, including concurrent order placement and
  split-parcel tracking.

---

## Hướng dẫn tiếng Việt

**1. Tạo app trên AliExpress Open Platform**

Đăng nhập <https://openservice.aliexpress.com>, tạo application và xin giải pháp
**Dropshipping (DS)**. Lấy App Key + App Secret. Đặt redirect URL đúng bằng
`https://<tên-miền-app>/app/suppliers/callback/aliexpress`. Nên tạo thêm
**tracking id** affiliate để dùng được tìm kiếm theo từ khoá.

**2. Cấu hình**

Đặt `SUPPLIER_DRIVER=live`, `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`,
`ALIEXPRESS_REDIRECT_URI`, `ALIEXPRESS_TRACKING_ID` (tuỳ chọn) và `ENCRYPTION_KEY`.

**3. Kết nối**

Vào **Suppliers → AliExpress → Connect**. App sẽ đổi mã lấy token (mã hoá khi lưu) và
tự gọi `ds.add.info` để đăng ký cửa hàng với chương trình dropshipping. Bấm **Test**
để kiểm tra. Khi token hết hạn, tài khoản hiện **Reconnect needed** và app dừng đặt
hàng thay vì lỗi từng đơn.

**4. Thanh toán**

AliExpress không cho app trừ tiền tài khoản của bạn. App tạo đơn ở trạng thái chưa
thanh toán rồi đưa link trực tiếp: trang **Payments** liệt kê mọi đơn chưa trả, tổng
tiền, đồng hồ đếm ngược 24 giờ, nút **Pay** mở đúng đơn đó trên AliExpress, và **Open
unpaid list** để trả nhiều đơn một lần. Trả xong bấm **Check payment status**, hoặc
để job tự chạy mỗi 20 phút. **Đơn chưa thanh toán bị AliExpress huỷ sau 24 giờ** —
app cảnh báo trước 6 giờ.

**5. Lưu ý quan trọng**

Tạo đơn phải gửi `sku_attr` (chuỗi thuộc tính) chứ không phải `sku_id` (số). App đã
lưu cả hai và gửi đúng loại cho từng API. Sản phẩm nhập từ trước bản sửa này cần nhập
lại để lấy `sku_attr`; nếu thiếu, app báo lỗi rõ ràng và hướng dẫn làm đúng việc đó.
