/**
 * Stock changes. Every change writes a stock event holding the pack as it was
 * before, so any change can be undone and waste can be counted.
 */
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  type AdjustStockInput,
  applyStillSome,
  applyUse,
  bestBeforeOnDefrost,
  bestBeforeOnFreeze,
  bestBeforeOnOpen,
  canDefrost,
  canFreeze,
  canOpen,
  type CalendarDate,
  estimateOnAdd,
  learnedDaysFromEdit,
  type LocationType,
  mergePacks,
  orderForUse,
  shouldAskOpened,
  type StillSomeAnswer,
  type StockChangeDto,
  type StockMergeDto,
  type StockEventType,
  type StockItemDto,
  todayIn,
  type UseAmount,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { locations, products, type StockSnapshot, stockEvents, stockItems } from '../db/schema';
import { badRequest, conflict, notFound } from '../http';
import { type Catalog, loadCatalog, measuresFor, type ProductRow, productShelfLife } from './catalog';

type StockRow = typeof stockItems.$inferSelect;
type LocationRow = typeof locations.$inferSelect;

export interface StockDeps {
  db: Db;
  auth: Auth;
  now: Date;
  /** Set while cooking, so every use and leftover can be undone together. */
  cookId?: string;
  /** Set when food is eaten or cooked for a planned meal. */
  mealPlanEntryId?: string;
}

export function householdToday(auth: Auth, now: Date): CalendarDate {
  return todayIn(auth.household.timeZone, now);
}

function snapshot(item: StockRow): StockSnapshot {
  return {
    locationId: item.locationId,
    state: item.state,
    bestBefore: item.bestBefore,
    openedOn: item.openedOn,
    frozenOn: item.frozenOn,
    defrostedOn: item.defrostedOn,
    fractionLeft: item.fractionLeft,
    remainingGrams: item.remainingGrams,
    initialGrams: item.initialGrams,
    finishedAt: item.finishedAt,
  };
}

export function toStockDto(
  item: StockRow,
  product: ProductRow,
  location: LocationRow,
  catalog: Catalog,
  today: CalendarDate,
): StockItemDto {
  const shelfLife = productShelfLife(product, catalog);
  const measures = measuresFor(product.ingredientId, catalog);
  const ingredient = product.ingredientId ? catalog.ingredients.get(product.ingredientId) : undefined;
  // Cooked meals are counted in portions.
  if (product.portionGrams) measures.gramsPerCount = product.portionGrams;
  // Food sold by the item (apples, eggs) is counted, even when this pack was bought by weight.
  const counted = !product.portionGrams && product.displayUnit === 'g' && ingredient?.packUnit === 'count' && Boolean(measures.gramsPerCount);
  const open = canOpen(item.state, shelfLife);
  const freeze = canFreeze({ today, state: item.state, bestBefore: item.bestBefore, shelfLife });
  const defrost = canDefrost(item.state);
  return {
    id: item.id,
    productId: product.id,
    productName: product.name ?? 'Unnamed product',
    brand: product.brand,
    imageUrl: product.imageUrl,
    ingredientId: product.ingredientId,
    locationId: location.id,
    locationName: location.name,
    locationType: location.type,
    state: item.state,
    bestBefore: item.bestBefore,
    addedOn: item.addedOn,
    openedOn: item.openedOn,
    frozenOn: item.frozenOn,
    fractionLeft: item.fractionLeft,
    initialGrams: item.initialGrams,
    remainingGrams: item.remainingGrams,
    displayUnit: counted ? 'count' : product.displayUnit,
    densityGPerMl: measures.densityGPerMl ?? null,
    gramsPerCount: measures.gramsPerCount ?? null,
    countUnit: product.portionGrams ? null : (ingredient?.countUnit ?? null),
    itemGrams: product.portionGrams && product.recipeId === null ? product.portionGrams : null,
    addedAt: item.addedAt.toISOString(),
    isMeal: product.recipeId !== null,
    foodGroup: product.foodGroup ?? (product.ingredientId ? (catalog.ingredients.get(product.ingredientId)?.foodGroup ?? null) : null),
    kcalPer100g: product.nutritionPer100g?.kcal ?? ingredient?.nutritionPer100g?.kcal ?? null,
    actions: {
      open: open.ok ? null : open.reason,
      freeze: freeze.ok ? null : freeze.reason,
      defrost: defrost.ok ? null : defrost.reason,
      freezeWarning: freeze.ok ? (freeze.warning ?? null) : null,
    },
  };
}

