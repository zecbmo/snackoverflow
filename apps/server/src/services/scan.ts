/** Turning a scanned barcode into a product: this household's products first, then Open Food Facts, else an unknown product to name later. */
import { and, eq } from 'drizzle-orm';
import { parsePackQuantity } from '@snackoverflow/shared';
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
