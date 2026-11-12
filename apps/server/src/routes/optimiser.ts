import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { calendarDate, MEAL_SLOTS } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { badRequest, parse } from '../http';
import { proposeWeek, scoreAllRecipes, suggest, surplusHints } from '../services/optimiser';

const suggestQuery = z.object({
  date: calendarDate.optional(),
  servings: z.coerce.number().positive().max(50).optional(),
  ingredient: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const planWeekInput = z.object({
  from: calendarDate,
  to: calendarDate,
  slots: z.array(z.enum(MEAL_SLOTS)).min(1).max(4).default(['dinner']),
  servings: z.number().positive().max(50).optional(),
});

export async function optimiserRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const pricing = () => ctx.config.PRICING_ENABLED;

  /** Every recipe scored: Cook now, Nearly there (1-3 missing) and Use it up. */
  app.get('/api/optimiser/recipes', async (req) => scoreAllRecipes(ctx.db, requireAuth(req), ctx.now(), pricing()));

  app.get('/api/optimiser/suggest', async (req) => {
    const q = parse(suggestQuery, req.query);
    return suggest(ctx.db, requireAuth(req), ctx.now(), pricing(), { date: q.date, servings: q.servings, ingredientId: q.ingredient, limit: q.limit });
  });

  app.post('/api/optimiser/plan-week', async (req) => {
    const input = parse(planWeekInput, req.body);
    if (input.to < input.from) throw badRequest('The end comes before the start.');
    return proposeWeek(ctx.db, requireAuth(req), ctx.now(), pricing(), input);
  });

  app.get('/api/optimiser/surplus', async (req) => surplusHints(ctx.db, requireAuth(req), ctx.now(), pricing()));
}
