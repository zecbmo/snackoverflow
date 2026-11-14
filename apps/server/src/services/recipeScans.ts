/**
 * The recipe photo bank: photos of recipes (a cookbook page, both sides of a recipe card) wait
 * here until someone taps "Read them all" (AI) or asks their own assistant (MCP). Each becomes a
 * saved recipe; lines that couldn't be matched end up under Settings → Unmatched ingredients.
 * The photos are deleted once their recipe is saved.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type RecipeDraftDto, type RecipeInput, recipeInput, type RecipeScanDto } from '@snackoverflow/shared';
import type { AppContext, Auth } from '../context';
import type { Db } from '../db/client';
import { recipeScanImages, recipeScans, recipes } from '../db/schema';
import { notFound } from '../http';
import { checkPhotos, type Photo, readRecipePhotos } from './aiKitchen';
import { loadCatalog } from './catalog';
import { completeRecipeLines, saveRecipe } from './recipes';

/** Scans being read right now in this process; anything else marked "reading" was cut short and can go again. */
const active = new Set<string>();

export async function addScans(ctx: AppContext, auth: Auth, photos: Photo[], separate: boolean): Promise<string[]> {
  checkPhotos(photos);
  const groups = separate ? photos.map((p) => [p]) : [photos];
  const ids: string[] = [];
  for (const group of groups) {
    const [scan] = await ctx.db.insert(recipeScans).values({ householdId: auth.household.id, createdBy: auth.user.id }).returning({ id: recipeScans.id });
    await ctx.db.insert(recipeScanImages).values(group.map((p, i) => ({ scanId: scan!.id, position: i, file: p.data, fileType: p.type })));
    ids.push(scan!.id);
  }
  return ids;
}

export async function listScans(db: Db, auth: Auth): Promise<RecipeScanDto[]> {
  const rows = await db
    .select({ scan: recipeScans, title: recipes.title })
    .from(recipeScans)
    .leftJoin(recipes, eq(recipes.id, recipeScans.recipeId))
    .where(eq(recipeScans.householdId, auth.household.id))
    .orderBy(desc(recipeScans.createdAt));
  const counts = new Map<string, number>();
  if (rows.length) {
    const imgs = await db
      .select({ scanId: recipeScanImages.scanId })
      .from(recipeScanImages)
      .where(inArray(recipeScanImages.scanId, rows.map((r) => r.scan.id)));
    for (const i of imgs) counts.set(i.scanId, (counts.get(i.scanId) ?? 0) + 1);
  }
  return rows.map(({ scan, title }) => ({
    id: scan.id,
    status: scan.status === 'reading' && !active.has(scan.id) ? 'waiting' : (scan.status as RecipeScanDto['status']),
    error: scan.error,
    recipeId: scan.recipeId,
    recipeTitle: title,
    imageCount: counts.get(scan.id) ?? 0,
    createdAt: scan.createdAt.toISOString(),
  }));
}

async function ownScan(db: Db, householdId: string, id: string) {
  const [s] = await db.select().from(recipeScans).where(and(eq(recipeScans.id, id), eq(recipeScans.householdId, householdId)));
  if (!s) throw notFound('No such recipe photo.');
  return s;
}

export async function scanImages(db: Db, householdId: string, id: string): Promise<Photo[]> {
  await ownScan(db, householdId, id);
  const rows = await db.select().from(recipeScanImages).where(eq(recipeScanImages.scanId, id)).orderBy(asc(recipeScanImages.position));
  return rows.map((r) => ({ data: r.file, type: r.fileType }));
}

export async function deleteScan(db: Db, householdId: string, id: string): Promise<void> {
  await db.delete(recipeScans).where(and(eq(recipeScans.id, id), eq(recipeScans.householdId, householdId)));
}

export const recipeInputFromDraft = (d: RecipeDraftDto): RecipeInput =>
  recipeInput.parse({
    title: d.title,
    serves: d.serves,
    steps: d.steps,
    tags: d.tags,
    prepMinutes: d.prepMinutes,
    cookMinutes: d.cookMinutes,
    ingredients: d.ingredients.map((l) => ({ text: l.text, amount: l.amount, unit: l.unit, ingredientId: l.ingredientId, note: l.note, optional: l.optional })),
  });

/** Save the recipe read from a scan (by the AI or an assistant), then let the photos go. */
export async function saveScanRecipe(ctx: AppContext, auth: Auth, scanId: string, input: RecipeInput): Promise<string> {
  const scan = await ownScan(ctx.db, auth.household.id, scanId);
  if (scan.status === 'done' && scan.recipeId) return scan.recipeId;
  const complete = completeRecipeLines(input, await loadCatalog(ctx.db, auth.household.id), ctx.seed);
  const recipeId = await saveRecipe(ctx.db, auth, ctx.seed, complete);
  await ctx.db.update(recipeScans).set({ status: 'done', error: null, recipeId, doneAt: ctx.now() }).where(eq(recipeScans.id, scanId));
  await ctx.db.delete(recipeScanImages).where(eq(recipeScanImages.scanId, scanId));
  ctx.live.publish(auth.household.id, 'recipes');
  return recipeId;
}

async function readOne(ctx: AppContext, auth: Auth, scanId: string): Promise<void> {
  try {
    await ctx.db.update(recipeScans).set({ status: 'reading', error: null }).where(eq(recipeScans.id, scanId));
    ctx.live.publish(auth.household.id, 'recipes');
    const photos = await scanImages(ctx.db, auth.household.id, scanId);
    const draft = await readRecipePhotos(ctx.config, photos, await loadCatalog(ctx.db, auth.household.id), ctx.fetch);
    await saveScanRecipe(ctx, auth, scanId, recipeInputFromDraft(draft));
  } catch (e) {
    await ctx.db
      .update(recipeScans)
      .set({ status: 'failed', error: e instanceof Error ? e.message : "Couldn't read that recipe." })
      .where(eq(recipeScans.id, scanId));
    ctx.live.publish(auth.household.id, 'recipes');
  }
}

/**
 * Read every photo still waiting (or that failed), one after another in the background.
 * Returns how many it started and a promise for when they're all done (tests wait on it).
 */
export async function readAllScans(ctx: AppContext, auth: Auth): Promise<{ started: number; finished: Promise<void> }> {
  const rows = await ctx.db
    .select({ id: recipeScans.id })
    .from(recipeScans)
    .where(and(eq(recipeScans.householdId, auth.household.id), inArray(recipeScans.status, ['waiting', 'failed', 'reading'])))
    .orderBy(asc(recipeScans.createdAt));
  const ids = rows.map((r) => r.id).filter((id) => !active.has(id));
  for (const id of ids) active.add(id);
  if (ids.length) await ctx.db.update(recipeScans).set({ status: 'reading', error: null }).where(inArray(recipeScans.id, ids));
  const finished = (async () => {
    for (const id of ids) {
      await readOne(ctx, auth, id);
      active.delete(id);
    }
  })();
  return { started: ids.length, finished };
}
