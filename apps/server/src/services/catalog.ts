/** Ingredients, products and shelf-life categories: lookups, DTOs and suggestions. */
import { and, eq, inArray } from 'drizzle-orm';
import {
  type DisplayUnit,
  type IngredientDto,
  type Measures,
  mergeShelfLife,
  type ProductDto,
  type ShelfLife,
  type ShelfLifeCategoryDto,
  toGrams,
  type UnitTable,
  unitKind,
} from '@snackoverflow/shared';
import type { Db } from '../db/client';
import { barcodes, ingredients, products, shelfLifeCategories } from '../db/schema';

export type CategoryRow = typeof shelfLifeCategories.$inferSelect;
export type IngredientRow = typeof ingredients.$inferSelect;
export type ProductRow = typeof products.$inferSelect;

export interface Catalog {
  categories: Map<string, CategoryRow>;
  ingredients: Map<string, IngredientRow>;
}

export async function loadCatalog(db: Db, householdId: string): Promise<Catalog> {
  const [cats, ings] = await Promise.all([
    db.select().from(shelfLifeCategories).where(eq(shelfLifeCategories.householdId, householdId)),
    db.select().from(ingredients).where(eq(ingredients.householdId, householdId)),
  ]);
  return {
    categories: new Map(cats.map((c) => [c.id, c])),
    ingredients: new Map(ings.map((i) => [i.id, i])),
  };
}

function shelfLifeOf(row: Partial<ShelfLife> | undefined | null): Partial<ShelfLife> | null {
  if (!row) return null;
  return {
    closedDays: row.closedDays ?? null,
    openedDays: row.openedDays ?? null,
    frozenDays: row.frozenDays ?? null,
    defrostedDays: row.defrostedDays ?? null,
    freezable: 'freezable' in row ? (row.freezable ?? null) : null,
  };
}

export function ingredientShelfLife(ing: IngredientRow, catalog: Catalog): ShelfLife {
  const cat = ing.shelfLifeCategoryId ? catalog.categories.get(ing.shelfLifeCategoryId) : undefined;
  return mergeShelfLife(shelfLifeOf(ing), shelfLifeOf(cat));
}

/** Product's own category first, then the ingredient (its own values, then its category). */
export function productShelfLife(product: ProductRow, catalog: Catalog): ShelfLife {
  const cat = product.shelfLifeCategoryId ? catalog.categories.get(product.shelfLifeCategoryId) : undefined;
  const ing = product.ingredientId ? catalog.ingredients.get(product.ingredientId) : undefined;
  const ingCat = ing?.shelfLifeCategoryId ? catalog.categories.get(ing.shelfLifeCategoryId) : undefined;
  return mergeShelfLife(shelfLifeOf(cat), shelfLifeOf(ing), shelfLifeOf(ingCat));
}

export function measuresFor(ingredientId: string | null, catalog: Catalog): Measures {
  const ing = ingredientId ? catalog.ingredients.get(ingredientId) : undefined;
  return { densityGPerMl: ing?.densityGPerMl ?? null, gramsPerCount: ing?.gramsPerCount ?? null };
}

export function packFields(
  amount: number | null | undefined,
  unit: string | null | undefined,
  units: UnitTable,
  measures: Measures,
): { packAmount: number | null; packUnit: string | null; packGrams: number | null; displayUnit: DisplayUnit } {
  if (!amount || !unit) return { packAmount: amount ?? null, packUnit: unit ?? null, packGrams: null, displayUnit: 'g' };
  const kind = unitKind(unit, units);
  const grams = toGrams(amount, unit, units, measures);
  return {
    packAmount: amount,
    packUnit: unit,
    packGrams: grams === null ? null : Math.round(grams * 10) / 10,
    displayUnit: kind === 'volume' ? 'ml' : kind === 'count' ? 'count' : 'g',
  };
}

export function categoryDto(c: CategoryRow): ShelfLifeCategoryDto {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    examples: c.examples,
    defaultLocation: c.defaultLocation,
    closedDays: c.closedDays,
    openedDays: c.openedDays,
    frozenDays: c.frozenDays,
    defrostedDays: c.defrostedDays,
    freezable: c.freezable,
    source: c.source,
    notes: c.notes,
  };
}

