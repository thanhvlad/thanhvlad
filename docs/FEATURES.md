# Feature matrix — DSers vs DropshipHub

| DSers feature | DropshipHub | Where |
| --- | --- | --- |
| Find suppliers / product search | ✅ keyword, sort, image search (AliExpress), CJ search, shipping cost shown per result | `/app/search` |
| Add to shop from search | ✅ one click: import, price with the default rule and push to Shopify in one job | `/app/search` |
| Import from URL / Chrome extension | ✅ URL/ID paste, bulk paste, CSV, MV3 extension + capture API | `/app/search`, `/app/import`, `extension/` |
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
| Bulk place orders to AliExpress | ✅ `Place N orders` → job | `/app/orders` |
| Native "Request fulfillment" button in Shopify | ✅ the app registers as a Shopify fulfilment service, so requesting fulfilment on a Shopify order routes it here and places the supplier order | Settings → Fulfilment |
| Pay supplier orders | ✅ Payments page: every unpaid order, running total per currency, 24-hour countdown, deep link per order, bulk open, status polling, manual "I paid this" | `/app/payments` |
| Order issue detection (address, phone, mapping, stock, payment, risk) | ✅ with reasons per line | orders list + detail |
| Address editing & auto fix (line too long) | ✅ editor + auto split + write-back to Shopify | order detail |
| Country-specific customs IDs (CPF, RUT, PCCC, TC Kimlik…) | ✅ validated | domain/orders/address |
| Phone number rules / fallback phone | ✅ | Settings → Orders |
| Order note to supplier | ✅ default + per order | Settings, order detail |
| Shipping method settings per country | ✅ ranked carriers, cost/day/tracking limits, fallback | `/app/shipping` |
| Auto sync tracking numbers to Shopify | ✅ fulfilment creation, customer notification, carrier override, custom URL | `/app/tracking`, Settings → Fulfilment |
| Order tagging in Shopify | ✅ placed/shipped tags | Settings → Orders |
| Auto update price / stock (notify or update) | ✅ policy with thresholds, unpublish, restock, dry run, interval | `/app/inventory` |
| Product removed by supplier | ✅ unpublish/zero/notify | same |
| Notifications | ✅ in-app feed with dedupe | `/app/notifications` |
| Reports (sales, cost, profit) | ✅ KPIs, daily chart, top products, destinations | `/app/reports` |
| Multiple stores under one account | ✅ account linking, shared supplier accounts | Settings → Stores |
| Staff accounts / roles | ✅ Owner/Admin/Staff/Read-only | Settings → Staff |
| Multiple supplier accounts, default account | ✅ | `/app/suppliers` |
| Activity log | ✅ | `/app/logs` |
| Auto place orders | ✅ with delay | Settings → Orders |
| Cancel supplier order when Shopify order cancelled | ✅ (where supplier API allows) | webhook |
| Manual order (placed by hand) link | ✅ | order detail |
| Manual tracking entry | ✅ | order detail |
| CSV export of orders | ✅ | `/app/orders/export` |
| AliExpress affiliate / cashback | ⚠️ tracking id is passed on order creation (`ALIEXPRESS_TRACKING_ID`); no cashback dashboard |
| Supplier payment | ⚠️ done on the supplier site, as with DSers. AliExpress does not let an app charge the merchant's account, so the app never tries: it places the order unpaid and hands over deep links. See `/app/payments`. |
| Email notifications | ⚠️ settings exist; sender not wired (in-app feed only) |
| Temu / other marketplaces | ⚠️ adapter contract ready; only AliExpress, CJ and mock implemented |
| Multi-language UI | ✅ English and Vietnamese across the admin; switch under Settings → General. English is the source of truth and a missing key falls back to it, so a partial translation is always safe. | `app/lib/i18n.ts` |
