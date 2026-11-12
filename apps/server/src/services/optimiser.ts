/**
 * Feeds the optimiser (packages/shared/src/optimiser.ts) with the household's
 * real data: stock lots, what the shopping list will bring, planned meals,
 * recipes, recent cooking (no repeats), leftovers and, when pricing is on, prices.
 */
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  amountText,
  addDays,
  type CalendarDate,
  type Lot,
  type Need,
  planWeek,
  rankRecipes,
  type RankRules,
  type RecipeScore,
  riskWeight,
  type ScoringRecipe,
  scoreRecipe,
  surplusLots,
  surplusSummary,
  todayIn,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { cooks, locations, mealPlanEntries, products, recipeIngredients, recipes, shoppingItems, stockItems } from '../db/schema';
import { type Catalog, ingredientShelfLife, loadCatalog } from './catalog';
import { householdSettings } from './household';
import { earmarks } from './planner';
import { ingredientPrices } from './pricing';

export interface MealOption {
  kind: 'stock';
  stockItemId: string;
  title: string;
  portions: number;
  locationName: string;
  frozen: boolean;
  bestBefore: CalendarDate | null;
  reason: string;
  score: number;
}

interface Data {
  today: CalendarDate;
  catalog: Catalog;
  lots: Lot[];
  needs: Need[];
  recipes: ScoringRecipe[];
  rules: RankRules;
  meals: MealOption[];
  priceOf?: (ingredientId: string, grams: number) => number | null;
  amountText: (ingredientId: string, grams: number) => string;
}

async function gather(db: Db, auth: Auth, now: Date, pricingDefault: boolean): Promise<Data> {
  const today = todayIn(auth.household.timeZone, now);
  const settings = householdSettings(auth.household, pricingDefault);
  const catalog = await loadCatalog(db, auth.household.id);

  // Stock lots (cooked meals are handled separately, as meal options).
  const stock = await db
    .select({ item: stockItems, product: products, location: locations })
    .from(stockItems)
    .innerJoin(products, eq(products.id, stockItems.productId))
    .innerJoin(locations, eq(locations.id, stockItems.locationId))
    .where(and(eq(stockItems.householdId, auth.household.id), isNull(stockItems.finishedAt)));
  const lots: Lot[] = [];
  const meals: MealOption[] = [];
  for (const { item, product, location } of stock) {
    if (product.recipeId) {
      const portions = item.remainingGrams && product.portionGrams ? Math.floor((item.remainingGrams / product.portionGrams) * 2) / 2 : 1;
      if (portions <= 0) continue;
      const frozen = item.state === 'frozen';
      // Leftovers in the fridge come first; freezer portions are favoured over cooking something that saves nothing.
      const score = frozen ? 1 : 2 + riskWeight({ bestBefore: item.bestBefore, frozen: false, coming: false }, today) * 3;
      meals.push({
        kind: 'stock',
        stockItemId: item.id,
        title: product.name ?? 'Leftovers',
        portions,
        locationName: location.name,
        frozen,
        bestBefore: item.bestBefore,
        reason: frozen ? `From your ${location.name.toLowerCase()}: ${portions} portion${portions === 1 ? '' : 's'} ready to go.` : `Leftovers in the ${location.name.toLowerCase()}, best eaten by ${item.bestBefore ?? 'soon'}.`,
        score,
      });
      continue;
    }
    if (!product.ingredientId) continue;
    const grams = item.remainingGrams ?? (product.packGrams ? product.packGrams * item.fractionLeft : null);
    if (!grams) continue;
    lots.push({ ingredientId: product.ingredientId, grams, bestBefore: item.bestBefore, frozen: item.state === 'frozen', coming: false });
  }

  // What the shopping list will bring in.
  const list = await db.select().from(shoppingItems).where(and(eq(shoppingItems.householdId, auth.household.id), eq(shoppingItems.checked, false)));
  for (const i of list) {
    if (!i.ingredientId || !i.packGrams) continue;
    const ing = catalog.ingredients.get(i.ingredientId);
    const days = ing ? ingredientShelfLife(ing, catalog).closedDays : null;
    lots.push({ ingredientId: i.ingredientId, grams: i.packGrams * i.packs, bestBefore: days !== null ? addDays(today, days) : null, frozen: false, coming: true });
  }

  const needs: Need[] = (await earmarks(db, auth, today)).flatMap((m) => m.meals.map((meal) => ({ ingredientId: m.ingredientId, grams: meal.grams, date: meal.date })));

  const rows = await db.select().from(recipes).where(eq(recipes.householdId, auth.household.id));
  const lines = rows.length ? await db.select().from(recipeIngredients).where(inArray(recipeIngredients.recipeId, rows.map((r) => r.id))) : [];
  const scoring: ScoringRecipe[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    serves: r.serves,
    tags: r.tags,
    lines: lines
      .filter((l) => l.recipeId === r.id)
      .map((l) => ({ ingredientId: l.ingredientId, name: (l.ingredientId && catalog.ingredients.get(l.ingredientId)?.name) || l.text, grams: l.grams, optional: l.optional })),
  }));

  // No repeats: cooked or planned within the household's no-repeat window.
  const since = addDays(today, -settings.noRepeatDays);
  const recent = new Set<string>();
  const cooked = await db.select({ recipeId: cooks.recipeId, at: cooks.createdAt }).from(cooks).where(and(eq(cooks.householdId, auth.household.id), isNull(cooks.undoneAt)));
  for (const c of cooked) if (c.recipeId && todayIn(auth.household.timeZone, c.at) >= since) recent.add(c.recipeId);
  const planned = await db
    .select({ recipeId: mealPlanEntries.recipeId })
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.householdId, auth.household.id), gte(mealPlanEntries.date, since), lte(mealPlanEntries.date, addDays(today, settings.noRepeatDays))));
  for (const p of planned) if (p.recipeId) recent.add(p.recipeId);

  let priceOf: Data['priceOf'];
  if (settings.pricingEnabled) {
    const table = await ingredientPrices(db, auth.household.id);
    {
      // Shops sell whole packs, so an extra costs whole packs.
      priceOf = (ingredientId, grams) => {
        const p = table.get(ingredientId);
        return p ? Math.ceil(grams / p.packGrams) * p.packPence : null;
      };
    }
  }

  return {
    today,
    catalog,
    lots,
    needs,
    recipes: scoring,
    rules: { recent, excludedTags: settings.excludedTags, maxExtraIngredients: settings.maxExtraIngredients },
    meals: meals.sort((a, b) => b.score - a.score),
    priceOf,
    amountText: (ingredientId, grams) => amountText(grams, catalog.ingredients.get(ingredientId)),
  };
}

