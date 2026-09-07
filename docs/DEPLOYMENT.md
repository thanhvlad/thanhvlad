# Deployment

## 1. Shopify app configuration

```bash
npm install -g @shopify/cli
shopify app config link        # binds shopify.app.toml to an app in your Partner dashboard
shopify app deploy             # pushes config + webhook subscriptions (app/uninstalled, orders/*, products/*, fulfillments/*, compliance)
```

Set the app URL and redirect URLs to your production host. Required scopes are listed
in `shopify.app.toml`.

For AliExpress, register the app on <https://openservice.aliexpress.com> under the
*Dropshipping* solution and set the callback URL to
`https://<your-app>/app/suppliers/callback/aliexpress`.

## 2. Infrastructure

- **PostgreSQL 14+** — `DATABASE_URL`.
- **Redis 6+** — `REDIS_URL` (strongly recommended in production; without it jobs run in
  the web process and are lost on restart).
- **Web process** — `npm run start` (after `npm run setup` which runs migrations).
- **Worker process** — `npm run worker` (at least one instance).

### Docker

```bash
docker compose up -d postgres redis
docker build -t dropship-hub .
docker run --env-file .env -p 3000:3000 dropship-hub                 # web (runs migrations first)
docker run --env-file .env dropship-hub npm run worker               # worker
```

### Fly.io / Render / Railway

Two services from the same image: `web` (`npm run docker-start`) and `worker`
(`npm run worker`). Attach managed Postgres + Redis, set the env vars from
`.env.example`, and point `SHOPIFY_APP_URL` at the web service's public URL.
Single-instance hosting can set `RUN_WORKER_IN_WEB=true` instead of a worker service.

## 3. Production checklist

- [ ] `ENCRYPTION_KEY` set (`openssl rand -base64 32`) so supplier tokens are encrypted.
- [ ] `SUPPLIER_DRIVER=live` and platform keys configured.
- [ ] `shopify app deploy` run so webhooks are registered for the production URL.
- [ ] Worker running; check **Settings → Advanced → System** shows queue mode `redis`.
- [ ] A test order flows: Orders → Awaiting order → Place → Awaiting payment → pay at
      supplier → Awaiting shipment → tracking → Fulfilled.
- [ ] Auto-update policy reviewed under **Auto updates** (defaults: notify on price,
      zero inventory when supplier is out of stock, unpublish when removed).
- [ ] Database backups scheduled.

## 4. Upgrading

```bash
git pull
npm ci
npx prisma migrate deploy
npm run build
# restart web + worker
```

Schema changes are shipped as Prisma migrations under `prisma/migrations/`.
