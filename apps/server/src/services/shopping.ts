/**
 * The shared shopping list: build it from the plan (what the plan needs, minus
 * stock, minus what's already on the list, rounded up to whole packs), staples
 * running low, manual items, and putting the shopping away afterwards.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import {
  addDays,
  type BuildListResultDto,
  type CalendarDate,
  choosePacks,
  estimateRunOut,
  RUNNING_LOW_DAYS,
  type RunningLowDto,
  type ShoppingItemDto,
  formatPackSize,
  amountText,
  todayIn,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { ingredients, locations, products, shoppingItems, stockEvents, stockItems, users } from '../db/schema';
import { notFound } from '../http';
import { type Catalog, type IngredientRow, loadCatalog } from './catalog';
import { earmarks } from './planner';
import { estimateItemPence, ingredientPrices, latestPrices } from './pricing';
import { addPack, firstLocationOfType, type StockDeps } from './stock';

type ItemRow = typeof shoppingItems.$inferSelect;

function aisleOf(item: ItemRow, catalog: Catalog): string {
  return (item.ingredientId ? catalog.ingredients.get(item.ingredientId)?.aisle : null) ?? 'Other';
}

/** The list, grouped by aisle. With `pricing` on, each line gets an estimated cost. */
export async function listShopping(db: Db, auth: Auth, pricing = false, now: Date = new Date()): Promise<ShoppingItemDto[]> {
  const [rows, catalog, people, prods] = await Promise.all([
    db.select().from(shoppingItems).where(eq(shoppingItems.householdId, auth.household.id)).orderBy(asc(shoppingItems.createdAt)),
    loadCatalog(db, auth.household.id),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.householdId, auth.household.id)),
    db.select().from(products).where(eq(products.householdId, auth.household.id)),
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  // What the planned meals still need, after stock, per ingredient: shown as "Needed" on every item for that food.
  const [needs, have] = await Promise.all([earmarks(db, auth, todayIn(auth.household.timeZone, now)), onHand(db, auth.household.id)]);
  const short = new Map(needs.map((m) => [m.ingredientId, Math.max(0, m.grams - (have.get(m.ingredientId) ?? 0))]));
  const productsById = new Map(prods.map((p) => [p.id, p]));
  const [latest, byIngredient] = pricing ? await Promise.all([latestPrices(db, auth.household.id), ingredientPrices(db, auth.household.id)]) : [null, null];
  /** Grams said the way the food is sold: "568ml" for milk, "12 eggs", "2.5kg". */
  const say = (grams: number | null, r: ItemRow): string | null => {
    if (!grams) return null;
    const ing = r.ingredientId ? catalog.ingredients.get(r.ingredientId) : undefined;
    return amountText(grams, ing);
  };
  const packLabel = (r: ItemRow): string | null => {
    const prod = r.productId ? productsById.get(r.productId) : undefined;
    if (prod?.packAmount && prod.packUnit) return formatPackSize(prod.packAmount, prod.packUnit);
    return say(r.packGrams, r);
  };
  return rows
    .map((r) => ({
      id: r.id,
      text: r.text,
      ingredientId: r.ingredientId,
      productId: r.productId,
      aisle: aisleOf(r, catalog),
      grams: r.grams,
      packs: r.packs,
      packGrams: r.packGrams,
      packLabel: packLabel(r),
      surplusGrams: r.surplusGrams,
      surplusLabel: say(r.surplusGrams, r),
      needLabel: (() => {
        const ingredientId = r.ingredientId ?? (r.productId ? (productsById.get(r.productId)?.ingredientId ?? null) : null);
        const g = ingredientId ? short.get(ingredientId) : undefined;
        if (!g || g < 1) return null;
        return amountText(g, catalog.ingredients.get(ingredientId!));
      })(),
      foodGroup: (r.productId ? productsById.get(r.productId)?.foodGroup : null) ?? (() => {
        const ingredientId = r.ingredientId ?? (r.productId ? (productsById.get(r.productId)?.ingredientId ?? null) : null);
        return ingredientId ? (catalog.ingredients.get(ingredientId)?.foodGroup ?? null) : null;
      })(),
      reason: r.reason,
      pricePence: latest && byIngredient ? estimateItemPence(r, latest, byIngredient) : null,
      forMeals: r.forMeals,
      checked: r.checked,
      addedByName: r.addedBy ? (names.get(r.addedBy) ?? null) : null,
    }))
    .sort((a, b) => (a.aisle === b.aisle ? 0 : a.aisle === 'Other' ? 1 : b.aisle === 'Other' ? -1 : a.aisle.localeCompare(b.aisle)));
}

