/**
 * Adding stock by hand, several things at once, without scanning: each line is a product, a
 * food (ingredient) or just a name. A food uses the product the household bought last time for
 * it; anything never seen before becomes a simple product so it's remembered next time. Every
 * pack is added the usual way (estimated best-before, a stock event each, so Undo works).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ManualAddLine, StockChangeDto, UnitTable } from '@snackoverflow/shared';
import { products, stockItems } from '../db/schema';
import { notFound } from '../http';
import { type Catalog, loadCatalog, measuresFor, packFields, type ProductRow } from './catalog';
import { addPack, type StockDeps, usualLocationId } from './stock';

async function productFor(deps: StockDeps, units: UnitTable, catalog: Catalog, line: ManualAddLine): Promise<ProductRow> {
  const { db, auth } = deps;
  const household = auth.household.id;
  if (line.productId) {
    const [p] = await db.select().from(products).where(and(eq(products.id, line.productId), eq(products.householdId, household)));
    if (!p) throw notFound('No such product.');
    return p;
  }
  const mine = (await db.select().from(products).where(and(eq(products.householdId, household), isNull(products.recipeId)))).filter((p) => p.name);
  const text = line.text?.trim().toLowerCase();
  // Typed text that is exactly a food's name counts as that food.
  const ingredientId = line.ingredientId ?? (text ? ([...catalog.ingredients.values()].find((i) => i.name.toLowerCase() === text)?.id ?? null) : null);
  if (ingredientId) {
    const ing = catalog.ingredients.get(ingredientId);
    if (!ing) throw notFound('No such food.');
    const [recent] = await db
      .select({ product: products })
      .from(stockItems)
      .innerJoin(products, eq(products.id, stockItems.productId))
      .where(and(eq(stockItems.householdId, household), eq(products.ingredientId, ingredientId), isNull(products.recipeId)))
      .orderBy(desc(stockItems.addedAt))
      .limit(1);
    if (recent) return recent.product;
    const known = mine.filter((p) => p.ingredientId === ingredientId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (known) return known;
    const smallest = ing.packSizesGrams?.length ? Math.min(...ing.packSizesGrams) : null;
    return create(deps, { name: ing.name, ingredientId, ...packFields(smallest, smallest ? 'g' : null, units, measuresFor(ingredientId, catalog)) });
  }
  const byName = mine.find((p) => p.name!.toLowerCase() === text);
  if (byName) return byName;
  return create(deps, { name: line.text!.trim(), ingredientId: null, ...packFields(null, null, units, measuresFor(null, catalog)) });
}

async function create(deps: StockDeps, values: { name: string; ingredientId: string | null } & ReturnType<typeof packFields>): Promise<ProductRow> {
  const [p] = await deps.db
    .insert(products)
    .values({ householdId: deps.auth.household.id, source: 'manual', ...values })
    .returning();
  return p!;
}

export async function addByHand(deps: StockDeps, units: UnitTable, lines: ManualAddLine[]): Promise<StockChangeDto[]> {
  const catalog = await loadCatalog(deps.db, deps.auth.household.id);
  const changes: StockChangeDto[] = [];
  for (const line of lines) {
    const product = await productFor(deps, units, catalog, line);
    const locationId = line.locationId ?? (await usualLocationId(deps, product, catalog));
    if (!locationId) throw notFound('Add a place to keep food first (Settings, Locations).');
    for (let i = 0; i < line.count; i++) {
      changes.push(await addPack(deps, { product, locationId, bestBefore: line.bestBefore ?? undefined, catalog }));
    }
  }
  return changes;
}
