/**
 * The meal planner: per-person calendars of meal slots, calories, eating
 * planned food (which takes it out of stock), Eat-mode scans, and the food
 * earmarked for planned meals (planned meals warn, they don't lock stock).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  addDays,
  type CalendarDate,
  type EarmarkDto,
  eatenPortions,
  isPieceUnit,
  kcalSplit,
  macroTotals,
  type Nutrition,
  nutritionFor,
  MEAL_SLOTS,
  type MealSlot,
  orderForUse,
  type PlanDayDto,
  type PlanDto,
  type PlanEatDto,
  type PlanEntryDto,
  type PlanEntryInput,
  type StockChangeDto,
  type UseAmount,
  onCalendarOf,
  slotForTime,
  wallClockIn,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { chainMenuItems, chains, ingredients, locations, mealPlanEntries, mealPlanPeople, products, recipeIngredients, recipes, stockEvents, stockItems, users } from '../db/schema';
import { badRequest, forbidden, HttpError, notFound } from '../http';
import type { ProductRow } from './catalog';
import { listRecipes } from './recipes';
import { giveBack, householdToday, type StockDeps, undoEvent, useFromRow, usePack, usePackOpening } from './stock';

type EntryRow = typeof mealPlanEntries.$inferSelect;
const SLOT_ORDER: Record<MealSlot, number> = Object.fromEntries(MEAL_SLOTS.map((s, i) => [s, i])) as Record<MealSlot, number>;

type IngredientRow = typeof ingredients.$inferSelect;

/** One serving of a generic food: one item when it's counted (a banana), else 100g. */
export function ingredientServing(i: Pick<IngredientRow, 'gramsPerCount' | 'packUnit' | 'countUnit' | 'nutritionPer100g'>) {
  const counted = i.packUnit === 'count' && Boolean(i.gramsPerCount);
  const unitGrams = counted ? i.gramsPerCount! : 100;
  const per100 = i.nutritionPer100g?.kcal;
  return {
    unitGrams,
    displayUnit: (counted ? 'count' : i.packUnit === 'ml' ? 'ml' : 'g') as 'g' | 'ml' | 'count',
    countUnit: counted ? (i.countUnit ?? null) : null,
    kcalPerServing: per100 == null ? null : Math.round((per100 * unitGrams) / 100),
    nutritionPerServing: nutritionFor(i.nutritionPer100g, unitGrams),
  };
}

/**
 * Grams in one serving of a product: one portion for cooked meals and multipacks, else one pack.
 * A product whose pack size nobody knows (some Open Food Facts entries) is served by the 100g
 * when its nutrition is known, so its calories still show.
 */
export function productServingGrams(p: ProductRow | undefined): number | null {
  if (!p) return null;
  return p.portionGrams ?? p.packGrams ?? (p.nutritionPer100g?.kcal != null ? 100 : null);
}

/** Nutrition in one serving of a product. */
export function productNutrition(p: ProductRow | undefined): Nutrition | null {
  return nutritionFor(p?.nutritionPer100g, productServingGrams(p));
}

/** Calories in one serving of a product. */
export function productKcal(p: ProductRow | undefined): number | null {
  const per100 = p?.nutritionPer100g?.kcal;
  const grams = productServingGrams(p);
  if (per100 == null || !grams) return null;
  return Math.round((per100 * grams) / 100);
}

interface Lookups {
  members: { id: string; name: string }[];
  recipeKcal: Map<string, { title: string; kcal: number | null; nutrition: Nutrition | null }>;
  productsById: Map<string, ProductRow>;
  stockById: Map<string, { productId: string; locationName: string }>;
  /** For swaps: what each swapped recipe line was, and ingredient names. */
  lineNames: Map<string, string>;
  ingredientNames: Map<string, string>;
  /** Generic foods logged as ingredients. */
  ingredientsById: Map<string, IngredientRow>;
  /** Menu items: their chain's name. */
  chainNames: Map<string, string>;
  /** Grams each line has out of stock. */
  taken: Map<string, number>;
}

