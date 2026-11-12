/**
 * The meal planner: per-person calendars of meal slots, calories, eating
 * planned food (which takes it out of stock), Eat-mode scans, and the food
 * earmarked for planned meals (planned meals warn, they don't lock stock).
 */
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  addDays,
  type CalendarDate,
  type EarmarkDto,
  MEAL_SLOTS,
  type MealSlot,
  orderForUse,
  type PlanDayDto,
  type PlanDto,
  type PlanEntryDto,
  type PlanEntryInput,
  portionShare,
  slotForTime,
  wallClockIn,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { locations, mealPlanEntries, mealPlanPeople, products, recipeIngredients, recipes, stockItems, users } from '../db/schema';
import { forbidden, notFound } from '../http';
import type { ProductRow } from './catalog';
import { listRecipes } from './recipes';
import { householdToday, type StockDeps, usePack } from './stock';

type EntryRow = typeof mealPlanEntries.$inferSelect;
const SLOT_ORDER: Record<MealSlot, number> = Object.fromEntries(MEAL_SLOTS.map((s, i) => [s, i])) as Record<MealSlot, number>;

/** Calories in one serving of a product: one pack, or one portion for cooked meals. */
export function productKcal(p: ProductRow | undefined): number | null {
  const per100 = p?.nutritionPer100g?.kcal;
  const grams = p?.portionGrams ?? p?.packGrams;
  if (per100 == null || !grams) return null;
  return Math.round((per100 * grams) / 100);
}

interface Lookups {
  members: { id: string; name: string }[];
  recipeKcal: Map<string, { title: string; kcal: number | null }>;
  productsById: Map<string, ProductRow>;
  stockById: Map<string, { productId: string; locationName: string }>;
}

async function lookups(db: Db, auth: Auth, rows: EntryRow[]): Promise<Lookups> {
  const members = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.householdId, auth.household.id));
  const summaries = await listRecipes(db, auth);
  const recipeKcal = new Map(summaries.map((r) => [r.id, { title: r.title, kcal: r.kcalPerServing }]));
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
  return {
    members,
    recipeKcal,
    productsById: new Map(prods.map((p) => [p.id, p])),
    stockById: new Map(stock.map((s) => [s.id, { productId: s.productId, locationName: s.locationName }])),
  };
}

function toDto(row: EntryRow, people: { userId: string; portions: number }[], l: Lookups, personId: string | null): PlanEntryDto {
  let title = row.text ?? 'Meal';
  let kcalPerServing: number | null = row.kcalPerServing;
  let detail: string | null = null;
  let unit: ProductRow | undefined;
  if (row.kind === 'recipe' && row.recipeId) {
    const r = l.recipeKcal.get(row.recipeId);
    title = r?.title ?? 'Deleted recipe';
    kcalPerServing = r?.kcal ?? null;
  } else if (row.kind === 'product' && row.productId) {
    const p = l.productsById.get(row.productId);
    unit = p;
    title = p?.name ?? 'Unnamed product';
    kcalPerServing = productKcal(p);
  } else if (row.kind === 'stock' && row.stockItemId) {
    const s = l.stockById.get(row.stockItemId);
    const p = s ? l.productsById.get(s.productId) : undefined;
    unit = p;
    title = p?.name ? `Leftover ${p.name.charAt(0).toLowerCase()}${p.name.slice(1)}` : 'Leftovers';
    kcalPerServing = productKcal(p);
    detail = s ? `From ${s.locationName.toLowerCase()}` : null;
  }
  if (row.source === 'scan') detail = 'Scanned';
  const names = new Map(l.members.map((m) => [m.id, m.name]));
  const share = personId ? portionShare(row.servings, people, personId, l.members.length) : row.servings;
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    kind: row.kind,
    recipeId: row.recipeId,
    productId: row.productId,
    stockItemId: row.stockItemId,
    title,
    detail,
    servings: row.servings,
    unitGrams: unit ? (unit.portionGrams ?? unit.packGrams ?? null) : null,
    displayUnit: unit?.displayUnit ?? 'g',
    status: row.status,
    source: row.source === 'scan' ? 'scan' : 'plan',
    people: people.map((p) => ({ userId: p.userId, name: names.get(p.userId) ?? 'Someone', portions: p.portions })),
    kcalPerServing,
    kcal: kcalPerServing === null ? null : Math.round(kcalPerServing * share),
  };
}