/** All packs still in stock, earliest best-before first. */
export async function listStock(db: Db, auth: Auth, now: Date): Promise<StockItemDto[]> {
  const today = householdToday(auth, now);
  const [rows, catalog] = await Promise.all([
    db
      .select({ item: stockItems, product: products, location: locations })
      .from(stockItems)
      .innerJoin(products, eq(products.id, stockItems.productId))
      .innerJoin(locations, eq(locations.id, stockItems.locationId))
      .where(and(eq(stockItems.householdId, auth.household.id), isNull(stockItems.finishedAt)))
      .orderBy(sql`${stockItems.bestBefore} asc nulls last`, asc(stockItems.addedAt)),
    loadCatalog(db, auth.household.id),
  ]);
  return rows.map((r) => toStockDto(r.item, r.product, r.location, catalog, today));
}

async function loadItem(db: Db, auth: Auth, id: string) {
  const [row] = await db
    .select({ item: stockItems, product: products, location: locations })
    .from(stockItems)
    .innerJoin(products, eq(products.id, stockItems.productId))
    .innerJoin(locations, eq(locations.id, stockItems.locationId))
    .where(and(eq(stockItems.id, id), eq(stockItems.householdId, auth.household.id)))
    .for('update', { of: stockItems })
    .limit(1);
  if (!row) throw notFound("That item isn't in stock.");
  return row;
}

export async function getStockItem(db: Db, auth: Auth, now: Date, id: string): Promise<StockItemDto> {
  const row = await loadItem(db, auth, id);
  const catalog = await loadCatalog(db, auth.household.id);
  return toStockDto(row.item, row.product, row.location, catalog, householdToday(auth, now));
}

async function loadLocation(db: Db, auth: Auth, id: string): Promise<LocationRow> {
  const [loc] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), eq(locations.householdId, auth.household.id)))
    .limit(1);
  if (!loc) throw notFound('That location no longer exists.');
  return loc;
}

/** Where a product usually goes: where it went last time, else the default for its kind of food, else anywhere. */
export async function usualLocationId(deps: StockDeps, product: ProductRow, catalog: Catalog): Promise<string | undefined> {
  const { db, auth } = deps;
  const [last] = await db
    .select({ locationId: stockItems.locationId })
    .from(stockItems)
    .where(and(eq(stockItems.productId, product.id), lt(stockItems.addedAt, deps.now)))
    .orderBy(desc(stockItems.addedAt))
    .limit(1);
  if (last) return last.locationId;
  const ing = product.ingredientId ? catalog.ingredients.get(product.ingredientId) : undefined;
  const categoryId = product.shelfLifeCategoryId ?? ing?.shelfLifeCategoryId;
  const cat = categoryId ? catalog.categories.get(categoryId) : undefined;
  const byType = await firstLocationOfType(db, auth.household.id, cat?.defaultLocation ?? 'cupboard');
  if (byType) return byType.id;
  const [any] = await db.select({ id: locations.id }).from(locations).where(eq(locations.householdId, auth.household.id)).limit(1);
  return any?.id;
}

export async function firstLocationOfType(db: Db, householdId: string, type: LocationType): Promise<LocationRow | null> {
  const [loc] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.householdId, householdId), eq(locations.type, type)))
    .orderBy(asc(locations.sortOrder), asc(locations.createdAt))
    .limit(1);
  return loc ?? null;
}

