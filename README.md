# Snack Overflow

A self-hosted household food app: scan your shopping in, see what's going off, plan meals around what you already have, and build a cheap shopping list that wastes as little as possible.

> Status: phases 1 to 4 are built: **stock**, the **Android app**, **recipes and cooking**, and the **planner and shopping list**. The optimiser, pricing and the dashboard come next (see [the build phases](docs/SPEC.md#build-phases)).

## What it does today

- **Fast barcode scanning.** Pick a location (fridge, freezer, cupboard) and scan item after item, supermarket-till style: a beep, a big tick, and the name and estimated best-before. Products are looked up in [Open Food Facts](https://world.openfoodfacts.org/), and unknown barcodes are remembered once you name them. Scan in **Use** mode to take things out. No camera? Type the barcode.
- **Best-before tracking.** Dates are estimated from UK food-safety defaults and learned from your edits (change a product's date once and it's remembered). Opening never extends a date, frozen and defrosted food get new dates, and defrosted food can't be refrozen.
- **Stock.** One row per item with colour bands (going off, this week, fine, frozen). Use all or some, open, freeze, defrost, move or bin anything, with Undo on every change. "Is there still some left?" when the numbers look off.
- **Notifications.** "Expires tomorrow" reminders with Use / Freeze / Binned buttons, and a Sunday "going off this week" summary. Everything lands in the in-app inbox (the bell), and each person picks extra channels (browser push, email) and quiet hours.
- **Android app.** Native ML Kit barcode scanning, phone notifications with action buttons, and an offline queue: scans made with no signal are kept and added when you're back online (the web app queues offline scans too). No Firebase: the app checks your server's inbox in the background about every 15 minutes.
- **Recipes and cooking.** Import recipes from a link (BBC Good Food, Hello Fresh, most blogs), type them in, or let your own Claude add them over MCP. Ingredient lines are matched to your food, with calories per serving. Cook from stock in one go (earliest-expiring first), keep leftovers with the right food-safety dates, or batch cook into fridge and freezer portions. Every cook can be undone.
- **Meal planner.** Each person's week as breakfast, lunch, dinner and snack, with calories per person (a shared meal is split between who's eating it). Plan recipes, leftovers, food or a note; scan in **Eat** mode to log a snack to your current meal. "Cooking Fish pie tonight?" at meal times with Cooked it / Skip / Move. Planned meals don't lock stock, but using food a planned meal needs gets a warning first.
- **Shopping list.** One shared list, built from the plan (what it needs, minus stock, rounded up to real pack sizes, with what's left over), staples running low, and anything typed in. Tick things off in the shop, then put them away in one tap.
- **Household ready.** Several people and phones see the same stock live. Admin and member roles, invite links, and optional sign-in through a self-hosted identity provider (OpenID Connect).
- **Installable.** A web app you can add to your phone's home screen; works on desktop with a sidebar layout. Dark mode follows your device.
- **Self-hosted.** Docker Compose (app + PostgreSQL), nightly database backups and a JSON export.

## Coming next

Receipt import (rest of 4), the waste-aware optimiser and pricing (5), and the dashboard (6). The full design is in [`docs/SPEC.md`](docs/SPEC.md).

## Try it on Windows (one click)

With Docker Desktop installed, double-click **`start-test-env.bat`**. It builds and starts a separate test copy on <http://localhost:3080>, opens your browser and shows the admin login (stored in the git-ignored `.env.test`). **`stop-test-env.bat`** stops it and keeps the data; `scripts	est-env.ps1 reset` wipes it, and `scripts	est-env.ps1 logs` follows the logs. Phones on the same Wi-Fi can open the address it prints, but they only allow the camera over HTTPS, so type barcodes there.

## Android app

Build the APK (needs a JDK 17+ and the Android SDK, not Android Studio; `winget install Microsoft.OpenJDK.21` gets the JDK on Windows):

```sh
pnpm install
pnpm android        # -> apps/android/android/app/build/outputs/apk/debug/app-debug.apk
```

Copy the APK to your phone and open it to install (allow installing from your file manager when asked). On first launch, enter the address you use in the browser, for example `http://192.168.1.20:3000` or `https://snacks.example.com`, then sign in. Each phone gets its own sign-in token; you can sign a lost phone out from **Your profile → Phones**.

Notifications reach the phone without Firebase or any Google push service: the app checks the server's inbox in the background about every 15 minutes (Android may wait longer in battery saver), and instantly while it's open. Allow notifications when asked, and if a reminder seems late, turn off battery optimisation for Snack Overflow in Android settings.

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

### Recipes: import, AI clean-up and Claude (MCP)

- **Import from a link:** paste a recipe page's address; most recipe sites embed structured recipe data, which gives an accurate first pass for you to review.
- **AI clean-up (optional):** set `AI_API_KEY` (Anthropic) to show a "Tidy up" button that cleans messy imports and matches each line to your ingredients. `AI_MODEL` overrides the model. Hidden when no key is set.
- **Claude via MCP (optional):** set `MCP_TOKEN` to a long random string and add `APP_URL/mcp` as a remote MCP server in your assistant, sending the token as a Bearer token. Claude can then list ingredients and create or fix recipes (for example from a photo of a recipe card) without an API key on the server.

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