async function peopleFor(db: Db, ids: string[]) {
  const rows = ids.length ? await db.select().from(mealPlanPeople).where(inArray(mealPlanPeople.entryId, ids)) : [];
  const map = new Map<string, { userId: string; portions: number }[]>();
  for (const r of rows) map.set(r.entryId, [...(map.get(r.entryId) ?? []), { userId: r.userId, portions: r.portions }]);
  return map;
}

/** A person's calendar (their meals and the household's), or everyone's. Skipped meals are left out of the calories. */
export async function listPlan(db: Db, auth: Auth, from: CalendarDate, to: CalendarDate, personId: string | null): Promise<PlanDto> {
  const rows = await db
    .select()
    .from(mealPlanEntries)
    .where(and(eq(mealPlanEntries.householdId, auth.household.id), gte(mealPlanEntries.date, from), lte(mealPlanEntries.date, to)));
  const people = await peopleFor(db, rows.map((r) => r.id));
  const l = await lookups(db, auth, rows);
  const visible = rows
    .filter((r) => !personId || (people.get(r.id) ?? []).length === 0 || (people.get(r.id) ?? []).some((p) => p.userId === personId))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()));
  const days: PlanDayDto[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const entries = visible.filter((r) => r.date === d).map((r) => toDto(r, people.get(r.id) ?? [], l, personId));
    days.push({ date: d, entries, kcal: entries.filter((e) => e.status !== 'skipped').reduce((s, e) => s + (e.kcal ?? 0), 0) });
  }
  return { from, to, personId, days };
}

export async function getEntry(db: Db, auth: Auth, id: string, personId: string | null = null): Promise<PlanEntryDto> {
  const [row] = await db.select().from(mealPlanEntries).where(and(eq(mealPlanEntries.id, id), eq(mealPlanEntries.householdId, auth.household.id)));
  if (!row) throw notFound('That meal is no longer planned.');
  const people = await peopleFor(db, [id]);
  return toDto(row, people.get(id) ?? [], await lookups(db, auth, [row]), personId);
}

/** Members can change their own and household meals; admins anyone's. */
async function assertCanEdit(db: Db, auth: Auth, entryId: string): Promise<EntryRow> {
  const [row] = await db.select().from(mealPlanEntries).where(and(eq(mealPlanEntries.id, entryId), eq(mealPlanEntries.householdId, auth.household.id)));
  if (!row) throw notFound('That meal is no longer planned.');
  if (auth.user.role !== 'admin') {
    const people = (await peopleFor(db, [entryId])).get(entryId) ?? [];
    if (people.length && !people.some((p) => p.userId === auth.user.id)) throw forbidden("That's on someone else's calendar.");
  }
  return row;
}

async function setPeople(db: Db, auth: Auth, entryId: string, people: { userId: string; portions: number }[]) {
  await db.delete(mealPlanPeople).where(eq(mealPlanPeople.entryId, entryId));
  if (!people.length) return;
  const members = new Set((await db.select({ id: users.id }).from(users).where(eq(users.householdId, auth.household.id))).map((u) => u.id));
  const valid = people.filter((p) => members.has(p.userId));
  if (valid.length) await db.insert(mealPlanPeople).values(valid.map((p) => ({ entryId, userId: p.userId, portions: p.portions })));
}

export async function createEntry(deps: StockDeps, input: PlanEntryInput & { source?: 'plan' | 'scan' }): Promise<PlanEntryDto> {
  const { db, auth } = deps;
  if (auth.user.role !== 'admin' && input.people.length && !input.people.some((p) => p.userId === auth.user.id)) {
    throw forbidden("Only admins can plan meals on someone else's calendar.");
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
      text: input.kind === 'text' ? (input.text ?? null) : null,
      servings: input.servings,
      kcalPerServing: input.kind === 'text' ? (input.kcalPerServing ?? null) : null,
      status: 'planned',
      source: input.source ?? 'plan',
      createdBy: auth.user.id,
    })
    .returning();
  await setPeople(db, auth, row!.id, input.people);
  if (input.eaten) {
    await eatEntry(deps, row!.id, true);
  }
  return getEntry(db, auth, row!.id, input.people.length === 1 ? input.people[0]!.userId : null);
}