async function writeEvent(
  { db, auth, now, cookId, mealPlanEntryId }: StockDeps,
  item: StockRow,
  type: StockEventType,
  extra: { grams?: number | null; fraction?: number | null; before?: StockSnapshot | null; from?: string; to?: string },
): Promise<string> {
  const [ev] = await db
    .insert(stockEvents)
    .values({
      householdId: auth.household.id,
      stockItemId: item.id,
      productId: item.productId,
      type,
      grams: extra.grams ?? null,
      fraction: extra.fraction ?? null,
      fromLocationId: extra.from ?? null,
      toLocationId: extra.to ?? null,
      before: extra.before ?? null,
      userId: auth.user.id,
      createdAt: now,
      cookId: cookId ?? null,
      mealPlanEntryId: mealPlanEntryId ?? null,
    })
    .returning({ id: stockEvents.id });
  if (!ev) throw new Error('Could not record the stock event');
  return ev.id;
}

async function finishChange(
  db: Db,
  auth: Auth,
  now: Date,
  itemId: string,
  eventId: string,
  extra: Partial<StockChangeDto> = {},
): Promise<StockChangeDto> {
  return { item: await getStockItem(db, auth, now, itemId), eventId, ...extra };
}

/** Add one pack of a product to a location, with an estimated best-before unless one is given. */
export async function addPack(
  deps: StockDeps,
  input: {
    product: ProductRow;
    locationId: string;
    bestBefore?: CalendarDate | null;
    catalog?: Catalog;
    addedOn?: CalendarDate;
    /** Size of this pack when it differs from the product's usual pack (e.g. 3 portions of leftovers). */
    grams?: number;
  },
): Promise<StockChangeDto & { estimated: boolean }> {
  const { db, auth, now } = deps;
  // Scans queued offline keep the day they were really scanned.
  const today = input.addedOn ?? householdToday(auth, now);
  const location = await loadLocation(db, auth, input.locationId);
  const catalog = input.catalog ?? (await loadCatalog(db, auth.household.id));
  const estimate = estimateOnAdd({
    today,
    locationType: location.type,
    shelfLife: productShelfLife(input.product, catalog),
    learnedClosedDays: input.product.learnedClosedDays,
    learnedFrozenDays: input.product.learnedFrozenDays,
  });
  const given = input.bestBefore !== undefined && input.bestBefore !== null;
  const grams = input.grams ?? input.product.packGrams;
  const [item] = await db
    .insert(stockItems)
    .values({
      householdId: auth.household.id,
      productId: input.product.id,
      locationId: location.id,
      state: estimate.state,
      bestBefore: given ? input.bestBefore : estimate.bestBefore,
      addedOn: today,
      frozenOn: estimate.state === 'frozen' ? today : null,
      fractionLeft: 1,
      initialGrams: grams,
      remainingGrams: grams,
      addedBy: auth.user.id,
      addedAt: now,
    })
    .returning();
  if (!item) throw new Error('Could not add the pack');
  const eventId = await writeEvent(deps, item, 'add', { grams, fraction: 1, to: location.id });
  const change = await finishChange(db, auth, now, item.id, eventId);
  return { ...change, estimated: !given && estimate.source !== 'none' };
}

/** Use some or all of a pack. */
export async function usePack(deps: StockDeps, id: string, amount: UseAmount): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const { item } = await loadItem(db, auth, id);
  if (item.finishedAt) throw conflict("That's already been used up.");
  let result;
  try {
    result = applyUse(item, amount);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const finished = result.after.fractionLeft <= 0 && !result.askStillSome;
  const [updated] = await db
    .update(stockItems)
    .set({
      fractionLeft: result.after.fractionLeft,
      remainingGrams: result.after.remainingGrams,
      finishedAt: finished || result.after.fractionLeft <= 0 ? now : null,
    })
    .where(eq(stockItems.id, item.id))
    .returning();
  if (!updated) throw notFound();
  const eventId = await writeEvent(deps, item, 'use', {
    grams: result.usedGrams,
    fraction: result.usedFraction,
    before: snapshot(item),
  });
  const change = await finishChange(db, auth, now, item.id, eventId, { askStillSome: result.askStillSome, usedGrams: result.usedGrams });
  // Only ask "Is it opened now?" when opening would change its date (`actions.open` is null when allowed).
  return { ...change, askOpened: shouldAskOpened(item.state, amount, result.after, change.item.actions.open === null) };
}

