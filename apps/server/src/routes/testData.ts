/** Test copies only (TEST_MODE): put the household's food data back to made-up demo data. */
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/session';
import { forbidden } from '../http';
import { type ApiCall, fillDemoData, wipeFoodData } from '../services/testData';

export async function testDataRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /**
   * Delete the food data and fill it with demo data, through the app's own API as the admin
   * asking (their cookie or device token), so it all follows the usual rules. Takes a few seconds.
   */
  app.post('/api/test-data/reset', async (req) => {
    const auth = requireAdmin(req);
    if (!ctx.config.TEST_MODE) throw forbidden('Resetting is only for test copies (TEST_MODE=true).');
    const as: Record<string, string> = {};
    if (req.headers.cookie) as.cookie = req.headers.cookie;
    if (req.headers.authorization) as.authorization = req.headers.authorization;
    const call: ApiCall = async (method, url, body, anon = false) => {
      const res = await app.inject({ method, url, headers: anon ? {} : as, ...(body !== undefined ? { payload: body as object } : {}) });
      if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 300)}`);
      return res.body ? res.json() : null;
    };
    await wipeFoodData(ctx.db, auth);
    const steps = await fillDemoData(call);
    for (const topic of ['stock', 'plan', 'shopping', 'products'] as const) ctx.live.publish(auth.household.id, topic);
    return { steps };
  });
}