async function lookups(db: Db, auth: Auth, rows: EntryRow[]): Promise<Lookups> {
  const members = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.householdId, auth.household.id));
  const summaries = await listRecipes(db, auth);
  // Recipes without enough known ingredients have no calories, so no macros either.
  const recipeKcal = new Map(summaries.map((r) => [r.id, { title: r.title, kcal: r.kcalPerServing, nutrition: r.kcalPerServing === null ? null : r.nutritionPerServing }]));
  const stockIds = rows.map((r) => r.stockItemId).filter((x): x is string => Boolean(x));
  const stock = stockIds.length
    ? await db
        .select({ id: stockItems.id, productId: stockItems.productId, locationName: locations.name })
        .from(stockItems)
        .innerJoin(locations, eq(locations.id, stockItems.locationId))
        .where(inArray(stockItems.id, stockIds))
    : [];
  const productIds = [...new Set([...rows.map((r) => r.productId), ...stock.map((s) => s.productId)].filter((x): x is string => Boolean(x)))];
  const prods = productIds.length ? await db.select().from(products).where(inArray(products.id, productIds)) : [];
  const swapLineIds = [...new Set(rows.flatMap((r) => Object.keys(r.swaps ?? {})))];
  const swapLines = swapLineIds.length
    ? await db
        .select({ id: recipeIngredients.id, text: recipeIngredients.text, ingredientId: recipeIngredients.ingredientId })
        .from(recipeIngredients)
        .where(inArray(recipeIngredients.id, swapLineIds))
    : [];
  const ingIds = [...new Set([...rows.flatMap((r) => Object.values(r.swaps ?? {})), ...swapLines.map((l) => l.ingredientId).filter((x): x is string => Boolean(x))])];
  const ings = ingIds.length ? await db.select({ id: ingredients.id, name: ingredients.name }).from(ingredients).where(inArray(ingredients.id, ingIds)) : [];
  const ingredientNames = new Map(ings.map((i) => [i.id, i.name]));
  // Generic foods logged as ingredients, and the ingredient behind each product (for its slices or items).
  const foodIds = [...new Set([...rows.map((r) => (r.kind === 'ingredient' ? r.ingredientId : null)), ...prods.map((p) => p.ingredientId)].filter((x): x is string => Boolean(x)))];
  const foods = foodIds.length ? await db.select().from(ingredients).where(inArray(ingredients.id, foodIds)) : [];
  const chainItemIds = [...new Set(rows.map((r) => r.chainItemId).filter((x): x is string => Boolean(x)))];
  const chainRows = chainItemIds.length
    ? await db
        .select({ id: chainMenuItems.id, chain: chains.name })
        .from(chainMenuItems)
        .innerJoin(chains, eq(chains.key, chainMenuItems.chainKey))
        .where(inArray(chainMenuItems.id, chainItemIds))
    : [];
  const ids = rows.map((r) => r.id);
  const uses = ids.length
    ? await db
        .select({ entryId: stockEvents.mealPlanEntryId, grams: stockEvents.grams })
        .from(stockEvents)
        .where(and(inArray(stockEvents.mealPlanEntryId, ids), eq(stockEvents.type, 'use'), isNull(stockEvents.undoneAt)))
    : [];
  const taken = new Map<string, number>();
  for (const u of uses) taken.set(u.entryId!, (taken.get(u.entryId!) ?? 0) + (u.grams ?? 0));
  return {
    taken,
    ingredientsById: new Map(foods.map((i) => [i.id, i])),
    chainNames: new Map(chainRows.map((c) => [c.id, c.chain])),
    members,
    recipeKcal,
    lineNames: new Map(swapLines.map((l) => [l.id, (l.ingredientId && ingredientNames.get(l.ingredientId)) || l.text])),
    ingredientNames,
    productsById: new Map(prods.map((p) => [p.id, p])),
    stockById: new Map(stock.map((s) => [s.id, { productId: s.productId, locationName: s.locationName }])),
  };
}

type PeopleRow = { userId: string; portions: number; eatenAt: Date | null };

function toDto(row: EntryRow, people: PeopleRow[], l: Lookups, personId: string | null): PlanEntryDto {
  let title = row.text ?? 'Meal';
  let kcalPerServing: number | null = row.kcalPerServing;
  let nutritionPerServing: Nutrition | null = row.nutrition ?? null;
  let detail: string | null = null;
  let unit: ProductRow | undefined;
  let unitGrams: number | null = null;
  let displayUnit: 'g' | 'ml' | 'count' = 'g';
  let countUnit: string | null = null;
  let pieceGrams: number | null = null;
  let pieceUnit: string | null = null;
  if (row.kind === 'recipe' && row.recipeId) {
    const r = l.recipeKcal.get(row.recipeId);
    title = r?.title ?? 'Deleted recipe';
    kcalPerServing = r?.kcal ?? null;
    nutritionPerServing = r?.nutrition ?? null;
  } else if (row.kind === 'product' && row.productId) {
    const p = l.productsById.get(row.productId);
    unit = p;
    title = p?.name ?? 'Unnamed product';
    kcalPerServing = productKcal(p);
    nutritionPerServing = productNutrition(p);
  } else if (row.kind === 'stock' && row.stockItemId) {
    const s = l.stockById.get(row.stockItemId);
    const p = s ? l.productsById.get(s.productId) : undefined;
    unit = p;
    title = p?.name ? `Leftover ${p.name.charAt(0).toLowerCase()}${p.name.slice(1)}` : 'Leftovers';
    kcalPerServing = productKcal(p);
    nutritionPerServing = productNutrition(p);
    detail = s ? `From ${s.locationName.toLowerCase()}` : null;
  } else if (row.kind === 'ingredient') {
    const i = row.ingredientId ? l.ingredientsById.get(row.ingredientId) : undefined;
    title = i?.name ?? 'Food';
    if (i) ({ unitGrams, displayUnit, countUnit, kcalPerServing, nutritionPerServing } = ingredientServing(i));
  } else if (row.kind === 'chain') {
    title = row.text ?? 'Takeaway';
    detail = (row.chainItemId && l.chainNames.get(row.chainItemId)) || null;
  }
  if (unit) {
    unitGrams = productServingGrams(unit);
    displayUnit = unit.displayUnit;
    // A pack of food that's eaten by the item or the slice: bananas, a loaf.
    const ing = unit.ingredientId && !unit.portionGrams && unit.recipeId === null ? l.ingredientsById.get(unit.ingredientId) : undefined;
    if (ing?.gramsPerCount && ing.countUnit && (ing.packUnit === 'count' || isPieceUnit(ing.countUnit))) {
      pieceGrams = ing.gramsPerCount;
      pieceUnit = ing.countUnit;
    }
  }
  if (row.source === 'scan') detail = 'Scanned';
  const names = new Map(l.members.map((m) => [m.id, m.name]));
  const eatenPeople = people.map((p) => ({ userId: p.userId, portions: p.portions, eaten: p.eatenAt !== null }));
  // A person's calendar counts only their own portions; free portions and batch cooks count for nobody.
  const share = personId ? (row.batch ? 0 : (people.find((p) => p.userId === personId)?.portions ?? 0)) : row.servings;
  const eaten = personId ? Boolean(people.find((p) => p.userId === personId)?.eatenAt) : people.length > 0 && people.every((p) => p.eatenAt);
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    kind: row.kind,
    recipeId: row.recipeId,
    productId: row.productId,
    stockItemId: row.stockItemId,
    ingredientId: row.ingredientId,
    chainItemId: row.chainItemId,
    title,
    detail,
    servings: row.servings,
    unitGrams,
    displayUnit,
    countUnit,
    pieceGrams,
    pieceUnit,
    status: row.status,
    source: row.source === 'scan' ? 'scan' : 'plan',
    people: eatenPeople.map((p) => ({ ...p, name: names.get(p.userId) ?? 'Someone' })),
    batch: row.batch,
    kcalPerServing,
    nutritionPerServing,
    kcal: kcalPerServing === null ? null : Math.round(kcalPerServing * share),
    eaten,
    fromStock: stockableRow(row) ? row.fromStock : null,
    stockGrams: Math.max(0, Math.round((l.taken.get(row.id) ?? 0) * 10) / 10),
    keptServings: row.keptServings,
    swaps: Object.entries(row.swaps ?? {})
      .filter(([lineId, ingId]) => l.lineNames.has(lineId) && l.ingredientNames.has(ingId))
      .map(([lineId, ingId]) => ({ recipeIngredientId: lineId, ingredientId: ingId, from: l.lineNames.get(lineId)!, to: l.ingredientNames.get(ingId)! })),
  };
}