/** Counted food (apples, a bar from a multipack, portions of a meal): using one doesn't open the rest. */
function countedFood(item: StockItemDto): boolean {
  return item.isMeal || item.displayUnit === 'count' || item.itemGrams !== null;
}

/**
 * Use some of a pack, and mark it opened when that's the first time part of a closed pack is
 * used: it must be open now, so nobody is asked. Opening never extends a date. Counted food is
 * left alone, as is food whose date doesn't change once opened.
 */
export async function usePackOpening(deps: StockDeps, id: string, amount: UseAmount): Promise<StockChangeDto> {
  const change = await usePack(deps, id, amount);
  if (!change.askOpened || countedFood(change.item)) return change;
  const opened = await openPack(deps, id);
  return { ...change, item: opened.item, askOpened: false, opened: true };
}

/** The packs on a stock row (one food in one place, frozen or not), in the order they're used. */
async function rowPacks(deps: StockDeps, item: StockRow): Promise<StockRow[]> {
  const { db, auth } = deps;
  const rows = await db
    .select()
    .from(stockItems)
    .where(and(eq(stockItems.householdId, auth.household.id), eq(stockItems.productId, item.productId), eq(stockItems.locationId, item.locationId), isNull(stockItems.finishedAt)));
  return orderForUse(rows.filter((p) => (p.state === 'frozen') === (item.state === 'frozen')).map((p) => ({ ...p })));
}

/** What's left on a stock row: grams (null when a pack's size isn't known) and packs. */
async function rowLeft(deps: StockDeps, item: StockRow): Promise<{ grams: number | null; packs: number }> {
  const packs = await rowPacks(deps, item);
  return { grams: packs.some((p) => p.remainingGrams === null) ? null : Math.round(packs.reduce((n, p) => n + p.remainingGrams!, 0) * 1000) / 1000, packs: packs.length };
}

/**
 * Use food from a stock row (every pack of one food in one place). An amount in grams comes from
 * the pack that's already open, then the others, earliest best-before first: 500g of chicken when
 * the open pack has 300g takes the other 200g from the next pack. `wholeRow` uses everything.
 * `finishOpen` empties the pack it ended on, whatever the numbers say ("that's the bread done").
 * A fraction, or "all" without `wholeRow`, is of this pack only (for packs whose size isn't known).
 */
export async function useFromRow(deps: StockDeps, id: string, amount: UseAmount, opts: { wholeRow?: boolean; finishOpen?: boolean } = {}): Promise<StockChangeDto> {
  const { db, auth } = deps;
  const { item } = await loadItem(db, auth, id);
  if (item.finishedAt) throw conflict("That's already been used up.");
  const changes: StockChangeDto[] = [];
  let message: string | undefined;
  if (amount.kind === 'grams') {
    let left = amount.grams;
    for (const p of await rowPacks(deps, item)) {
      if (left <= 0.5) break;
      if (p.remainingGrams === null) {
        // A pack of unknown size: count it as used up.
        changes.push(await usePack(deps, p.id, { kind: 'all' }));
        left = 0;
        break;
      }
      const take = Math.min(p.remainingGrams, left);
      changes.push(await usePackOpening(deps, p.id, take >= p.remainingGrams - 0.5 ? { kind: 'all' } : { kind: 'grams', grams: take }));
      left -= take;
    }
    if (!changes.length) throw conflict("That's already been used up.");
    if (left > 0.5) message = 'That was all there was.';
  } else if (amount.kind === 'all' && opts.wholeRow) {
    for (const p of await rowPacks(deps, item)) changes.push(await usePack(deps, p.id, { kind: 'all' }));
  } else {
    changes.push(await usePackOpening(deps, id, amount));
  }
  let last = changes[changes.length - 1]!;
  // "That finished the pack": empty it, as a correction that's undone with the use.
  if (opts.finishOpen && last.item.fractionLeft > 0) {
    const emptied = await answerStillSome(deps, last.item.id, 'none');
    last = { ...last, item: emptied.item };
  }
  const usedGrams = changes.some((c) => c.usedGrams == null) ? null : Math.round(changes.reduce((n, c) => n + c.usedGrams!, 0) * 1000) / 1000;
  return {
    ...last,
    usedGrams,
    eventIds: changes.map((c) => c.eventId),
    opened: changes.some((c) => c.opened) || undefined,
    askOpened: false,
    askStillSome: false,
    rowLeft: await rowLeft(deps, item),
    ...(message ? { message } : {}),
  };
}

