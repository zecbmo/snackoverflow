# Snack Overflow

A self-hosted household food app: scan your shopping in, see what's going off, plan meals around what you already have, and build a cheap shopping list that wastes as little as possible.

> Status: **phase 1 (foundation and stock)** is built. Recipes, the planner and the shopping list come in later phases (see [the build phases](docs/SPEC.md#build-phases)).

## What it does today

- **Fast barcode scanning.** Pick a location (fridge, freezer, cupboard) and scan item after item, supermarket-till style: a beep, a big tick, and the name and estimated best-before. Products are looked up in [Open Food Facts](https://world.openfoodfacts.org/), and unknown barcodes are remembered once you name them. Scan in **Use** mode to take things out. No camera? Type the barcode.
- **Best-before tracking.** Dates are estimated from UK food-safety defaults and learned from your edits (change a product's date once and it's remembered). Opening never extends a date, frozen and defrosted food get new dates, and defrosted food can't be refrozen.
- **Stock.** One row per item with colour bands (going off, this week, fine, frozen). Use all or some, open, freeze, defrost, move or bin anything, with Undo on every change. "Is there still some left?" when the numbers look off.
- **Notifications.** "Expires tomorrow" push notifications with Use / Freeze / Binned buttons, and a Sunday "going off this week" summary by push and email. Each person picks channels and quiet hours.
- **Household ready.** Several people and phones see the same stock live. Admin and member roles, invite links, and optional sign-in through a self-hosted identity provider (OpenID Connect).
- **Installable.** A web app you can add to your phone's home screen; works on desktop with a sidebar layout. Dark mode follows your device.
- **Self-hosted.** Docker Compose (app + PostgreSQL), nightly database backups and a JSON export.

## Coming next

Android app (phase 2), recipes and cooking (3), the per-person meal planner, shopping list and receipt import (4), the waste-aware optimiser and pricing (5), and the dashboard (6). The full design is in [`docs/SPEC.md`](docs/SPEC.md).

## Try it on Windows (one click)

With Docker Desktop installed, double-click **`start-test-env.bat`**. It builds and starts a separate test copy on <http://localhost:3080>, opens your browser and shows the admin login (stored in the git-ignored `.env.test`). **`stop-test-env.bat`** stops it and keeps the data; `scripts	est-env.ps1 reset` wipes it, and `scripts	est-env.ps1 logs` follows the logs. Phones on the same Wi-Fi can open the address it prints, but they only allow the camera over HTTPS, so type barcodes there.

## Run it with Docker

```sh
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, SESSION_SECRET (openssl rand -hex 32), APP_URL and the first admin.
docker compose up -d
```

The app listens on port 3000 (change with `PORT`). Put it behind an HTTPS reverse proxy: the camera, push notifications and installing the app all need HTTPS. On first start the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` is created; without those, the first visitor sets up the household in the browser. Invite everyone else from **People & roles**.

Optional features switch on when configured in `.env` and stay hidden otherwise:

| Feature | Settings |
| --- | --- |
| Email (weekly summary, invites) | `SMTP_*` |
| Push notifications | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`) |
| Single sign-on | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; callback URL is `APP_URL/api/auth/oidc/callback` |
| Online barcode lookup | on by default; `OFF_ENABLED=false` to turn off |

### Backups

A `pg_dump` backup is written every night (`BACKUP_TIME`, default 03:30) to the `backups` volume and kept for `BACKUP_KEEP_DAYS`. Admins can also back up now, download backups and export everything as JSON from **Settings**. To restore a backup into a fresh install:

```sh
docker compose cp ./snackoverflow-YYYYMMDD-HHMMSS.dump db:/tmp/restore.dump
docker compose exec db pg_restore --clean --if-exists --no-owner -U snackoverflow -d snackoverflow /tmp/restore.dump
docker compose restart app
```

## Development

Needs Node.js 22+ and pnpm 10.

```sh
pnpm install
cp .env.example .env            # point DATABASE_URL at a local Postgres
pnpm dev                        # API on :3000, web app on :5173 (proxied)
pnpm check                      # lint, type-check and unit/API tests
pnpm build && pnpm test:e2e     # Playwright key flows (PW_CHANNEL=chrome to use installed Chrome)
```

API tests run against an in-memory Postgres (PGlite), so they need no database. See [`CLAUDE.md`](CLAUDE.md) for conventions.

## Configuration

Secrets and environment-specific settings live in `.env`, which is git-ignored. [`.env.example`](.env.example) documents every variable. Never commit real credentials.

## Licence

[MIT](LICENSE)
