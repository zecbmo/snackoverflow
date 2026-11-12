import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session';
import { parse } from '../http';
import { calorieStats, spending, wasteReport } from '../services/dashboard';
import { pricingOn } from '../services/pricing';

const periodQuery = z.object({ period: z.enum(['week', 'month']).default('month') });
const caloriesQuery = z.object({ person: z.union([z.literal('me'), z.literal('household'), z.uuid()]).default('me') });

export async function dashboardRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Calories per day for the last 30 days, with 7- and 30-day averages. */
  app.get('/api/stats/calories', async (req) => {
    const q = parse(caloriesQuery, req.query);
    return calorieStats(ctx.db, requireAuth(req), ctx.now(), q.person);
  });

  /** What was binned, by week or month, item and category. */
  app.get('/api/stats/waste-report', async (req) => {
    const auth = requireAuth(req);
    const q = parse(periodQuery, req.query);
    return wasteReport(ctx.db, auth, ctx.now(), pricingOn(ctx, auth.household), q.period);
  });

  /** Spending from receipts; only while pricing is on. */
  app.get('/api/stats/spending', async (req) => {
    const auth = requireAuth(req);
    const q = parse(periodQuery, req.query);
    if (!pricingOn(ctx, auth.household)) return null;
    return spending(ctx.db, auth, ctx.now(), q.period);
  });
}
