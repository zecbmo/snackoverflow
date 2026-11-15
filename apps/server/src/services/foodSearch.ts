/**
 * Log food's server side: one search across everything you could log as eaten (what's in the
 * kitchen, your recipes, foods you've bought, generic foods and takeaway menus), suggestions
 * from what you usually have, favourites, saved meals ("my usual breakfast"), Open Food Facts
 * by name, and barcodes. Every food comes back in the same shape, ready to log.
 */
import { and, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import {
  amountText,
  itemOf,
  tidyCapitals,
  type BarcodeFoodDto,
  type CalendarDate,
  type FoodResultDto,
  type FoodSuggestionsDto,
  type MealSlot,
  matchesSearch,
  nutritionFor,
  type OffSearchDto,
  parsePackQuantity,
  type PlanEntryDto,
  type RecipeSummaryDto,
  type SavedMealDto,
  searchRank,
  type StockItemDto,
} from '@snackoverflow/shared';
import type { AppContext, Auth } from '../context';
import type { OffProduct } from './off';
import { searchLocalOff } from './offDump';
import type { Db } from '../db/client';
import { barcodes, chainMenuItems, chains, foodFavourites, ingredients, mealPlanEntries, mealPlanPeople, products, recipes, type SavedMealItem, savedMeals, stockItems } from '../db/schema';
import { badRequest, notFound } from '../http';
import { packFields, type ProductRow } from './catalog';
import { searchChainItems } from './chains';
import { createEntryWithStock, getEntry, ingredientServing, productKcal, productNutrition, productServingGrams } from './planner';
import { listRecipes } from './recipes';
import { resolveBarcode } from './scan';
import { listStock, type StockDeps } from './stock';

const LIMITS = { kitchen: 12, recipes: 8, products: 10, ingredients: 10, chains: 15, off: 15 };
type IngredientRow = typeof ingredients.$inferSelect;
type ChainItem = Awaited<ReturnType<typeof searchChainItems>>[number];
type FavKind = 'product' | 'recipe' | 'ingredient' | 'chain';

function byRank<T>(rows: T[], name: (r: T) => string, q: string, limit: number): T[] {
  if (!q) return rows.slice(0, limit);
  return rows
    .map((r) => ({ r, rank: searchRank(name(r), q) }))
    .filter((x) => x.rank !== null)
    .sort((a, b) => a.rank! - b.rank! || name(a.r).localeCompare(name(b.r)))
    .slice(0, limit)
    .map((x) => x.r);
}

/** "1 item (45g)", "1 pack (400g)", "1 pack". */
function productServing(p: ProductRow, measures: Pick<StockItemDto, 'displayUnit' | 'densityGPerMl' | 'gramsPerCount' | 'countUnit'> | null): string {
  if (p.portionGrams) return `1 item (${amountText(p.portionGrams, measures)})`;
  if (p.packGrams) return `1 pack (${amountText(p.packGrams, measures)})`;
  // No pack size (some Open Food Facts entries): by the 100g, when the nutrition is known.
  return productServingGrams(p) ? '100g' : '1 pack';
}

/** What's in the house, by product and by generic food, for "in stock" and "In your kitchen". */
interface Kitchen {
  stock: StockItemDto[];
  byProduct: Map<string, StockItemDto[]>;
  byIngredient: Map<string, StockItemDto[]>;
}

async function loadKitchen(db: Db, auth: Auth, now: Date): Promise<Kitchen> {
  const stock = await listStock(db, auth, now);
  const byProduct = new Map<string, StockItemDto[]>();
  const byIngredient = new Map<string, StockItemDto[]>();
  for (const s of stock) {
    if (s.isMeal) continue;
    byProduct.set(s.productId, [...(byProduct.get(s.productId) ?? []), s]);
    if (s.ingredientId) byIngredient.set(s.ingredientId, [...(byIngredient.get(s.ingredientId) ?? []), s]);
  }
  return { stock, byProduct, byIngredient };
}

/** Your stars and how much you usually have of each food, so results can show both. */
interface Personal {
  favourites: Set<string>;
  usual: Map<string, number>;
}

const key = (kind: string, id: string) => `${kind}:${id}`;

function resultKey(r: Pick<FoodResultDto, 'source' | 'id' | 'title' | 'kcalPerServing'>): string | null {
  if (r.source === 'stock' || r.source === 'product') return key('product', r.id);
  if (r.source === 'recipe' || r.source === 'ingredient' || r.source === 'chain') return key(r.source, r.id);
  if (r.source === 'quick') return key('quick', `${r.title}|${r.kcalPerServing ?? ''}`);
  return null;
}

function personalise(r: FoodResultDto, me: Personal | null): FoodResultDto {
  const k = resultKey(r);
  if (!me || !k) return r;
  return { ...r, favourite: me.favourites.has(k), usualServings: me.usual.get(k) ?? null };
}

const blank = { favourite: false, usualServings: null } as const;

/**
 * How food in the kitchen is eaten when that isn't a pack at a time: by the item or the slice
 * (bananas, a loaf), else by weight from 100g (chicken, rice). A product with a serving size on
 * its label is eaten by the serving. Other snacks and multipacks keep their pack or item.
 */
function eatBy(p: ProductRow, first: StockItemDto | undefined): FoodResultDto['eatBy'] {
  const per100 = p.nutritionPer100g?.kcal;
  const kcal = (grams: number) => (per100 == null ? null : Math.round((per100 * grams) / 100));
  // The label's own serving ("30g" of a 165g tube), in stock or not.
  if (p.servingGrams && !p.portionGrams && !p.recipeId) {
    return { grams: p.servingGrams, unit: 'serving', label: `1 serving (${amountText(p.servingGrams, { displayUnit: p.displayUnit })})`, kcal: kcal(p.servingGrams) };
  }
  if (!first || !p.ingredientId || !p.packGrams || p.portionGrams || p.recipeId) return null;
  const one = itemOf(first);
  if (one) return { grams: one.grams, unit: one.name, label: `1 ${one.name} (${Math.round(one.grams)}g)`, kcal: kcal(one.grams) };
  const ml = first.displayUnit === 'ml';
  const grams = ml ? 100 * (first.densityGPerMl ?? 1) : 100;
  return { grams, unit: null, label: ml ? '100ml' : '100g', kcal: kcal(grams) };
}

export function productResult(p: ProductRow, kitchen: Kitchen | null): FoodResultDto {
  const packs = kitchen?.byProduct.get(p.id) ?? [];
  const first = packs[0];
  return {
    eatBy: eatBy(p, first),
    ingredientId: p.ingredientId,
    source: first ? 'stock' : 'product',
    id: p.id,
    title: p.name ?? 'Unnamed product',
    subtitle: first ? `${first.locationName} · ${packs.length} ${packs.length === 1 ? 'pack' : 'packs'}` : p.brand,
    kcalPerServing: productKcal(p),
    servingLabel: productServing(p, first ?? null),
    unitGrams: productServingGrams(p),
    displayUnit: p.displayUnit,
    countUnit: null,
    inStock: first ? { packs: packs.length, locationName: first.locationName } : null,
    nutritionPerServing: productNutrition(p),
    ...blank,
  };
}

function leftoverResult(s: StockItemDto, p: ProductRow | undefined): FoodResultDto {
  return {
    eatBy: null,
    ingredientId: null,
    source: 'leftovers',
    id: s.id,
    title: `Leftover ${s.productName.charAt(0).toLowerCase()}${s.productName.slice(1)}`,
    subtitle: s.locationName,
    kcalPerServing: productKcal(p),
    servingLabel: '1 portion',
    unitGrams: p?.portionGrams ?? null,
    displayUnit: 'g',
    countUnit: null,
    inStock: { packs: 1, locationName: s.locationName },
    nutritionPerServing: productNutrition(p),
    ...blank,
  };
}

function ingredientResult(i: IngredientRow, kitchen: Kitchen | null): FoodResultDto {
  const serving = ingredientServing(i);
  const packs = kitchen?.byIngredient.get(i.id) ?? [];
  return {
    eatBy: null,
    ingredientId: i.id,
    source: 'ingredient',
    id: i.id,
    title: i.name,
    subtitle: 'Food',
    kcalPerServing: serving.kcalPerServing,
    servingLabel: serving.countUnit ? `1 ${serving.countUnit} (${Math.round(serving.unitGrams)}g)` : serving.displayUnit === 'ml' ? '100ml' : '100g',
    unitGrams: serving.unitGrams,
    displayUnit: serving.displayUnit,
    countUnit: serving.countUnit,
    inStock: packs.length ? { packs: packs.length, locationName: packs[0]!.locationName } : null,
    nutritionPerServing: serving.nutritionPerServing,
    ...blank,
  };
}

function recipeResult(r: RecipeSummaryDto): FoodResultDto {
  return {
    eatBy: null,
    ingredientId: null,
    source: 'recipe',
    id: r.id,
    title: r.title,
    subtitle: 'Recipe',
    kcalPerServing: r.kcalPerServing,
    servingLabel: '1 serving',
    unitGrams: null,
    displayUnit: 'g',
    countUnit: null,
    inStock: null,
    nutritionPerServing: r.kcalPerServing === null ? null : r.nutritionPerServing,
    ...blank,
  };
}

function chainResult(c: ChainItem): FoodResultDto {
  return {
    eatBy: null,
    ingredientId: null,
    source: 'chain',
    id: c.id,
    title: c.name,
    subtitle: [c.chainName, c.section].filter(Boolean).join(' · '),
    kcalPerServing: Math.round(c.kcal),
    servingLabel: c.serving ?? '1 serving',
    unitGrams: c.servingG ?? null,
    displayUnit: 'g',
    countUnit: null,
    inStock: null,
    nutritionPerServing: { kcal: c.kcal, protein: c.protein, carbs: c.carbs, sugars: c.sugars, fat: c.fat, saturates: c.saturates, fibre: c.fibre, salt: c.salt },
    ...blank,
  };
}

function quickResult(text: string, kcal: number | null): FoodResultDto {
  return {
    eatBy: null,
    ingredientId: null,
    source: 'quick',
    id: '',
    title: text,
    subtitle: 'Calories only',
    kcalPerServing: kcal,
    servingLabel: '1',
    unitGrams: null,
    displayUnit: 'g',
    countUnit: null,
    inStock: null,
    nutritionPerServing: null,
    ...blank,
  };
}

async function chainItemsById(db: Db, ids: string[]): Promise<Map<string, ChainItem>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: chainMenuItems.id,
      chainKey: chainMenuItems.chainKey,
      chainName: chains.name,
      name: chainMenuItems.name,
      section: chainMenuItems.section,
      serving: chainMenuItems.serving,
      servingG: chainMenuItems.servingG,
      kcal: chainMenuItems.kcal,
      fat: chainMenuItems.fat,
      saturates: chainMenuItems.saturates,
      carbs: chainMenuItems.carbs,
      sugars: chainMenuItems.sugars,
      fibre: chainMenuItems.fibre,
      protein: chainMenuItems.protein,
      salt: chainMenuItems.salt,
    })
    .from(chainMenuItems)
    .innerJoin(chains, eq(chains.key, chainMenuItems.chainKey))
    .where(inArray(chainMenuItems.id, ids));
  return new Map(rows.map((r) => [r.id, r as ChainItem]));
}