/**
 * Keep only swaps for lines of this recipe, to ingredients of this household. Null when none are
 * left. The household's cook might swap anything for anything, so there's no rule beyond that.
 */
export async function cleanSwaps(db: Db, auth: Auth, recipeId: string | null, swaps: Record<string, string> | null | undefined): Promise<Record<string, string> | null> {
  if (!recipeId || !swaps || !Object.keys(swaps).length) return null;
  const lines = new Set(
    (await db.select({ id: recipeIngredients.id }).from(recipeIngredients).where(and(eq(recipeIngredients.recipeId, recipeId), inArray(recipeIngredients.id, Object.keys(swaps))))).map(
      (l) => l.id,
    ),
  );
  const ings = new Set(
    (
      await db
        .select({ id: ingredients.id })
        .from(ingredients)
        .where(and(eq(ingredients.householdId, auth.household.id), inArray(ingredients.id, Object.values(swaps))))
    ).map((i) => i.id),
  );
  const out = Object.fromEntries(Object.entries(swaps).filter(([line, ing]) => lines.has(line) && ings.has(ing)));
  return Object.keys(out).length ? out : null;
}

async function peopleFor(db: Db, ids: string[]) {
  const rows = ids.length ? await db.select().from(mealPlanPeople).where(inArray(mealPlanPeople.entryId, ids)) : [];
  const map = new Map<string, PeopleRow[]>();
  for (const r of rows) map.set(r.entryId, [...(map.get(r.entryId) ?? []), { userId: r.userId, portions: r.portions, eatenAt: r.eatenAt }]);
  return map;
}

/**
 * A person's calendar, or everyone's. It has their meals plus any with portions nobody has yet
 * (so everyone sees what's being cooked); a meal given entirely to other people isn't on it.
 * Calories are split into eaten and still planned; skipped meals count for neither.
 */
export async function listPlan(db: Db, auth: Auth, from: CalendarDate, to: CalendarDate, personId: string | null): Promise<PlanDto> {
  const rows = await db
    .select()
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.householdId, auth.household.id), gte(mealPlanEntries.date, from), lte(mealPlanEntries.date, to)));
  const people = await peopleFor(db, rows.map((r) => r.id));
  const l = await lookups(db, auth, rows);
  const visible = rows
    .filter((r) => !personId || r.batch || onCalendarOf(r.servings, people.get(r.id) ?? [], personId))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()));
  const days: PlanDayDto[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dayRows = visible.filter((r) => r.date === d);
    const entries = dayRows.map((r) => toDto(r, people.get(r.id) ?? [], l, personId));
    // Eaten and planned are kept apart: they're never added together.
    let eatenKcal = 0;
    let plannedKcal = 0;
    for (const e of entries) {
      const split = kcalSplit({ kcalPerServing: e.kcalPerServing, servings: e.servings, people: e.people, batch: e.batch, status: e.status }, personId);
      eatenKcal += split.eaten;
      plannedKcal += split.planned;
    }
    const eatenMacros = macroTotals(entries.map((e) => ({ nutritionPerServing: e.nutritionPerServing, servings: eatenPortions(e, personId) })));
    days.push({ date: d, entries, eatenKcal, plannedKcal, eatenMacros });
  }
  return { from, to, personId, days };
}

export async function getEntry(db: Db, auth: Auth, id: string, personId: string | null = null): Promise<PlanEntryDto> {
  const [row] = await db.select().from(mealPlanEntries).where(and(eq(mealPlanEntries.id, id), eq(mealPlanEntries.householdId, auth.household.id)));
  if (!row) throw notFound('That meal is no longer planned.');
  const people = await peopleFor(db, [id]);
  return toDto(row, people.get(id) ?? [], await lookups(db, auth, [row]), personId);
}

/** Members can change their own meals and ones with free portions; admins anyone's. */
async function assertCanEdit(db: Db, auth: Auth, entryId: string): Promise<EntryRow> {
  const row = await findEntry(db, auth, entryId);
  if (auth.user.role !== 'admin') {
    const people = (await peopleFor(db, [entryId])).get(entryId) ?? [];
    if (!row.batch && !onCalendarOf(row.servings, people, auth.user.id)) throw forbidden("That's on someone else's calendar.");
  }
  return row;
}

async function findEntry(db: Db, auth: Auth, entryId: string): Promise<EntryRow> {
  const [row] = await db.select().from(mealPlanEntries).where(and(eq(mealPlanEntries.id, entryId), eq(mealPlanEntries.householdId, auth.household.id)));
  if (!row) throw notFound('That meal is no longer planned.');
  return row;
}

type Portions = { userId: string; portions: number }[];
const totalPortions = (people: Portions) => people.reduce((n, p) => n + p.portions, 0);

/** Fewer servings than portions given out: take the extra back, from the last people first. */
function trimTo(servings: number, people: Portions): Portions {
  let over = totalPortions(people) - servings;
  const out = people.map((p) => ({ ...p }));
  for (let i = out.length - 1; i >= 0 && over > 0.001; i--) {
    const take = Math.min(out[i]!.portions, over);
    out[i]!.portions = Math.round((out[i]!.portions - take) * 1000) / 1000;
    over -= take;
  }
  return out.filter((p) => p.portions > 0.001);
}