/** Bin a pack (or part of it). Kept separate from use so waste can be counted. */
export async function discardPack(deps: StockDeps, id: string, amount: UseAmount): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const { item } = await loadItem(db, auth, id);
  if (item.finishedAt) throw conflict("That's already gone.");
  const result = applyUse(item, amount.kind === 'grams' && item.initialGrams === null ? { kind: 'all' } : amount);
  const gone = result.after.fractionLeft <= 0;
  await db
    .update(stockItems)
    .set({ fractionLeft: result.after.fractionLeft, remainingGrams: result.after.remainingGrams, finishedAt: gone ? now : null })
    .where(eq(stockItems.id, item.id));
  const eventId = await writeEvent(deps, item, 'discard', {
    grams: result.usedGrams,
    fraction: result.usedFraction,
    before: snapshot(item),
  });
  return finishChange(db, auth, now, item.id, eventId);
}

/** Answer "Is there still some left?". */
export async function answerStillSome(deps: StockDeps, id: string, answer: StillSomeAnswer): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const { item } = await loadItem(db, auth, id);
  const after = applyStillSome(item, answer);
  await db
    .update(stockItems)
    .set({
      fractionLeft: after.fractionLeft,
      remainingGrams: after.remainingGrams,
      finishedAt: after.fractionLeft <= 0 ? (item.finishedAt ?? now) : null,
    })
    .where(eq(stockItems.id, item.id));
  const delta = after.fractionLeft - item.fractionLeft;
  const eventId = await writeEvent(deps, item, 'adjust', {
    fraction: delta,
    grams: item.initialGrams === null ? null : Math.round(item.initialGrams * delta * 1000) / 1000,
    before: snapshot(item),
  });
  return finishChange(db, auth, now, item.id, eventId);
}

export async function openPack(deps: StockDeps, id: string): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const today = householdToday(auth, now);
  const { item, product } = await loadItem(db, auth, id);
  const catalog = await loadCatalog(db, auth.household.id);
  const shelfLife = productShelfLife(product, catalog);
  const check = canOpen(item.state, shelfLife);
  if (!check.ok) throw badRequest(check.reason);
  const bestBefore = bestBeforeOnOpen({ today, current: item.bestBefore, shelfLife });
  await db.update(stockItems).set({ state: 'opened', openedOn: today, bestBefore }).where(eq(stockItems.id, item.id));
  const eventId = await writeEvent(deps, item, 'open', { before: snapshot(item) });
  return finishChange(db, auth, now, item.id, eventId);
}

export async function freezePack(deps: StockDeps, id: string, locationId?: string): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const today = householdToday(auth, now);
  const { item, product } = await loadItem(db, auth, id);
  const catalog = await loadCatalog(db, auth.household.id);
  const shelfLife = productShelfLife(product, catalog);
  const check = canFreeze({ today, state: item.state, bestBefore: item.bestBefore, shelfLife });
  if (!check.ok) throw badRequest(check.reason);
  const target = locationId ? await loadLocation(db, auth, locationId) : await firstLocationOfType(db, auth.household.id, 'freezer');
  if (!target || target.type !== 'freezer') throw badRequest('Add a freezer location first.');
  await db
    .update(stockItems)
    .set({ state: 'frozen', frozenOn: today, locationId: target.id, bestBefore: bestBeforeOnFreeze({ today, shelfLife }) })
    .where(eq(stockItems.id, item.id));
  const eventId = await writeEvent(deps, item, 'freeze', { before: snapshot(item), from: item.locationId, to: target.id });
  return finishChange(db, auth, now, item.id, eventId);
}