/** Usual pack sizes for an ingredient: the seed data plus the products the household buys. */
async function packSizes(db: Db, householdId: string, ing: IngredientRow): Promise<number[]> {
  const prods = await db
    .select({ g: products.packGrams })
    .from(products)
    .where(and(eq(products.householdId, householdId), eq(products.ingredientId, ing.id)));
  return [...(ing.packSizesGrams ?? []), ...prods.map((p) => p.g).filter((g): g is number => g !== null && g > 0)];
}

/** Grams of each ingredient in stock now (packs of unknown size don't count). */
async function onHand(db: Db, householdId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ ingredientId: products.ingredientId, grams: stockItems.remainingGrams })
    .from(stockItems)
    .innerJoin(products, eq(products.id, stockItems.productId))
    .where(and(eq(stockItems.householdId, householdId), isNull(stockItems.finishedAt), isNull(products.recipeId)));
  const map = new Map<string, number>();
  for (const r of rows) if (r.ingredientId && r.grams) map.set(r.ingredientId, (map.get(r.ingredientId) ?? 0) + r.grams);
  return map;
}

export async function addItem(
  db: Db,
  auth: Auth,
  input: { text?: string; ingredientId?: string | null; productId?: string | null; packs: number; reason: 'manual' | 'running-low' },
): Promise<string> {
  const catalog = await loadCatalog(db, auth.household.id);
  const ing = input.ingredientId ? catalog.ingredients.get(input.ingredientId) : undefined;
  const [prod] = input.productId ? await db.select().from(products).where(and(eq(products.id, input.productId), eq(products.householdId, auth.household.id))) : [];
  // Already on the list and not ticked: add to it rather than listing it twice.
  if (ing || prod) {
    const [existing] = await db
      .select()
      .from(shoppingItems)
      .where(
        and(
          eq(shoppingItems.householdId, auth.household.id),
          eq(shoppingItems.checked, false),
          prod ? eq(shoppingItems.productId, prod.id) : eq(shoppingItems.ingredientId, ing!.id),
        ),
      )
      .limit(1);
    if (existing) {
      if (input.reason === 'manual') await db.update(shoppingItems).set({ packs: existing.packs + input.packs }).where(eq(shoppingItems.id, existing.id));
      return existing.id;
    }
  }
  const packGrams = prod?.packGrams ?? (ing ? Math.min(...(await packSizes(db, auth.household.id, ing)), Infinity) : null);
  const [row] = await db
    .insert(shoppingItems)
    .values({
      householdId: auth.household.id,
      ingredientId: ing?.id ?? prod?.ingredientId ?? null,
      productId: prod?.id ?? null,
      text: input.text?.trim() || prod?.name || ing?.name || 'Item',
      packs: input.packs,
      packGrams: packGrams && Number.isFinite(packGrams) ? packGrams : null,
      reason: input.reason,
      addedBy: auth.user.id,
    })
    .returning({ id: shoppingItems.id });
  return row!.id;
}

export async function updateItem(db: Db, auth: Auth, id: string, patch: { checked?: boolean; packs?: number; text?: string }, now: Date) {
  const set: Partial<ItemRow> = { ...patch };
  if (patch.checked !== undefined) set.checkedAt = patch.checked ? now : null;
  const r = await db
    .update(shoppingItems)
    .set(set)
    .where(and(eq(shoppingItems.id, id), eq(shoppingItems.householdId, auth.household.id)))
    .returning({ id: shoppingItems.id });
  if (!r.length) throw notFound("That's no longer on the list.");
}