/**
 * A member changing who has portions: they can take free portions or give theirs back, but
 * not change anyone else's. Admins can assign anyone.
 */
function assertPeopleChange(auth: Auth, servings: number, before: Portions, after: Portions) {
  if (totalPortions(after) > servings + 0.001) throw badRequest('More portions handed out than there are servings.');
  if (auth.user.role === 'admin') return;
  const others = (list: Portions) =>
    list
      .filter((p) => p.userId !== auth.user.id)
      .map((p) => `${p.userId}:${Math.round(p.portions * 1000)}`)
      .sort()
      .join(',');
  if (others(before) !== others(after)) throw forbidden("Only admins can give portions to other people.");
}

async function setPeople(db: Db, auth: Auth, entryId: string, people: { userId: string; portions: number }[], takeOver: Date | null = null) {
  // Whoever has already eaten keeps their tick; `takeOver` is the tick of the one person a food is passing from.
  const before = (await peopleFor(db, [entryId])).get(entryId) ?? [];
  await db.delete(mealPlanPeople).where(eq(mealPlanPeople.entryId, entryId));
  if (!people.length) return;
  const members = new Set((await householdMembers(db, auth)).map((u) => u.id));
  const valid = people.filter((p) => members.has(p.userId));
  if (valid.length) {
    await db.insert(mealPlanPeople).values(
      valid.map((p) => {
        const was = before.find((b) => b.userId === p.userId);
        return { entryId, userId: p.userId, portions: p.portions, eatenAt: was ? was.eatenAt : takeOver };
      }),
    );
  }
}

async function householdMembers(db: Db, auth: Auth) {
  return db.select({ id: users.id }).from(users).where(eq(users.householdId, auth.household.id));
}

type NewEntry = Omit<PlanEntryInput, 'merge'> & { merge?: boolean; source?: 'plan' | 'scan' };

export async function createEntry(deps: StockDeps, input: NewEntry): Promise<PlanEntryDto> {
  return (await createEntryWithStock(deps, input)).entry;
}

// --- Food and stock ----------------------------------------------------------------------
// A line of food or leftovers owns what it took from stock. Its stock events link back to it,
// and every change to what's been eaten (a tick, an untick, a new amount, removing it) moves
// the difference, so the diary and the kitchen can't drift apart or count anything twice.

type StockRow = typeof stockItems.$inferSelect;

/** Lines whose food can come out of stock when eaten (recipes go through Cooked it). */
function stockableRow(row: Pick<EntryRow, 'batch' | 'kind'>): boolean {
  return !row.batch && (row.kind === 'stock' || row.kind === 'product' || row.kind === 'ingredient');
}

const eatenServings = (people: PeopleRow[]) => people.reduce((n, p) => n + (p.eatenAt ? p.portions : 0), 0);

/** Grams in one serving of a line's food, for taking it from stock; null when its size isn't known. */
async function servingGrams(db: Db, row: EntryRow): Promise<number | null> {
  if (row.kind === 'stock' && row.stockItemId) {
    const [r] = await db
      .select({ portion: products.portionGrams })
      .from(stockItems)
      .innerJoin(products, eq(products.id, stockItems.productId))
      .where(eq(stockItems.id, row.stockItemId));
    return r?.portion ?? null;
  }
  if (row.kind === 'product' && row.productId) {
    const [p] = await db.select({ portion: products.portionGrams, pack: products.packGrams }).from(products).where(eq(products.id, row.productId));
    return p?.portion ?? p?.pack ?? null;
  }
  if (row.kind === 'ingredient' && row.ingredientId) {
    const [ing] = await db.select().from(ingredients).where(eq(ingredients.id, row.ingredientId));
    return ing ? ingredientServing(ing).unitGrams : null;
  }
  return null;
}

/** The packs a line's food can come from, in the order they're used. */
async function packsFor(db: Db, auth: Auth, row: EntryRow): Promise<StockRow[]> {
  const inHouse = and(eq(stockItems.householdId, auth.household.id), isNull(stockItems.finishedAt));
  if (row.kind === 'stock' && row.stockItemId) {
    // These leftovers first, then any other portions of the same meal.
    const [item] = await db.select().from(stockItems).where(eq(stockItems.id, row.stockItemId));
    if (!item) return [];
    const others = orderForUse((await db.select().from(stockItems).where(and(inHouse, eq(stockItems.productId, item.productId)))).filter((p) => p.id !== item.id));
    return item.finishedAt ? others : [item, ...others];
  }
  if (row.kind === 'product' && row.productId) {
    return orderForUse(await db.select().from(stockItems).where(and(inHouse, eq(stockItems.productId, row.productId))));
  }
  if (row.kind === 'ingredient' && row.ingredientId) {
    // Any pack of that food (not cooked meals made from it).
    const rows = await db
      .select({ item: stockItems })
      .from(stockItems)
      .innerJoin(products, eq(products.id, stockItems.productId))
      .where(and(inHouse, eq(products.ingredientId, row.ingredientId), isNull(products.recipeId)));
    return orderForUse(rows.map((r) => r.item));
  }
  return [];
}

/** What a line has out of stock: grams (uses less anything put back), and whether it took a pack of unknown size. */
async function takenFor(db: Db, entryId: string): Promise<{ grams: number; unsized: boolean }> {
  const events = await db
    .select({ grams: stockEvents.grams })
    .from(stockEvents)
    .where(and(eq(stockEvents.mealPlanEntryId, entryId), eq(stockEvents.type, 'use'), isNull(stockEvents.undoneAt)));
  return { grams: Math.round(events.reduce((n, e) => n + (e.grams ?? 0), 0) * 1000) / 1000, unsized: events.some((e) => e.grams === null) };
}