/** Every recipe scored against today's surplus: for Cook now / Nearly there / Use it up. */
export async function scoreAllRecipes(db: Db, auth: Auth, now: Date, pricingDefault: boolean): Promise<{ on: CalendarDate; scores: RecipeScore[] }> {
  const d = await gather(db, auth, now, pricingDefault);
  const surplus = surplusLots(d.lots, d.needs);
  return { on: d.today, scores: d.recipes.map((r) => scoreRecipe(r, surplus, { on: d.today, priceOf: d.priceOf, amountText: d.amountText })) };
}

/** "Suggest meals": the best recipes for a day, plus leftovers and freezer portions to eat. */
export async function suggest(
  db: Db,
  auth: Auth,
  now: Date,
  pricingDefault: boolean,
  opts: { date?: CalendarDate; servings?: number; ingredientId?: string; limit?: number },
): Promise<{ date: CalendarDate; recipes: RecipeScore[]; meals: MealOption[] }> {
  const d = await gather(db, auth, now, pricingDefault);
  const date = opts.date && opts.date >= d.today ? opts.date : d.today;
  const surplus = surplusLots(d.lots, d.needs);
  let ranked = rankRecipes(d.recipes, surplus, { on: date, servings: opts.servings, priceOf: d.priceOf, amountText: d.amountText }, d.rules);
  if (opts.ingredientId) ranked = ranked.filter((r) => r.uses.some((u) => u.ingredientId === opts.ingredientId));
  const meals = d.meals.filter((m) => m.frozen || !m.bestBefore || m.bestBefore >= date);
  return { date, recipes: ranked.slice(0, opts.limit ?? 6), meals: opts.ingredientId ? [] : meals.slice(0, 3) };
}