export function ingredientDto(i: IngredientRow, catalog: Catalog): IngredientDto {
  return {
    id: i.id,
    key: i.key,
    name: i.name,
    aisle: i.aisle,
    shelfLifeCategoryId: i.shelfLifeCategoryId,
    densityGPerMl: i.densityGPerMl,
    gramsPerCount: i.gramsPerCount,
    countUnit: i.countUnit,
    packUnit: i.packUnit,
    trackRunningLow: i.trackRunningLow,
    shelfLife: ingredientShelfLife(i, catalog),
    overrides: { closedDays: i.closedDays, openedDays: i.openedDays, frozenDays: i.frozenDays, defrostedDays: i.defrostedDays },
  };
}

export function productDto(p: ProductRow, codes: string[], catalog: Catalog, pricePence: number | null = null): ProductDto {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    imageUrl: p.imageUrl,
    barcodes: codes,
    ingredientId: p.ingredientId,
    ingredientName: p.ingredientId ? (catalog.ingredients.get(p.ingredientId)?.name ?? null) : null,
    shelfLifeCategoryId: p.shelfLifeCategoryId,
    packGrams: p.packGrams,
    packAmount: p.packAmount,
    packUnit: p.packUnit,
    displayUnit: p.displayUnit,
    nutritionPer100g: p.nutritionPer100g ?? null,
    learnedClosedDays: p.learnedClosedDays,
    learnedFrozenDays: p.learnedFrozenDays,
    source: p.source,
    pricePence,
    portionGrams: p.portionGrams,
  };
}

export async function barcodesFor(db: Db, productIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (productIds.length === 0) return map;
  const rows = await db.select().from(barcodes).where(inArray(barcodes.productId, productIds));
  for (const r of rows) map.set(r.productId, [...(map.get(r.productId) ?? []), r.code]);
  return map;
}

export async function findProductByBarcode(db: Db, householdId: string, code: string): Promise<ProductRow | null> {
  const [row] = await db
    .select({ product: products })
    .from(barcodes)
    .innerJoin(products, eq(products.id, barcodes.productId))
    .where(and(eq(barcodes.householdId, householdId), eq(barcodes.code, code)))
    .limit(1);
  return row?.product ?? null;
}

function normalise(s: string): string {
  return ` ${s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Suggest the ingredient a product is, from its name: the longest ingredient name
 * or alias found as whole words in the product name wins.
 */
export function suggestIngredient(
  productName: string,
  all: IngredientRow[],
  aliases: Map<string, string[]>,
): IngredientRow | null {
  const name = normalise(productName);
  // Plurals on either side: "Maris Pipers" matches "maris piper", "Chicken Thighs" matches "chicken thigh".
  const singularName = name.replace(/(\w{3,})s /g, '$1 ');
  let best: { ing: IngredientRow; len: number } | null = null;
  for (const ing of all) {
    const terms = [ing.name, ...(ing.key ? (aliases.get(ing.key) ?? []) : [])];
    for (const term of terms) {
      const t = normalise(term);
      const singular = t.replace(/(\w{3,})s /g, '$1 ');
      const hit = name.includes(t) || name.includes(singular) || singularName.includes(singular);
      if (hit && t.length > (best?.len ?? 0)) best = { ing, len: t.length };
    }
  }
  return best?.ing ?? null;
}

/** Suggest a shelf-life category from Open Food Facts category tags or the name, using each category's examples. */
export function suggestCategory(productName: string, offCategories: string[], cats: CategoryRow[]): CategoryRow | null {
  const haystack = normalise([productName, ...offCategories.map((t) => t.replace(/^[a-z]{2}:/, ''))].join(' '));
  let best: { cat: CategoryRow; len: number } | null = null;
  for (const cat of cats) {
    const examples = cat.examples.split(',').map((e) => normalise(e));
    for (const e of examples) {
      const singular = e.endsWith('s ') ? `${e.slice(0, -2)} ` : e;
      if ((haystack.includes(e) || haystack.includes(singular)) && e.length > (best?.len ?? 0)) best = { cat, len: e.length };
    }
  }
  return best?.cat ?? null;
}