export async function updateEntry(
  deps: StockDeps,
  id: string,
  input: { date?: string; slot?: MealSlot; servings?: number; status?: 'planned' | 'cooked' | 'skipped'; people?: { userId: string; portions: number }[] },
): Promise<PlanEntryDto> {
  const { db, auth } = deps;
  await assertCanEdit(db, auth, id);
  const { people, ...rest } = input;
  if (Object.keys(rest).length) await db.update(mealPlanEntries).set(rest).where(eq(mealPlanEntries.id, id));
  if (people) await setPeople(db, auth, id, people);
  return getEntry(db, auth, id);
}

export async function deleteEntry(deps: StockDeps, id: string): Promise<void> {
  await assertCanEdit(deps.db, deps.auth, id);
  await deps.db.delete(mealPlanEntries).where(eq(mealPlanEntries.id, id));
}

/** Mark a planned product or leftovers as eaten, taking it out of stock. (Recipes go through the cook flow.) */
export async function eatEntry(deps: StockDeps, id: string, fromStock: boolean): Promise<{ entry: PlanEntryDto; changed: boolean }> {
  const { db, auth } = deps;
  const row = await assertCanEdit(db, auth, id);
  let changed = false;
  const d: StockDeps = { ...deps, mealPlanEntryId: id };
  if (fromStock && row.kind === 'stock' && row.stockItemId) {
    const [item] = await db.select().from(stockItems).where(and(eq(stockItems.id, row.stockItemId), isNull(stockItems.finishedAt)));
    const [product] = item ? await db.select().from(products).where(eq(products.id, item.productId)) : [];
    if (item) {
      const portion = product?.portionGrams;
      const grams = portion && item.remainingGrams !== null ? Math.min(item.remainingGrams, portion * row.servings) : null;
      await usePack(d, item.id, grams ? { kind: 'grams', grams } : { kind: 'all' });
      changed = true;
    }
  } else if (fromStock && row.kind === 'product' && row.productId) {
    const [product] = await db.select().from(products).where(eq(products.id, row.productId));
    const packs = orderForUse(
      (await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.householdId, auth.household.id), eq(stockItems.productId, row.productId), isNull(stockItems.finishedAt)))).map((p) => ({ ...p })),
    );
    // One item is a portion (a bar from a multipack) or the whole pack; take exactly what was planned.
    const itemGrams = product?.portionGrams ?? product?.packGrams ?? null;
    if (itemGrams) {
      let left = itemGrams * row.servings;
      for (const p of packs) {
        if (left <= 0.5) break;
        const take = p.remainingGrams === null ? null : Math.min(p.remainingGrams, left);
        await usePack(d, p.id, take === null || take >= (p.remainingGrams ?? 0) ? { kind: 'all' } : { kind: 'grams', grams: take });
        left -= take ?? itemGrams;
        changed = true;
      }
    } else {
      let packsLeft = Math.ceil(row.servings);
      for (const p of packs) {
        if (packsLeft <= 0) break;
        await usePack(d, p.id, { kind: 'all' });
        packsLeft--;
        changed = true;
      }
    }
  }
  await db.update(mealPlanEntries).set({ status: 'cooked' }).where(eq(mealPlanEntries.id, id));
  return { entry: await getEntry(db, auth, id), changed };
}

/** Eat mode: log a scanned product to your current meal and take one from stock if it's there. */
export async function logEaten(deps: StockDeps, product: ProductRow, slot?: MealSlot): Promise<{ entry: PlanEntryDto; stockChanged: boolean }> {
  const { auth, now } = deps;
  const clock = wallClockIn(auth.household.timeZone, now);
  const entry = await createEntry(deps, {
    date: householdToday(auth, now),
    slot: slot ?? slotForTime(clock.hour),
    kind: 'product',
    productId: product.id,
    servings: 1,
    people: [{ userId: auth.user.id, portions: 1 }],
    eaten: false,
    source: 'scan',
  });
  const r = await eatEntry(deps, entry.id, true);
  return { entry: r.entry, stockChanged: r.changed };
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
      const e = out.get(l.ingredientId!) ?? { ingredientId: l.ingredientId!, grams: 0, meals: [] };
      e.grams = Math.round((e.grams + grams) * 10) / 10;
      e.meals.push({ entryId: entry.id, title: recipe.title, date: entry.date, grams });
      out.set(l.ingredientId!, e);
    }
  }
  return [...out.values()];
}
