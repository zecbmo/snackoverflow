/** Recipes: saving, matching lines to ingredients, grams and nutrition. */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  amountText,
  normaliseUnit,
  type Nutrition,
  parseIngredientLine,
  type RecipeDraftDto,
  type RecipeDto,
  type RecipeIngredientDto,
  type RecipeIngredientInput,
  type RecipeInput,
  recipeNutrition,
  type RecipeSummaryDto,
  type SwapOptionDto,
  toGrams,
  type UnitTable,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { ingredients, products, recipeIngredients, recipes, stockItems } from '../db/schema';
import { ingredientAliases, type SeedData } from '../db/seed';
import { notFound } from '../http';
import { type Catalog, type IngredientRow, loadCatalog, type ProductRow, suggestIngredient } from './catalog';
import { excludedPairs, pairKey } from './swapGroups';

type RecipeRow = typeof recipes.$inferSelect;
type LineRow = typeof recipeIngredients.$inferSelect;

/** Grams for a recipe amount, using the ingredient's density or weight per item. */
export function lineGrams(amount: number | null | undefined, unit: string | null | undefined, ingredient: IngredientRow | undefined, units: UnitTable): number | null {
  if (!amount || !unit) return null;
  const u = normaliseUnit(unit);
  const measures = { densityGPerMl: ingredient?.densityGPerMl ?? null, gramsPerCount: ingredient?.gramsPerCount ?? null };
  const g = toGrams(amount, u, units, measures);
  return g === null ? null : Math.round(g * 10) / 10;
}

/**
 * Work out grams again for every recipe line linked to these ingredients, after one gained a
 * weight per item or a density (or a line was linked to it). Returns how many lines changed.
 */
export async function recomputeLineGrams(db: Db, householdId: string, ingredientIds: string[], units: UnitTable): Promise<number> {
  if (!ingredientIds.length) return 0;
  const ings = new Map((await db.select().from(ingredients).where(inArray(ingredients.id, ingredientIds))).map((i) => [i.id, i]));
  const lines = await db
    .select({ id: recipeIngredients.id, amount: recipeIngredients.amount, unit: recipeIngredients.unit, ingredientId: recipeIngredients.ingredientId, grams: recipeIngredients.grams })
    .from(recipeIngredients)
    .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
    .where(and(eq(recipes.householdId, householdId), inArray(recipeIngredients.ingredientId, ingredientIds)));
  let changed = 0;
  for (const l of lines) {
    const grams = lineGrams(l.amount, l.unit, ings.get(l.ingredientId!), units);
    if (grams === l.grams) continue;
    await db.update(recipeIngredients).set({ grams }).where(eq(recipeIngredients.id, l.id));
    changed++;
  }
  return changed;
}

/** Fill in amount, unit and ingredient from the text for lines that left them out (assistants, AI). */
export function completeRecipeLines(input: RecipeInput, catalog: Catalog, seed: SeedData): RecipeInput {
  return {
    ...input,
    ingredients: input.ingredients.map((l) => {
      if (l.ingredientId && catalog.ingredients.has(l.ingredientId) && l.amount != null) return l;
      const d = draftLine(l.text, catalog, seed);
      return {
        ...l,
        amount: l.amount ?? d.amount,
        unit: l.unit ?? d.unit,
        ingredientId: l.ingredientId && catalog.ingredients.has(l.ingredientId) ? l.ingredientId : d.ingredientId,
        note: l.note ?? d.note,
      };
    }),
  };
}

/** Read a line as written and suggest which ingredient it is. */
export function draftLine(text: string, catalog: Catalog, seed: SeedData): RecipeDraftDto['ingredients'][number] {
  const p = parseIngredientLine(text);
  const all = [...catalog.ingredients.values()];
  const match = suggestIngredient(p.name, all, ingredientAliases(seed));
  // A match on the whole name is confident; one found only inside a longer description less so.
  const confidence: 'high' | 'low' | 'none' = !match
    ? 'none'
    : p.name.toLowerCase().replace(/s$/, '').trim() === match.name.toLowerCase().replace(/s$/, '').trim() || p.name.split(' ').length <= 3
      ? 'high'
      : 'low';
  return {
    text,
    amount: p.amount,
    unit: p.unit,
    ingredientId: match?.id ?? null,
    ingredientName: match?.name ?? null,
    productId: null,
    note: p.note,
    optional: p.optional,
    matchConfidence: confidence,
  };
}