// --- History ---------------------------------------------------------------------------

interface Eaten {
  key: string;
  last: Date;
  lastServings: number;
  count: number;
  slotCount: number;
  /** What's needed to show it again. */
  kind: string;
  refId: string;
  text: string | null;
  kcal: number | null;
}

/** What you've eaten in the last 90 days, one row per food. */
async function history(db: Db, auth: Auth, now: Date, slot?: MealSlot): Promise<Eaten[]> {
  const rows = await db
    .select({
      kind: mealPlanEntries.kind,
      slot: mealPlanEntries.slot,
      productId: mealPlanEntries.productId,
      recipeId: mealPlanEntries.recipeId,
      ingredientId: mealPlanEntries.ingredientId,
      chainItemId: mealPlanEntries.chainItemId,
      text: mealPlanEntries.text,
      kcal: mealPlanEntries.kcalPerServing,
      portions: mealPlanPeople.portions,
      eatenAt: mealPlanPeople.eatenAt,
    })
    .from(mealPlanPeople)
    .innerJoin(mealPlanEntries, eq(mealPlanEntries.id, mealPlanPeople.entryId))
    .where(
      and(
        eq(mealPlanPeople.userId, auth.user.id),
        eq(mealPlanEntries.householdId, auth.household.id),
        isNotNull(mealPlanPeople.eatenAt),
        gt(mealPlanPeople.eatenAt, new Date(now.getTime() - 90 * 86_400_000)),
      ),
    )
    .orderBy(desc(mealPlanPeople.eatenAt))
    .limit(600);
  const out = new Map<string, Eaten>();
  for (const r of rows) {
    const ref =
      r.kind === 'product' ? r.productId : r.kind === 'recipe' ? r.recipeId : r.kind === 'ingredient' ? r.ingredientId : r.kind === 'chain' ? r.chainItemId : r.kind === 'text' ? r.text : null;
    if (!ref) continue;
    const k = r.kind === 'text' ? key('quick', `${r.text}|${r.kcal ?? ''}`) : key(r.kind, ref);
    const e = out.get(k);
    const inSlot = slot && r.slot === slot ? 1 : 0;
    if (e) {
      e.count++;
      e.slotCount += inSlot;
    } else {
      out.set(k, { key: k, last: r.eatenAt!, lastServings: r.portions, count: 1, slotCount: inSlot, kind: r.kind, refId: ref, text: r.text, kcal: r.kcal });
    }
  }
  return [...out.values()];
}

