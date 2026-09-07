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
| **Find products** | Keyword + image search across supplier catalogs (AliExpress DS API, CJ), sort by orders/rating/price, paste URLs or IDs, bulk link import, CSV import, browser-extension capture. |
| **Import list** | Staging area: edit title, description (HTML with preview), vendor/type/tags/handle/collections, images (reorder/remove/add), variants (price, compare-at, SKU, inventory, enable/disable), exclude option values, split by option, apply pricing rules, bulk push to Shopify. |
| **My products** | Managed products mirrored from Shopify, link existing Shopify products for mapping, reprice from supplier cost, auto-update toggles, refresh/unlink/delete, resource-picker linking. |
| **Mapping** | Basic (1:1), Advanced (ranked suppliers per destination country with in-stock fall-through), BOGO (quantity tiers), Bundle (multi-SKU components). Auto-map by option values. Live "test the mapping" resolver. Supplier cost history. |
| **Orders** | Webhook ingest + backfill sync, pipeline stages (Pending → Awaiting order → Awaiting payment → Awaiting shipment → Awaiting delivery → Fulfilled / Canceled / Failed), address validation with country rules (phone, ZIP, province, CPF/RUT/PCCC/TC Kimlik…), auto-fix over-long addresses, per-line mapping resolution with clear failure reasons, bulk place, force place, ignore lines, address editor that can write back to Shopify, CSV export. |
| **Fulfilment** | One purchase order per supplier, shipping method chosen from your carrier preferences with cost/day/tracking guard rails and cheapest/fastest fallback, idempotent placement, retry/cancel/manual link, supplier status polling that never regresses, tracking capture, Shopify fulfilment creation with customer notification, carrier-name override, custom tracking URL, order tagging, auto-cancel upstream on Shopify cancel, auto-place with delay. |
| **Tracking** | All tracking numbers with sync state, failed-sync retry, delivered filter. |
| **Auto updates** | Policy per shop: on price change (update via rule / notify / nothing) with threshold; on stock change (set 0 when out + restock, mirror capped quantity, unpublish, notify); on product removed. Dry-run preview, manual run, schedule interval, run history. |
| **Pricing rules** | Multiply / add / target margin / fixed; compare-at derived from price; cents ending; round-up-to-multiple; min/max clamps; include shipping; cost-range tiers; default rule; live preview table. |
| **Shipping** | Ranked carriers per country (or `*`), max cost, max days, tracking required, fallback cheapest/fastest/none, global cost cap. |
| **Suppliers** | AliExpress OAuth, CJ API-key, mock account; shared across stores on the account; default per platform; connection test; encrypted tokens; automatic refresh. |
| **Reports** | Revenue / cost / profit / margin KPIs, daily chart, top products, destinations, recalculation. |
| **Multi-store & staff** | Several Shopify stores under one account (shared supplier connections), staff roles (Owner/Admin/Staff/Read-only). |
| **Notifications & activity** | In-app notification feed with dedupe, full activity log, background job list with progress, queue/webhook status. |
| **Settings** | Orders, fulfilment, products defaults, currency (live FX with buffer/manual rate), notifications, UI language (EN/VI scaffold), extension API token, system status. |
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
| `ENCRYPTION_KEY` | 32-byte base64 key; supplier tokens are AES-256-GCM encrypted at rest when set. |
| `EXCHANGE_RATE_API_URL` | FX provider (default open.er-api.com). |

Per-shop behaviour (order gating, auto-place, supplier note, tags, phone fallback,
fulfilment options, product defaults, currency buffer, notifications, UI) lives in
**Settings** inside the app.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Docker, Fly.io/Render/Railway notes,
Shopify app configuration (`shopify app deploy` registers the webhooks declared in
`shopify.app.toml`) and production checklist.

## Status and known limits

- AliExpress and CJ adapters implement the documented request/response shapes of their
  public APIs, but were written against the docs rather than a live account — expect to
  adjust field mappings once you have credentials. The mock adapter and the integration
  suite prove the rest of the pipeline end to end.
- Supplier payment is done on the supplier site (as with DSers); the app links you to
  the payment page and tracks status afterwards.
- Email delivery for notifications is not wired (in-app feed only); the settings exist so
  an SMTP/SendGrid sender can be added in `services/notifications.server.ts`.
- Vietnamese UI strings cover navigation, statuses and common actions; the rest of the UI
  is English. The i18n scaffold (`app/lib/i18n.ts`) is ready to extend.

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
điền khoá API AliExpress/CJ khi dùng thật. Chi tiết tính năng so với DSers xem
`docs/FEATURES.md`; kiến trúc xem `docs/ARCHITECTURE.md`; triển khai xem
`docs/DEPLOYMENT.md`.
