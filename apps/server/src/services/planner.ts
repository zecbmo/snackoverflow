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
import { householdToday, type StockDeps, undoEvent, usePack } from './stock';

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

/** Nutrition in one serving of a product: one pack, or one portion for cooked meals. */
export function productNutrition(p: ProductRow | undefined): Nutrition | null {
  return nutritionFor(p?.nutritionPer100g, p?.portionGrams ?? p?.packGrams);
}

/** Calories in one serving of a product: one pack, or one portion for cooked meals. */
export function productKcal(p: ProductRow | undefined): number | null {
  const per100 = p?.nutritionPer100g?.kcal;
  const grams = p?.portionGrams ?? p?.packGrams;
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
  const foodIds = [...new Set(rows.map((r) => (r.kind === 'ingredient' ? r.ingredientId : null)).filter((x): x is string => Boolean(x)))];
  const foods = foodIds.length ? await db.select().from(ingredients).where(inArray(ingredients.id, foodIds)) : [];
  const chainItemIds = [...new Set(rows.map((r) => r.chainItemId).filter((x): x is string => Boolean(x)))];
  const chainRows = chainItemIds.length
    ? await db
        .select({ id: chainMenuItems.id, chain: chains.name })
        .from(chainMenuItems)
        .innerJoin(chains, eq(chains.key, chainMenuItems.chainKey))
        .where(inArray(chainMenuItems.id, chainItemIds))
    : [];
  return {
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
    unitGrams = unit.portionGrams ?? unit.packGrams ?? null;
    displayUnit = unit.displayUnit;
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
    status: row.status,
    source: row.source === 'scan' ? 'scan' : 'plan',
    people: eatenPeople.map((p) => ({ ...p, name: names.get(p.userId) ?? 'Someone' })),
    batch: row.batch,
    kcalPerServing,
    nutritionPerServing,
    kcal: kcalPerServing === null ? null : Math.round(kcalPerServing * share),
    eaten,
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

async function setPeople(db: Db, auth: Auth, entryId: string, people: { userId: string; portions: number }[]) {
  // Whoever has already eaten keeps their tick.
  const before = (await peopleFor(db, [entryId])).get(entryId) ?? [];
  await db.delete(mealPlanPeople).where(eq(mealPlanPeople.entryId, entryId));
  if (!people.length) return;
  const members = new Set((await householdMembers(db, auth)).map((u) => u.id));
  const valid = people.filter((p) => members.has(p.userId));
  if (valid.length) {
    await db.insert(mealPlanPeople).values(
      valid.map((p) => {
        const was = before.find((b) => b.userId === p.userId);
        return { entryId, userId: p.userId, portions: p.portions, eatenAt: was?.eatenAt ?? null };
      }),
    );
  }
}

async function householdMembers(db: Db, auth: Auth) {
  return db.select({ id: users.id }).from(users).where(eq(users.householdId, auth.household.id));
}

export async function createEntry(deps: StockDeps, input: PlanEntryInput & { source?: 'plan' | 'scan' }): Promise<PlanEntryDto> {
  return (await createEntryWithStock(deps, input)).entry;
}

/** Plan a meal, or log one as eaten (taking it from stock when asked). Returns the stock changes too. */
export async function createEntryWithStock(deps: StockDeps, input: PlanEntryInput & { source?: 'plan' | 'scan' }): Promise<PlanEatDto> {
  const { db, auth } = deps;
  if (auth.user.role !== 'admin' && !input.eaten && input.people.length && !input.people.some((p) => p.userId === auth.user.id)) {
    throw forbidden("Only admins can plan meals on someone else's calendar.");
  }
  const batch = input.kind === 'recipe' && input.batch;
  // Logged as already eaten with nobody named: the person logging it ate it.
  const people = batch ? [] : input.people.length || !input.eaten ? input.people : [{ userId: auth.user.id, portions: input.servings }];
  if (totalPortions(people) > input.servings + 0.001) throw badRequest('More portions handed out than there are servings.');
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
    swaps?: Record<string, string> | null;
  },
): Promise<PlanEntryDto> {
  const { db, auth } = deps;
  const { people, swaps, ...rest } = input;
  if (swaps !== undefined) {
    const row = await assertCanEdit(db, auth, id);
    await db.update(mealPlanEntries).set({ swaps: await cleanSwaps(db, auth, row.recipeId, swaps) }).where(eq(mealPlanEntries.id, id));
  }
  const before = (await peopleFor(db, [id])).get(id) ?? [];
  // Taking a free portion (or giving yours back) is open to anyone who can see the meal.
  const row = Object.keys(rest).length ? await assertCanEdit(db, auth, id) : await findEntry(db, auth, id);
  if (rest.batch && row.kind !== 'recipe') throw badRequest('Only recipes can be batch cooked.');
  const servings = rest.servings ?? row.servings;
  const batch = rest.batch ?? row.batch;
  let next: Portions | undefined = people;
  if (batch) next = [];
  else if (next) assertPeopleChange(auth, servings, before, next);
  else if (rest.servings !== undefined && totalPortions(before) > servings) next = trimTo(servings, before);
  if (Object.keys(rest).length) await db.update(mealPlanEntries).set(rest).where(eq(mealPlanEntries.id, id));
  if (next) await setPeople(db, auth, id, next);
  // "Not done yet" and Skip: nobody has eaten it. Marked done: everyone with a portion has.
  if (rest.status === 'planned' || rest.status === 'skipped') {
    await db.update(mealPlanPeople).set({ eatenAt: null, eatenBy: null }).where(eq(mealPlanPeople.entryId, id));
  } else if (rest.status === 'cooked') {
    await db.update(mealPlanPeople).set({ eatenAt: deps.now, eatenBy: auth.user.id }).where(and(eq(mealPlanPeople.entryId, id), isNull(mealPlanPeople.eatenAt)));
  }
  return getEntry(db, auth, id);
}

/**
 * Remove a meal. With `restoreStock`, food it took from stock goes back first (newest change
 * first); anything that has changed since stays as it is.
 */
export async function deleteEntry(deps: StockDeps, id: string, restoreStock = false): Promise<{ restored: number }> {
  await assertCanEdit(deps.db, deps.auth, id);
  let restored = 0;
  if (restoreStock) {
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
 * servings. With `fromStock`, their share of planned food, leftovers or a generic food comes
 * out of stock (recipes go through the cook flow). The meal is done once everyone's eaten.
 */
export async function eatEntry(deps: StockDeps, id: string, fromStock: boolean, who?: string[]): Promise<PlanEatDto> {
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
    let free = Math.max(0, row.servings - totalPortions(people));
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
  const servings = totalPortions(ticking);
  const stockEventIds: string[] = [];
  if (fromStock && servings > 0) stockEventIds.push(...(await takeFromStock({ ...deps, mealPlanEntryId: id }, row, servings)));
  if (ticking.length) {
    await db
      .update(mealPlanPeople)
      .set({ eatenAt: now, eatenBy: auth.user.id })
      .where(and(eq(mealPlanPeople.entryId, id), inArray(mealPlanPeople.userId, ticking.map((p) => p.userId))));
  }
  const after = (await peopleFor(db, [id])).get(id) ?? [];
  if (after.length && after.every((p) => p.eatenAt)) await db.update(mealPlanEntries).set({ status: 'cooked' }).where(eq(mealPlanEntries.id, id));
  return { entry: await getEntry(db, auth, id, eaters.length === 1 ? eaters[0]! : null), stockEventIds };
}

/** Untick: they haven't eaten it after all. Stock isn't put back here (Undo does that). */
export async function uneatEntry(deps: StockDeps, id: string, who?: string[]): Promise<PlanEntryDto> {
  const { db, auth } = deps;
  const row = await findEntry(db, auth, id);
  const people = who?.length ? who : [auth.user.id];
  await db.update(mealPlanPeople).set({ eatenAt: null, eatenBy: null }).where(and(eq(mealPlanPeople.entryId, id), inArray(mealPlanPeople.userId, people)));
  // Done meals go back to planned; a cooked recipe stays cooked (the cook happened).
  if (row.status === 'cooked' && row.kind !== 'recipe') await db.update(mealPlanEntries).set({ status: 'planned' }).where(eq(mealPlanEntries.id, id));
  return getEntry(db, auth, id, people.length === 1 ? people[0]! : null);
}

/** Take `servings` of a meal's food out of stock, earliest-expiring first. Returns the stock events. */
async function takeFromStock(d: StockDeps, row: EntryRow, servings: number): Promise<string[]> {
  const { db, auth } = d;
  const events: string[] = [];
  if (row.kind === 'stock' && row.stockItemId) {
    const [item] = await db.select().from(stockItems).where(and(eq(stockItems.id, row.stockItemId), isNull(stockItems.finishedAt)));
    const [product] = item ? await db.select().from(products).where(eq(products.id, item.productId)) : [];
    if (item) {
      const portion = product?.portionGrams;
      const grams = portion && item.remainingGrams !== null ? Math.min(item.remainingGrams, portion * servings) : null;
      events.push((await usePack(d, item.id, grams && grams < item.remainingGrams! ? { kind: 'grams', grams } : { kind: 'all' })).eventId);
    }
    return events;
  }
  let itemGrams: number | null = null;
  let packs: (typeof stockItems.$inferSelect)[] = [];
  if (row.kind === 'product' && row.productId) {
    const [product] = await db.select().from(products).where(eq(products.id, row.productId));
    // One item is a portion (a bar from a multipack) or the whole pack; take exactly what was eaten.
    itemGrams = product?.portionGrams ?? product?.packGrams ?? null;
    packs = await db
      .select()
      .from(stockItems)
      .where(and(eq(stockItems.householdId, auth.household.id), eq(stockItems.productId, row.productId), isNull(stockItems.finishedAt)));
  } else if (row.kind === 'ingredient' && row.ingredientId) {
    const [ing] = await db.select().from(ingredients).where(eq(ingredients.id, row.ingredientId));
    if (!ing) return events;
    itemGrams = ingredientServing(ing).unitGrams;
    // Any pack of that food (not cooked meals made from it).
    packs = (
      await db
        .select({ item: stockItems })
        .from(stockItems)
        .innerJoin(products, eq(products.id, stockItems.productId))
        .where(and(eq(stockItems.householdId, auth.household.id), eq(products.ingredientId, row.ingredientId), isNull(products.recipeId), isNull(stockItems.finishedAt)))
    ).map((r) => r.item);
  } else {
    return events;
  }
  const ordered = orderForUse(packs.map((p) => ({ ...p })));
  if (itemGrams) {
    let left = itemGrams * servings;
    for (const p of ordered) {
      if (left <= 0.5) break;
      const take = p.remainingGrams === null ? null : Math.min(p.remainingGrams, left);
      events.push((await usePack(d, p.id, take === null || take >= (p.remainingGrams ?? 0) ? { kind: 'all' } : { kind: 'grams', grams: take })).eventId);
      left -= take ?? itemGrams;
    }
  } else {
    let packsLeft = Math.ceil(servings);
    for (const p of ordered) {
      if (packsLeft <= 0) break;
      events.push((await usePack(d, p.id, { kind: 'all' })).eventId);
      packsLeft--;
    }
  }
  return events;
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