/** Turn food keys into results, loading only what's needed. Unknown or deleted foods drop out. */
async function resultsFor(db: Db, auth: Auth, refs: { kind: string; refId: string; text?: string | null; kcal?: number | null }[], kitchen: Kitchen): Promise<FoodResultDto[]> {
  const ids = (k: string) => refs.filter((r) => r.kind === k).map((r) => r.refId);
  const [prods, ings, recipeList, chainItems] = await Promise.all([
    ids('product').length ? db.select().from(products).where(and(eq(products.householdId, auth.household.id), inArray(products.id, ids('product')))) : [],
    ids('ingredient').length ? db.select().from(ingredients).where(and(eq(ingredients.householdId, auth.household.id), inArray(ingredients.id, ids('ingredient')))) : [],
    ids('recipe').length ? listRecipes(db, auth) : [],
    chainItemsById(db, ids('chain')),
  ]);
  const p = new Map(prods.map((x) => [x.id, x]));
  const i = new Map(ings.map((x) => [x.id, x]));
  const r = new Map(recipeList.map((x) => [x.id, x]));
  const out: FoodResultDto[] = [];
  for (const ref of refs) {
    if (ref.kind === 'product' && p.get(ref.refId)?.name) out.push(productResult(p.get(ref.refId)!, kitchen));
    else if (ref.kind === 'ingredient' && i.has(ref.refId)) out.push(ingredientResult(i.get(ref.refId)!, kitchen));
    else if (ref.kind === 'recipe' && r.has(ref.refId)) out.push(recipeResult(r.get(ref.refId)!));
    else if (ref.kind === 'chain' && chainItems.has(ref.refId)) out.push(chainResult(chainItems.get(ref.refId)!));
    else if (ref.kind === 'text') out.push(quickResult(ref.text ?? ref.refId, ref.kcal ?? null));
  }
  return out;
}

