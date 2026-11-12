/**
 * Optional pricing (off by default). No UK supermarket has a public price API,
 * so prices come from what people type, from receipts, and from Open Prices
 * (the crowd-sourced price database run by Open Food Facts). Everything here
 * fails gracefully: no price just means "unknown".
 */
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { addDays, daysBetween, todayIn } from '@snackoverflow/shared';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { barcodes, households, prices, products, shoppingItems } from '../db/schema';
import { householdSettings } from './household';

export interface LatestPrice {
  pricePence: number;
  date: string;
  store: string | null;
  source: string;
}

/** A household's own prices are trusted over Open Prices when both are this recent. */
const OWN_PRICE_DAYS = 60;
/** Don't ask Open Prices about the same barcode more than once a week. */
const OPEN_PRICES_REFRESH_DAYS = 7;

export function pricingOn(ctx: Pick<AppContext, 'config'>, household: { settings: unknown }): boolean {
  return householdSettings(household as Parameters<typeof householdSettings>[0], ctx.config.PRICING_ENABLED).pricingEnabled;
}

/** The latest price per product. The household's own prices win over Open Prices when recent. */
export async function latestPrices(db: Db, householdId: string): Promise<Map<string, LatestPrice>> {
  const rows = await db.select().from(prices).where(eq(prices.householdId, householdId)).orderBy(desc(prices.date), desc(prices.createdAt));
  const own = new Map<string, LatestPrice>();
  const open = new Map<string, LatestPrice>();
  for (const r of rows) {
    const target = r.source === 'open-prices' ? open : own;
    if (!target.has(r.productId)) target.set(r.productId, { pricePence: r.pricePence, date: r.date, store: r.store, source: r.source });
  }
  const out = new Map<string, LatestPrice>();
  for (const id of new Set([...own.keys(), ...open.keys()])) {
    const o = own.get(id);
    const p = open.get(id);
    if (o && p) out.set(id, Math.abs(daysBetween(o.date, p.date)) <= OWN_PRICE_DAYS || o.date >= p.date ? o : p);
    else out.set(id, (o ?? p)!);
  }
  return out;
}

export interface IngredientPrice {
  pencePerGram: number;
  packGrams: number;
  packPence: number;
}

/**
 * The cheapest known price per gram for each ingredient, from the products linked to it
 * that have a pack size and a price. Used to cost list items and extra ingredients.
 */
export async function ingredientPrices(db: Db, householdId: string): Promise<Map<string, IngredientPrice>> {
  const latest = await latestPrices(db, householdId);
  if (!latest.size) return new Map();
  const prods = await db
    .select({ id: products.id, ingredientId: products.ingredientId, packGrams: products.packGrams })
    .from(products)
    .where(and(eq(products.householdId, householdId), inArray(products.id, [...latest.keys()])));
  const out = new Map<string, IngredientPrice>();
  for (const p of prods) {
    const price = latest.get(p.id);
    if (!p.ingredientId || !p.packGrams || !price) continue;
    const perGram = price.pricePence / p.packGrams;
    const best = out.get(p.ingredientId);
    if (!best || perGram < best.pencePerGram) out.set(p.ingredientId, { pencePerGram: perGram, packGrams: p.packGrams, packPence: price.pricePence });
  }
  return out;
}

/** Estimated cost of a shopping list item: its product's price, else the ingredient's price per gram. */
export function estimateItemPence(
  item: { productId: string | null; ingredientId: string | null; packs: number; packGrams: number | null },
  latest: Map<string, LatestPrice>,
  byIngredient: Map<string, IngredientPrice>,
): number | null {
  const own = item.productId ? latest.get(item.productId) : undefined;
  if (own) return own.pricePence * item.packs;
  const ing = item.ingredientId ? byIngredient.get(item.ingredientId) : undefined;
  if (!ing) return null;
  return Math.round(ing.pencePerGram * (item.packGrams ?? ing.packGrams) * item.packs);
}

export async function addManualPrice(db: Db, householdId: string, productId: string, pricePence: number, store: string | null, today: string) {
  await db.insert(prices).values({ householdId, productId, pricePence, store, date: today, source: 'manual' });
}

// --- Open Prices -------------------------------------------------------------------------

/** Last time each barcode was asked about (this process); the newest open-prices row covers restarts. */
const asked = new Map<string, number>();

