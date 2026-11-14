/** Unmatched recipe lines (Settings): list them, fix them, ignore them, or ask the AI for fixes to review. */
import type { FastifyInstance } from 'fastify';
import { unmatchedFixInput, unmatchedIgnoreInput } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { parse } from '../http';
import { suggestUnmatchedFixes } from '../services/ai';
import { loadCatalog } from '../services/catalog';
import { applyUnmatchedFixes, listUnmatched, setUnmatchedIgnored } from '../services/unmatched';

export async function unmatchedRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/unmatched', async (req) => listUnmatched(ctx.db, requireAuth(req), ctx.seed.units));

  app.post('/api/unmatched/fix', async (req) => {
    const auth = requireAuth(req);
    const { fixes } = parse(unmatchedFixInput, req.body);
    const result = await applyUnmatchedFixes(ctx.db, auth, ctx.seed.units, fixes);
    ctx.live.publish(auth.household.id, 'recipes', 'ingredients', 'plan', 'shopping');
    return result;
  });

  app.post('/api/unmatched/ignore', async (req) => {
    const auth = requireAuth(req);
    const { keys, ignored } = parse(unmatchedIgnoreInput, req.body);
    await setUnmatchedIgnored(ctx.db, auth, keys, ignored);
    ctx.live.publish(auth.household.id, 'recipes', 'household');
    return { ok: true };
  });

  /** Suggestions only: nothing changes until the household applies them. */
  app.post('/api/unmatched/suggest', async (req) => {
    const auth = requireAuth(req);
    const groups = (await listUnmatched(ctx.db, auth, ctx.seed.units)).filter((g) => !g.ignored && g.problem !== 'unknownUnit').slice(0, 100);
    return suggestUnmatchedFixes(ctx.config, groups, await loadCatalog(ctx.db, auth.household.id), ctx.fetch);
  });
}