async function personal(db: Db, auth: Auth, now: Date, slot?: MealSlot): Promise<{ me: Personal; eaten: Eaten[]; favs: { kind: FavKind; refId: string }[] }> {
  const [eaten, favs] = await Promise.all([
    history(db, auth, now, slot),
    db.select({ kind: foodFavourites.kind, refId: foodFavourites.refId }).from(foodFavourites).where(eq(foodFavourites.userId, auth.user.id)).orderBy(desc(foodFavourites.createdAt)),
  ]);
  return {
    eaten,
    favs: favs as { kind: FavKind; refId: string }[],
    me: { favourites: new Set(favs.map((f) => key(f.kind, f.refId))), usual: new Map(eaten.map((e) => [e.key, e.lastServings])) },
  };
}

/**
 * Products picked from Open Food Facts that were never logged, put in stock or starred. Picking
 * one makes it a product (so it can be logged), but until it's used it's still just a search
 * result: it stays under Open Food Facts and out of Foods.
 */
async function unusedOffProducts(db: Db, auth: Auth): Promise<Set<string>> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.householdId, auth.household.id), eq(products.source, 'off')));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return new Set();
  const [stocked, logged, starred] = await Promise.all([
    db.selectDistinct({ id: stockItems.productId }).from(stockItems).where(inArray(stockItems.productId, ids)),
    db.selectDistinct({ id: mealPlanEntries.productId }).from(mealPlanEntries).where(inArray(mealPlanEntries.productId, ids)),
    db.select({ id: foodFavourites.refId }).from(foodFavourites).where(and(eq(foodFavourites.kind, 'product'), inArray(foodFavourites.refId, ids))),
  ]);
  const used = new Set([...stocked, ...logged, ...starred].map((r) => r.id));
  return new Set(ids.filter((id) => !used.has(id)));
}

