import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cookInput, recipeInput } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { parse } from '../http';
import { confirmCook, planCook, recentCooks, undoCook } from '../services/cooking';
import { deleteRecipe, draftLines, getRecipe, listRecipes, saveRecipe } from '../services/recipes';
import type { StockDeps } from '../services/stock';

const linesInput = z.object({ lines: z.array(z.string().max(300)).max(100) });
const servingsQuery = z.object({ servings: z.coerce.number().positive().max(500).optional() });

export async function recipeRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const inTx = async <T>(req: FastifyRequest, fn: (d: StockDeps) => Promise<T>, ...topics: ('stock' | 'recipes' | 'products')[]): Promise<T> => {
    const auth = requireAuth(req);
    const result = await ctx.db.transaction((tx) => fn({ db: tx, auth, now: ctx.now() }));
    ctx.live.publish(auth.household.id, ...topics);
    return result;
  };

  app.get('/api/recipes', async (req) => listRecipes(ctx.db, requireAuth(req)));

  app.get<{ Params: { id: string } }>('/api/recipes/:id', async (req) => getRecipe(ctx.db, requireAuth(req), req.params.id));

  app.post('/api/recipes', async (req) => {
    const auth = requireAuth(req);
    const input = parse(recipeInput, req.body);
    const id = await saveRecipe(ctx.db, auth, ctx.seed, input);
    ctx.live.publish(auth.household.id, 'recipes');
    return getRecipe(ctx.db, auth, id);
  });

  app.put<{ Params: { id: string } }>('/api/recipes/:id', async (req) => {
    const auth = requireAuth(req);
    const input = parse(recipeInput, req.body);
    await saveRecipe(ctx.db, auth, ctx.seed, input, req.params.id);
    ctx.live.publish(auth.household.id, 'recipes');
    return getRecipe(ctx.db, auth, req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/recipes/:id', async (req) => {
    const auth = requireAuth(req);
    await deleteRecipe(ctx.db, auth, req.params.id);
    ctx.live.publish(auth.household.id, 'recipes');
    return { ok: true };
  });

  /** Read ingredient lines as typed and suggest matches (the editor uses this as you type). */
  app.post('/api/recipes/parse-lines', async (req) => {
    const { lines } = parse(linesInput, req.body);
    return draftLines(ctx.db, requireAuth(req), ctx.seed, lines);
  });

  app.get<{ Params: { id: string } }>('/api/recipes/:id/cook-plan', async (req) => {
    const auth = requireAuth(req);
    const { servings } = parse(servingsQuery, req.query);
    const recipe = await getRecipe(ctx.db, auth, req.params.id);
    return planCook(ctx.db, auth, recipe.id, servings ?? recipe.serves);
  });

  app.post<{ Params: { id: string } }>('/api/recipes/:id/cook', async (req) => {
    const input = parse(cookInput, req.body);
    return inTx(req, (d) => confirmCook(d, req.params.id, input), 'stock', 'products');
  });

  app.get('/api/cooks', async (req) => recentCooks(ctx.db, requireAuth(req)));

  app.post<{ Params: { id: string } }>('/api/cooks/:id/undo', async (req) => {
    await inTx(req, (d) => undoCook(d, req.params.id), 'stock');
    return { ok: true };
  });
}
