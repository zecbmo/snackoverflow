/**
 * Swap groups: foods that can stand in for each other in a recipe, like broccoli and tenderstem.
 * A recipe short of one shows the others in stock as close swaps; food from the same category
 * (chicken and pork are both Meat) shows as loose swaps. An ingredient is in one group at most.
 * Set up by hand in Settings, from AI suggestions the household reviews, or by an assistant (MCP).
 */
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import type { SwapExclusionDto, SwapGroupDto } from '@snackoverflow/shared';
import type { Db } from '../db/client';
import { ingredients, swapExclusions, swapGroups } from '../db/schema';
import { badRequest, notFound } from '../http';

export async function listSwapGroups(db: Db, householdId: string): Promise<SwapGroupDto[]> {
  const [groups, members] = await Promise.all([
    db.select().from(swapGroups).where(eq(swapGroups.householdId, householdId)).orderBy(asc(swapGroups.name)),
    db
      .select({ id: ingredients.id, name: ingredients.name, groupId: ingredients.swapGroupId })
      .from(ingredients)
      .where(eq(ingredients.householdId, householdId))
      .orderBy(asc(ingredients.name)),
  ]);
  return groups.map((g) => ({ id: g.id, name: g.name, ingredients: members.filter((m) => m.groupId === g.id).map(({ id, name }) => ({ id, name })) }));
}

/** Make the group's members exactly these ingredients (moving any from other groups). */
export async function setSwapGroupMembers(db: Db, householdId: string, groupId: string, ingredientIds: string[]): Promise<void> {
  const mine = and(eq(ingredients.householdId, householdId), eq(ingredients.swapGroupId, groupId));
  await db
    .update(ingredients)
    .set({ swapGroupId: null })
    .where(ingredientIds.length ? and(mine, notInArray(ingredients.id, ingredientIds)) : mine);
  if (ingredientIds.length) {
    await db
      .update(ingredients)
      .set({ swapGroupId: groupId })
      .where(and(eq(ingredients.householdId, householdId), inArray(ingredients.id, ingredientIds)));
  }
}

export async function createSwapGroup(db: Db, householdId: string, name: string, ingredientIds: string[] = []): Promise<string> {
  const [g] = await db.insert(swapGroups).values({ householdId, name }).returning({ id: swapGroups.id });
  if (ingredientIds.length) await setSwapGroupMembers(db, householdId, g!.id, ingredientIds);
  return g!.id;
}

export async function updateSwapGroup(db: Db, householdId: string, id: string, input: { name?: string; ingredientIds?: string[] }): Promise<void> {
  const [g] = await db.select().from(swapGroups).where(and(eq(swapGroups.id, id), eq(swapGroups.householdId, householdId)));
  if (!g) throw notFound('No such swap group.');
  if (input.name) await db.update(swapGroups).set({ name: input.name }).where(eq(swapGroups.id, g.id));
  if (input.ingredientIds) await setSwapGroupMembers(db, householdId, g.id, input.ingredientIds);
}

/**
 * Save several groups at once (from reviewed suggestions or an assistant): one with an id gets
 * these foods added (or, with `replace`, exactly these); one without is made, or merged into an
 * existing group of the same name.
 */
export async function saveSwapGroups(
  db: Db,
  householdId: string,
  groups: { id?: string | null; name: string; ingredientIds: string[]; replace?: boolean }[],
): Promise<SwapGroupDto[]> {
  for (const g of groups) {
    const current = await listSwapGroups(db, householdId);
    const existing = g.id ? current.find((c) => c.id === g.id) : current.find((c) => c.name.trim().toLowerCase() === g.name.trim().toLowerCase());
    if (g.id && !existing) throw notFound(`No swap group with id ${g.id}.`);
    if (existing) {
      const ids = g.replace ? g.ingredientIds : [...new Set([...existing.ingredients.map((i) => i.id), ...g.ingredientIds])];
      await updateSwapGroup(db, householdId, existing.id, { name: g.id ? g.name : undefined, ingredientIds: ids });
    } else {
      await createSwapGroup(db, householdId, g.name.trim(), g.ingredientIds);
    }
  }
  return listSwapGroups(db, householdId);
}

// --- Pairs that aren't swaps ----------------------------------------------------------------

/** One key per pair, whichever way round it's asked. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Pairs of foods never offered as swaps for each other. */
export async function excludedPairs(db: Db, householdId: string): Promise<Set<string>> {
  const rows = await db.select().from(swapExclusions).where(eq(swapExclusions.householdId, householdId));
  return new Set(rows.map((r) => pairKey(r.ingredientId, r.otherIngredientId)));
}

export async function listSwapExclusions(db: Db, householdId: string): Promise<SwapExclusionDto[]> {
  const rows = await db.select().from(swapExclusions).where(eq(swapExclusions.householdId, householdId));
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.ingredientId, r.otherIngredientId]))];
  const names = new Map((await db.select({ id: ingredients.id, name: ingredients.name }).from(ingredients).where(inArray(ingredients.id, ids))).map((i) => [i.id, i.name]));
  return rows
    .map((r) => ({
      id: r.id,
      ingredients: [
        { id: r.ingredientId, name: names.get(r.ingredientId) ?? 'Food' },
        { id: r.otherIngredientId, name: names.get(r.otherIngredientId) ?? 'Food' },
      ] as SwapExclusionDto['ingredients'],
    }))
    .sort((a, b) => a.ingredients[0].name.localeCompare(b.ingredients[0].name) || a.ingredients[1].name.localeCompare(b.ingredients[1].name));
}

/** "Pesto isn't a swap for stock cubes": never offer either for the other again. */
export async function addSwapExclusion(db: Db, householdId: string, a: string, b: string): Promise<void> {
  const mine = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(and(eq(ingredients.householdId, householdId), inArray(ingredients.id, [a, b])));
  if (mine.length !== 2) throw badRequest('Those foods aren’t in this household.');
  const [first, second] = a < b ? [a, b] : [b, a];
  await db.insert(swapExclusions).values({ householdId, ingredientId: first, otherIngredientId: second }).onConflictDoNothing();
}

export async function removeSwapExclusion(db: Db, householdId: string, id: string): Promise<void> {
  await db.delete(swapExclusions).where(and(eq(swapExclusions.id, id), eq(swapExclusions.householdId, householdId)));
}