// --- Search --------------------------------------------------------------------------------

export async function searchFoods(ctx: AppContext, auth: Auth, q: string): Promise<FoodResultDto[]> {
  const { db } = ctx;
  const now = ctx.now();
  const query = q.trim();
  const [kitchen, recipeList, productRows, ingredientRows, mine] = await Promise.all([
    loadKitchen(db, auth, now),
    query ? listRecipes(db, auth) : Promise.resolve([]),
    db
      .select()
      .from(products)
      .where(and(eq(products.householdId, auth.household.id), isNotNull(products.name))),
    query ? db.select().from(ingredients).where(eq(ingredients.householdId, auth.household.id)) : Promise.resolve([]),
    personal(db, auth, now),
  ]);
  const productsById = new Map(productRows.map((p) => [p.id, p]));
  const out: FoodResultDto[] = [];

  // In the kitchen: leftovers one pack at a time, everything else one row per product. Stock
  // arrives in best-before order, so with no query this is "use these first".
  const leftovers = kitchen.stock.filter((s) => s.isMeal && (!query || matchesSearch(s.productName, query)));
  for (const s of byRank(leftovers, (x) => x.productName, query, LIMITS.kitchen)) out.push(leftoverResult(s, productsById.get(s.productId)));
  const stockGroups = [...kitchen.byProduct.values()].filter((g) => productsById.has(g[0]!.productId) && (!query || matchesSearch(`${g[0]!.productName} ${g[0]!.brand ?? ''}`, query)));
  for (const g of byRank(stockGroups, (x) => x[0]!.productName, query, LIMITS.kitchen - Math.min(leftovers.length, LIMITS.kitchen / 2))) {
    out.push(productResult(productsById.get(g[0]!.productId)!, kitchen));
  }
  if (query) {
    for (const r of byRank(
      recipeList.filter((x) => matchesSearch(`${x.title} ${x.tags.join(' ')}`, query)),
      (x) => x.title,
      query,
      LIMITS.recipes,
    )) {
      out.push(recipeResult(r));
    }
    // Food you've bought before but haven't got now (cooked meals are leftovers, above).
    const unused = await unusedOffProducts(db, auth);
    const others = productRows.filter((p) => !kitchen.byProduct.has(p.id) && p.recipeId === null && !unused.has(p.id) && matchesSearch(`${p.name} ${p.brand ?? ''}`, query));
    for (const p of byRank(others, (x) => x.name ?? '', query, LIMITS.products)) out.push(productResult(p, kitchen));
    // Generic foods ("banana", "rice"), unless the kitchen row above is the same food already.
    const inKitchen = new Set(out.filter((r) => r.source === 'stock' && r.eatBy).map((r) => r.ingredientId));
    for (const i of byRank(
      ingredientRows.filter((x) => !inKitchen.has(x.id) && matchesSearch(x.name, query)),
      (x) => x.name,
      query,
      LIMITS.ingredients,
    )) {
      out.push(ingredientResult(i, kitchen));
    }
    for (const c of await searchChainItems(db, query, { limit: LIMITS.chains })) out.push(chainResult(c));
    // The local copy of Open Food Facts, as you type (when it's kept).
    if (ctx.config.OFF_DUMP_ENABLED) out.push(...(await offResults(ctx, auth, await searchLocalOff(db, query, LIMITS.off))));
  }
  // What you've had before, and your stars, first within each group.
  const ranked = out.map((r) => personalise(r, mine.me));
  return ranked
    .map((r, i) => ({ r, i, boost: r.favourite ? 0 : r.usualServings !== null ? 1 : 2 }))
    .sort((a, b) => groupOf(a.r) - groupOf(b.r) || a.boost - b.boost || a.i - b.i)
    .map((x) => x.r);
}

