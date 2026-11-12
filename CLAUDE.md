# CLAUDE.md

Instructions for Claude Code working in this repository.

## What this is

Snack Overflow: a self-hosted household food app (pantry stock with barcode scanning, best-before tracking, recipes, per-person meal planning with calories, a waste-aware shopping list). Deployed with Docker Compose on a home server, used from phones (installable web app plus an Android wrapper) and desktop browsers.

## Source of truth

- **`docs/SPEC.md`** is the design spec. Read the relevant section before building a feature. If the code needs to differ from the spec, update the spec in the same change and say why in the commit message.
- **`docs/data/`** holds seed data (shelf-life defaults, unit conversions, pack sizes) and the food-safety rules the app must follow. Load the CSVs as seed data; don't invent numbers in code.
- **`docs/design/`** (when present) holds screenshots of the mock-ups. Match their layout and visual direction.
- Build in the order of the **Build phases** in the spec. Each phase must end deployable. GitHub issues track the work for the current phase.

## Public repository rules

This repo is public. Never commit:

- `.env` files, real credentials, API keys, tokens, push or signing keys, `google-services.json`, keystores
- personal data: real names, email addresses, home server domains or IP addresses, photos
- database dumps or backups

All configuration comes from environment variables, documented in `.env.example` with fake values. When you add a setting, add it to `.env.example` in the same change.

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict) everywhere |
| Monorepo | pnpm workspaces |
| Web UI | React + Vite, PWA, Tailwind CSS |
| Server | Node.js LTS + Fastify, REST + WebSocket live updates |
| Database | PostgreSQL + Drizzle ORM (migrations checked in) |
| Android | Capacitor wrapper around the web build |
| Tests | Vitest (unit and API), Playwright (key flows) |
| Deployment | Docker Compose (app + Postgres), one app image |

Suggested layout (create as needed):

```
apps/server     Fastify API, scheduler, MCP endpoint
apps/web        React PWA
apps/android    Capacitor project (phase 2)
packages/shared Types, zod schemas, unit conversion and date logic shared by server and web
docs/           Spec, seed data, design screenshots
```

## Conventions

- **Units:** quantities are stored in grams (liquids via density, counts via per-ingredient weight). Convert only at the edges (input and display). Unit and date logic lives in `packages/shared` with thorough unit tests.
- **Dates:** best-before dates are calendar dates (no time). Compute in the household's time zone (default `Europe/London`).
- **Food-safety rules** in `docs/data/README.md` are hard rules, not user settings (e.g. defrosted food = 24 hours, leftovers = 2 days, opened never extends a date).
- **Stock events:** every change to stock writes a stock event (add, use, open, move, freeze, defrost, discard, adjust). Waste stats, undo and usage estimates depend on this.
- **Validation:** validate every API input with zod schemas shared with the web app.
- **UI:** phone-first. Touch targets ≥ 44px. Colours: violet accent `#6B4EFF` for primary actions; green, amber and red only for freshness; blue for frozen. Headings in Bricolage Grotesque, body in Inter. Dark mode supported.
- **Copy:** UK English ("best-before", "colour", "tin", "favourite"), short and friendly.
- **Accessibility:** real buttons and links, labels on inputs, `aria-label` on icon-only buttons, 4.5:1 text contrast.
- **External services** (Open Food Facts, push, email, AI) must fail gracefully: the app keeps working offline from them, and optional features hide when not configured.
- Keep dependencies few and well known. Prefer the platform (fetch, BarcodeDetector) over libraries when it is enough.

## Definition of done

A change is done when:

1. it matches the spec (or the spec is updated),
2. tests cover the logic (unit tests for shared logic, API tests for endpoints, a Playwright test for any new key flow),
3. lint, type-check and tests pass,
4. `docker compose up` still starts a working app with migrations applied,
5. any new setting is in `.env.example` and any new user-facing feature is mentioned in `README.md`.

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Dev (API :3000 + web :5173) | `pnpm dev` (needs Postgres; set `DATABASE_URL` in `.env`) |
| Lint / type-check / tests | `pnpm lint`, `pnpm typecheck`, `pnpm test` (all three: `pnpm check`) |
| Build | `pnpm build` (web to `apps/web/dist`, server bundle to `apps/server/dist`) |
| E2E (Playwright) | `pnpm build && pnpm test:e2e` (`PW_CHANNEL=chrome` uses installed Chrome) |
| New migration after editing `apps/server/src/db/schema.ts` | `pnpm db:generate` (commit the files in `apps/server/drizzle`) |
| Apply migrations | `pnpm db:migrate` (the server also applies them on start) |
| Docker | `docker compose up -d --build` |
| Local test stack (Windows) | `start-test-env.bat` / `stop-test-env.bat` (port 3080, project `snackoverflow-test`, settings in `.env.test`) |

Notes:

- API tests (`apps/server/test`) run on PGlite (in-memory Postgres) with fake Open Food Facts, push and email; use `makeTestApp()` and `setupAdmin()` from `test/helpers.ts`.
- The Playwright web server (`apps/server/test/e2e-server.ts`) is the real app on PGlite serving the built web app.
- Every stock change goes through `apps/server/src/services/stock.ts`, which writes the stock event used for undo.
- Food-safety rules live in `packages/shared/src/shelfLife.ts`; day counts come from the seed CSVs.