export interface WeekPickDto {
  date: CalendarDate;
  slot: string;
  kind: 'recipe' | 'stock';
  recipeId: string | null;
  stockItemId: string | null;
  title: string;
  reason: string;
  missing: string[];
  alternatives: { recipeId: string; title: string; reason: string }[];
}

/** "Plan my week": a proposal for the empty slots, not saved until the cook says so. */
export async function proposeWeek(
  db: Db,
  auth: Auth,
  now: Date,
  pricingDefault: boolean,
  input: { from: CalendarDate; to: CalendarDate; slots: string[]; servings?: number },
): Promise<WeekPickDto[]> {
  const d = await gather(db, auth, now, pricingDefault);
  const from = input.from < d.today ? d.today : input.from;
  const taken = await db
    .select({ date: mealPlanEntries.date, slot: mealPlanEntries.slot })
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.householdId, auth.household.id), gte(mealPlanEntries.date, from), lte(mealPlanEntries.date, input.to)));
  const empty: { date: CalendarDate; slot: string }[] = [];
  for (let day = from; day <= input.to; day = addDays(day, 1)) {
    for (const slot of input.slots) if (!taken.some((t) => t.date === day && t.slot === slot)) empty.push({ date: day, slot });
  }
  // Leftovers first: each goes to the earliest empty slot before it goes off.
  const picks: WeekPickDto[] = [];
  const left = [...empty];
  for (const m of d.meals.filter((x) => !x.frozen)) {
    const i = left.findIndex((s) => !m.bestBefore || s.date <= m.bestBefore);
    if (i < 0) continue;
    const [s] = left.splice(i, 1);
    picks.push({ date: s!.date, slot: s!.slot, kind: 'stock', recipeId: null, stockItemId: m.stockItemId, title: `Leftover ${m.title.toLowerCase()}`, reason: m.reason, missing: [], alternatives: [] });
  }
  const week = planWeek(d.recipes, d.lots, d.needs, left, { servings: input.servings, priceOf: d.priceOf, amountText: d.amountText }, d.rules);
  const frozenMeals = d.meals.filter((x) => x.frozen);
  for (const s of left) {
    const p = week.find((w) => w.date === s.date && w.slot === s.slot);
    // Nothing worth saving that day: favour a portion from the freezer over cooking from scratch.
    if ((!p || p.choice.score <= 0) && frozenMeals.length) {
      const m = frozenMeals.shift()!;
      picks.push({ date: s.date, slot: s.slot, kind: 'stock', recipeId: null, stockItemId: m.stockItemId, title: m.title, reason: m.reason, missing: [], alternatives: p ? [{ recipeId: p.choice.recipeId, title: p.choice.title, reason: p.choice.reason }] : [] });
      continue;
    }
    if (!p) continue;
    picks.push({
      date: s.date,
      slot: s.slot,
      kind: 'recipe',
      recipeId: p.choice.recipeId,
      stockItemId: null,
      title: p.choice.title,
      reason: p.choice.reason,
      missing: p.choice.missing.map((m) => m.name),
      alternatives: p.alternatives.map((a) => ({ recipeId: a.recipeId, title: a.title, reason: a.reason })),
    });
  }
  return picks.sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
}

/** Surplus left over after the plan and the list: "2.1kg potatoes spare after this plan", with how many recipes would use it. */
export async function surplusHints(db: Db, auth: Auth, now: Date, pricingDefault: boolean) {
  const d = await gather(db, auth, now, pricingDefault);
  const surplus = surplusLots(d.lots, d.needs);
  const summary = surplusSummary(surplus, d.today).filter((s) => s.grams >= 100);
  return summary.slice(0, 5).map((s) => {
    const ideas = rankRecipes(d.recipes, surplus, { on: d.today, priceOf: d.priceOf, amountText: d.amountText }, d.rules).filter((r) => r.uses.some((u) => u.ingredientId === s.ingredientId));
    return {
      ingredientId: s.ingredientId,
      name: d.catalog.ingredients.get(s.ingredientId)?.name ?? 'Food',
      grams: s.grams,
      goesOffBy: s.goesOffBy,
      ideas: ideas.length,
      topIdea: ideas[0] ? { recipeId: ideas[0].recipeId, title: ideas[0].title, missing: ideas[0].missing.map((m) => m.name) } : null,
    };
  });
}
