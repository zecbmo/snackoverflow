/**
 * Cooking a recipe: work out what each line takes from stock (earliest
 * best-before first), apply the deductions the cook confirms, and turn any
 * leftovers or batch-cook portions into stock. A whole cook can be undone.
 */
import { and, asc, desc, eq, gt, inArray, isNull, notInArray } from 'drizzle-orm';
import {
  type CookInput,
  type CookPlanDto,
  type CookPlanLineDto,
  type CookResultDto,
  orderForUse,
  scaledLine,
  type StockItemDto,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { cooks, locations, mealPlanEntries, products, recipes, shelfLifeCategories, stockEvents, stockItems } from '../db/schema';
import { badRequest, conflict, notFound } from '../http';
import { loadCatalog } from './catalog';
import { getRecipe } from './recipes';
import { addPack, type StockDeps, usePack } from './stock';

const round = (n: number) => Math.round(n * 10) / 10;

export async function planCook(db: Db, auth: Auth, recipeId: string, servings: number): Promise<CookPlanDto> {
  const recipe = await getRecipe(db, auth, recipeId);
  const factor = servings / recipe.serves;
  const rows = await db
    .select({ item: stockItems, product: products, location: locations })
    .from(stockItems)
    .innerJoin(products, eq(products.id, stockItems.productId))
    .innerJoin(locations, eq(locations.id, stockItems.locationId))
    .where(and(eq(stockItems.householdId, auth.household.id), isNull(stockItems.finishedAt), isNull(products.recipeId)));
  // Grams already promised to earlier lines, so two lines never take the same food twice.
  const promised = new Map<string, number>();
  const catalog = await loadCatalog(db, auth.household.id);

  const lines: CookPlanLineDto[] = recipe.ingredients.map((line) => {
    const needed = line.grams === null ? null : round(line.grams * factor);
    const candidates = orderForUse(
      rows
        .filter((r) => (line.productId ? r.product.id === line.productId : line.ingredientId !== null && r.product.ingredientId === line.ingredientId))
        .map((r) => ({ ...r, id: r.item.id, bestBefore: r.item.bestBefore, addedAt: r.item.addedAt })),
    );
    const takes: CookPlanLineDto['takes'] = [];
    let left = needed;
    for (const c of candidates) {
      if (left !== null && left <= 0) break;
      if (needed === null) break; // Nothing to measure ("salt to taste"): don't guess.
      const base = { stockItemId: c.item.id, productName: c.product.name ?? 'Unnamed product', locationName: c.location.name, state: c.item.state, bestBefore: c.item.bestBefore };
      if (c.item.remainingGrams === null) {
        // Pack of unknown size: suggest using half of what's left, and stop there.
        takes.push({ ...base, grams: null, fraction: 0.5, availableGrams: null });
        left = 0;
        break;
      }
      const available = c.item.remainingGrams - (promised.get(c.item.id) ?? 0);
      if (available <= 0) continue;
      const take = round(Math.min(available, left!));
      promised.set(c.item.id, (promised.get(c.item.id) ?? 0) + take);
      takes.push({ ...base, grams: take, fraction: null, availableGrams: round(available) });
      left = round(left! - take);
    }
    const measured = candidates.filter((c) => c.item.remainingGrams !== null);
    return {
      recipeIngredientId: line.id,
      text: scaledLine(line.text, line.amount, recipe.serves, servings),
      originalText: scaledLine(line.text, line.amount, recipe.serves, recipe.serves),
      inStockGrams: measured.length ? round(measured.reduce((s, c) => s + (c.item.remainingGrams ?? 0), 0)) : candidates.length ? null : 0,
      ingredientName: line.ingredientName ?? line.productName,
      optional: line.optional,
      unit: (() => {
        const ing = line.ingredientId ? catalog.ingredients.get(line.ingredientId) : undefined;
        return { displayUnit: ing?.packUnit === 'ml' ? ('ml' as const) : ing?.packUnit === 'count' ? ('count' as const) : ('g' as const), densityGPerMl: ing?.densityGPerMl ?? null };
      })(),
      neededGrams: needed,
      takes,
      shortGrams: needed === null ? null : Math.max(0, left ?? 0),
    };
  });

  const totalGrams = recipe.ingredients.reduce((s, l) => s + (l.optional || l.grams === null ? 0 : l.grams), 0);
  return {
    recipeId: recipe.id,
    title: recipe.title,
    serves: recipe.serves,
    servings,
    portionGrams: totalGrams > 0 ? round(totalGrams / recipe.serves) : null,
    lines,
  };
}

/** The meal product for a recipe's leftovers and batch portions (made the first time). */
async function mealProduct(db: Db, auth: Auth, recipeId: string, portionGrams: number | null) {
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.householdId, auth.household.id), eq(products.recipeId, recipeId)))
    .limit(1);
  const recipe = await getRecipe(db, auth, recipeId);
  // Rice and pasta dishes keep for less time than other leftovers (FSA).
  const catalog = await loadCatalog(db, auth.household.id);
  const keys = new Set(recipe.ingredients.map((l) => (l.ingredientId ? catalog.ingredients.get(l.ingredientId)?.key : null)));
  const categoryKey = keys.has('rice') ? 'cooked_rice' : keys.has('pasta') ? 'cooked_pasta' : 'leftovers';
  const [category] = await db
    .select({ id: shelfLifeCategories.id })
    .from(shelfLifeCategories)
    .where(and(eq(shelfLifeCategories.householdId, auth.household.id), eq(shelfLifeCategories.key, categoryKey)));
  const perServing = recipe.nutritionPerServing;
  const portion = portionGrams ?? 1;
  const nutritionPer100g =
    portionGrams && perServing.kcal != null && recipe.nutritionCoverage >= 0.6
      ? Object.fromEntries(Object.entries(perServing).map(([k, v]) => [k, typeof v === 'number' ? round((v / portionGrams) * 100) : v]))
      : null;
  const values = {
    name: recipe.title,
    recipeId,
    portionGrams: portion,
    packGrams: portion,
    packAmount: 1,
    packUnit: 'count',
    displayUnit: 'count' as const,
    shelfLifeCategoryId: category?.id ?? null,
    nutritionPer100g,
  };
  if (existing) {
    const [p] = await db.update(products).set(values).where(eq(products.id, existing.id)).returning();
    return p!;
  }
  const [p] = await db
    .insert(products)
    .values({ ...values, householdId: auth.household.id, source: 'manual' })
    .returning();
  return p!;
}

