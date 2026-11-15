/** Turning a scanned barcode into a product: this household's products first, then Open Food Facts, else an unknown product to name later. */
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { expandReceiptText, type OffMatchSearchDto, parsePackQuantity, scannedProductName, tidyCapitals } from '@snackoverflow/shared';
import type { AppContext, Auth } from '../context';
import type { OffProduct } from './off';
import { lookupLocalOff, searchLocalOff } from './offDump';
import { barcodes, products } from '../db/schema';
import { ingredientAliases } from '../db/seed';
import { findProductByBarcode, loadCatalog, measuresFor, packFields, type ProductRow, suggestCategory, suggestIngredient } from './catalog';

export interface ResolvedProduct {
  product: ProductRow;
  /** False when nobody has named this barcode yet. */
  known: boolean;
  created: boolean;
}

export async function resolveBarcode(ctx: AppContext, auth: Auth, code: string): Promise<ResolvedProduct> {
  const existing = await findProductByBarcode(ctx.db, auth.household.id, code);
  if (existing && existing.name !== null) {
    // Made from Open Food Facts when it had no pack size: it may have learned it since (and its serving size with it).
    // Only then, so a product that's complete is never looked up again.
    if (existing.source === 'off' && existing.packGrams === null) {
      const filled = await fillFromOff(ctx, auth, existing, code);
      if (filled) return { product: filled, known: true, created: false };
    }
    return { product: existing, known: true, created: false };
  }

  const off = await offFor(ctx, code);
  const catalog = await loadCatalog(ctx.db, auth.household.id);
  if (existing) {
    // Nobody has named it yet: Open Food Facts may know it by now (or was unreachable last time).
    if (!off?.name) return { product: existing, known: false, created: false };
    const [named] = await ctx.db.update(products).set(offValues(ctx, auth, off, catalog)).where(eq(products.id, existing.id)).returning();
    ctx.live.publish(auth.household.id, 'products');
    return { product: named!, known: true, created: false };
  }
  const values: typeof products.$inferInsert = off?.name ? offValues(ctx, auth, off, catalog) : { householdId: auth.household.id, name: null, source: 'scan' };

  // Bought on a receipt but never scanned: link this barcode to that product rather than making a duplicate.
  if (off?.name) {
    const linked = await linkReceiptProduct(ctx, auth, code, off.name, values.ingredientId ?? null, values.packGrams ?? null);
    if (linked) return { product: linked, known: true, created: false };
  }

  const result = await ctx.db.transaction(async (tx) => {
    const [p] = await tx.insert(products).values(values).returning();
    if (!p) throw new Error('Could not save the product');
    const inserted = await tx
      .insert(barcodes)
      .values({ householdId: auth.household.id, code, productId: p.id })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // Someone else scanned the same new barcode at the same moment; use theirs.
      await tx.delete(products).where(eq(products.id, p.id));
      return null;
    }
    return p;
  });
  if (!result) {
    const theirs = await findProductByBarcode(ctx.db, auth.household.id, code);
    if (!theirs) throw new Error('Barcode vanished');
    return { product: theirs, known: theirs.name !== null, created: false };
  }
  ctx.live.publish(auth.household.id, 'products');
  return { product: result, known: result.name !== null, created: true };
}

/**
 * What Open Food Facts knows about a barcode: the local copy first (no network), then their API.
 * When the local copy has the product but not its pack size, the API is asked as well and fills
 * the gaps (the pack size, and the serving size with it): the copy can be a week behind, and
 * without a pack size the amount in stock can't be shown.
 */
async function offFor(ctx: AppContext, code: string): Promise<OffProduct | null> {
  const local = ctx.config.OFF_DUMP_ENABLED ? await lookupLocalOff(ctx.db, code) : null;
  if (local && (local.quantity || !ctx.config.OFF_ENABLED)) return local;
  const live = ctx.config.OFF_ENABLED ? await ctx.off.lookup(code) : null;
  if (!local) return live;
  return live ? { ...local, quantity: live.quantity, servingGrams: local.servingGrams ?? live.servingGrams ?? null } : local;
}

/**
 * Fill in a product's pack size and serving size from Open Food Facts when it has learned them
 * since. Only what's missing: anything the household has set is left alone. Null when there's nothing new.
 */
async function fillFromOff(ctx: AppContext, auth: Auth, existing: ProductRow, code: string): Promise<ProductRow | null> {
  const off = await offFor(ctx, code).catch(() => null);
  if (!off?.name) return null;
  const values = offValues(ctx, auth, off, await loadCatalog(ctx.db, auth.household.id));
  const patch: Partial<typeof products.$inferInsert> = {};
  if (existing.packGrams === null && values.packGrams) {
    patch.packGrams = values.packGrams;
    patch.packAmount = values.packAmount;
    patch.packUnit = values.packUnit;
    patch.displayUnit = values.displayUnit;
  }
  const pack = patch.packGrams ?? existing.packGrams;
  if (existing.servingGrams === null && off.servingGrams && (!pack || off.servingGrams < pack * 0.95)) patch.servingGrams = off.servingGrams;
  if (!Object.keys(patch).length) return null;
  const [updated] = await ctx.db.update(products).set(patch).where(eq(products.id, existing.id)).returning();
  ctx.live.publish(auth.household.id, 'products');
  return updated ?? null;
}

