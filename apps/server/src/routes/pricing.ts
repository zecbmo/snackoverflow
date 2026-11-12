import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type PriceDto, type ShoppingEstimateDto, todayIn } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { prices, products } from '../db/schema';
import { badRequest, notFound, parse } from '../http';
import { addManualPrice, pricingOn } from '../services/pricing';
import { listShopping } from '../services/shopping';

const priceInput = z.object({
  pricePence: z.number().int().min(1).max(100_000),
  store: z.string().trim().max(80).nullish(),
});

export async function pricingRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  async function product(householdId: string, id: string) {
    const [p] = await ctx.db.select({ id: products.id }).from(products).where(and(eq(products.id, id), eq(products.householdId, householdId)));
    if (!p) throw notFound('No such product.');
    return p;
  }

  /** A price someone typed in (e.g. when scanning). */
  app.post<{ Params: { id: string } }>('/api/products/:id/prices', async (req) => {
    const auth = requireAuth(req);
    if (!pricingOn(ctx, auth.household)) throw badRequest('Prices are switched off. Turn them on in Settings.');
    const input = parse(priceInput, req.body);
    await product(auth.household.id, req.params.id);
    await addManualPrice(ctx.db, auth.household.id, req.params.id, input.pricePence, input.store ?? null, todayIn(auth.household.timeZone, ctx.now()));
    ctx.live.publish(auth.household.id, 'products', 'shopping');
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/products/:id/prices', async (req): Promise<PriceDto[]> => {
    const auth = requireAuth(req);
    await product(auth.household.id, req.params.id);
    if (!pricingOn(ctx, auth.household)) return [];
    const rows = await ctx.db
      .select()
      .from(prices)
      .where(and(eq(prices.householdId, auth.household.id), eq(prices.productId, req.params.id)))
      .orderBy(desc(prices.date), desc(prices.createdAt))
      .limit(20);
    return rows.map((r) => ({ id: r.id, pricePence: r.pricePence, store: r.store, date: r.date, source: r.source }));
  });

  /** Estimated total of what's still to get. */
  app.get('/api/shopping/estimate', async (req): Promise<ShoppingEstimateDto> => {
    const auth = requireAuth(req);
    if (!pricingOn(ctx, auth.household)) return { enabled: false, totalPence: null, priced: 0, unpriced: 0 };
    const items = (await listShopping(ctx.db, auth, true, ctx.now())).filter((i) => !i.checked);
    const priced = items.filter((i) => i.pricePence !== null);
    return {
      enabled: true,
      totalPence: priced.length ? priced.reduce((s, i) => s + i.pricePence!, 0) : null,
      priced: priced.length,
      unpriced: items.length - priced.length,
    };
  });
}
