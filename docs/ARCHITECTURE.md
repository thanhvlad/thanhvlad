# Architecture

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ Remix routes (app/routes)                                          │
│   Polaris admin UI · webhooks · public API · OAuth callbacks        │
├────────────────────────────────────────────────────────────────────┤
│ Services (app/services)                                            │
│   import · products · mapping · orders · fulfillment · inventory   │
│   pricing · shipping · currency · reports · notifications · jobs   │
│   shopify/* (Admin GraphQL)   suppliers/* (adapters + catalog)     │
├────────────────────────────────────────────────────────────────────┤
│ Domain (app/domain) — pure, unit-tested                             │
│   pricing engine · mapping resolver · shipping selector            │
│   address validation · order pipeline · inventory rules · settings │
├────────────────────────────────────────────────────────────────────┤
│ Prisma / PostgreSQL            BullMQ / Redis           Shopify     │
└────────────────────────────────────────────────────────────────────┘
```

**Domain** modules take plain data and return decisions. They never touch the database
or the network, which is what makes the pricing preview, the "test the mapping" panel,
the dry-run of the inventory policy and the order list all agree with what the jobs do.

**Services** load rows, call domain functions, persist results and talk to Shopify /
suppliers. Every service takes a `ShopWithSettings` (the shop row plus parsed settings)
so behaviour is per-store.

**Routes** are thin: `requireShop()` authenticates the embedded session, loaders read,
actions dispatch on an `intent` field.

## Data model (prisma/schema.prisma)

- **Account → Shop**: an account owns several stores (multi-store). Supplier accounts
  and staff hang off the account; pricing rules, shipping preferences, inventory policy,
  products and orders are per shop.
- **SupplierProduct / SupplierVariant / SupplierShippingOption**: cached upstream
  catalog, keyed by `(platform, externalId)`. Refreshed by the inventory job; every
  refresh writes a `SupplierPriceSnapshot`.
- **ImportedProduct / ImportedVariant**: the import list (fully editable staging).
- **Product / ProductVariant**: Shopify mirror for managed products.
- **ProductMapping / VariantMapping**: one mapping per product; rows carry
  quantity, priority, ship-to country, quantity tier bounds and bundle group so all four
  mapping types share one table.
- **Order / OrderLineItem**: Shopify order mirror with derived `stage`, `issues` and a
  per-line `resolution` snapshot (the supplier lines that *would* be ordered).
- **PurchaseOrder / PurchaseOrderItem / TrackingNumber**: one PO per supplier per
  order; PO ids double as the idempotency key sent upstream.
- **PricingRule(+Tier), ShippingPreference, InventoryPolicy**: automation settings.
- **JobRun, ActivityLog, Notification, WebhookEvent, CurrencyRate, DailyMetric**: ops.

## Key flows

### Import → push

1. `detectPlatform(reference)` → adapter → `getProduct` → `cacheSupplierProduct`.
2. Supplier prices are converted to the shop currency (`currency.server`) and run through
   the pricing rule (`domain/pricing`). An `ImportedProduct` with variants is created.
3. `pushImportedProduct` builds a `productSet` mutation (options, variants, images,
   inventory, cost), publishes to the online store, mirrors the result into
   `Product/ProductVariant`, and creates a **BASIC** mapping from each variant to the
   supplier SKU it came from.

### Order → supplier

1. Webhook (`orders/create|updated|paid|cancelled`) or backfill → `upsertOrderFromSnapshot`.
2. `evaluateAndStoreOrder`: validate address (`domain/orders/address`), resolve every
   managed line (`domain/mapping/resolve` via `mapping.server`), derive stage + issues
   (`domain/orders/pipeline`).
3. `placeSupplierOrders`: group resolved lines per platform, quote shipping
   (`catalog.getShippingOptions`) and choose a carrier (`domain/shipping/select` with the
   shop's preferences), create a `PurchaseOrder` in `SUBMITTING`, call
   `adapter.placeOrder({ reference: po.id, … })`, store the upstream id and costs, tag the
   Shopify order. Failures are recorded on the PO and surfaced as notifications.
4. `syncPurchaseOrder` (scheduled): `adapter.getOrder` → status (never regresses) →
   `adapter.getTracking` → `TrackingNumber` rows → `syncPendingTracking` creates the
   Shopify fulfilment (`fulfillmentCreate` on the right fulfilment orders) and tags the
   order.

### Auto updates

`runInventorySync` refreshes each referenced supplier product once, then runs
`planVariantSync` (`domain/inventory/rules`) per variant and applies the resulting
actions in batches: `productVariantsBulkUpdate` (price/compare-at/cost),
`inventorySetQuantities`, `productUpdate(status: DRAFT)`, notifications.

## Jobs

`services/jobs/queue.server.ts` wraps BullMQ. With `REDIS_URL` the web process only
enqueues; `worker/main.ts` (or `RUN_WORKER_IN_WEB=true`) processes. Without Redis,
`enqueue` runs the handler on the next tick. `dedupeKey` collapses duplicates (BullMQ
job id / in-memory set). `scheduler-tick` jobs fan out per active shop so adding a store
needs no scheduler change.

## Supplier adapters

`services/suppliers/types.ts` defines the contract (`searchProducts`, `getProduct`,
`getShippingQuotes`, `placeOrder`, `getOrder`, `cancelOrder`, `getTracking`, OAuth
helpers, `parseProductReference`). `index.server.ts` resolves the adapter for a shop
(default account → account-wide account → credential-less), refreshing OAuth tokens when
they are about to expire. `SUPPLIER_DRIVER=mock` routes every platform to the
deterministic mock so the full pipeline can be exercised offline.

## Security notes

- Supplier tokens are AES-256-GCM encrypted when `ENCRYPTION_KEY` is set.
- Webhooks are HMAC-verified by `authenticate.webhook`, de-duplicated by `webhookId`,
  and processed asynchronously so Shopify always gets a fast 200.
- The public extension endpoint requires a per-shop bearer token (rotatable/revocable).
- OAuth `state` is signed with a shop id + nonce + timestamp (30 min validity).