export async function saveRecipe(db: Db, auth: Auth, seed: SeedData, input: RecipeInput, id?: string): Promise<string> {
  const catalog = await loadCatalog(db, auth.household.id);
  return db.transaction(async (tx) => {
    let recipeId = id;
    const values = {
      title: input.title,
      serves: input.serves,
      steps: input.steps,
      imageUrl: input.imageUrl ?? null,
      sourceUrl: input.sourceUrl ?? null,
      tags: [...new Set(input.tags)],
      prepMinutes: input.prepMinutes ?? null,
      cookMinutes: input.cookMinutes ?? null,
    };
    if (recipeId) {
      const updated = await tx
        .update(recipes)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(recipes.id, recipeId), eq(recipes.householdId, auth.household.id)))
        .returning({ id: recipes.id });
      if (updated.length === 0) throw notFound('No such recipe.');
      await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId));
    } else {
      const [r] = await tx
        .insert(recipes)
        .values({ ...values, householdId: auth.household.id, createdBy: auth.user.id })
        .returning({ id: recipes.id });
      recipeId = r!.id;
    }
    if (input.ingredients.length) {
      await tx.insert(recipeIngredients).values(
        input.ingredients.map((l: RecipeIngredientInput, i) => {
          const ingredient = l.ingredientId ? catalog.ingredients.get(l.ingredientId) : undefined;
          return {
            recipeId: recipeId!,
            position: i,
            text: l.text,
            amount: l.amount ?? null,
            unit: l.unit ?? null,
            ingredientId: ingredient ? ingredient.id : null,
            productId: l.productId ?? null,
            note: l.note ?? null,
            optional: l.optional,
            grams: lineGrams(l.amount, l.unit, ingredient, seed.units),
          };
        }),
      );
    }
    return recipeId!;
  });
}

/**
 * Food in stock that could stand in for an ingredient the recipe is short of: `close` from the
 * same swap group (tenderstem for broccoli), `loose` from the same category (pork for chicken).
 */
export function swapOptions(ingredientId: string, stockGrams: Map<string, number>, catalog: Catalog, excluded: Set<string> = new Set()): RecipeIngredientDto['swaps'] {
  const ing = catalog.ingredients.get(ingredientId);
  if (!ing) return { close: [], loose: [] };
  const option = (i: IngredientRow): SwapOptionDto => ({ ingredientId: i.id, name: i.name, inStockGrams: Math.round(stockGrams.get(i.id) ?? 0), amount: amountText(stockGrams.get(i.id) ?? 0, i) });
  // Pairs the household said aren't swaps (pesto for stock cubes) are never offered.
  const inStock = [...catalog.ingredients.values()].filter((i) => i.id !== ing.id && (stockGrams.get(i.id) ?? 0) > 0 && !excluded.has(pairKey(ing.id, i.id))).sort((a, b) => (stockGrams.get(b.id) ?? 0) - (stockGrams.get(a.id) ?? 0));
  const close = ing.swapGroupId ? inStock.filter((i) => i.swapGroupId === ing.swapGroupId) : [];
  const loose = ing.foodGroup ? inStock.filter((i) => i.foodGroup === ing.foodGroup && !close.includes(i)) : [];
  return { close: close.slice(0, 4).map(option), loose: loose.slice(0, 4).map(option) };
}

interface Context {
  catalog: Catalog;
  productsById: Map<string, ProductRow>;
  /** Average nutrition of products linked to each ingredient, for ingredients with none of their own. */
  productNutrition: Map<string, Nutrition>;
  stockGrams: Map<string, number>;
}

async function context(db: Db, householdId: string): Promise<Context> {
  const catalog = await loadCatalog(db, householdId);
  const allProducts = await db.select().from(products).where(eq(products.householdId, householdId));
  const productsById = new Map(allProducts.map((p) => [p.id, p]));
  const sums = new Map<string, { n: number; total: Nutrition }>();
  for (const p of allProducts) {
    if (!p.ingredientId || p.nutritionPer100g?.kcal == null) continue;
    const s = sums.get(p.ingredientId) ?? { n: 0, total: {} };
    s.n++;
    for (const [k, v] of Object.entries(p.nutritionPer100g)) if (typeof v === 'number') s.total[k as keyof Nutrition] = (s.total[k as keyof Nutrition] ?? 0) + v;
    sums.set(p.ingredientId, s);
  }
  const productNutrition = new Map(
    [...sums].map(([k, s]) => [k, Object.fromEntries(Object.entries(s.total).map(([n, v]) => [n, (v as number) / s.n])) as Nutrition]),
  );
  const stock = await db
    .select({ productId: stockItems.productId, remaining: stockItems.remainingGrams })
    .from(stockItems)
    .where(and(eq(stockItems.householdId, householdId), isNull(stockItems.finishedAt)));
  const stockGrams = new Map<string, number>();
  for (const s of stock) {
    const ing = productsById.get(s.productId)?.ingredientId;
    if (ing && s.remaining !== null) stockGrams.set(ing, (stockGrams.get(ing) ?? 0) + s.remaining);
  }
  return { catalog, productsById, productNutrition, stockGrams };
}