function groupOf(r: FoodResultDto): number {
  return ['leftovers', 'stock'].includes(r.source) ? 0 : r.source === 'recipe' ? 1 : r.source === 'product' || r.source === 'ingredient' ? 2 : r.source === 'chain' ? 3 : r.source === 'quick' ? 4 : 5;
}

// --- Suggestions ---------------------------------------------------------------------------

/** Before anything's typed: your stars, what you usually have at this meal, what you've had lately, your saved meals. */
export async function foodSuggestions(db: Db, auth: Auth, now: Date, slot?: MealSlot): Promise<FoodSuggestionsDto> {
  const [kitchen, mine, meals] = await Promise.all([loadKitchen(db, auth, now), personal(db, auth, now, slot), listSavedMeals(db, auth)]);
  const favourites = await resultsFor(db, auth, mine.favs.slice(0, 12), kitchen);
  const seen = new Set(favourites.map(resultKey));
  const usualRefs = mine.eaten
    .filter((e) => e.slotCount >= 2)
    .sort((a, b) => b.slotCount - a.slotCount || b.last.getTime() - a.last.getTime())
    .slice(0, 8);
  const usual = (await resultsFor(db, auth, usualRefs, kitchen)).filter((r) => !seen.has(resultKey(r)));
  for (const r of usual) seen.add(resultKey(r));
  const recentRefs = mine.eaten.sort((a, b) => b.last.getTime() - a.last.getTime()).slice(0, 16);
  const recent = (await resultsFor(db, auth, recentRefs, kitchen)).filter((r) => !seen.has(resultKey(r))).slice(0, 8);
  const p = (list: FoodResultDto[]) => list.map((r) => personalise(r, mine.me));
  return { favourites: p(favourites), usual: p(usual), recent: p(recent), meals };
}

// --- Favourites ----------------------------------------------------------------------------

export async function setFavourite(db: Db, auth: Auth, kind: FavKind, refId: string, on: boolean): Promise<void> {
  if (!on) {
    await db.delete(foodFavourites).where(and(eq(foodFavourites.userId, auth.user.id), eq(foodFavourites.kind, kind), eq(foodFavourites.refId, refId)));
    return;
  }
  const hh = auth.household.id;
  const exists =
    kind === 'product'
      ? (await db.select({ id: products.id }).from(products).where(and(eq(products.id, refId), eq(products.householdId, hh)))).length
      : kind === 'recipe'
        ? (await db.select({ id: recipes.id }).from(recipes).where(and(eq(recipes.id, refId), eq(recipes.householdId, hh)))).length
        : kind === 'ingredient'
          ? (await db.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.id, refId), eq(ingredients.householdId, hh)))).length
          : (await db.select({ id: chainMenuItems.id }).from(chainMenuItems).where(eq(chainMenuItems.id, refId))).length;
  if (!exists) throw notFound('No such food.');
  await db.insert(foodFavourites).values({ householdId: hh, userId: auth.user.id, kind, refId }).onConflictDoNothing();
}

// --- Saved meals ---------------------------------------------------------------------------

async function listSavedMeals(db: Db, auth: Auth): Promise<SavedMealDto[]> {
  const rows = await db.select().from(savedMeals).where(eq(savedMeals.userId, auth.user.id)).orderBy(desc(savedMeals.createdAt));
  return rows.map((m) => {
    const items = m.items.map((i) => ({ title: i.text, servings: i.servings, kcal: i.kcalPerServing === null ? null : Math.round(i.kcalPerServing * i.servings) }));
    return { id: m.id, name: m.name, items, kcal: items.some((i) => i.kcal === null) ? null : items.reduce((n, i) => n + i.kcal!, 0) };
  });
}

