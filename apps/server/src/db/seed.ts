/**
 * Seed data from docs/data: shelf-life categories, ingredients with their unit
 * conversions and pack sizes, and default locations. All numbers come from the CSVs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  parseCsv,
  parsePackSizes,
  parseShelfLifeCsv,
  parseUnitTable,
  type Nutrition,
  type ShelfLifeCategorySeed,
  toGrams,
  type UnitTable,
} from '@snackoverflow/shared';
import type { Db } from './client';
import { households, ingredients, locations, shelfLifeCategories } from './schema';

export interface SeedData {
  units: UnitTable;
  categories: ShelfLifeCategorySeed[];
  ingredients: Record<string, string>[];
  packSizes: Record<string, { sizes: string; unit: string }>;
  /** Typical nutrition per 100g by ingredient key (docs/data/nutrition.csv). */
  nutrition: Record<string, Nutrition>;
}

export function loadSeedData(dir: string): SeedData {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const packSizes: SeedData['packSizes'] = {};
  for (const row of parseCsv(read('pack-sizes.csv'))) {
    if (row.ingredient) packSizes[row.ingredient] = { sizes: row.pack_sizes ?? '', unit: row.unit ?? 'g' };
  }
  const nutrition: SeedData['nutrition'] = {};
  const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : Number(v));
  for (const row of parseCsv(read('nutrition.csv'))) {
    if (row.ingredient) nutrition[row.ingredient] = { kcal: num(row.kcal), protein: num(row.protein), carbs: num(row.carbs), fat: num(row.fat) };
  }
  return {
    nutrition,
    units: parseUnitTable(read('unit-conversions.csv')),
    categories: parseShelfLifeCsv(read('shelf-life-defaults.csv')),
    ingredients: parseCsv(read('ingredients.csv')),
    packSizes,
  };
}

export function categoryName(key: string): string {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const DEFAULT_LOCATIONS = [
  { name: 'Fridge', type: 'fridge', icon: 'fridge' },
  { name: 'Freezer', type: 'freezer', icon: 'snowflake' },
  { name: 'Cupboard', type: 'cupboard', icon: 'cupboard' },
] as const;

/** Seed a household. Safe to run again: existing rows (by key) are left as the user edited them. */
export async function seedHousehold(db: Db, householdId: string, seed: SeedData, opts: { locations?: boolean } = {}) {
  if (seed.categories.length) {
    await db
      .insert(shelfLifeCategories)
      .values(
        seed.categories.map((c) => ({
          householdId,
          key: c.key,
          name: categoryName(c.key),
          examples: c.examples,
          defaultLocation: c.defaultLocation,
          closedDays: c.closedDays,
          openedDays: c.openedDays,
          frozenDays: c.frozenDays,
          defrostedDays: c.defrostedDays,
          freezable: c.freezable,
          source: c.source,
          notes: c.notes,
        })),
      )
      .onConflictDoNothing();
  }

  const cats = await db
    .select({ id: shelfLifeCategories.id, key: shelfLifeCategories.key })
    .from(shelfLifeCategories)
    .where(sql`${shelfLifeCategories.householdId} = ${householdId}`);
  const catId = new Map(cats.map((c) => [c.key, c.id]));

  const rows = seed.ingredients
    .filter((r) => r.key && r.name)
    .map((r) => {
      const densityGPerMl = r.density_key ? (seed.units.densities[r.density_key] ?? null) : null;
      const gramsPerCount = r.count_key ? (seed.units.counts[r.count_key] ?? null) : null;
      const packs = r.pack_sizes_key ? seed.packSizes[r.pack_sizes_key] : undefined;
      const packSizesGrams = packs
        ? parsePackSizes(packs.sizes, packs.unit)
            .map((p) => toGrams(p.amount, p.unit, seed.units, { densityGPerMl, gramsPerCount }))
            .filter((g): g is number => g !== null)
            .map((g) => Math.round(g))
        : null;
      return {
        householdId,
        key: r.key as string,
        name: r.name as string,
        aisle: r.aisle || null,
        shelfLifeCategoryId: (r.shelf_life_category && catId.get(r.shelf_life_category)) || null,
        densityGPerMl,
        gramsPerCount,
        countUnit: r.count_unit || null,
        packSizesGrams: packSizesGrams?.length ? packSizesGrams : null,
        trackRunningLow: r.track_running_low === 'yes',
        nutritionPer100g: seed.nutrition[r.key as string] ?? null,
      };
    });
  if (rows.length) await db.insert(ingredients).values(rows).onConflictDoNothing();

  if (opts.locations) {
    await db.insert(locations).values(DEFAULT_LOCATIONS.map((l, i) => ({ ...l, householdId, sortOrder: i })));
  }
}

/** Alternative names per ingredient key, used to suggest an ingredient for a product. */
export function ingredientAliases(seed: SeedData): Map<string, string[]> {
  return new Map(
    seed.ingredients
      .filter((r) => r.key)
      .map((r) => [r.key as string, (r.aliases ?? '').split(';').map((a) => a.trim().toLowerCase()).filter(Boolean)]),
  );
}

/**
 * On start-up, bring every household up to date with the seed files: add new
 * categories and ingredients, and fill in nutrition that was added later.
 * Nothing the household has edited is overwritten.
 */
export async function syncSeedData(db: Db, seed: SeedData): Promise<void> {
  const all = await db.select({ id: households.id }).from(households);
  for (const h of all) {
    await seedHousehold(db, h.id, seed);
    for (const [key, n] of Object.entries(seed.nutrition)) {
      await db
        .update(ingredients)
        .set({ nutritionPer100g: n })
        .where(and(eq(ingredients.householdId, h.id), eq(ingredients.key, key), isNull(ingredients.nutritionPer100g)));
    }
  }
}
