/** Turning a scanned barcode into a product: this household's products first, then Open Food Facts, else an unknown product to name later. */
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { expandReceiptText, parsePackQuantity } from '@snackoverflow/shared';
import type { AppContext, Auth } from '../context';
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
  if (existing) return { product: existing, known: existing.name !== null, created: false };

  const off = ctx.config.OFF_ENABLED ? await ctx.off.lookup(code) : null;
  const catalog = await loadCatalog(ctx.db, auth.household.id);
  let values: typeof products.$inferInsert = { householdId: auth.household.id, name: null, source: 'scan' };
  if (off?.name) {
    const ingredient = suggestIngredient(off.name, [...catalog.ingredients.values()], ingredientAliases(ctx.seed));
    const category = ingredient ? null : suggestCategory(off.name, off.categories, [...catalog.categories.values()]);
    const qty = parsePackQuantity(off.quantity);
    values = {
      householdId: auth.household.id,
      name: off.name,
      brand: off.brand,
      imageUrl: off.imageUrl,
      ingredientId: ingredient?.id ?? null,
      shelfLifeCategoryId: category?.id ?? null,
      nutritionPer100g: off.nutritionPer100g,
      source: 'off',
      ...packFields(qty?.amount, qty?.unit, ctx.seed.units, measuresFor(ingredient?.id ?? null, catalog)),
    };
  }

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
