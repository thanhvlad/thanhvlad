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
- **Redis 6+** — `REDIS_URL`. Optional: without it, a web process started with
  `RUN_WORKER_IN_WEB=true` runs the same schedule on timers and executes jobs inline.
  What Redis buys is durability (a queued job survives a restart) and the ability to run
  more than one instance. Start without it; add it when losing queued work on a deploy
  would cost you an order.
- **Web process** — `npm run start` (after `npm run setup` which runs migrations).
- **Worker process** — `npm run worker` (at least one instance).

### Docker

```bash
docker compose up -d postgres redis
docker build -t dropship-hub .
docker run --env-file .env -p 3000:3000 dropship-hub                 # web (runs migrations first)
docker run --env-file .env dropship-hub npm run worker               # worker
```

### Windows Server

The app is plain Node with no shell calls, POSIX paths or platform checks, so it runs
natively on Windows — no Docker, no WSL. `scripts/setup-windows.ps1` does the setup:
it checks Node, git and PostgreSQL, fetches the code, creates the database, writes a
`.env` with a generated `ENCRYPTION_KEY`, installs, migrates, builds, and writes a Caddy
config. Run it in an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 -Domain your-domain.com -PgPassword 'postgres-password'
```

It deliberately installs nothing itself; each missing prerequisite is reported with the
`winget` command that fixes it.

Two things Windows needs that Linux hosts give you:

- **HTTPS.** Shopify requires a trusted certificate. Caddy is one `caddy.exe` plus a
  three-line `Caddyfile` and gets a Let's Encrypt certificate on its own; the script
  writes the config.
- **Staying up.** Register the server and Caddy as Windows services with
  [NSSM](https://nssm.cc) so they survive a reboot. The script prints both commands.

`SIGTERM` is not delivered on Windows the way it is on Unix, so stopping the service
skips the graceful queue shutdown. Without Redis there is no queued work to lose, so it
only matters once you add one.

### Fly.io / Render / Railway

Two services from the same image: `web` (`npm run docker-start`) and `worker`
(`npm run worker`). Attach managed Postgres + Redis, set the env vars from
`.env.example`, and point `SHOPIFY_APP_URL` at the web service's public URL.
Single-instance hosting can set `RUN_WORKER_IN_WEB=true` instead of a worker service.

- **Fly.io**: `fly.toml` defines both process groups and the health check. `fly launch
  --no-deploy`, attach Postgres and Redis, `fly secrets set ...`, `fly deploy`.
- **Render**: `render.yaml` is a blueprint for web + worker + Postgres + Redis; fill the
  `sync: false` secrets in the dashboard after the first deploy.

### Health and boot checks

`GET /healthz` answers `200 {"ok":true}` when the database responds and, with Redis
configured, the queue does too; `503` otherwise with the failing component named. Point
the host's health check at it (the Dockerfile, `fly.toml` and `render.yaml` already do).

In production the app refuses to boot — with a message naming the variable — without
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, an `https` `SHOPIFY_APP_URL`, `DATABASE_URL`,
`ENCRYPTION_KEY`, and supplier keys when `SUPPLIER_DRIVER=live`.

## 3. Production checklist

- [ ] `ENCRYPTION_KEY` set (`openssl rand -base64 32`) so supplier tokens are encrypted.
- [ ] `SUPPLIER_DRIVER=live` and platform keys configured.
- [ ] `shopify app deploy` run so webhooks are registered for the production URL.
- [ ] Worker running; check **Settings → Advanced → System** shows queue mode `redis`.
- [ ] A test order flows: Orders → Awaiting order → Place → Awaiting payment → pay at
      supplier → Awaiting shipment → tracking → Fulfilled.
- [ ] Auto-update policy reviewed under **Auto updates** (defaults: notify on price,
      zero inventory when supplier is out of stock, unpublish when removed).
- [ ] `SUPPORT_EMAIL` set; `/privacy`, `/terms`, `/support` open in a browser.
- [ ] `EMAIL_FROM` + `RESEND_API_KEY` or `SMTP_URL` if merchants should get emails.
- [ ] Billing tested on a development store (Settings → Plan → Upgrade, then Downgrade).
- [ ] Compliance webhooks triggered once with `shopify app webhook trigger` (see
      `PUBLISHING.md`).
- [ ] Host monitoring alerts on `/healthz` returning 503.
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