/** Save the foods of some logged meals (your portions) as one meal to log again in a tap. */
export async function saveMeal(db: Db, auth: Auth, name: string, entryIds: string[]): Promise<SavedMealDto> {
  const items: SavedMealItem[] = [];
  for (const id of entryIds) {
    const [row] = await db.select().from(mealPlanEntries).where(and(eq(mealPlanEntries.id, id), eq(mealPlanEntries.householdId, auth.household.id)));
    if (!row) continue;
    const dto: PlanEntryDto = await getEntry(db, auth, id, auth.user.id);
    const mine = dto.people.find((p) => p.userId === auth.user.id)?.portions ?? row.servings;
    let kind: SavedMealItem['kind'] = row.kind === 'stock' ? 'product' : row.kind;
    let refId = row.recipeId ?? row.productId ?? row.ingredientId ?? row.chainItemId;
    if (row.kind === 'stock' && row.stockItemId) {
      const [s] = await db.select({ productId: stockItems.productId }).from(stockItems).where(eq(stockItems.id, row.stockItemId));
      refId = s?.productId ?? null;
    }
    if (row.kind === 'text' || !refId) {
      kind = 'text';
      refId = null;
    }
    items.push({ kind, refId, text: dto.title, kcalPerServing: dto.kcalPerServing, nutrition: dto.nutritionPerServing, servings: mine });
  }
  if (!items.length) throw badRequest('Nothing to save there.');
  const [m] = await db.insert(savedMeals).values({ householdId: auth.household.id, userId: auth.user.id, name, items }).returning();
  return (await listSavedMeals(db, auth)).find((x) => x.id === m!.id)!;
}

export async function deleteSavedMeal(db: Db, auth: Auth, id: string): Promise<void> {
  const gone = await db.delete(savedMeals).where(and(eq(savedMeals.id, id), eq(savedMeals.userId, auth.user.id))).returning({ id: savedMeals.id });
  if (!gone.length) throw notFound('No such meal.');
}

/** Log every food of a saved meal as eaten by you. Foods that have gone since are logged by name and calories. */
export async function logSavedMeal(deps: StockDeps, id: string, input: { date: CalendarDate; slot: MealSlot; fromStock: boolean }): Promise<{ entries: PlanEntryDto[]; stockEventIds: string[] }> {
  const { db, auth } = deps;
  const [meal] = await db.select().from(savedMeals).where(and(eq(savedMeals.id, id), eq(savedMeals.userId, auth.user.id)));
  if (!meal) throw notFound('No such meal.');
  const entries: PlanEntryDto[] = [];
  const stockEventIds: string[] = [];
  for (const item of meal.items) {
    const still = item.refId ? await foodExists(db, auth, item.kind, item.refId) : false;
    const base = { date: input.date, slot: input.slot, servings: item.servings, people: [{ userId: auth.user.id, portions: item.servings }], batch: false, eaten: true, fromStock: input.fromStock };
    const r = still
      ? await createEntryWithStock(deps, {
          ...base,
          kind: item.kind,
          recipeId: item.kind === 'recipe' ? item.refId : null,
          productId: item.kind === 'product' ? item.refId : null,
          ingredientId: item.kind === 'ingredient' ? item.refId : null,
          chainItemId: item.kind === 'chain' ? item.refId : null,
        })
      : await createEntryWithStock(deps, { ...base, kind: 'text', text: item.text, kcalPerServing: item.kcalPerServing });
    entries.push(r.entry);
    stockEventIds.push(...r.stockEventIds);
  }
  return { entries, stockEventIds };
}

async function foodExists(db: Db, auth: Auth, kind: SavedMealItem['kind'], refId: string): Promise<boolean> {
  const hh = auth.household.id;
  if (kind === 'product') return (await db.select({ id: products.id }).from(products).where(and(eq(products.id, refId), eq(products.householdId, hh)))).length > 0;
  if (kind === 'recipe') return (await db.select({ id: recipes.id }).from(recipes).where(and(eq(recipes.id, refId), eq(recipes.householdId, hh)))).length > 0;
  if (kind === 'ingredient') return (await db.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.id, refId), eq(ingredients.householdId, hh)))).length > 0;
  if (kind === 'chain') return (await db.select({ id: chainMenuItems.id }).from(chainMenuItems).where(eq(chainMenuItems.id, refId))).length > 0;
  return false;
}