export async function defrostPack(deps: StockDeps, id: string, locationId?: string): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const today = householdToday(auth, now);
  const { item, product } = await loadItem(db, auth, id);
  const check = canDefrost(item.state);
  if (!check.ok) throw badRequest(check.reason);
  const catalog = await loadCatalog(db, auth.household.id);
  const shelfLife = productShelfLife(product, catalog);
  const target = locationId ? await loadLocation(db, auth, locationId) : await firstLocationOfType(db, auth.household.id, 'fridge');
  if (!target) throw badRequest('Add a fridge location first.');
  if (target.type === 'freezer') throw badRequest('Defrost into the fridge or cupboard, not a freezer.');
  await db
    .update(stockItems)
    .set({ state: 'defrosted', defrostedOn: today, locationId: target.id, bestBefore: bestBeforeOnDefrost({ today, shelfLife }) })
    .where(eq(stockItems.id, item.id));
  const eventId = await writeEvent(deps, item, 'defrost', { before: snapshot(item), from: item.locationId, to: target.id });
  return finishChange(db, auth, now, item.id, eventId);
}

/** Move a pack. Moving into a freezer freezes it; moving out of one defrosts it. */
export async function movePack(deps: StockDeps, id: string, locationId: string): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const { item, location: from } = await loadItem(db, auth, id);
  const to = await loadLocation(db, auth, locationId);
  if (to.type === 'freezer' && from.type !== 'freezer' && item.state !== 'frozen') return freezePack(deps, id, to.id);
  if (from.type === 'freezer' && to.type !== 'freezer' && item.state === 'frozen') return defrostPack(deps, id, to.id);
  if (to.id === from.id) return finishChange(db, auth, now, item.id, '', { message: 'Already there.' });
  await db.update(stockItems).set({ locationId: to.id }).where(eq(stockItems.id, item.id));
  const eventId = await writeEvent(deps, item, 'move', { before: snapshot(item), from: from.id, to: to.id });
  return finishChange(db, auth, now, item.id, eventId);
}

/** Fix a pack's date, amount or location. Date changes teach the app the product's usual shelf life. */
export async function adjustPack(deps: StockDeps, id: string, input: AdjustStockInput): Promise<StockChangeDto> {
  const { db, auth, now } = deps;
  const { item, product } = await loadItem(db, auth, id);
  if (input.locationId && input.locationId !== item.locationId) {
    const to = await loadLocation(db, auth, input.locationId);
    const from = await loadLocation(db, auth, item.locationId);
    if (to.type === 'freezer' || from.type === 'freezer') {
      throw badRequest('Use Freeze or Defrost to move things in or out of the freezer.');
    }
  }
  const patch: Partial<typeof stockItems.$inferInsert> = {};
  let fraction = item.fractionLeft;
  if (input.bestBefore !== undefined) patch.bestBefore = input.bestBefore;
  if (input.locationId) patch.locationId = input.locationId;
  if (input.remainingGrams !== undefined) {
    if (!item.initialGrams) {
      // First time we learn the size of this pack: take the amount as the pack size.
      patch.initialGrams = input.remainingGrams;
      fraction = input.remainingGrams > 0 ? 1 : 0;
    } else if (input.remainingGrams > item.initialGrams) {
      // More than the pack holds: the pack was bigger than we thought, so it's full at the new size.
      patch.initialGrams = input.remainingGrams;
      fraction = 1;
    } else {
      fraction = input.remainingGrams / item.initialGrams;
    }
    patch.remainingGrams = input.remainingGrams;
  } else if (input.fractionLeft !== undefined) {
    fraction = input.fractionLeft;
    patch.remainingGrams = item.initialGrams === null ? null : Math.round(item.initialGrams * fraction * 1000) / 1000;
  }
  patch.fractionLeft = Math.round(fraction * 1000) / 1000;
  patch.finishedAt = patch.fractionLeft <= 0 ? (item.finishedAt ?? now) : null;
  await db.update(stockItems).set(patch).where(eq(stockItems.id, item.id));

  if (input.bestBefore) {
    const learned = learnedDaysFromEdit({
      state: item.state,
      addedOn: item.addedOn,
      frozenOn: item.frozenOn,
      newBestBefore: input.bestBefore,
    });
    if (learned) {
      await db
        .update(products)
        .set(learned.kind === 'closed' ? { learnedClosedDays: learned.days } : { learnedFrozenDays: learned.days })
        .where(eq(products.id, product.id));
    }
  }
  const delta = patch.fractionLeft - item.fractionLeft;
  const eventId = await writeEvent(deps, item, 'adjust', {
    fraction: delta || null,
    grams: delta && item.initialGrams ? Math.round(item.initialGrams * delta * 1000) / 1000 : null,
    before: snapshot(item),
    from: item.locationId,
    to: input.locationId ?? item.locationId,
  });
  return finishChange(db, auth, now, item.id, eventId);
}