/** Take grams of a line's food out of stock, the open pack first. Returns the stock events. */
async function takeGrams(d: StockDeps, row: EntryRow, grams: number): Promise<string[]> {
  const events: string[] = [];
  let left = grams;
  for (const p of await packsFor(d.db, d.auth, row)) {
    if (left <= 0.5) break;
    if (p.remainingGrams === null) {
      // A pack of unknown size: count it as used up.
      events.push((await usePack(d, p.id, { kind: 'all' })).eventId);
      break;
    }
    const take = Math.min(p.remainingGrams, left);
    events.push((await usePackOpening(d, p.id, take >= p.remainingGrams - 0.5 ? { kind: 'all' } : { kind: 'grams', grams: take })).eventId);
    left -= take;
  }
  return events;
}

/** Food whose size isn't known comes out a pack at a time. */
async function takePacks(d: StockDeps, row: EntryRow, servings: number): Promise<string[]> {
  const events: string[] = [];
  let packsLeft = row.kind === 'stock' ? 1 : Math.ceil(servings);
  for (const p of await packsFor(d.db, d.auth, row)) {
    if (packsLeft <= 0) break;
    events.push((await usePack(d, p.id, { kind: 'all' })).eventId);
    packsLeft--;
  }
  return events;
}

/**
 * Put a line's food back: all of it, or so many grams, from the pack it last came from first.
 * Where the whole of one use is going back, that use is undone, so the pack is exactly as it was
 * (closed again, same date). Otherwise, or when the pack has changed since, the amount is added
 * back to the pack. Returns the grams put back.
 */
async function returnToStock(d: StockDeps, entryId: string, grams: number | 'all'): Promise<number> {
  const events = await d.db
    .select()
    .from(stockEvents)
    .where(and(eq(stockEvents.mealPlanEntryId, entryId), eq(stockEvents.type, 'use'), eq(stockEvents.householdId, d.auth.household.id), isNull(stockEvents.undoneAt)))
    .orderBy(desc(stockEvents.seq));
  const byPack = new Map<string, typeof events>();
  for (const e of events) byPack.set(e.stockItemId, [...(byPack.get(e.stockItemId) ?? []), e]);
  let left = grams === 'all' ? Infinity : grams;
  let back = 0;
  for (const [packId, evs] of byPack) {
    if (left <= 0.5) break;
    const net = evs.some((e) => e.grams === null) ? null : evs.reduce((n, e) => n + e.grams!, 0);
    if (net !== null && net <= 0.5) continue;
    const want = net === null ? null : Math.min(net, left);
    if (evs.length === 1 && (want === null || want >= net! - 0.5)) {
      try {
        await undoEvent(d, evs[0]!.id);
        back += net ?? 0;
        left -= net ?? 0;
        continue;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
    }
    if (want === null) continue;
    back += await giveBack(d, packId, want);
    left -= want;
  }
  return Math.round(back * 1000) / 1000;
}

/**
 * Bring stock into line after what's been eaten of a line went from `before` to `after` servings:
 * take the extra, or put the difference back. Does nothing for lines that aren't from stock.
 * Returns the stock events of anything taken.
 */
async function settleStock(deps: StockDeps, row: EntryRow, before: number, after: number): Promise<string[]> {
  if (!stockableRow(row) || !row.fromStock) return [];
  const d = { ...deps, mealPlanEntryId: row.id };
  if (after <= 0.0005) {
    if (before > 0.0005) await returnToStock(d, row.id, 'all');
    return [];
  }
  const unit = await servingGrams(d.db, row);
  if (unit === null) return before <= 0.0005 ? takePacks(d, row, after) : [];
  const delta = (after - before) * unit;
  if (delta > 0.5) return takeGrams(d, row, delta);
  if (delta < -0.5) await returnToStock(d, row.id, -delta);
  return [];
}

/** After a take: a line that asked for stock but found none isn't "from stock" after all. */
async function dropIfNothingTaken(db: Db, row: EntryRow): Promise<void> {
  const taken = await takenFor(db, row.id);
  if (taken.grams <= 0.5 && !taken.unsized) await db.update(mealPlanEntries).set({ fromStock: false }).where(eq(mealPlanEntries.id, row.id));
}

const MERGE_KINDS = new Set(['product', 'ingredient', 'stock', 'chain']);

/**
 * The line a new log of the same food can be added to: the same food at the same meal that day,
 * eaten by this one person, and from stock (or not) like the new one.
 */
async function mergeTarget(db: Db, auth: Auth, input: Pick<NewEntry, 'date' | 'slot' | 'kind' | 'productId' | 'ingredientId' | 'stockItemId' | 'chainItemId' | 'fromStock'>, userId: string): Promise<EntryRow | null> {
  if (!MERGE_KINDS.has(input.kind)) return null;
  const ref =
    input.kind === 'product'
      ? input.productId && eq(mealPlanEntries.productId, input.productId)
      : input.kind === 'ingredient'
        ? input.ingredientId && eq(mealPlanEntries.ingredientId, input.ingredientId)
        : input.kind === 'stock'
          ? input.stockItemId && eq(mealPlanEntries.stockItemId, input.stockItemId)
          : input.chainItemId && eq(mealPlanEntries.chainItemId, input.chainItemId);
  if (!ref) return null;
  const rows = await db
    .select()
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.householdId, auth.household.id), eq(mealPlanEntries.date, input.date), eq(mealPlanEntries.slot, input.slot), eq(mealPlanEntries.kind, input.kind), eq(mealPlanEntries.batch, false), ref))
    .orderBy(asc(mealPlanEntries.createdAt));
  const people = await peopleFor(db, rows.map((r) => r.id));
  const wantStock = input.kind !== 'chain' && input.fromStock;
  return (
    rows.find((r) => {
      const who = people.get(r.id) ?? [];
      return who.length === 1 && who[0]!.userId === userId && who[0]!.eatenAt !== null && Math.abs(who[0]!.portions - r.servings) < 0.001 && (r.kind === 'chain' || (r.fromStock ?? false) === wantStock);
    }) ?? null
  );
}

