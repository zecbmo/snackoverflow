/** Fast food and takeaway chains with their menu nutrition (read-only reference data). */
import type { FastifyInstance } from 'fastify';
import { chainItemSearchQuery } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { notFound, parse } from '../http';
import { chainMenu, listChains, searchChainItems } from '../services/chains';

export async function chainRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/chains', async (req) => {
    requireAuth(req);
    return listChains(ctx.db);
  });

  app.get<{ Params: { key: string } }>('/api/chains/:key', async (req) => {
    requireAuth(req);
    const chain = (await listChains(ctx.db)).find((c) => c.key === req.params.key);
    if (!chain) throw notFound("That chain isn't in the list.");
    return { chain, items: await chainMenu(ctx.db, chain.key) };
  });

  app.get('/api/chain-items', async (req) => {
    requireAuth(req);
    const { q, chain, limit } = parse(chainItemSearchQuery, req.query);
    return searchChainItems(ctx.db, q, { chain, limit });
  });
}
