# DropshipHub — DSers-style dropshipping automation for Shopify

A full-featured Shopify app that does what DSers does: find and import products from
AliExpress (and CJ Dropshipping), edit them before they hit your store, map every
variant to supplier SKUs (Basic / Advanced / BOGO / Bundle), place supplier orders in
bulk with automatic shipping selection, sync tracking numbers back to Shopify as
fulfilments, keep prices and stock in step with the supplier, and report on revenue,
cost and profit — across several stores under one account.

*Tiếng Việt: xem phần [Hướng dẫn nhanh (VI)](#hướng-dẫn-nhanh-vi) ở cuối.*

---

## Feature overview

| Area | What you get |
| --- | --- |
| **Find products** | Keyword + image search across supplier catalogs (AliExpress DS API, CJ), sort by orders/rating/price, shipping cost per result, **Add to shop** in one click (import + price + push), paste URLs or IDs, bulk link import, CSV import, browser-extension capture. |
| **Import list** | Staging area: edit title, description (HTML with preview), vendor/type/tags/handle/collections, images (reorder/remove/add), variants (price, compare-at, SKU, inventory, enable/disable), exclude option values, split by option, apply pricing rules, bulk push to Shopify. |
| **My products** | Managed products mirrored from Shopify, link existing Shopify products for mapping, reprice from supplier cost, auto-update toggles, refresh/unlink/delete, resource-picker linking. |
| **Mapping** | Basic (1:1), Advanced (ranked suppliers per destination country with in-stock fall-through), BOGO (quantity tiers), Bundle (multi-SKU components). Auto-map by option values, with an AI pass for the variants the deterministic matcher cannot place. Live "test the mapping" resolver. Supplier cost history. |
| **Supplier comparison** | Side-by-side landed cost, shipping, delivery days, rating, order count and variant coverage for every supplier of a product, scored and ranked, with one-click switch and the saving it earns. |
| **Orders** | Webhook ingest + backfill sync, pipeline stages (Pending → Awaiting order → Awaiting payment → Awaiting shipment → Awaiting delivery → Fulfilled / Canceled / Failed), address validation with country rules (phone, ZIP, province, CPF/RUT/PCCC/TC Kimlik…), auto-fix over-long addresses, per-line mapping resolution with clear failure reasons, bulk place, force place, ignore lines, address editor that can write back to Shopify, CSV export. |
| **Fulfilment** | One purchase order per supplier, shipping method chosen from your carrier preferences with cost/day/tracking guard rails and cheapest/fastest fallback, idempotent placement, retry/cancel/manual link, supplier status polling that never regresses, tracking capture, Shopify fulfilment creation with customer notification, carrier-name override, custom tracking URL, order tagging, auto-cancel upstream on Shopify cancel, auto-place with delay. |
| **Tracking** | All tracking numbers with sync state, failed-sync retry, delivered filter. A supplier order that ships as several parcels puts every number on the one Shopify fulfilment. |
| **Payments** | AliExpress will not let an app charge your account, so the app never tries: it places orders unpaid and gives you the links. Every unpaid order with its total, a running total per currency, a 24-hour countdown before AliExpress cancels it, a **Pay** button per order, bulk open, automatic status polling and a manual "I paid this". |
| **Request fulfillment from Shopify** | Register the app as a Shopify fulfilment service and the native **Request fulfillment** button on a Shopify order routes it here, which places the supplier order. Unmapped lines are rejected back to Shopify with the reason. |
| **Auto updates** | Policy per shop: on price change (update via rule / notify / nothing) with threshold; on stock change (set 0 when out + restock, mirror capped quantity, unpublish, notify); on product removed. Dry-run preview, manual run, schedule interval, run history. |
| **Pricing rules** | Multiply / add / target margin / fixed; compare-at derived from price; cents ending; round-up-to-multiple; min/max clamps; include shipping; cost-range tiers; default rule; live preview table. |
| **Shipping** | Ranked carriers per country (or `*`), max cost, max days, tracking required, fallback cheapest/fastest/none, global cost cap. |
| **Suppliers** | AliExpress OAuth, CJ API-key, mock account; shared across stores on the account; default per platform; connection test; encrypted tokens; automatic refresh. |
| **Reports** | Revenue / cost / profit / margin KPIs, daily chart, top products, destinations, recalculation. |
| **Multi-store & staff** | Several Shopify stores under one account (shared supplier connections), staff roles (Owner/Admin/Staff/Read-only). |
| **Notifications & activity** | In-app notification feed with dedupe, full activity log, background job list with progress, queue/webhook status. |
| **Plans & billing** | Basic (free), Advanced, Pro and Enterprise through the Shopify Billing API with a 14-day trial; caps on products, stores and staff across the account; AI mapping and auto-place on paid plans; usage meters and upgrade/downgrade under Settings → Plan. |
| **Email** | Instant notification emails or a daily digest at 08:00 shop time, via SMTP or Resend; critical notices always go out. |
| **Privacy & retention** | Mandatory compliance webhooks: data requests produce a downloadable export, redaction erases personal fields, shop redact and a 30-day purge erase the store. |
| **Settings** | Orders, fulfilment, products defaults, currency (live FX with buffer/manual rate), notifications, UI language (English / Tiếng Việt, auto-detected from the admin), plan, support, extension API token, system status. |
| **Extension** | Minimal MV3 Chrome extension (`extension/`) that sends the current AliExpress/CJ product page to the import list. |

A detailed DSers feature-by-feature comparison is in [`docs/FEATURES.md`](docs/FEATURES.md).

## Architecture in one paragraph

Remix (Vite) + Polaris embedded app on `@shopify/shopify-app-remix` v5, Prisma on
PostgreSQL, BullMQ on Redis for background work (with an inline fallback for dev).
Business rules — pricing, mapping resolution, carrier selection, address validation,
order pipeline and inventory policy — are **pure functions** in `app/domain/` with unit
tests. `app/services/` orchestrates the database, the Shopify Admin GraphQL API and
supplier adapters (`app/services/suppliers/`: AliExpress DS API, CJ Dropshipping, and a
deterministic mock). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
app/
  domain/        pure engines: pricing, mapping, shipping, orders (address, pipeline), inventory, settings
  services/      db + Shopify + supplier orchestration, jobs, webhooks
    shopify/     Admin GraphQL wrappers
    suppliers/   adapter contract, mock, aliexpress, cj, catalog cache, registry
    jobs/        queue (BullMQ/inline), handlers, scheduler
  routes/        Remix routes (Polaris UI, webhooks, public API)
  components/    shared UI
prisma/          schema, migration, seed
worker/          standalone queue worker
extension/       Chrome extension
tests/           unit (domain, adapters) + integration (Postgres + fake Shopify)
docs/            architecture, features, deployment, extension API
```

## Quick start (development)

Prerequisites: Node 22+, PostgreSQL 14+ (Redis optional), a Shopify Partner account
and the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli).

```bash
git clone <this repo> && cd <repo>
npm install
cp .env.example .env            # fill in SHOPIFY_API_KEY/SECRET or run `shopify app config link`

docker compose up -d postgres redis   # or point DATABASE_URL at your own Postgres
npx prisma migrate deploy
npm run db:seed                       # optional demo data (mock supplier)

npm run dev                           # shopify app dev → tunnel + install on your dev store
```

Leave `SUPPLIER_DRIVER=mock` to exercise the complete flow with the built-in sample
catalog: products import, orders route to the mock supplier, orders move to
paid → shipped → delivered over a few minutes and tracking numbers appear. Switch to
`SUPPLIER_DRIVER=live` and set the AliExpress / CJ keys to go live.
Going live with a real AliExpress account is covered step by step, in English and
Vietnamese, in [`docs/ALIEXPRESS.md`](docs/ALIEXPRESS.md).

### Background worker

With `REDIS_URL` set, run the worker in a second process:

```bash
npm run worker
```

It consumes the queue and owns the repeatable schedules (supplier order polling every
30 min, tracking sync every 15 min, auto-update per policy interval, auto-place every
10 min, metrics hourly, FX rates twice a day). Without Redis, jobs run inline in the web
process (fine for development). `RUN_WORKER_IN_WEB=true` runs the worker inside the web
process for single-dyno hosting.

### See the whole flow without a Shopify store

```bash
SUPPLIER_DRIVER=mock npm run demo
```

Drives the real services — the same code the admin UI calls — with the Demo supplier
and a stand-in Admin API, and prints each step: connect a supplier, import, push, map,
take an order, place it, watch it get paid and shipped, sync the tracking number into a
Shopify fulfilment, run the auto-update policy, roll up the reports. It takes about
three minutes because it waits for the Demo supplier to ship; `--quick` skips that wait
and `--keep` leaves the demo store in the database so you can browse it in the UI. It
refuses to run against a live supplier driver, where the orders would be real.

### Tests

```bash
npm run typecheck
npm run lint
npm test                      # unit tests (domain engines, adapters)
TEST_DATABASE_URL=postgresql://... npm test   # + end-to-end flow on a real database
npm run build
```

The integration suite (`tests/integration/flow.test.ts`) drives the whole product
lifecycle — import → push → mapping → order → placement → tracking → fulfilment →
inventory sync → reports — against PostgreSQL with a fake Shopify Admin API and the mock
supplier.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Standard Shopify app config (the CLI fills these). |
| `DATABASE_URL` | PostgreSQL connection string. |
| `REDIS_URL`, `QUEUE_PREFIX`, `RUN_WORKER_IN_WEB` | Queue. Leave `REDIS_URL` empty for inline jobs. |
| `SUPPLIER_DRIVER` | `mock` (sample catalog) or `live`. |
| `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, `ALIEXPRESS_REDIRECT_URI`, `ALIEXPRESS_TRACKING_ID` | AliExpress Open Platform (Dropshipping solution). Redirect URI must be `https://<app>/app/suppliers/callback/aliexpress`. |
| `CJ_EMAIL`, `CJ_API_KEY` | Optional server-wide CJ credentials (merchants can also enter their own in the UI). |
| `ENCRYPTION_KEY` | 32-byte base64 key (`openssl rand -base64 32`); supplier tokens are AES-256-GCM encrypted at rest. **Required in production** — the app refuses to boot without it. |
| `EMAIL_FROM`, `SMTP_URL` or `RESEND_API_KEY`, `EMAIL_PROVIDER` | Notification emails and the daily digest. Leave unset for in-app notifications only. |
| `SUPPORT_EMAIL` | Shown on the public support page and used as the reply-to address. |
| `BILLING_TEST` | Force Shopify Billing test mode on a staging deployment; automatic outside production and on development stores. |
| `ANTHROPIC_API_KEY`, `AI_MAPPING_MODEL` | Optional. Enables the AI pass on variant matching for the variants the deterministic matcher cannot place. Without a key the deterministic matcher is used alone. |
| `EXCHANGE_RATE_API_URL` | FX provider (default open.er-api.com). |

Per-shop behaviour (order gating, auto-place, supplier note, tags, phone fallback,
fulfilment options, product defaults, currency buffer, notifications, UI) lives in
**Settings** inside the app.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Docker, Fly.io/Render/Railway notes,
Shopify app configuration (`shopify app deploy` registers the webhooks declared in
`shopify.app.toml`) and production checklist.

## Publishing

[`docs/PUBLISHING.md`](docs/PUBLISHING.md) walks through the App Store submission:
Partner Dashboard configuration, the scope justifications reviewers ask for,
protected customer data, billing test mode, proving the compliance webhooks, the
listing copy and the test instructions for the reviewer (the built-in Demo supplier
lets anyone run the whole flow without an AliExpress account).

## Status and known limits

- The AliExpress adapter follows the live Dropshipping API's wire format as captured by
  independent integrations (see `docs/ALIEXPRESS.md`); the CJ adapter follows its public
  docs. Run one real order end to end after connecting your account — the parsing tests
  say exactly where to adjust if your account answers differently.
- Supplier payment is done on the supplier site (as with DSers); the app links you to
  the payment page and tracks status afterwards.
- The Chrome extension is minimal (send the current supplier page to the import list);
  it is not published to the Chrome Web Store.
- Only AliExpress, CJ Dropshipping and the Demo supplier are implemented; Temu and
  others fit the adapter contract but have no adapter yet.

## Hướng dẫn nhanh (VI)

DropshipHub là ứng dụng Shopify tương tự DSers: tìm & nhập sản phẩm từ AliExpress/CJ,
chỉnh sửa trong **Import list** trước khi đẩy lên cửa hàng, **mapping** biến thể với SKU
nhà cung cấp (Basic / Advanced theo quốc gia / BOGO / Bundle), **đặt hàng hàng loạt** lên
nhà cung cấp với tự động chọn phương thức vận chuyển, **đồng bộ mã vận đơn** về Shopify
(tạo fulfillment, gửi email khách), **tự động cập nhật giá/tồn kho** theo chính sách, báo
cáo doanh thu – chi phí – lợi nhuận, quản lý nhiều cửa hàng và nhân viên.

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis
npx prisma migrate deploy
npm run db:seed        # dữ liệu mẫu
npm run dev            # Shopify CLI mở tunnel và cài app lên dev store
npm run worker         # (tuỳ chọn) worker xử lý hàng đợi khi có Redis
```

Giữ `SUPPLIER_DRIVER=mock` để chạy thử toàn bộ luồng với catalog mẫu; đổi sang `live` và
điền khoá API AliExpress/CJ khi dùng thật. Hướng dẫn kết nối tài khoản AliExpress thật,
từng bước bằng tiếng Việt, nằm ở `docs/ALIEXPRESS.md`.

**Giao diện tiếng Việt.** Vào **Settings → General → Language** chọn *Tiếng Việt*. Tiếng
Anh là bản gốc, nên nếu thiếu chuỗi nào thì hiện tiếng Anh chứ không để trống.

**Thanh toán.** AliExpress không cho phép ứng dụng trừ tiền tài khoản của bạn, nên app
không bao giờ tự thanh toán: app tạo đơn ở trạng thái chưa trả rồi đưa link trực tiếp.
Trang **Payments** liệt kê mọi đơn chưa trả, tổng tiền theo từng loại tiền tệ, đồng hồ
đếm ngược 24 giờ trước khi AliExpress huỷ đơn, nút **Pay** mở đúng đơn đó, và nút mở
hàng loạt để trả nhiều đơn một lần.

**Nút Request fulfillment ngay trong Shopify.** Đăng ký app làm fulfillment service
(Settings → Fulfilment) là mỗi đơn Shopify sẽ có nút **Request fulfillment** gửi thẳng
sang app và app tự đặt hàng nhà cung cấp. Dòng nào chưa map thì app từ chối kèm lý do.

**So sánh nhà cung cấp & map bằng AI.** Trang sản phẩm hiển thị mọi nhà cung cấp của
sản phẩm đó cạnh nhau: giá vốn đã gồm ship, số ngày giao, đánh giá, số đơn, và tỷ lệ
biến thể khớp được — có điểm số và nút chuyển sang nhà cung cấp rẻ hơn. Việc ghép biến
thể chạy bằng bộ so khớp tất định trước (hiểu màu/size/quốc gia ở 10 ngôn ngữ), phần
còn lại mới nhờ AI.

Chi tiết tính năng so với DSers xem `docs/FEATURES.md`; kiến trúc xem
`docs/ARCHITECTURE.md`; triển khai xem `docs/DEPLOYMENT.md`.
