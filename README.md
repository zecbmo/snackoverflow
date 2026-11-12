# Snack Overflow

A self-hosted household food app: scan your shopping in, see what's going off, plan meals around what you already have, and build a cheap shopping list that wastes as little as possible.

> Status: design stage. Nothing to run yet.

## What it does

- **Fast barcode scanning.** Pick a location (fridge, freezer, cupboard) and scan item after item, supermarket-till style. Products are looked up in [Open Food Facts](https://world.openfoodfacts.org/), and unknown barcodes are remembered once you name them.
- **Receipt import.** Photograph a receipt, share a PDF, or forward an online-order email, and the whole shop is matched to products and added to stock in one go, with prices saved.
- **Best-before tracking.** Dates are estimated automatically and learned from your edits. Opened, frozen and defrosted items get new dates, and notifications warn you about food going off.
- **Recipes.** Import from a URL (BBC Good Food, Hello Fresh, blogs), with optional AI clean-up or import through an MCP endpoint. Recipes link to the food you have in.
- **Meal planning.** Per-person calendars, leftovers and batch cooks, calorie tracking, and suggestions for what to cook from what's in the house.
- **Waste-aware shopping list.** One shared list built from your plan and rounded to real pack sizes. It suggests meals that use up the surplus (the rest of that 2.5kg bag of potatoes).
- **Household ready.** Multiple users and phones, admin/member roles, optional sign-in through a self-hosted identity provider (OpenID Connect).
- **Self-hosted.** Docker Compose (app + PostgreSQL), a web app you can install on your phone, and an Android companion app.

## Design

The full design spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Planned stack

TypeScript throughout: React + Vite (PWA) and Tailwind on the front end, Node.js + Fastify, PostgreSQL with Drizzle, and Capacitor for Android. Deployed with Docker Compose.

## Configuration

Secrets and environment-specific settings will live in a `.env` file, which is git-ignored. An `.env.example` will document every variable. Never commit real credentials.

## Licence

To be decided.