function nutritionFor(line: LineRow, ctx: Context): Nutrition | null {
  const product = line.productId ? ctx.productsById.get(line.productId) : undefined;
  if (product?.nutritionPer100g?.kcal != null) return product.nutritionPer100g;
  const ing = line.ingredientId ? ctx.catalog.ingredients.get(line.ingredientId) : undefined;
  if (ing?.nutritionPer100g?.kcal != null) return ing.nutritionPer100g;
  return line.ingredientId ? (ctx.productNutrition.get(line.ingredientId) ?? null) : null;
}

function summary(r: RecipeRow, lines: LineRow[], ctx: Context): RecipeSummaryDto & { nutrition: ReturnType<typeof recipeNutrition> } {
  const nutrition = recipeNutrition(
    lines.filter((l) => !l.optional).map((l) => ({ grams: l.grams, per100g: nutritionFor(l, ctx) })),
    r.serves,
  );
  const total = (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);
  return {
    id: r.id,
    title: r.title,
    serves: r.serves,
    imageUrl: r.imageUrl,
    tags: r.tags,
    totalMinutes: total || null,
    // Only claim a calorie figure when most of the recipe is known.
    kcalPerServing: nutrition.coverage >= 0.6 && nutrition.perServing.kcal != null ? Math.round(nutrition.perServing.kcal) : null,
    ingredientCount: lines.length,
    nutrition,
  };
}

export async function listRecipes(db: Db, auth: Auth): Promise<RecipeSummaryDto[]> {
  const rows = await db.select().from(recipes).where(eq(recipes.householdId, auth.household.id)).orderBy(asc(recipes.title));
  if (rows.length === 0) return [];
  const lines = await db
    .select()
    .from(recipeIngredients)
    .where(inArray(recipeIngredients.recipeId, rows.map((r) => r.id)));
  const ctx = await context(db, auth.household.id);
  return rows.map((r) => {
    const { nutrition: _n, ...s } = summary(r, lines.filter((l) => l.recipeId === r.id), ctx);
    return s;
  });
}

export async function getRecipe(db: Db, auth: Auth, id: string): Promise<RecipeDto> {
  const [r] = await db.select().from(recipes).where(and(eq(recipes.id, id), eq(recipes.householdId, auth.household.id)));
  if (!r) throw notFound('No such recipe.');
  const lines = await db.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, id)).orderBy(asc(recipeIngredients.position));
  const [ctx, excluded] = await Promise.all([context(db, auth.household.id), excludedPairs(db, auth.household.id)]);
  const s = summary(r, lines, ctx);
  const ingredients: RecipeIngredientDto[] = lines.map((l) => ({
    id: l.id,
    position: l.position,
    text: l.text,
    amount: l.amount,
    unit: l.unit,
    ingredientId: l.ingredientId,
    ingredientName: l.ingredientId ? (ctx.catalog.ingredients.get(l.ingredientId)?.name ?? null) : null,
    productId: l.productId,
    productName: l.productId ? (ctx.productsById.get(l.productId)?.name ?? null) : null,
    note: l.note,
    optional: l.optional,
    grams: l.grams,
    inStockGrams: l.ingredientId ? (ctx.stockGrams.get(l.ingredientId) ?? 0) : null,
    swaps:
      l.ingredientId && l.grams && !l.optional && (ctx.stockGrams.get(l.ingredientId) ?? 0) < l.grams
        ? swapOptions(l.ingredientId, ctx.stockGrams, ctx.catalog, excluded)
        : { close: [], loose: [] },
  }));
  const { nutrition, ...rest } = s;
  return {
    ...rest,
    steps: r.steps,
    sourceUrl: r.sourceUrl,
    prepMinutes: r.prepMinutes,
    cookMinutes: r.cookMinutes,
    ingredients,
    nutritionPerServing: nutrition.perServing,
    nutritionCoverage: Math.round(nutrition.coverage * 100) / 100,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function deleteRecipe(db: Db, auth: Auth, id: string): Promise<void> {
  const gone = await db
    .delete(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.householdId, auth.household.id)))
    .returning({ id: recipes.id });
  if (gone.length === 0) throw notFound('No such recipe.');
}

/** Turn plain recipe lines into a reviewable draft. */
export async function draftLines(db: Db, auth: Auth, seed: SeedData, lines: string[]) {
  const catalog = await loadCatalog(db, auth.household.id);
  return lines.map((t) => t.trim()).filter(Boolean).map((t) => draftLine(t, catalog, seed));
}
