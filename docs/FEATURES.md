# Feature matrix — DSers vs DropshipHub

**Read this first.** Production runs extension-first (`SUPPLIER_DRIVER=mock`, no
AliExpress API keys, no email provider). Products are imported with the Chrome
extension on the AliExpress product page. For orders, the Chrome extension lists the
orders waiting to be placed and opens each product on AliExpress. You place and pay for
the order there, then record the AliExpress order number in the extension; tracking you
add there is sent to Shopify. Rows marked **(DS API)** are implemented against the
AliExpress Dropshipping API and only run with `SUPPLIER_DRIVER=live` and approved keys;
they are not something a merchant on production can use today.

| DSers feature | DropshipHub | Where |
| --- | --- | --- |
| Find suppliers / product search | ✅ **(DS API)** keyword, sort, image search (AliExpress), CJ search, shipping cost shown per result | `/app/search` |
| Add to shop from search | ✅ **(DS API)** import, price with the default rule and push to Shopify in one job | `/app/search` |
| Import from URL / Chrome extension | ✅ MV3 extension capture from the product page (production today: title, images, up to 250 variants, prices, description and specifications) + capture API; URL/ID paste, bulk paste and CSV **(DS API)** | `/app/import`, `extension/` |
| Import list with product editor | ✅ title, description, images, variants, tags, collections, handle, exclude values | `/app/import/:id` |
| Split product by option | ✅ | Import editor → Variants tab |
| Pricing rule / pricing template | ✅ multiply/add/margin/fixed, compare-at, cents ending, rounding, min/max, tiers, default rule | `/app/pricing` |
| Currency conversion | ✅ live FX with buffer and manual override | Settings → Currency |
| Push to Shopify (bulk) | ✅ background job with progress | `/app/import` |
| My Products | ✅ list, filters, bulk reprice/auto-update/delete/refresh, link existing product | `/app/products` |
| Basic mapping | ✅ | `/app/products/:id` |
| Advanced mapping (multi-supplier, per country) | ✅ ranked options with in-stock fall-through, exact-country beats wildcard | same |
| BOGO mapping | ✅ quantity tiers | same |
| Bundle mapping | ✅ multi-SKU groups, all-or-nothing | same |
| Supplier optimizer (alternative suppliers) | ✅ load any supplier product into the mapping pool; auto-map by options | same |
| Compare suppliers side by side | ✅ landed cost, shipping, delivery days, rating, order count, variant coverage, scored and ranked | `/app/products/:id` → Suppliers |
| One-click switch to a cheaper supplier | ✅ re-maps every variant and reports the saving; dismissable per candidate | same |
| AI variant matching | ✅ deterministic matcher first (colour/size/country synonyms across 10 languages), Claude for the leftovers, confidence recorded per row | same |
| Orders: Awaiting order / payment / shipment / fulfilled / canceled / failed tabs | ✅ 8 stages with counts | `/app/orders` |
| Place orders on AliExpress | ✅ Production today: The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify. The extension never places or pays for an order by itself. **(DS API)** `Place N orders` → job | `/app/orders`, `extension/` |
| Native "Request fulfillment" button in Shopify | ✅ the app registers as a Shopify fulfilment service, so requesting fulfilment on a Shopify order routes it here, where it waits to be placed (extension flow today; **(DS API)** placed by the app) | Settings → Fulfilment |
| Pay supplier orders | ✅ you pay on AliExpress. **(DS API)** Payments page: every unpaid order, running total per currency, 24-hour countdown, deep link per order, bulk open, status polling, manual "I paid this" | `/app/payments` |
| Order issue detection (address, phone, mapping, stock, payment, risk) | ✅ with reasons per line | orders list + detail |
| Address editing & auto fix (line too long) | ✅ editor + auto split + write-back to Shopify | order detail |
| Country-specific customs IDs (CPF, RUT, PCCC, TC Kimlik…) | ✅ validated | domain/orders/address |
| Phone number rules / fallback phone | ✅ | Settings → Orders |
| Order note to supplier | ✅ default + per order | Settings, order detail |
| Shipping method settings per country | ✅ ranked carriers, cost/day/tracking limits, fallback | `/app/shipping` |
| Tracking numbers to Shopify | ✅ tracking you record (extension or order page) becomes a Shopify fulfilment; Shopify notifies the customer when that store setting is on; carrier override, custom URL. **(DS API)** tracking polled from the supplier | `/app/tracking`, Settings → Fulfilment |
| Order tagging in Shopify | ✅ placed/shipped tags | Settings → Orders |
| Auto update price / stock (notify or update) | ✅ **(DS API)** policy with thresholds, unpublish, restock, dry run, interval | `/app/inventory` |
| Product removed by supplier | ✅ **(DS API)** unpublish/zero/notify | same |
| Notifications | ✅ in-app feed with dedupe | `/app/notifications` |
| Reports (sales, cost, profit) | ✅ KPIs, daily chart, top products, destinations | `/app/reports` |
| Multiple stores under one account | ✅ account linking, shared supplier accounts | Settings → Stores |
| Staff accounts / roles | ✅ Owner/Admin/Staff/Read-only | Settings → Staff |
| Multiple supplier accounts, default account | ✅ | `/app/suppliers` |
| Activity log | ✅ | `/app/logs` |
| Auto place orders | ✅ **(DS API)** with delay | Settings → Orders |
| Cancel supplier order when Shopify order cancelled | ✅ an order still waiting to be placed is cancelled in the app; **(DS API)** upstream cancel where the supplier API allows | webhook |
| Manual order (placed by hand) link | ✅ | order detail |
| Manual tracking entry | ✅ | order detail |
| CSV export of orders | ✅ | `/app/orders/export` |
| AliExpress affiliate / cashback | ⚠️ tracking id is passed on order creation (`ALIEXPRESS_TRACKING_ID`); no cashback dashboard |
| Supplier payment | ⚠️ done on the supplier site, as with DSers. AliExpress does not let an app charge the merchant's account, so the app never tries. **(DS API)** it places the order unpaid and hands over deep links; see `/app/payments`. |
| Email notifications | ⚠️ needs an email provider (`EMAIL_FROM` plus `RESEND_API_KEY` or `SMTP_URL`), which production does not have: until one is set, notifications stay in the app and the settings screen disables email. With one: instant or daily digest (08:00 shop time), per-type toggles | Settings → General → Notifications |
| Plans & billing | ✅ Basic / Advanced / Pro / Enterprise through the Shopify Billing API, 14-day trial, caps on products/stores/staff across the account, AI mapping and auto-place on paid plans | `/app/settings/plan` |
| GDPR / privacy webhooks | ✅ data request → downloadable export, customer redact, shop redact, 30-day purge of uninstalled stores | `services/compliance.server.ts` |
| Help center, privacy policy, terms | ✅ public pages in English and Vietnamese | `/support`, `/privacy`, `/terms` |
| Temu / other marketplaces | ⚠️ adapter contract ready; only AliExpress, CJ and mock implemented |
| Multi-language UI | ✅ English and Vietnamese across the admin; switch under Settings → General. English is the source of truth and a missing key falls back to it, so a partial translation is always safe. | `app/lib/i18n.ts` |