export async function confirmCook(deps: StockDeps, recipeId: string, input: CookInput): Promise<CookResultDto> {
  const { db, auth, now } = deps;
  const [recipe] = await db.select().from(recipes).where(and(eq(recipes.id, recipeId), eq(recipes.householdId, auth.household.id)));
  if (!recipe) throw notFound('No such recipe.');
  const [cook] = await db
    .insert(cooks)
    .values({ householdId: auth.household.id, recipeId, servings: input.servings, userId: auth.user.id, createdAt: now })
    .returning();
  const d: StockDeps = { ...deps, cookId: cook!.id, mealPlanEntryId: input.mealPlanEntryId };
  if (input.mealPlanEntryId) {
    await db
      .update(mealPlanEntries)
      .set({ status: 'cooked' })
      .where(and(eq(mealPlanEntries.id, input.mealPlanEntryId), eq(mealPlanEntries.householdId, auth.household.id)));
  }

  const askOpened = new Map<string, StockItemDto>();
  const askStillSome = new Map<string, StockItemDto>();
  for (const line of input.lines) {
    for (const take of line.takes) {
      const amount = take.grams !== undefined ? { kind: 'grams' as const, grams: take.grams } : { kind: 'fraction' as const, fraction: take.fraction ?? 1 };
      const change = await usePack(d, take.stockItemId, amount);
      if (change.askOpened) askOpened.set(change.item.id, change.item);
      else askOpened.delete(change.item.id);
      if (change.askStillSome) askStillSome.set(change.item.id, change.item);
    }
  }

  const leftovers: StockItemDto[] = [];
  if (input.leftovers.length) {
    const plan = await planCook(db, auth, recipeId, recipe.serves);
    const product = await mealProduct(db, auth, recipeId, plan.portionGrams);
    for (const group of input.leftovers) {
      const added = await addPack(d, { product, locationId: group.locationId, grams: (product.portionGrams ?? 1) * group.portions });
      leftovers.push(added.item);
    }
  }
  return { cookId: cook!.id, askOpened: [...askOpened.values()], askStillSome: [...askStillSome.values()], leftovers };
}

/** Undo a whole cook: every use goes back and the leftovers disappear. */
export async function undoCook(deps: StockDeps, cookId: string): Promise<void> {
  const { db, auth, now } = deps;
  const [cook] = await db.select().from(cooks).where(and(eq(cooks.id, cookId), eq(cooks.householdId, auth.household.id)));
  if (!cook) throw notFound("Couldn't find that cook.");
  if (cook.undoneAt) throw conflict('That has already been undone.');
  const events = await db
    .select()
    .from(stockEvents)
    .where(and(eq(stockEvents.cookId, cookId), isNull(stockEvents.undoneAt)))
    .orderBy(desc(stockEvents.seq));
  const itemIds = [...new Set(events.map((e) => e.stockItemId))];
  const ids = events.map((e) => e.id);
  if (itemIds.length) {
    const [later] = await db
      .select({ id: stockEvents.id })
      .from(stockEvents)
      .where(
        and(
          inArray(stockEvents.stockItemId, itemIds),
          isNull(stockEvents.undoneAt),
          gt(stockEvents.seq, Math.min(...events.map((e) => e.seq))),
          notInArray(stockEvents.id, ids),
        ),
      )
      .limit(1);
    if (later) throw conflict('Some of that food has changed since, so this cook can no longer be undone in one go.');
  }
  for (const ev of events) {
    if (ev.type === 'add') {
      await db.delete(stockItems).where(eq(stockItems.id, ev.stockItemId));
    } else if (ev.before) {
      await db.update(stockItems).set(ev.before).where(eq(stockItems.id, ev.stockItemId));
      await db.update(stockEvents).set({ undoneAt: now }).where(eq(stockEvents.id, ev.id));
    } else {
      throw badRequest("That cook can't be undone.");
    }
  }
  await db.update(cooks).set({ undoneAt: now }).where(eq(cooks.id, cookId));
  // The planned meal goes back to planned.
  const planned = [...new Set(events.map((e) => e.mealPlanEntryId).filter((x): x is string => Boolean(x)))];
  if (planned.length) await db.update(mealPlanEntries).set({ status: 'planned' }).where(inArray(mealPlanEntries.id, planned));
}

/** Recent cooks, newest first. */
export async function recentCooks(db: Db, auth: Auth, limit = 20) {
  return db
    .select({ id: cooks.id, recipeId: cooks.recipeId, servings: cooks.servings, createdAt: cooks.createdAt, undoneAt: cooks.undoneAt, title: recipes.title })
    .from(cooks)
    .leftJoin(recipes, eq(recipes.id, cooks.recipeId))
    .where(eq(cooks.householdId, auth.household.id))
    .orderBy(desc(cooks.createdAt), asc(cooks.id))
    .limit(limit);
}

