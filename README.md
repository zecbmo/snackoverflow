# Snack Overflow

A self-hosted household food app: scan your shopping in, see what's going off, plan meals around what you already have, and build a cheap shopping list that wastes as little as possible.

> Status: all six build phases are built: **stock**, the **Android app**, **recipes and cooking**, the **planner and shopping list**, the **waste-aware optimiser and prices**, and the **dashboard** (see [the build phases](docs/SPEC.md#build-phases)).

## What it does today

- **Fast barcode scanning.** Pick a location (fridge, freezer, cupboard) and scan item after item, supermarket-till style: a beep, a big tick, and the name and estimated best-before. Products are looked up in [Open Food Facts](https://world.openfoodfacts.org/), and unknown barcodes are remembered once you name them. Scan in **Use** mode to take things out. No camera? Type the barcode.
- **Best-before tracking.** Dates are estimated from UK food-safety defaults and learned from your edits (change a product's date once and it's remembered). Opening never extends a date, frozen and defrosted food get new dates, and defrosted food can't be refrozen.
- **Stock.** A table with quick filters for fridge, freezer and cupboard, and columns for where it is, opened or frozen, packs, what's left (liquids in ml) and how much the planned meals need (red when you're short, marked when it's already on the shopping list). Use, freeze, defrost, move or bin from the row, with Undo on every change. Freezing food past its date asks first rather than refusing.
- **Notifications.** "Expires tomorrow" reminders with Use / Freeze / Binned buttons, and a Sunday "going off this week" summary. Everything lands in the in-app inbox (the bell), and each person picks extra channels (browser push, email) and quiet hours.
- **Android app.** Native ML Kit barcode scanning, phone notifications with action buttons, and an offline queue: scans made with no signal are kept and added when you're back online (the web app queues offline scans too). No Firebase: the app checks your server's inbox in the background about every 15 minutes.
- **Recipes and cooking.** Import recipes from a link (BBC Good Food, Hello Fresh, most blogs), type them in, or let your own Claude add them over MCP. Ingredient lines are matched to your food, with calories per serving. Cook from stock in one go (earliest-expiring first), keep leftovers with the right food-safety dates, or batch cook into fridge and freezer portions. Every cook can be undone.
- **Calendar.** Plan meals by dragging stock, recipes or leftovers from the side pane onto a day and meal, drag planned meals to move them, or drag them back to the pane to take them off. Each meal shows its calorie total. Plan food by the item (one bar from a multipack) or by weight (150g of chicken). Each person's week as breakfast, lunch, dinner and snack, with calories per person (a shared meal is split between who's eating it). Plan recipes, leftovers, food or a note; scan in **Eat** mode to log a snack to your current meal. "Cooking Fish pie tonight?" at meal times with Cooked it / Skip / Move. Planned meals don't lock stock, but using food a planned meal needs gets a warning first.
- **Use it up.** Recipes sorted into **Cook now** (everything's in stock), **Nearly there** (missing one to three things) and **Use it up** (ranked by how much soon-to-expire food they save, with "Uses spinach (tomorrow)"). In the planner, **Suggest meals** gives ideas with a reason for any day, and **Plan my week** fills the empty slots around what's going off (leftovers first, then freezer portions), for you to swap or remove before anything is planned. Spare food left after the plan ("2.1kg potatoes spare after this plan") shows on the plan and the list, with recipes that would use it. No repeats within a week and excluded tags are set in Settings.
- **Shopping list.** One shared list, built from the plan (what it needs, minus stock, rounded up to real pack sizes, with what's left over), staples running low, and anything typed in. Tick things off in the shop, then put them away in one tap.
- **Receipts.** Photograph a receipt, upload or share a photo or PDF, paste one, or forward an online-order email: the whole shop is matched to your food (learning your shop's abbreviations as it goes), checked on one screen and added to stock in one go, ticked off the list, with prices saved. Photos are read by AI if you set a key, or by your own assistant over MCP; a compressed copy of the photo stays with the receipt.
- **Prices (optional, off by default).** Turn prices on in Settings and the list shows an estimated total, each product shows its latest price, and meal suggestions favour cheaper extras. Prices come from receipts, what you type when scanning, and [Open Prices](https://prices.openfoodfacts.org/); no supermarket site is scraped.
- **Dashboard and waste report.** Calories per day for each person over 7 or 30 days, with 7- and 30-day averages against a daily target you set in your profile (admins can see everyone's). What was binned this month and how it compares with last month at the same point, by item and category, with its value and your spending from receipts when prices are on. On a wide screen, Today shows the week's dinners, calories, waste, running low and the shopping list at a glance.
- **Household ready.** Several people and phones see the same stock live. Admin and member roles, invite links, and optional sign-in through a self-hosted identity provider (OpenID Connect).
- **Built for desktop and phone.** On a computer: a collapsible sidebar, tables with search, filter, sort and group, Use / Freeze / Move / Bin on every stock row, tick several rows to act on them at once, and details in a side panel. On a phone: the same lists, a bottom bar and a big Scan button, installable to the home screen. Eight colour palettes and light or dark themes, picked per device in Settings.
- **Self-hosted.** Docker Compose (app + PostgreSQL), nightly database backups and a JSON export.

## What's next

Refinements from real use. The full design is in [`docs/SPEC.md`](docs/SPEC.md).

## Try it on Windows (one click)

With Docker Desktop installed, double-click **`start-test-env.bat`**. It builds and starts a separate test copy on <http://localhost:3080>, opens your browser and shows the admin login (stored in the git-ignored `.env.test`). **`stop-test-env.bat`** stops it and keeps the data; `scripts	est-env.ps1 reset` wipes it, and `scripts	est-env.ps1 logs` follows the logs. Phones on the same Wi-Fi can open the address it prints, but they only allow the camera over HTTPS, so type barcodes there.

To see it with a full house of made-up data (three people, stock going off, recipes, two weeks of meals, a plan, a shopping list and receipts), run `node --env-file=.env.test scripts/demo-data.mjs` once the test copy is up.

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
| AI recipe clean-up and receipt reading | `AI_API_KEY` (and optionally `AI_MODEL`) |
| Your own assistant over MCP (recipes, reading receipts) | `MCP_TOKEN`; the endpoint is `APP_URL/mcp` |
| Receipts by email | `RECEIPT_IMAP_*` and `RECEIPT_ALLOWED_SENDERS`: forward online-order emails to that mailbox (with no allowed senders set, only household members' own addresses are accepted) |

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