const roundServings = (n: number) => Math.round(n * 10_000) / 10_000;

/** Plan a meal, or log one as eaten (taking it from stock when asked). Returns the stock changes too. */
export async function createEntryWithStock(deps: StockDeps, input: NewEntry): Promise<PlanEatDto> {
  const { db, auth } = deps;
  if (auth.user.role !== 'admin' && !input.eaten && input.people.length && !input.people.some((p) => p.userId === auth.user.id)) {
    throw forbidden("Only admins can plan meals on someone else's calendar.");
  }
  const batch = input.kind === 'recipe' && input.batch;
  // Logged as already eaten with nobody named: the person logging it ate it.
  const people = batch ? [] : input.people.length || !input.eaten ? input.people : [{ userId: auth.user.id, portions: input.servings }];
  if (totalPortions(people) > input.servings + 0.001) throw badRequest('More portions handed out than there are servings.');
  // More of something already logged at this meal: add to that line.
  if (input.merge && input.eaten && people.length === 1) {
    const into = await mergeTarget(db, auth, input, people[0]!.userId);
    if (into) {
      await updateEntry(deps, into.id, { servings: roundServings(into.servings + input.servings) });
      return { entry: { ...(await getEntry(db, auth, into.id, people[0]!.userId)), mergedFrom: into.servings }, stockEventIds: [] };
    }
  }
  let text = input.kind === 'text' ? (input.text ?? null) : null;
  let kcalPerServing = input.kind === 'text' ? (input.kcalPerServing ?? null) : null;
  let nutrition: Nutrition | null = null;
  if (input.kind === 'chain') {
    // A copy of the menu item, so the meal stays right if the menu changes.
    const [item] = await db.select().from(chainMenuItems).where(eq(chainMenuItems.id, input.chainItemId!));
    if (!item) throw notFound("That menu item isn't there any more.");
    text = item.name;
    kcalPerServing = item.kcal;
    nutrition = { kcal: item.kcal, protein: item.protein, carbs: item.carbs, sugars: item.sugars, fat: item.fat, saturates: item.saturates, fibre: item.fibre, salt: item.salt };
  }
  if (input.kind === 'ingredient') {
    const [ing] = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(and(eq(ingredients.id, input.ingredientId!), eq(ingredients.householdId, auth.household.id)));
    if (!ing) throw notFound('No such food.');
  }
  const [row] = await db
    .insert(mealPlanEntries)
    .values({
      householdId: auth.household.id,
      date: input.date,
      slot: input.slot,
      kind: input.kind,
      recipeId: input.kind === 'recipe' ? (input.recipeId ?? null) : null,
      productId: input.kind === 'product' ? (input.productId ?? null) : null,
      stockItemId: input.kind === 'stock' ? (input.stockItemId ?? null) : null,
      ingredientId: input.kind === 'ingredient' ? (input.ingredientId ?? null) : null,
      chainItemId: input.kind === 'chain' ? (input.chainItemId ?? null) : null,
      text,
      servings: input.servings,
      kcalPerServing,
      nutrition,
      swaps: input.kind === 'recipe' ? await cleanSwaps(db, auth, input.recipeId ?? null, input.swaps) : null,
      batch,
      status: 'planned',
      source: input.source ?? 'plan',
      createdBy: auth.user.id,
    })
    .returning();
  await setPeople(db, auth, row!.id, people);
  const viewer = people.length === 1 ? people[0]!.userId : null;
  if (input.eaten && people.length) {
    const r = await eatEntry(deps, row!.id, input.fromStock, people.map((p) => p.userId));
    return { entry: await getEntry(db, auth, row!.id, viewer), stockEventIds: r.stockEventIds };
  }
  return { entry: await getEntry(db, auth, row!.id, viewer), stockEventIds: [] };
}

export async function updateEntry(
  deps: StockDeps,
  id: string,
  input: {
    date?: string;
    slot?: MealSlot;
    servings?: number;
    status?: 'planned' | 'cooked' | 'skipped';
    people?: Portions;
    batch?: boolean;
    fromStock?: boolean;
    swaps?: Record<string, string> | null;
  },
): Promise<PlanEntryDto> {
  const { db, auth } = deps;
  const { people, swaps, fromStock, ...rest } = input;
  if (swaps !== undefined) {
    const row = await assertCanEdit(db, auth, id);
    await db.update(mealPlanEntries).set({ swaps: await cleanSwaps(db, auth, row.recipeId, swaps) }).where(eq(mealPlanEntries.id, id));
  }
  const before = (await peopleFor(db, [id])).get(id) ?? [];
  // Taking a free portion (or giving yours back) is open to anyone who can see the meal.
  const row = Object.keys(rest).length || fromStock !== undefined ? await assertCanEdit(db, auth, id) : await findEntry(db, auth, id);
  if (rest.batch && row.kind !== 'recipe') throw badRequest('Only recipes can be batch cooked.');
  const servings = rest.servings ?? row.servings;
  const batch = rest.batch ?? row.batch;
  // A food that's all one person's: a new amount is their new amount, and a new person takes it over (eaten or not).
  const onePersons = row.kind !== 'recipe' && before.length === 1 && Math.abs(before[0]!.portions - row.servings) < 0.001;
  let next: Portions | undefined = people;
  if (batch) next = [];
  else if (next) assertPeopleChange(auth, servings, before, next);
  else if (rest.servings !== undefined && onePersons) next = [{ userId: before[0]!.userId, portions: servings }];
  else if (rest.servings !== undefined && totalPortions(before) > servings) next = trimTo(servings, before);
  if (Object.keys(rest).length) await db.update(mealPlanEntries).set(rest).where(eq(mealPlanEntries.id, id));
  if (next) await setPeople(db, auth, id, next, onePersons && next.length === 1 ? before[0]!.eatenAt : null);
  // "Not done yet" and Skip: nobody has eaten it. Marked done: everyone with a portion has.
  if (rest.status === 'planned' || rest.status === 'skipped') {
    await db.update(mealPlanPeople).set({ eatenAt: null, eatenBy: null }).where(eq(mealPlanPeople.entryId, id));
  } else if (rest.status === 'cooked') {
    await db.update(mealPlanPeople).set({ eatenAt: deps.now, eatenBy: auth.user.id }).where(and(eq(mealPlanPeople.entryId, id), isNull(mealPlanPeople.eatenAt)));
  }
  // Stock follows what's been eaten.
  const now = { ...row, ...rest, batch };
  if (stockableRow(now)) {
    const after = eatenServings((await peopleFor(db, [id])).get(id) ?? []);
    if (fromStock !== undefined && fromStock !== (row.fromStock ?? false)) {
      await db.update(mealPlanEntries).set({ fromStock }).where(eq(mealPlanEntries.id, id));
      if (!fromStock) await returnToStock({ ...deps, mealPlanEntryId: id }, id, 'all');
      else {
        await settleStock(deps, { ...now, fromStock: true }, 0, after);
        await dropIfNothingTaken(db, now);
      }
    } else {
      await settleStock(deps, now, eatenServings(before), after);
    }
  }
  return getEntry(db, auth, id);
}

