/** Swap groups (Settings): list, make, change and remove them, or have the AI suggest some to review. */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { swapExclusionInput, swapGroupInput, swapGroupsSaveInput } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { swapGroups } from '../db/schema';
import { parse } from '../http';
import { suggestSwapGroups } from '../services/aiKitchen';
import { loadCatalog } from '../services/catalog';
import {
  addSwapExclusion,
  createSwapGroup,
  listSwapExclusions,
  listSwapGroups,
  removeSwapExclusion,
  saveSwapGroups,
  updateSwapGroup,
} from '../services/swapGroups';

export async function swapGroupRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/swap-groups', async (req) => listSwapGroups(ctx.db, requireAuth(req).household.id));

  // Pairs that aren't swaps: tapped away on a recipe, listed (and undone) in Settings.
  app.get('/api/swap-exclusions', async (req) => listSwapExclusions(ctx.db, requireAuth(req).household.id));

  app.post('/api/swap-exclusions', async (req) => {
    const auth = requireAuth(req);
    const input = parse(swapExclusionInput, req.body);
    await addSwapExclusion(ctx.db, auth.household.id, input.ingredientId, input.otherIngredientId);
    ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
    return listSwapExclusions(ctx.db, auth.household.id);
  });

  app.delete<{ Params: { id: string } }>('/api/swap-exclusions/:id', async (req) => {
    const auth = requireAuth(req);
    await removeSwapExclusion(ctx.db, auth.household.id, req.params.id);
    ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
    return { ok: true };
  });

  app.post('/api/swap-groups', async (req) => {
    const auth = requireAuth(req);
    const input = parse(swapGroupInput, req.body);
    const id = await createSwapGroup(ctx.db, auth.household.id, input.name, input.ingredientIds);
    ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
    return (await listSwapGroups(ctx.db, auth.household.id)).find((x) => x.id === id);
  });

  /** Several at once: applying reviewed suggestions. */
  app.post('/api/swap-groups/save', async (req) => {
    const auth = requireAuth(req);
    const { groups } = parse(swapGroupsSaveInput, req.body);
    const out = await saveSwapGroups(ctx.db, auth.household.id, groups);
    ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
    return out;
  });

  /** Suggestions only: nothing changes until the household applies them. */
  app.post('/api/swap-groups/suggest', async (req) => {
    const auth = requireAuth(req);
    const [catalog, groups] = await Promise.all([loadCatalog(ctx.db, auth.household.id), listSwapGroups(ctx.db, auth.household.id)]);
    return suggestSwapGroups(ctx.config, catalog, groups, ctx.fetch);
  });

  app.patch<{ Params: { id: string } }>('/api/swap-groups/:id', async (req) => {
    const auth = requireAuth(req);
    const input = parse(swapGroupInput.partial(), req.body);
    await updateSwapGroup(ctx.db, auth.household.id, req.params.id, input);
    ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
    return (await listSwapGroups(ctx.db, auth.household.id)).find((x) => x.id === req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/swap-groups/:id', async (req) => {
    const auth = requireAuth(req);
    await ctx.db.delete(swapGroups).where(and(eq(swapGroups.id, req.params.id), eq(swapGroups.householdId, auth.household.id)));
    ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
    return { ok: true };
  });
}