/**
 * Merge packs of one food in one place into the pack that's used first. The rest are finished
 * (not binned, so it isn't waste). Every pack gets an adjust event, so each can be undone.
 */
export async function mergeStockPacks(deps: StockDeps, ids: string[]): Promise<StockMergeDto> {
  const { db, auth, now } = deps;
  const rows = [];
  for (const id of [...new Set(ids)]) rows.push(await loadItem(db, auth, id));
  if (rows.length < 2) throw badRequest('Pick at least two packs to merge.');
  const [first] = rows;
  if (rows.some((r) => r.item.finishedAt)) throw conflict("One of those packs is already gone.");
  if (rows.some((r) => r.item.productId !== first!.item.productId || r.item.locationId !== first!.item.locationId)) {
    throw badRequest('Only packs of the same food in the same place can be merged.');
  }
  let merged;
  try {
    merged = mergePacks(rows.map((r) => r.item));
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const target = orderForUse(rows.map((r) => r.item))[0]!;
  const eventIds: string[] = [];
  for (const { item } of rows) {
    if (item.id === target.id) continue;
    await db.update(stockItems).set({ fractionLeft: 0, remainingGrams: item.initialGrams === null ? null : 0, finishedAt: now }).where(eq(stockItems.id, item.id));
    eventIds.push(await writeEvent(deps, item, 'adjust', { fraction: -item.fractionLeft, grams: item.remainingGrams === null ? null : -item.remainingGrams, before: snapshot(item) }));
  }
  await db.update(stockItems).set({ ...merged, finishedAt: merged.fractionLeft <= 0 ? now : null }).where(eq(stockItems.id, target.id));
  const delta = Math.round((merged.fractionLeft - target.fractionLeft) * 1000) / 1000;
  eventIds.push(
    await writeEvent(deps, target, 'adjust', {
      fraction: delta || null,
      grams: merged.remainingGrams !== null && target.remainingGrams !== null ? Math.round((merged.remainingGrams - target.remainingGrams) * 1000) / 1000 : null,
      before: snapshot(target),
    }),
  );
  return { item: await getStockItem(db, auth, now, target.id), eventIds };
}

/**
 * Put food back into a pack: the opposite of a use, for a meal whose amount went down or that
 * was unticked or removed after the pack had changed (so the use itself can't be undone). It's
 * written as a use of a negative amount, so what the meal has taken still adds up. Returns the
 * grams put back (nothing when the pack is gone or its size isn't known).
 */
export async function giveBack(deps: StockDeps, stockItemId: string, grams: number): Promise<number> {
  const { db, auth } = deps;
  const [item] = await db
    .select()
    .from(stockItems)
    .where(and(eq(stockItems.id, stockItemId), eq(stockItems.householdId, auth.household.id)))
    .for('update');
  if (!item || item.initialGrams === null || grams <= 0) return 0;
  const remaining = Math.round(((item.remainingGrams ?? 0) + grams) * 1000) / 1000;
  const initial = Math.max(item.initialGrams, remaining);
  await db
    .update(stockItems)
    .set({ remainingGrams: remaining, initialGrams: initial, fractionLeft: Math.min(1, Math.round((remaining / initial) * 1000) / 1000), finishedAt: null })
    .where(eq(stockItems.id, item.id));
  await writeEvent(deps, item, 'use', { grams: -grams, fraction: -Math.round((grams / initial) * 1000) / 1000, before: snapshot(item) });
  return grams;
}

/**
 * A pack as it was before a change, ready to write back. Snapshots are stored as JSON, so the
 * time it was finished comes back as text and has to be a date again.
 */
export function restored(before: StockSnapshot): StockSnapshot {
  return { ...before, finishedAt: before.finishedAt ? new Date(before.finishedAt as unknown as string) : null };
}

/** How soon after a use its follow-up answers come, for undoing them together. */
const FOLLOW_UP_MS = 15 * 60_000;

/**
 * Undo a stock change. Only the latest change to a pack can be undone, so
 * later changes are never silently overwritten, except the answers to a use's follow-up
 * questions, which are undone with it. Undoing an add removes the pack.
 */
export async function undoEvent(deps: StockDeps, eventId: string): Promise<{ item: StockItemDto | null }> {
  const { db, auth, now } = deps;
  const [ev] = await db
    .select()
    .from(stockEvents)
    .where(and(eq(stockEvents.id, eventId), eq(stockEvents.householdId, auth.household.id)))
    .limit(1);
  if (!ev) throw notFound("Couldn't find that change.");
  if (ev.undoneAt) throw conflict('That has already been undone.');
  const later = await db
    .select()
    .from(stockEvents)
    .where(and(eq(stockEvents.stockItemId, ev.stockItemId), isNull(stockEvents.undoneAt), gt(stockEvents.seq, ev.seq)))
    .orderBy(desc(stockEvents.seq));
  if (later.length) {
    // The answers to a use's follow-up questions ("Is it opened now?", "Is there still some
    // left?") go with it: same person, just after. Anything else later blocks the undo.
    const followUps =
      (ev.type === 'use' || ev.type === 'discard') &&
      later.every((l) => (l.type === 'open' || l.type === 'adjust') && l.userId === ev.userId && l.before && l.createdAt.getTime() - ev.createdAt.getTime() <= FOLLOW_UP_MS);
    if (!followUps) throw conflict('Something else has changed this item since, so it can no longer be undone.');
    for (const l of later) {
      await db.update(stockItems).set(restored(l.before!)).where(eq(stockItems.id, l.stockItemId));
      await db.update(stockEvents).set({ undoneAt: now }).where(eq(stockEvents.id, l.id));
    }
  }

  if (ev.type === 'add') {
    await db.delete(stockItems).where(eq(stockItems.id, ev.stockItemId));
    return { item: null };
  }
  if (!ev.before) throw conflict("That change can't be undone.");
  await db.update(stockItems).set(restored(ev.before)).where(eq(stockItems.id, ev.stockItemId));
  await db.update(stockEvents).set({ undoneAt: now }).where(eq(stockEvents.id, ev.id));
  return { item: await getStockItem(db, auth, now, ev.stockItemId) };
}

/** Packs of a product still in stock, in the order they should be used. */
export async function packsForUse(db: Db, auth: Auth, productId: string, locationId?: string) {
  const rows = await db
    .select()
    .from(stockItems)
    .where(and(eq(stockItems.householdId, auth.household.id), eq(stockItems.productId, productId), isNull(stockItems.finishedAt)));
  const ordered = orderForUse(rows.map((r) => ({ ...r, addedAt: r.addedAt })));
  if (!locationId) return ordered;
  const here = ordered.filter((r) => r.locationId === locationId);
  return here.length ? here : ordered;
}

export async function itemHistory(db: Db, auth: Auth, stockItemId: string) {
  return db
    .select()
    .from(stockEvents)
    .where(and(eq(stockEvents.householdId, auth.household.id), eq(stockEvents.stockItemId, stockItemId)))
    .orderBy(desc(stockEvents.seq));
}