export async function deleteItems(db: Db, auth: Auth, ids: string[] | 'checked') {
  const base = eq(shoppingItems.householdId, auth.household.id);
  await db.delete(shoppingItems).where(ids === 'checked' ? and(base, eq(shoppingItems.checked, true)) : and(base, inArray(shoppingItems.id, ids)));
}

/** Build list items for what the plan between `from` and `to` needs. Existing plan items are recalculated. */
export async function buildFromPlan(db: Db, auth: Auth, from: CalendarDate, to: CalendarDate, now: Date): Promise<BuildListResultDto> {
  const today = todayIn(auth.household.timeZone, now);
  const catalog = await loadCatalog(db, auth.household.id);
  const needs = await earmarks(db, auth, from, to);
  // Meals planned before the range eat into stock first.
  const earlier = from > today ? await earmarks(db, auth, today, addDays(from, -1)) : [];
  const stock = await onHand(db, auth.household.id);
  for (const e of earlier) stock.set(e.ingredientId, Math.max(0, (stock.get(e.ingredientId) ?? 0) - e.grams));

  const items = await db.select().from(shoppingItems).where(and(eq(shoppingItems.householdId, auth.household.id), eq(shoppingItems.checked, false)));
  const result: BuildListResultDto = { added: 0, updated: 0, covered: 0, surplus: [] };
  for (const need of needs) {
    const ing = catalog.ingredients.get(need.ingredientId);
    if (!ing) continue;
    const mine = items.filter((i) => i.ingredientId === ing.id);
    const planItem = mine.find((i) => i.reason === 'plan');
    // Other items already on the list for this ingredient are "coming".
    const coming = mine.filter((i) => i !== planItem).reduce((g, i) => g + (i.packGrams ?? 0) * i.packs, 0);
    const short = Math.round((need.grams - (stock.get(ing.id) ?? 0) - coming) * 10) / 10;
    const meals = [...new Set(need.meals.map((m) => m.title))].join(', ');
    if (short <= 0) {
      result.covered++;
      if (planItem) await db.delete(shoppingItems).where(eq(shoppingItems.id, planItem.id));
      continue;
    }
    const choice = choosePacks(short, await packSizes(db, auth.household.id, ing))!;
    const values = {
      grams: short,
      packs: choice.packs,
      packGrams: choice.packGrams,
      surplusGrams: choice.surplusGrams,
      forMeals: meals,
      text: ing.name,
    };
    if (planItem) {
      await db.update(shoppingItems).set(values).where(eq(shoppingItems.id, planItem.id));
      result.updated++;
    } else {
      await db.insert(shoppingItems).values({ ...values, householdId: auth.household.id, ingredientId: ing.id, reason: 'plan', addedBy: auth.user.id });
      result.added++;
    }
    if (choice.surplusGrams >= 50) result.surplus.push({ ingredientId: ing.id, name: ing.name, grams: choice.surplusGrams });
  }
  result.surplus.sort((a, b) => b.grams - a.grams);
  return result;
}