/**
 * Remove a meal. Food or leftovers it took from stock go back. For a cooked recipe,
 * `restoreStock` undoes what the cook took (newest change first); anything that has changed
 * since stays as it is.
 */
export async function deleteEntry(deps: StockDeps, id: string, restoreStock = false): Promise<{ restored: number }> {
  const row = await assertCanEdit(deps.db, deps.auth, id);
  let restored = 0;
  if (stockableRow(row)) {
    if ((await returnToStock({ ...deps, mealPlanEntryId: id }, id, 'all')) > 0) restored = 1;
  } else if (restoreStock) {
    const events = await deps.db
      .select({ id: stockEvents.id })
      .from(stockEvents)
      .where(and(eq(stockEvents.mealPlanEntryId, id), eq(stockEvents.householdId, deps.auth.household.id), isNull(stockEvents.undoneAt)))
      .orderBy(desc(stockEvents.seq));
    for (const ev of events) {
      try {
        await undoEvent(deps, ev.id);
        restored++;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
    }
  }
  await deps.db.delete(mealPlanEntries).where(eq(mealPlanEntries.id, id));
  return { restored };
}

/**
 * Tick people as having eaten a meal (default: you). Anyone in the household can tick for
 * anyone, so you can log for each other. Someone without a portion gets one of the free
 * servings. Food, leftovers and generic foods come out of stock: `fromStock` says whether (the
 * first time it's left out, they do when there is some), and the line remembers, so ticking
 * again never asks or takes twice. Recipes go through the cook flow. The meal is done once
 * everyone's eaten.
 */
export async function eatEntry(deps: StockDeps, id: string, fromStock: boolean | undefined, who?: string[]): Promise<PlanEatDto> {
  const { db, auth, now } = deps;
  const row = await findEntry(db, auth, id);
  if (row.batch) throw badRequest("A batch cook isn't eaten now: it's for later.");
  if (row.status === 'skipped') await db.update(mealPlanEntries).set({ status: 'planned' }).where(eq(mealPlanEntries.id, id));
  const members = new Set((await householdMembers(db, auth)).map((u) => u.id));
  const eaters = [...new Set(who?.length ? who : [auth.user.id])];
  if (eaters.some((u) => !members.has(u))) throw badRequest("That person isn't in your household.");
  let people = (await peopleFor(db, [id])).get(id) ?? [];
  // Give portions to anyone ticked who hasn't got one: all of it when nobody had any, else one each.
  const missing = eaters.filter((u) => !people.some((p) => p.userId === u));
  if (missing.length) {
    let free = Math.max(0, row.servings - row.keptServings - totalPortions(people));
    if (free < 0.001) throw badRequest('Every portion of that already belongs to someone.');
    const each = people.length ? null : Math.round((free / missing.length) * 1000) / 1000;
    const added: PeopleRow[] = [];
    for (const u of missing) {
      const portions = each ?? Math.min(1, free);
      if (portions < 0.001) break;
      free -= portions;
      added.push({ userId: u, portions, eatenAt: null });
    }
    if (added.length) await db.insert(mealPlanPeople).values(added.map((p) => ({ entryId: id, userId: p.userId, portions: p.portions })));
    people = [...people, ...added];
  }
  const ticking = people.filter((p) => eaters.includes(p.userId) && !p.eatenAt);
  let stockEventIds: string[] = [];
  if (ticking.length) {
    await db
      .update(mealPlanPeople)
      .set({ eatenAt: now, eatenBy: auth.user.id })
      .where(and(eq(mealPlanPeople.entryId, id), inArray(mealPlanPeople.userId, ticking.map((p) => p.userId))));
    if (stockableRow(row)) {
      const want = fromStock ?? row.fromStock ?? true;
      if (row.fromStock !== want) await db.update(mealPlanEntries).set({ fromStock: want }).where(eq(mealPlanEntries.id, id));
      const before = eatenServings(people);
      stockEventIds = await settleStock(deps, { ...row, fromStock: want }, before, before + totalPortions(ticking));
      if (want) await dropIfNothingTaken(db, row);
    }
  }
  const after = (await peopleFor(db, [id])).get(id) ?? [];
  if (after.length && after.every((p) => p.eatenAt)) await db.update(mealPlanEntries).set({ status: 'cooked' }).where(eq(mealPlanEntries.id, id));
  return { entry: await getEntry(db, auth, id, eaters.length === 1 ? eaters[0]! : null), stockEventIds };
}

/** Untick: they haven't eaten it after all. Their share goes back into stock if it came from there. */
export async function uneatEntry(deps: StockDeps, id: string, who?: string[]): Promise<PlanEntryDto> {
  const { db, auth } = deps;
  const row = await findEntry(db, auth, id);
  const people = who?.length ? who : [auth.user.id];
  const before = (await peopleFor(db, [id])).get(id) ?? [];
  await db.update(mealPlanPeople).set({ eatenAt: null, eatenBy: null }).where(and(eq(mealPlanPeople.entryId, id), inArray(mealPlanPeople.userId, people)));
  await settleStock(deps, row, eatenServings(before), eatenServings(before.filter((p) => !people.includes(p.userId))));
  // Done meals go back to planned; a cooked recipe stays cooked (the cook happened).
  if (row.status === 'cooked' && row.kind !== 'recipe') await db.update(mealPlanEntries).set({ status: 'planned' }).where(eq(mealPlanEntries.id, id));
  return getEntry(db, auth, id, people.length === 1 ? people[0]! : null);
}

/**
 * Use food from a stock row and log it as eaten by you, in one go: the use is linked to the
 * diary line, which owns it from then on (a new amount, an untick or removing the line moves
 * the food). More of something already logged at that meal is added to that line. The line's
 * amount is what was used, in its own servings (packs, items or portions), so its calories are right.
 */
export async function useAndLog(
  deps: StockDeps,
  stockItemId: string,
  amount: UseAmount,
  log: { date?: CalendarDate; slot?: MealSlot },
  opts: { wholeRow?: boolean; finishOpen?: boolean } = {},
): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const [item] = await db.select().from(stockItems).where(and(eq(stockItems.id, stockItemId), eq(stockItems.householdId, auth.household.id)));
  if (!item) throw notFound("That item isn't in stock.");
  const [product] = await db.select().from(products).where(eq(products.id, item.productId));
  const meal = product?.recipeId != null;
  const input: NewEntry = {
    date: log.date ?? householdToday(auth, now),
    slot: log.slot ?? slotForTime(wallClockIn(auth.household.timeZone, now).hour),
    kind: meal ? 'stock' : 'product',
    stockItemId: meal ? item.id : null,
    productId: meal ? null : item.productId,
    servings: 1,
    people: [{ userId: auth.user.id, portions: 1 }],
    batch: false,
    eaten: true,
    fromStock: false,
  };
  const into = await mergeTarget(db, auth, { ...input, fromStock: true }, auth.user.id);
  const entryId = into?.id ?? (await createEntryWithStock(deps, input)).entry.id;
  const change = await useFromRow({ ...deps, mealPlanEntryId: entryId }, item.id, amount, opts);
  // What it took, in the line's servings: by weight when the packs' sizes are known, else in packs.
  const unitGrams = product?.portionGrams ?? product?.packGrams ?? null;
  let used: number;
  if (change.usedGrams != null && unitGrams) used = change.usedGrams / unitGrams;
  else {
    const events = change.eventIds?.length ? await db.select({ fraction: stockEvents.fraction }).from(stockEvents).where(inArray(stockEvents.id, change.eventIds)) : [];
    used = events.reduce((n, e) => n + (e.fraction ?? 0), 0) || 1;
  }
  const servings = roundServings((into?.servings ?? 0) + Math.max(0.0001, used));
  await db.update(mealPlanEntries).set({ servings, fromStock: true }).where(eq(mealPlanEntries.id, entryId));
  await db.update(mealPlanPeople).set({ portions: servings }).where(eq(mealPlanPeople.entryId, entryId));
  return { ...change, entryId, ...(into ? { entryWas: into.servings } : {}) };
}

