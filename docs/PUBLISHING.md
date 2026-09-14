# Publishing to the Shopify App Store

Everything the app needs to pass review is in the code; this is the sequence of
things to do outside it, in the order that avoids waiting. Budget a working day
for the setup and one to two weeks for Shopify's review.

*Tiếng Việt: xem [tóm tắt ở cuối](#tóm-tắt-tiếng-việt).*

---

## 0. Launch gate (audited 2026-09-14)

An App Store readiness audit on 2026-09-14 checked this app against Shopify's
requirements, quoted from shopify.dev, and against production as it actually
ran. Several boxes further down had been ticked on the strength of the code
existing rather than of it being live. Until each item here is done, do not
submit:

**The Chrome extension cannot be the only way the app works.** App Store
requirement 1.1.11: *"Browser extensions are only permitted as an optional
feature."* The extension-first ordering and import flow is the right way to run
the owner's own stores now, but a publicly listed app must import products and
place supplier orders from inside the Shopify admin with no extension installed.
For AliExpress that means the official Dropshipping API
(`app/services/suppliers/aliexpress.server.ts`, kept intact for exactly this):
apply for AliExpress Open Platform Dropshipping access early, because approval
takes days to weeks, then set `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`,
`ALIEXPRESS_REDIRECT_URI` and `SUPPLIER_DRIVER=live`. Requirement 1.1.13 also
rules out listing copy like "import from any store", with or without an
extension.

Owner actions, none of which code can do:

1. `shopify app config link` against the production app, keeping this repo's
   `[access_scopes]`, `[webhooks]` (including `compliance_topics`), `[auth]` and
   `application_url`; then `shopify app deploy`. Until then `client_id` is empty
   here and the scopes, webhook subscriptions and compliance topics Shopify uses
   are whatever the Partner Dashboard last had.
2. Set distribution to Public, then request **Protected customer data** with
   Name, Email, Phone and Address, justified by fulfilling orders through the
   supplier. Without approval, a merchant's orders come back with no address.
3. AliExpress Dropshipping API approval (above), and a dedicated AliExpress
   buyer account for reviewers with no SMS or 2FA step.
4. A monitored support mailbox on the owner's domain, set as `SUPPORT_EMAIL` in
   production and in the listing; an emergency developer contact in the Partner
   Dashboard.
5. One brand-led app name. `shopify.app.toml` says "WS Fullfill App" (and
   misspells fulfil) while every page says DropshipHub.
6. In the submission form choose **Manual pricing with the Billing API**: the
   code implements the Billing API, and Shopify App Pricing is the default for
   new public apps. Do not list paid plans for features production cannot yet
   deliver.
7. If the extension stays in the listing as the optional shortcut, publish it on
   the Chrome Web Store first; reviewers cannot load an unpacked extension.
8. Review the legal wording of `/privacy` once the code-side corrections land.
9. Record the demo screencast only after live ordering works end to end.

## 1. Host it

Deploy once, before touching the Partner Dashboard, because every other step
needs the public URL.

- Follow [`DEPLOYMENT.md`](DEPLOYMENT.md): Postgres, Redis, a `web` process and a
  `worker` process from the same image (`fly.toml` and `render.yaml` are ready).
- The app **refuses to boot in production** without `SHOPIFY_API_KEY`,
  `SHOPIFY_API_SECRET`, an `https` `SHOPIFY_APP_URL`, `DATABASE_URL`,
  `ENCRYPTION_KEY`, and supplier keys when `SUPPLIER_DRIVER=live`. The error names
  what is missing.
- Confirm `https://<app>/healthz` answers `{"ok":true,...}` and that the three
  public pages render: `/privacy`, `/terms`, `/support`. Set `SUPPORT_EMAIL` so
  they show a real address.
- Set `EMAIL_FROM` and either `RESEND_API_KEY` or `SMTP_URL` if you want the
  notification emails; the app works without them.

## 2. Configure the app in the Partner Dashboard

```bash
shopify app config link      # binds shopify.app.toml to the app
shopify app deploy           # pushes URLs, scopes, webhooks (including compliance topics)
```

Check in the dashboard afterwards:

| Setting | Value |
| --- | --- |
| App URL | `https://<app>` |
| Allowed redirection URLs | `https://<app>/auth/callback`, `https://<app>/auth/shopify/callback`, `https://<app>/api/auth/callback` |
| Embedded | Yes |
| Webhooks API version | `2026-07` |
| Compliance webhooks | `https://<app>/webhooks/compliance` for all three topics (set by `deploy`) |
| Privacy policy URL | `https://<app>/privacy` |

### Access scopes and why the app asks for them

Reviewers check that every scope is used. These are, and this is where:

| Scope | Used for |
| --- | --- |
| `read_products`, `write_products` | Import list → Shopify (`productSet`), price/stock auto-updates, linking existing products |
| `read_publications`, `write_publications` | "Publish on push" (`publishablePublish`) |
| `read_orders`, `write_orders` | Order ingest (webhooks + sync), order tags, address write-back |
| `read_fulfillments`, `write_fulfillments` | Creating fulfilments with tracking numbers, updating tracking |
| `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`, `read_assigned_fulfillment_orders`, `write_assigned_fulfillment_orders` | The **Request fulfillment** button: the app is a fulfilment service and accepts/rejects fulfilment requests |
| `read_inventory`, `write_inventory` | Stocking products at the app's location, mirroring supplier stock |
| `read_locations` | Choosing the location for inventory and the fulfilment service |
| `read_customers` | The customer's email and phone on an order, which suppliers require for delivery |

Orders older than 60 days need `read_all_orders`, which Shopify grants on
request; the app does not need it (it syncs 30 days on install).

### Protected customer data

The app reads names, addresses, phones and emails on orders, so it must be
approved for **protected customer data** (App setup → Protected customer data
access) before it works on stores that are not development stores. Until
approval, those fields come back `null` and the app cannot place supplier
orders. Request:

- **Level 1 (customer data)** and the **Level 2 fields**: name, address, phone,
  email.
- Reason: *fulfilling orders through a third-party supplier requires the
  recipient's delivery details.*
- Data protection answers, all true of this code: data is encrypted in transit
  (TLS) and supplier tokens at rest (AES-256-GCM); personal data is kept only
  while the app is installed and erased on `shop/redact` and after 30 days of
  uninstall regardless; `customers/redact` erases the personal fields on the named
  orders; `customers/data_request` produces an export the merchant can pass on;
  staff access is limited by Shopify's own login; no data is sold or used for
  advertising.

## 3. Billing

Plans live in `app/domain/billing/plans.ts` and the Billing API config is derived
from them, so the price on the approval page cannot differ from the caps. Test on
a development store (charges are always test-mode there) by upgrading under
**Settings → Plan** and approving the test charge; the `app_subscriptions/update`
webhook and the plan page's reconciliation both bring the plan back.

The App Store listing's pricing section must repeat the same plans and prices;
reviewers compare them. Shopify's revenue share applies to every charge.

## 3b. Prove the pipeline on your own deployment

```bash
SUPPLIER_DRIVER=mock npm run demo
```

Runs the full merchant flow against your database and prints every step. Use it after a
deploy, before a submission, and any time you want to know whether a change broke the
pipeline without installing on a store.

## 4. Prove the compliance webhooks

```bash
shopify app webhook trigger --topic customers/data_request --address https://<app>/webhooks/compliance --api-version 2026-07
shopify app webhook trigger --topic customers/redact       --address https://<app>/webhooks/compliance --api-version 2026-07
shopify app webhook trigger --topic shop/redact            --address https://<app>/webhooks/compliance --api-version 2026-07
```

Each must answer `200`. A data request shows up in the app under Notifications
with a download link; a redact erases the fields; a shop redact removes the
store. The automated review also checks that an unsigned webhook is rejected
(`401`), which the framework does.

## 5. The listing

Prepare these before opening the listing form:

- **Name**: DropshipHub. **Tagline** (≤ 62 chars): *AliExpress dropshipping:
  import, order, track — automatically.*
- **Description**: adapt the feature overview in the README; lead with the
  merchant's problem (fulfilling AliExpress orders by hand), then the four
  jobs the app does: find & import, place supplier orders in bulk, sync tracking,
  keep prices and stock in step. Mention the native Request fulfillment button,
  multi-store accounts and the Vietnamese UI.
- **Key features** (three): one-click import with pricing rules; bulk supplier
  orders with automatic shipping selection and tracking sync; supplier comparison
  with AI variant mapping.
- **Screenshots** (1600×900): Find products with the Add to shop button; Import
  list editor; Orders pipeline; the Payments page; Settings → Plan.
- **Icon**: 1200×1200, no text.
- **Categories**: Orders and shipping → Dropshipping; Finding products → Dropshipping.
- **Support**: `SUPPORT_EMAIL`, `https://<app>/support`; privacy policy
  `https://<app>/privacy`.
- **Languages**: English, Vietnamese.

### Instructions for the reviewer

Paste into the "testing instructions" field:

> 1. Install on the test store. The dashboard shows a six-step checklist.
> 2. Suppliers → connect the **Demo supplier** (no credentials; it is a built-in
>    catalogue that behaves like AliExpress: orders move from paid to shipped to
>    delivered over a few minutes and tracking numbers appear).
> 3. Find products → search "watch" → **Add to shop**. The product appears in the
>    Shopify admin within seconds, priced by the default pricing rule.
> 4. Create a test order for that product in the Shopify admin and mark it paid.
>    Orders → the order is in *Awaiting order* → **Place**. It moves to *Awaiting
>    payment*, then *Awaiting shipment*, and a tracking number is added to the
>    Shopify order as a fulfilment within about three minutes.
> 5. Settings → Plan → Upgrade to Advanced approves a **test** charge and returns
>    to the app on the Advanced plan; Downgrade to Basic cancels it.
> 6. Settings → Fulfilment service → Register, then on a Shopify order use
>    **Request fulfillment**: the request is accepted and the supplier order placed.

The Demo supplier is the `MOCK` platform and is always available, whatever
`SUPPLIER_DRIVER` is set to, precisely so that reviewers and new merchants can
try the full flow without an AliExpress account.

## 6. Submission checklist

Everything on Shopify's requirements list, and where this app meets it:

- [x] Embedded, App Bridge, session-token auth (`@shopify/shopify-app-remix`), latest stable API version.
- [ ] OAuth via managed installation; scopes declared in `shopify.app.toml` **and deployed** (`shopify app config link` + `shopify app deploy` - not done as of 2026-09-14).
- [ ] Mandatory compliance webhooks implemented and answering `200` with HMAC verification (the handler exists; the subscriptions only exist once the config is deployed).
- [x] `app/uninstalled` handled; store data erased on `shop/redact` and after 30 days.
- [x] Billing through the Billing API only; no external payment collection.
- [x] Free plan available; trial on paid plans; plan changes and cancellation from inside the app.
- [x] Privacy policy, terms and support pages reachable without login.
- [ ] Protected customer data requested with the reasons above (Partner Dashboard; not confirmed as of 2026-09-14).
- [x] Polaris UI, works at 1280 px and on mobile admin; no page depends on third-party cookies.
- [ ] Health endpoint for the host; structured logs; worker and web separated (production runs the inline queue inside the web process with no Redis).
- [x] Reinstall works (the install hook reactivates the store and skips the order backfill when history exists).
- [ ] Listing copy, screenshots and icon uploaded.
- [ ] Protected customer data approved (submit the app for review only after this, or the reviewer's test orders will have no addresses).
- [ ] A test store with **AliExpress connected through the API** and one placed order, so the reviewer sees the real pipeline. The Demo supplier is not acceptable here: the listing describes AliExpress, and reviewers test what the listing claims.
- [ ] The app imports and orders with no browser extension installed (requirement 1.1.11).

## 7. After approval

- Watch `/healthz` from the host's monitoring and alert on 503.
- Keep `shopify app deploy` in the release process: it is what updates webhook
  subscriptions and scopes when `shopify.app.toml` changes.
- Upgrades: `git pull && npm ci && npx prisma migrate deploy && npm run build`, restart web and worker.

---

## Tóm tắt tiếng Việt

1. **Triển khai trước** (Postgres, Redis, web + worker theo `DEPLOYMENT.md`). App
   từ chối khởi động ở production nếu thiếu khoá Shopify, URL https, database,
   `ENCRYPTION_KEY` hoặc khoá nhà cung cấp; kiểm tra `/healthz`, `/privacy`,
   `/terms`, `/support`.
2. **Cấu hình trên Partner Dashboard** bằng `shopify app config link` rồi
   `shopify app deploy`; kiểm tra App URL, redirect URL, webhook tuân thủ và URL
   chính sách quyền riêng tư.
3. **Xin quyền Protected customer data** (tên, địa chỉ, điện thoại, email) với lý
   do "giao hàng qua nhà cung cấp bên thứ ba". Chưa được duyệt thì cửa hàng thật
   sẽ không có địa chỉ và app không đặt được đơn.
4. **Thanh toán**: gói nằm trong `app/domain/billing/plans.ts`; thử trên dev store
   ở Cài đặt → Gói dịch vụ. Phần giá trên listing phải khớp.
5. **Kiểm tra webhook tuân thủ** bằng `shopify app webhook trigger` cho 3 topic.
6. **Listing**: tên, mô tả, 3 tính năng chính, ảnh 1600×900, icon 1200×1200,
   email hỗ trợ, ngôn ngữ Anh + Việt; dán hướng dẫn cho người duyệt ở mục 5
   (dùng nhà cung cấp Demo, không cần tài khoản AliExpress).
7. **Sau khi duyệt**: theo dõi `/healthz`, giữ `shopify app deploy` trong quy
   trình phát hành.
