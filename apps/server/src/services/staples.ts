/**
 * Shopping staples: food the household always wants in. Each has a level ("keep at least 2L of
 * milk", "at least 2 tubes of Pringles"); when stock is below it, the food goes on the shopping
 * list by itself. A staple is a generic food (any product of it counts) or, for things with no
 * generic food behind them, one product.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { isPieceUnit, type StapleDto, type StapleInput } from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { ingredients, products, shoppingItems, staples, stockItems } from '../db/schema';
import { badRequest, notFound } from '../http';

type IngredientRow = typeof ingredients.$inferSelect;
type ProductRow = typeof products.$inferSelect;

/** How a staple's level is counted: items or slices, ml, g, or packs for a product. */
interface Measure {
  unit: StapleDto['unit'];
  unitName: string | null;
  /** Grams in one unit; null for packs of a product whose size isn't known (packs are counted instead). */
  gramsPerUnit: number | null;
  step: number;
}

function measureOf(ing: IngredientRow | undefined, product: ProductRow | undefined): Measure {
  if (ing) {
    if (ing.gramsPerCount && ing.countUnit && (ing.packUnit === 'count' || isPieceUnit(ing.countUnit))) {
      return { unit: 'count', unitName: ing.countUnit, gramsPerUnit: ing.gramsPerCount, step: 1 };
    }
    if (ing.packUnit === 'ml') return { unit: 'ml', unitName: null, gramsPerUnit: ing.densityGPerMl ?? 1, step: 250 };
    return { unit: 'g', unitName: null, gramsPerUnit: 1, step: 100 };
  }
  return { unit: 'pack', unitName: 'pack', gramsPerUnit: product?.portionGrams ? null : (product?.packGrams ?? null), step: 1 };
}

const round = (n: number) => Math.round(n * 10) / 10;

export async function listStaples(db: Db, auth: Auth): Promise<StapleDto[]> {
  const hh = auth.household.id;
  const rows = await db.select().from(staples).where(eq(staples.householdId, hh)).orderBy(asc(staples.createdAt));
  if (!rows.length) return [];
  const [ings, prods, stock, list] = await Promise.all([
    db.select().from(ingredients).where(eq(ingredients.householdId, hh)),
    db.select().from(products).where(eq(products.householdId, hh)),
    db
      .select({ productId: stockItems.productId, grams: stockItems.remainingGrams, fraction: stockItems.fractionLeft })
      .from(stockItems)
      .where(and(eq(stockItems.householdId, hh), isNull(stockItems.finishedAt))),
    db.select({ ingredientId: shoppingItems.ingredientId, productId: shoppingItems.productId }).from(shoppingItems).where(eq(shoppingItems.householdId, hh)),
  ]);
  const ingById = new Map(ings.map((i) => [i.id, i]));
  const prodById = new Map(prods.map((p) => [p.id, p]));
  return rows
    .map((s): StapleDto | null => {
      const ing = s.ingredientId ? ingById.get(s.ingredientId) : undefined;
      const product = s.productId ? prodById.get(s.productId) : undefined;
      if (!ing && !product) return null;
      const m = measureOf(ing, product);
      // What's in the house: every pack of the food (not cooked meals made from it), or of the one product.
      const packs = stock.filter((p) => {
        const of = prodById.get(p.productId);
        return ing ? of?.ingredientId === ing.id && of.recipeId === null : p.productId === product!.id;
      });
      const have = m.gramsPerUnit ? packs.reduce((n, p) => n + (p.grams ?? 0), 0) / m.gramsPerUnit : packs.reduce((n, p) => n + p.fraction, 0);
      return {
        id: s.id,
        ingredientId: ing?.id ?? null,
        productId: ing ? null : product!.id,
        name: ing?.name ?? product!.name ?? 'Unnamed product',
        min: s.min,
        have: round(have),
        unit: m.unit,
        unitName: m.unitName,
        step: m.step,
        low: have < s.min - 0.001,
        onList: list.some((i) => (ing ? i.ingredientId === ing.id : i.productId === product!.id)),
      };
    })
    .filter((s): s is StapleDto => s !== null);
}

/** Make a food a staple, or change its level. */
export async function saveStaple(db: Db, auth: Auth, input: StapleInput): Promise<void> {
  const hh = auth.household.id;
  if (input.ingredientId) {
    const [ing] = await db.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.id, input.ingredientId), eq(ingredients.householdId, hh)));
    if (!ing) throw notFound('No such food.');
  } else if (input.productId) {
    const [p] = await db.select().from(products).where(and(eq(products.id, input.productId), eq(products.householdId, hh)));
    if (!p) throw notFound('No such product.');
    if (p.recipeId) throw badRequest("Leftovers can't be a staple.");
    // A product of a generic food is a staple by that food, so any brand of milk counts.
    if (p.ingredientId) return saveStaple(db, auth, { ingredientId: p.ingredientId, min: input.min });
  }
  const match = input.ingredientId ? eq(staples.ingredientId, input.ingredientId) : eq(staples.productId, input.productId!);
  const [existing] = await db.select({ id: staples.id }).from(staples).where(and(eq(staples.householdId, hh), match));
  if (existing) await db.update(staples).set({ min: input.min }).where(eq(staples.id, existing.id));
  else await db.insert(staples).values({ householdId: hh, ingredientId: input.ingredientId ?? null, productId: input.ingredientId ? null : input.productId!, min: input.min, createdBy: auth.user.id });
}

export async function deleteStaple(db: Db, auth: Auth, id: string): Promise<void> {
  const gone = await db.delete(staples).where(and(eq(staples.id, id), eq(staples.householdId, auth.household.id))).returning({ id: staples.id });
  if (!gone.length) throw notFound("That isn't a staple any more.");
}

/**
 * Put staples that are below their level on the shopping list, unless they're on it already
 * (ticked counts: it's bought, just not put away). Runs whenever the list is read, like the plan's
 * part of the list. True if anything was added.
 */
export async function syncStapleItems(db: Db, auth: Auth): Promise<boolean> {
  const low = (await listStaples(db, auth)).filter((s) => s.low && !s.onList);
  if (!low.length) return false;
  const prods = await db.select().from(products).where(eq(products.householdId, auth.household.id));
  for (const s of low) {
    const product = s.productId ? prods.find((p) => p.id === s.productId) : undefined;
    await db.insert(shoppingItems).values({
      householdId: auth.household.id,
      ingredientId: s.ingredientId,
      productId: s.productId,
      text: s.name,
      packs: 1,
      packGrams: product?.packGrams ?? null,
      reason: 'running-low',
      forMeals: null,
    });
  }
  return true;
}