/** Eat mode: log a scanned product to your current meal and take one from stock if it's there. */
export async function logEaten(deps: StockDeps, product: ProductRow, slot?: MealSlot): Promise<{ entry: PlanEntryDto; stockChanged: boolean }> {
  const { auth, now } = deps;
  const clock = wallClockIn(auth.household.timeZone, now);
  const r = await createEntryWithStock(deps, {
    date: householdToday(auth, now),
    slot: slot ?? slotForTime(clock.hour),
    kind: 'product',
    productId: product.id,
    servings: 1,
    people: [{ userId: auth.user.id, portions: 1 }],
    batch: false,
    eaten: true,
    fromStock: true,
    source: 'scan',
  });
  return { entry: r.entry, stockChanged: r.stockEventIds.length > 0 };
}

/** Food set aside for meals planned from today on. */
export async function earmarks(db: Db, auth: Auth, today: CalendarDate, until?: CalendarDate): Promise<EarmarkDto[]> {
  const conditions = [eq(mealPlanEntries.householdId, auth.household.id), eq(mealPlanEntries.status, 'planned'), eq(mealPlanEntries.kind, 'recipe'), gte(mealPlanEntries.date, today)];
  if (until) conditions.push(lte(mealPlanEntries.date, until));
  const entries = await db
    .select({ entry: mealPlanEntries, recipe: recipes })
    .from(mealPlanEntries)
    .innerJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(and(...conditions))
    .orderBy(asc(mealPlanEntries.date));
  if (!entries.length) return [];
  const lines = await db
    .select()
    .from(recipeIngredients)
    .where(inArray(recipeIngredients.recipeId, [...new Set(entries.map((e) => e.recipe.id))]));
  const out = new Map<string, EarmarkDto>();
  for (const { entry, recipe } of entries) {
    for (const l of lines.filter((x) => x.recipeId === recipe.id && x.ingredientId && x.grams && !x.optional)) {
      const grams = Math.round(((l.grams! * entry.servings) / recipe.serves) * 10) / 10;
      // A swap chosen for this meal uses the other food instead, weight for weight.
      const ingredientId = entry.swaps?.[l.id] ?? l.ingredientId!;
      const e = out.get(ingredientId) ?? { ingredientId, grams: 0, meals: [] };
      e.grams = Math.round((e.grams + grams) * 10) / 10;
      e.meals.push({ entryId: entry.id, title: recipe.title, date: entry.date, grams });
      out.set(ingredientId, e);
    }
  }
  return [...out.values()];
}