/** A product's fields from Open Food Facts, linked to the household's ingredient or shelf-life category when one fits. */
function offValues(ctx: AppContext, auth: Auth, off: OffProduct, catalog: Awaited<ReturnType<typeof loadCatalog>>): typeof products.$inferInsert {
  const ingredient = suggestIngredient(off.name!, [...catalog.ingredients.values()], ingredientAliases(ctx.seed));
  // Capitals tidied, and the brand in front of a branded thing whose name alone doesn't say what it is (Pringles "Original").
  const name = scannedProductName(off.name!, off.brand, { generic: Boolean(ingredient) });
  const category = ingredient ? null : suggestCategory(off.name!, off.categories, [...catalog.categories.values()]);
  const qty = parsePackQuantity(off.quantity);
  const pack = packFields(qty?.amount, qty?.unit, ctx.seed.units, measuresFor(ingredient?.id ?? null, catalog));
  // The label's serving ("30g"), unless it's the whole pack or more: then the pack is the serving already.
  const serving = off.servingGrams && (!pack.packGrams || off.servingGrams < pack.packGrams * 0.95) ? off.servingGrams : null;
  return {
    householdId: auth.household.id,
    name,
    brand: off.brand ? tidyCapitals(off.brand) : null,
    imageUrl: off.imageUrl,
    ingredientId: ingredient?.id ?? null,
    shelfLifeCategoryId: category?.id ?? null,
    nutritionPer100g: off.nutritionPer100g,
    source: 'off',
    servingGrams: serving,
    ...pack,
  };
}

/**
 * Open Food Facts products by name, for a scanned barcode it doesn't have: the same food under
 * another barcode, whose details can be copied. The local copy first (no network), else their search.
 */
export async function offMatches(ctx: AppContext, auth: Auth, q: string): Promise<OffMatchSearchDto> {
  if (!q.trim()) return { status: 'ok', results: [] };
  let found: OffProduct[] = ctx.config.OFF_DUMP_ENABLED ? await searchLocalOff(ctx.db, q, 12) : [];
  if (!found.length) {
    if (!ctx.config.OFF_ENABLED) return { status: ctx.config.OFF_DUMP_ENABLED ? 'ok' : 'unavailable', results: [] };
    const r = await ctx.off.search(q);
    if (r.status === 'busy') return { status: 'busy', results: [] };
    if (r.status === 'failed') return { status: 'unavailable', results: [] };
    found = r.products.slice(0, 12);
  }
  const catalog = await loadCatalog(ctx.db, auth.household.id);
  return {
    status: 'ok',
    results: found
      .filter((p) => p.name)
      .map((p) => {
        const v = offValues(ctx, auth, p, catalog);
        return {
          barcode: p.barcode,
          name: v.name!,
          brand: v.brand ?? null,
          quantity: p.quantity,
          packAmount: v.packGrams ? (v.packAmount ?? null) : null,
          packUnit: v.packGrams ? (v.packUnit ?? null) : null,
          ingredientId: v.ingredientId ?? null,
          nutritionPer100g: p.nutritionPer100g,
          kcalPer100g: p.nutritionPer100g?.kcal != null ? Math.round(p.nutritionPer100g.kcal) : null,
          servingGrams: v.servingGrams ?? null,
          imageUrl: p.imageUrl,
        };
      }),
  };
}

export async function productById(ctx: AppContext, auth: Auth, id: string): Promise<ProductRow | null> {
  const [p] = await ctx.db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.householdId, auth.household.id)));
  return p ?? null;
}

function nameWords(s: string): Set<string> {
  return new Set(expandReceiptText(s).split(' ').filter((w) => w.length > 2 && !/^\d/.test(w)).map((w) => w.replace(/s$/, '')));
}

async function linkReceiptProduct(ctx: AppContext, auth: Auth, code: string, name: string, ingredientId: string | null, packGrams: number | null): Promise<ProductRow | null> {
  const withCodes = ctx.db.select({ id: barcodes.productId }).from(barcodes).where(eq(barcodes.householdId, auth.household.id));
  const candidates = await ctx.db
    .select()
    .from(products)
    .where(and(eq(products.householdId, auth.household.id), eq(products.source, 'receipt'), isNull(products.recipeId), notInArray(products.id, withCodes)));
  const want = nameWords(name);
  let best: { p: ProductRow; score: number } | null = null;
  for (const p of candidates) {
    if (ingredientId && p.ingredientId && p.ingredientId !== ingredientId) continue;
    // A different pack size is a different product (2 pints vs 4 pints).
    if (packGrams && p.packGrams && Math.abs(packGrams - p.packGrams) / Math.max(packGrams, p.packGrams) > 0.1) continue;
    const have = nameWords(p.name ?? '');
    let common = 0;
    for (const w of want) if (have.has(w)) common++;
    const score = want.size && have.size ? common / Math.min(want.size, have.size) : 0;
    if (score > (best?.score ?? 0)) best = { p, score };
  }
  if (!best || best.score < 0.6) return null;
  const inserted = await ctx.db.insert(barcodes).values({ householdId: auth.household.id, code, productId: best.p.id }).onConflictDoNothing().returning();
  if (!inserted.length) return null;
  ctx.live.publish(auth.household.id, 'products');
  return best.p;
}