/** Staples flagged "track running low" that are gone or will be within a few days at the usual rate. */
export async function runningLow(db: Db, auth: Auth, now: Date): Promise<RunningLowDto[]> {
  const today = todayIn(auth.household.timeZone, now);
  const tracked = await db
    .select()
    .from(ingredients)
    .where(and(eq(ingredients.householdId, auth.household.id), eq(ingredients.trackRunningLow, true)));
  if (!tracked.length) return [];
  const stock = await onHand(db, auth.household.id);
  const since = new Date(now.getTime() - 60 * 86_400_000);
  const events = await db
    .select({ ingredientId: products.ingredientId, grams: stockEvents.grams, type: stockEvents.type, at: stockEvents.createdAt })
    .from(stockEvents)
    .innerJoin(products, eq(products.id, stockEvents.productId))
    .where(and(eq(stockEvents.householdId, auth.household.id), isNull(stockEvents.undoneAt), gte(stockEvents.createdAt, since)));
  const onList = new Set(
    (await db.select({ id: shoppingItems.ingredientId }).from(shoppingItems).where(and(eq(shoppingItems.householdId, auth.household.id), eq(shoppingItems.checked, false)))).map(
      (r) => r.id,
    ),
  );
  const out: RunningLowDto[] = [];
  for (const ing of tracked) {
    const mine = events.filter((e) => e.ingredientId === ing.id);
    // Never bought: not "running low", just not something this household keeps.
    if (mine.length === 0) continue;
    const uses = mine.filter((e) => (e.type === 'use' || e.type === 'discard') && e.grams).map((e) => ({ grams: e.grams!, day: todayIn(auth.household.timeZone, e.at) }));
    const have = stock.get(ing.id) ?? 0;
    const est = estimateRunOut({ uses, onHandGrams: have, today });
    const low = have <= 0 || (est !== null && est.daysLeft <= RUNNING_LOW_DAYS);
    if (low) out.push({ ingredientId: ing.id, name: ing.name, onHandGrams: Math.round(have), daysLeft: have <= 0 ? 0 : (est?.daysLeft ?? null), onList: onList.has(ing.id) });
  }
  return out.sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));
}

/**
 * Put away ticked items in one tap: each becomes stock using the household's
 * usual product for it, in its usual place. Items with no known product are
 * returned so they can be scanned instead.
 */
export async function putAway(deps: StockDeps, itemIds?: string[]): Promise<{ added: number; needsScan: ShoppingItemDto[] }> {
  const { db, auth } = deps;
  const all = await listShopping(db, auth);
  const chosen = all.filter((i) => (itemIds ? itemIds.includes(i.id) : i.checked));
  const catalog = await loadCatalog(db, auth.household.id);
  let added = 0;
  const needsScan: ShoppingItemDto[] = [];
  for (const item of chosen) {
    let productId = item.productId;
    if (!productId && item.ingredientId) {
      const [recent] = await db
        .select({ productId: stockItems.productId })
        .from(stockItems)
        .innerJoin(products, eq(products.id, stockItems.productId))
        .where(and(eq(stockItems.householdId, auth.household.id), eq(products.ingredientId, item.ingredientId), isNull(products.recipeId)))
        .orderBy(desc(stockItems.addedAt))
        .limit(1);
      productId = recent?.productId ?? null;
    }
    const [product] = productId ? await db.select().from(products).where(eq(products.id, productId)) : [];
    if (!product) {
      needsScan.push(item);
      continue;
    }
    // Its usual place: where it went last time, else the default for its kind of food.
    const [last] = await db
      .select({ locationId: stockItems.locationId })
      .from(stockItems)
      .where(and(eq(stockItems.productId, product.id), lt(stockItems.addedAt, deps.now)))
      .orderBy(desc(stockItems.addedAt))
      .limit(1);
    let locationId = last?.locationId;
    if (!locationId) {
      const ing = product.ingredientId ? catalog.ingredients.get(product.ingredientId) : undefined;
      const cat = (product.shelfLifeCategoryId ?? ing?.shelfLifeCategoryId) ? catalog.categories.get((product.shelfLifeCategoryId ?? ing?.shelfLifeCategoryId)!) : undefined;
      locationId = (await firstLocationOfType(db, auth.household.id, cat?.defaultLocation ?? 'cupboard'))?.id;
    }
    if (!locationId) {
      const [any] = await db.select({ id: locations.id }).from(locations).where(eq(locations.householdId, auth.household.id)).limit(1);
      locationId = any?.id;
    }
    if (!locationId) {
      needsScan.push(item);
      continue;
    }
    for (let i = 0; i < item.packs; i++) await addPack(deps, { product, locationId });
    await db.delete(shoppingItems).where(eq(shoppingItems.id, item.id));
    added += item.packs;
  }
  return { added, needsScan };
}
