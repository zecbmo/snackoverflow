/**
 * Unmatched recipe lines: lines the app can't check against stock or put on the shopping list,
 * because they aren't linked to an ingredient, or they're counted ("1 sachet") and the ingredient
 * has no weight per item, or their ingredient has no nutrition (so calories leave it out). Lines naming
 * the same food are grouped so one fix covers every recipe.
 * They're fixed by hand in Settings, from AI suggestions the household reviews, or over MCP.
 */
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { foodKey, type UnmatchedFix, type UnmatchedFixResultDto, type UnmatchedGroupDto, unitKind, type UnitTable } from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { households, ingredients, products, recipeIngredients, recipes } from '../db/schema';
import { badRequest } from '../http';
import { householdSettings } from './household';
import { type IngredientRow, ingredientValues, loadCatalog } from './catalog';
import { recomputeLineGrams } from './recipes';

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Every group of unmatched lines, ignored ones included (flagged), most-used first. */
export async function listUnmatched(db: Db, auth: Auth, units: UnitTable): Promise<UnmatchedGroupDto[]> {
  const [rows, [household], catalog] = await Promise.all([
    db
      .select({ line: recipeIngredients, title: recipes.title })
      .from(recipeIngredients)
      .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
      .where(
        and(
          eq(recipes.householdId, auth.household.id),
          eq(recipeIngredients.optional, false),
          isNull(recipeIngredients.productId),
          or(
            isNull(recipeIngredients.ingredientId),
            and(isNull(recipeIngredients.grams), isNotNull(recipeIngredients.amount), isNotNull(recipeIngredients.unit)),
          ),
        ),
      )
      .orderBy(asc(recipes.title), asc(recipeIngredients.position)),
    db.select().from(households).where(eq(households.id, auth.household.id)),
    loadCatalog(db, auth.household.id),
  ]);
  // Ingredients whose calories come from a product the household has bought don't need their own.
  const fromProducts = new Set(
    (await db.select({ ingredientId: products.ingredientId, n: products.nutritionPer100g }).from(products).where(eq(products.householdId, auth.household.id)))
      .filter((p) => p.ingredientId && p.n?.kcal != null)
      .map((p) => p.ingredientId!),
  );
  const unweighed = await db
    .select({ line: recipeIngredients, title: recipes.title })
    .from(recipeIngredients)
    .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
    .where(and(eq(recipes.householdId, auth.household.id), eq(recipeIngredients.optional, false), isNotNull(recipeIngredients.ingredientId), isNotNull(recipeIngredients.grams)))
    .orderBy(asc(recipes.title), asc(recipeIngredients.position));
  const ignored = new Set(household ? householdSettings(household).ignoredFoods : []);
  const groups = new Map<string, UnmatchedGroupDto>();
  for (const { line, title } of rows) {
    const ing = line.ingredientId ? catalog.ingredients.get(line.ingredientId) : undefined;
    let key: string;
    let problem: UnmatchedGroupDto['problem'];
    let name: string;
    if (!ing) {
      key = foodKey(line.text);
      problem = 'unlinked';
      name = capitalise(key);
    } else {
      problem = unitKind(line.unit!, units) === 'count' ? 'noWeight' : 'unknownUnit';
      key = `${problem}:${ing.id}`;
      name = ing.name;
    }
    const g = groups.get(key) ?? { key, name, problem, ingredientId: ing?.id ?? null, ingredientName: ing?.name ?? null, ignored: ignored.has(key), lines: [] };
    g.lines.push({ id: line.id, recipeId: line.recipeId, recipeTitle: title, text: line.text, amount: line.amount, unit: line.unit });
    groups.set(key, g);
  }
  for (const { line, title } of unweighed) {
    const ing = catalog.ingredients.get(line.ingredientId!);
    if (!ing || ing.nutritionPer100g?.kcal != null || fromProducts.has(ing.id)) continue;
    const key = `noNutrition:${ing.id}`;
    const g = groups.get(key) ?? { key, name: ing.name, problem: 'noNutrition' as const, ingredientId: ing.id, ingredientName: ing.name, ignored: ignored.has(key), lines: [] };
    g.lines.push({ id: line.id, recipeId: line.recipeId, recipeTitle: title, text: line.text, amount: line.amount, unit: line.unit });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Number(a.ignored) - Number(b.ignored) || b.lines.length - a.lines.length || a.name.localeCompare(b.name));
}

/**
 * Apply fixes in one go: link each fix's lines to an ingredient (making it first when it's new;
 * a new one with the same name as an existing ingredient reuses that), set the weight per item
 * if given, then work out grams again for every line of the ingredients touched.
 */
export async function applyUnmatchedFixes(db: Db, auth: Auth, units: UnitTable, fixes: UnmatchedFix[]): Promise<UnmatchedFixResultDto> {
  return db.transaction(async (tx) => {
    const catalog = await loadCatalog(tx, auth.household.id);
    const byName = new Map([...catalog.ingredients.values()].map((i) => [i.name.trim().toLowerCase(), i]));
    const result: UnmatchedFixResultDto = { linked: 0, created: [] };
    const touched = new Set<string>();
    for (const fix of fixes) {
      let ing: IngredientRow | undefined;
      if (fix.ingredientId) {
        ing = catalog.ingredients.get(fix.ingredientId);
        if (!ing) throw badRequest('That ingredient no longer exists.');
      } else {
        const input = fix.newIngredient!;
        if (input.shelfLifeCategoryId && !catalog.categories.has(input.shelfLifeCategoryId)) throw badRequest('No such shelf-life category.');
        ing = byName.get(input.name.trim().toLowerCase());
        if (!ing) {
          [ing] = await tx
            .insert(ingredients)
            .values({ ...ingredientValues(input), name: input.name.trim(), householdId: auth.household.id })
            .returning();
          byName.set(ing!.name.toLowerCase(), ing!);
          result.created.push({ id: ing!.id, name: ing!.name });
        }
      }
      if (fix.gramsPerCount || fix.nutritionPer100g) {
        const set = { ...(fix.gramsPerCount ? { gramsPerCount: fix.gramsPerCount } : {}), ...(fix.nutritionPer100g ? { nutritionPer100g: fix.nutritionPer100g } : {}) };
        [ing] = await tx.update(ingredients).set(set).where(eq(ingredients.id, ing!.id)).returning();
      }
      // Only lines from this household's recipes.
      const mine = await tx
        .select({ id: recipeIngredients.id })
        .from(recipeIngredients)
        .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
        .where(and(eq(recipes.householdId, auth.household.id), inArray(recipeIngredients.id, fix.lineIds)));
      if (mine.length) {
        await tx
          .update(recipeIngredients)
          .set({ ingredientId: ing!.id })
          .where(inArray(recipeIngredients.id, mine.map((m) => m.id)));
      }
      result.linked += mine.length;
      touched.add(ing!.id);
    }
    await recomputeLineGrams(tx, auth.household.id, [...touched], units);
    return result;
  });
}

/** Mark groups (by key) as fine to leave unmatched ("water"), or bring them back. */
export async function setUnmatchedIgnored(db: Db, auth: Auth, keys: string[], ignored: boolean): Promise<void> {
  const [h] = await db.select().from(households).where(eq(households.id, auth.household.id));
  if (!h) return;
  const current = new Set(householdSettings(h).ignoredFoods);
  for (const k of keys) {
    if (ignored) current.add(k);
    else current.delete(k);
  }
  await db
    .update(households)
    .set({ settings: { ...(h.settings ?? {}), ignoredFoods: [...current].slice(-1000) } })
    .where(eq(households.id, h.id));
}