function parseOpenPrice(body: unknown): { pricePence: number; date: string; store: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items) || !items.length) return null;
  const first = items[0] as Record<string, unknown>;
  const price = typeof first.price === 'number' ? first.price : Number(first.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1000) return null;
  if (first.currency && first.currency !== 'GBP') return null;
  const date = typeof first.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(first.date) ? first.date.slice(0, 10) : null;
  if (!date) return null;
  const loc = first.location as Record<string, unknown> | undefined;
  const store = (typeof loc?.osm_name === 'string' && loc.osm_name) || (typeof loc?.osm_brand === 'string' && loc.osm_brand) || null;
  return { pricePence: Math.round(price * 100), date, store: store ? String(store).slice(0, 80) : null };
}

/** Latest GBP price for a barcode from Open Prices, or null on any problem. */
export async function lookupOpenPrice(ctx: Pick<AppContext, 'config' | 'fetch'>, barcode: string) {
  const f = ctx.fetch ?? fetch;
  const url = `${ctx.config.OPEN_PRICES_BASE_URL.replace(/\/$/, '')}/api/v1/prices?product_code=${encodeURIComponent(barcode)}&currency=GBP&order_by=-date&size=1`;
  try {
    const res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': ctx.config.OFF_USER_AGENT }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return parseOpenPrice(await res.json());
  } catch {
    return null;
  }
}

/** Fetch an Open Prices price for a product (by any of its barcodes) and cache it. At most once a week per barcode. */
export async function refreshOpenPrice(ctx: AppContext, householdId: string, productId: string, now: Date, timeZone = 'Europe/London'): Promise<boolean> {
  const codes = await ctx.db.select({ code: barcodes.code }).from(barcodes).where(and(eq(barcodes.householdId, householdId), eq(barcodes.productId, productId)));
  if (!codes.length) return false;
  const today = todayIn(timeZone, now);
  const [recent] = await ctx.db
    .select({ createdAt: prices.createdAt })
    .from(prices)
    .where(and(eq(prices.productId, productId), eq(prices.source, 'open-prices')))
    .orderBy(desc(prices.createdAt))
    .limit(1);
  if (recent && now.getTime() - recent.createdAt.getTime() < OPEN_PRICES_REFRESH_DAYS * 86_400_000) return false;
  for (const { code } of codes) {
    const last = asked.get(code);
    if (last && now.getTime() - last < OPEN_PRICES_REFRESH_DAYS * 86_400_000) continue;
    asked.set(code, now.getTime());
    const p = await lookupOpenPrice(ctx, code);
    if (p && p.date <= today) {
      await ctx.db.insert(prices).values({ householdId, productId, pricePence: p.pricePence, store: p.store, date: p.date, source: 'open-prices', createdAt: now });
      return true;
    }
  }
  return false;
}

/** Daily: for households with pricing on, refresh up to 30 products on the list or with no recent price. */
export async function refreshPrices(ctx: AppContext, now: Date): Promise<number> {
  let found = 0;
  const all = await ctx.db.select().from(households);
  for (const h of all) {
    if (!pricingOn(ctx, h)) continue;
    const today = todayIn(h.timeZone, now);
    const listed = await ctx.db
      .select({ productId: shoppingItems.productId })
      .from(shoppingItems)
      .where(and(eq(shoppingItems.householdId, h.id), eq(shoppingItems.checked, false)));
    const recentlyPriced = new Set(
      (await ctx.db.select({ productId: prices.productId }).from(prices).where(and(eq(prices.householdId, h.id), gte(prices.date, addDays(today, -OWN_PRICE_DAYS))))).map(
        (r) => r.productId,
      ),
    );
    const withCodes = await ctx.db
      .select({ productId: barcodes.productId })
      .from(barcodes)
      .innerJoin(products, eq(products.id, barcodes.productId))
      .where(and(eq(barcodes.householdId, h.id), isNull(products.recipeId)));
    const candidates = [
      ...listed.map((l) => l.productId).filter((x): x is string => Boolean(x)),
      ...withCodes.map((w) => w.productId).filter((id) => !recentlyPriced.has(id)),
    ];
    for (const id of [...new Set(candidates)].slice(0, 30)) {
      if (await refreshOpenPrice(ctx, h.id, id, now, h.timeZone)) found++;
    }
  }
  return found;
}
