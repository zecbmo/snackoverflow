/**
 * AI around the kitchen: fill in a product from photos of its pack, make up a recipe that uses
 * food going off, plan a week, and the recipe photo bank (read by AI or the household's assistant).
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { calendarDate, MEAL_SLOTS, photosInput, recipeScansInput, useItUpInput } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { products } from '../db/schema';
import { badRequest, notFound, parse } from '../http';
import { planWeekWithAi, readProductPhotos, useItUpRecipe } from '../services/aiKitchen';
import { loadCatalog } from '../services/catalog';
import { aiWeekInputs, useItUpInputs } from '../services/optimiser';
import { addScans, deleteScan, listScans, readAllScans, scanImages } from '../services/recipeScans';

const PHOTO_LIMIT = { bodyLimit: 60 * 1024 * 1024 };
const toPhotos = (photos: { data: string; type: string }[]) => photos.map((p) => ({ data: Buffer.from(p.data, 'base64'), type: p.type }));

const planWeekAiInput = z.object({
  from: calendarDate,
  to: calendarDate,
  slots: z.array(z.enum(MEAL_SLOTS)).min(1).max(4).default(['dinner']),
  request: z.string().trim().max(500).nullish(),
});

export async function aiKitchenRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Read a product from photos of its pack. Nothing is saved: the scan sheet fills in its form. */
  app.post<{ Params: { id: string } }>('/api/products/:id/read-photos', PHOTO_LIMIT, async (req) => {
    const auth = requireAuth(req);
    const { photos } = parse(photosInput, req.body);
    const [p] = await ctx.db.select({ id: products.id }).from(products).where(and(eq(products.id, req.params.id), eq(products.householdId, auth.household.id)));
    if (!p) throw notFound('No such product.');
    return readProductPhotos(ctx.config, toPhotos(photos), await loadCatalog(ctx.db, auth.household.id), ctx.fetch);
  });

  /** A made-up recipe using food going off, as a draft to check and save. */
  app.post('/api/recipes/use-it-up', async (req) => {
    const auth = requireAuth(req);
    const input = parse(useItUpInput, req.body);
    const inputs = await useItUpInputs(ctx.db, auth, ctx.now(), ctx.config.PRICING_ENABLED);
    return useItUpRecipe(ctx.config, { ...inputs, serves: input.serves, request: input.request ?? null }, inputs.catalog, ctx.fetch);
  });

  /** "Plan my week" with AI: the same proposal as the optimiser's, to review before it's added. */
  app.post('/api/optimiser/plan-week-ai', async (req) => {
    const auth = requireAuth(req);
    const input = parse(planWeekAiInput, req.body);
    if (input.to < input.from) throw badRequest('The end comes before the start.');
    const { ctx: week, missingOf } = await aiWeekInputs(ctx.db, auth, ctx.now(), ctx.config.PRICING_ENABLED, input);
    return planWeekWithAi(ctx.config, week, missingOf, ctx.fetch);
  });

  // --- Recipe photo bank ------------------------------------------------------------------

  app.get('/api/recipe-scans', async (req) => listScans(ctx.db, requireAuth(req)));

  app.post('/api/recipe-scans', PHOTO_LIMIT, async (req) => {
    const auth = requireAuth(req);
    const input = parse(recipeScansInput, req.body);
    const ids = await addScans(ctx, auth, toPhotos(input.photos), input.separate);
    ctx.live.publish(auth.household.id, 'recipes');
    return { ids };
  });

  app.get<{ Params: { id: string; n: string } }>('/api/recipe-scans/:id/images/:n', async (req, reply) => {
    const auth = requireAuth(req);
    const photos = await scanImages(ctx.db, auth.household.id, req.params.id);
    const p = photos[Number(req.params.n)];
    if (!p) throw notFound();
    return reply.header('content-type', p.type).header('cache-control', 'private, max-age=3600').send(p.data);
  });

  app.delete<{ Params: { id: string } }>('/api/recipe-scans/:id', async (req) => {
    const auth = requireAuth(req);
    await deleteScan(ctx.db, auth.household.id, req.params.id);
    ctx.live.publish(auth.household.id, 'recipes');
    return { ok: true };
  });

  /** Read every waiting photo with AI, one after another in the background. */
  app.post('/api/recipe-scans/read-all', async (req) => {
    const auth = requireAuth(req);
    if (!ctx.config.AI_API_KEY) throw badRequest("AI isn't set up. Add a key in Settings, or ask your assistant to read them.");
    const { started } = await readAllScans(ctx, auth);
    ctx.live.publish(auth.household.id, 'recipes');
    return { started };
  });
}