// --- Open Food Facts and barcodes ------------------------------------------------------------

/** Search Open Food Facts by name (on request: it limits searches). Barcodes you already have are left out. */
export async function searchOff(ctx: AppContext, auth: Auth, q: string): Promise<OffSearchDto> {
  if (!ctx.config.OFF_ENABLED || !q.trim()) return { status: 'unavailable', results: [] };
  const r = await ctx.off.search(q);
  if (r.status === 'busy') return { status: 'busy', results: [] };
  if (r.status === 'failed') return { status: 'unavailable', results: [] };
  const results = await offResults(ctx, auth, r.products);
  return { status: 'ok', results };
}

/** Open Food Facts products as results: per pack when its weight is known, else per 100g. Ones you've logged, stocked or starred are left out (they're your Foods). */
async function offResults(ctx: AppContext, auth: Auth, products: OffProduct[]): Promise<FoodResultDto[]> {
  const codes = products.map((p) => p.barcode);
  // Ones you've only looked at (picked, never logged) still belong here.
  const unused = await unusedOffProducts(ctx.db, auth);
  const known = new Set(
    codes.length
      ? (await ctx.db.select({ code: barcodes.code, productId: barcodes.productId }).from(barcodes).where(and(eq(barcodes.householdId, auth.household.id), inArray(barcodes.code, codes))))
          .filter((b) => !unused.has(b.productId))
          .map((b) => b.code)
      : [],
  );
  const results: FoodResultDto[] = [];
  for (const p of products) {
    if (known.has(p.barcode) || !p.name) continue;
    const qty = parsePackQuantity(p.quantity);
    const pack = packFields(qty?.amount, qty?.unit, ctx.seed.units, {});
    const grams = pack.packGrams ?? 100;
    const per100 = p.nutritionPer100g?.kcal;
    const serving = p.servingGrams && p.servingGrams < grams * 0.95 ? p.servingGrams : null;
    results.push({
      eatBy: serving ? { grams: serving, unit: 'serving', label: `1 serving (${Math.round(serving * 10) / 10}${pack.displayUnit === 'ml' ? 'ml' : 'g'})`, kcal: per100 == null ? null : Math.round((per100 * serving) / 100) } : null,
      ingredientId: null,
      source: 'off',
      id: p.barcode,
      title: tidyCapitals(p.name),
      subtitle: [p.brand && tidyCapitals(p.brand), p.quantity].filter(Boolean).join(' · ') || 'Open Food Facts',
      kcalPerServing: per100 == null ? null : Math.round((per100 * grams) / 100),
      servingLabel: pack.packGrams ? `1 pack (${p.quantity})` : '100g',
      unitGrams: grams,
      displayUnit: pack.displayUnit === 'ml' ? 'ml' : 'g',
      countUnit: null,
      inStock: null,
      nutritionPerServing: nutritionFor(p.nutritionPer100g, grams),
      ...blank,
    });
  }
  return results;
}

/** A barcode scanned or picked in Log food: this household's product (made from Open Food Facts, or unnamed). */
export async function barcodeFood(ctx: AppContext, auth: Auth, code: string): Promise<BarcodeFoodDto> {
  const resolved = await resolveBarcode(ctx, auth, code);
  const kitchen = await loadKitchen(ctx.db, auth, ctx.now());
  const mine = await personal(ctx.db, auth, ctx.now());
  return { food: personalise(productResult(resolved.product, kitchen), mine.me), productId: resolved.product.id, named: resolved.product.name !== null };
}

/** One product as a Log food result (after naming an unknown barcode, say). */
export async function productFood(db: Db, auth: Auth, now: Date, id: string): Promise<FoodResultDto> {
  const [p] = await db.select().from(products).where(and(eq(products.id, id), eq(products.householdId, auth.household.id)));
  if (!p) throw notFound('No such product.');
  const mine = await personal(db, auth, now);
  return personalise(productResult(p, await loadKitchen(db, auth, now)), mine.me);
}
