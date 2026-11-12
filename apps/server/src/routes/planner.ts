import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addDays,
  buildListInput,
  calendarDate,
  eatPlanEntryInput,
  type EatResultDto,
  planEntryInput,
  putAwayInput,
  scanInput,
  shoppingItemInput,
  todayIn,
  updatePlanEntryInput,
  updateShoppingItemInput,
} from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { stockEvents, users } from '../db/schema';
import { badRequest, forbidden, parse } from '../http';
import { deliver, prefsOf } from '../notify/notifications';
import { barcodesFor, loadCatalog, productDto } from '../services/catalog';
import { createEntry, deleteEntry, earmarks, eatEntry, getEntry, listPlan, logEaten, updateEntry } from '../services/planner';
import { resolveBarcode } from '../services/scan';
import { addItem, buildFromPlan, deleteItems, listShopping, putAway, runningLow, updateItem } from '../services/shopping';
import { getStockItem, type StockDeps } from '../services/stock';

const planQuery = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  /** "me" (default), "everyone", or a person's id. */
  person: z.string().default('me'),
});

export async function plannerRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const inTx = async <T>(req: FastifyRequest, fn: (d: StockDeps) => Promise<T>, ...topics: ('stock' | 'plan' | 'shopping')[]): Promise<T> => {
    const auth = requireAuth(req);
    const result = await ctx.db.transaction((tx) => fn({ db: tx, auth, now: ctx.now() }));
    for (const t of topics) ctx.live.publish(auth.household.id, t === 'plan' ? 'plan' : t === 'shopping' ? 'shopping' : 'stock');
    return result;
  };

  // --- Planner -----------------------------------------------------------------------
  app.get('/api/plan', async (req) => {
    const auth = requireAuth(req);
    const q = parse(planQuery, req.query);
    const today = todayIn(auth.household.timeZone, ctx.now());
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 6);
    if (to < from || to > addDays(from, 62)) throw badRequest('Pick up to two months at a time.');
    let personId: string | null = auth.user.id;
    if (q.person === 'everyone') personId = null;
    else if (q.person !== 'me' && q.person !== auth.user.id) {
      if (auth.user.role !== 'admin') throw forbidden("Only admins can see someone else's calendar.");
      personId = q.person;
    }
    return listPlan(ctx.db, auth, from, to, personId);
  });

  app.post('/api/plan', async (req) => {
    const input = parse(planEntryInput, req.body);
    return inTx(req, (d) => createEntry(d, input), 'plan', 'stock');
  });

  app.patch<{ Params: { id: string } }>('/api/plan/:id', async (req) => {
    const input = parse(updatePlanEntryInput, req.body);
    return inTx(req, (d) => updateEntry(d, req.params.id, input), 'plan');
  });

  app.delete<{ Params: { id: string } }>('/api/plan/:id', async (req) => {
    await inTx(req, (d) => deleteEntry(d, req.params.id), 'plan');
    return { ok: true };
  });

  /** Eaten a planned product or leftovers: mark it done and take it out of stock. */
  app.post<{ Params: { id: string } }>('/api/plan/:id/eat', async (req) => {
    const { fromStock } = parse(eatPlanEntryInput, req.body);
    return (await inTx(req, (d) => eatEntry(d, req.params.id, fromStock), 'plan', 'stock')).entry;
  });

  app.get<{ Params: { id: string } }>('/api/plan/:id', async (req) => getEntry(ctx.db, requireAuth(req), req.params.id));

  app.get('/api/plan/earmarks', async (req) => {
    const auth = requireAuth(req);
    return earmarks(ctx.db, auth, todayIn(auth.household.timeZone, ctx.now()));
  });

  /** Eat mode: log a scanned product to your current meal, and take it from stock if it's there. */
  app.post('/api/scan/eat', async (req): Promise<EatResultDto> => {
    const auth = requireAuth(req);
    const input = parse(scanInput, req.body);
    const resolved = await resolveBarcode(ctx, auth, input.barcode);
    const r = await inTx(req, (d) => logEaten(d, resolved.product, input.slot), 'plan', 'stock');
    const [catalog, codes] = await Promise.all([loadCatalog(ctx.db, auth.household.id), barcodesFor(ctx.db, [resolved.product.id])]);
    let change = null;
    if (r.stockChanged) {
      const [ev] = await ctx.db.select().from(stockEvents).where(and(eq(stockEvents.mealPlanEntryId, r.entry.id))).orderBy(desc(stockEvents.seq)).limit(1);
      if (ev) change = { item: await getStockItem(ctx.db, auth, ctx.now(), ev.stockItemId), eventId: ev.id };
    }
    return { entry: r.entry, product: productDto(resolved.product, codes.get(resolved.product.id) ?? [], catalog), change };
  });

  // --- Shopping list -------------------------------------------------------------------
  app.get('/api/shopping', async (req) => listShopping(ctx.db, requireAuth(req)));

  app.post('/api/shopping', async (req) => {
    const auth = requireAuth(req);
    const input = parse(shoppingItemInput, req.body);
    const id = await addItem(ctx.db, auth, input);
    ctx.live.publish(auth.household.id, 'shopping');
    void notifyListChanged(auth.user.id, auth.household.id, auth.user.name, input.text ?? null);
    return { id, items: await listShopping(ctx.db, auth) };
  });

  app.patch<{ Params: { id: string } }>('/api/shopping/:id', async (req) => {
    const auth = requireAuth(req);
    await updateItem(ctx.db, auth, req.params.id, parse(updateShoppingItemInput, req.body), ctx.now());
    ctx.live.publish(auth.household.id, 'shopping');
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/shopping/:id', async (req) => {
    const auth = requireAuth(req);
    await deleteItems(ctx.db, auth, [req.params.id]);
    ctx.live.publish(auth.household.id, 'shopping');
    return { ok: true };
  });

  app.post('/api/shopping/clear-checked', async (req) => {
    const auth = requireAuth(req);
    await deleteItems(ctx.db, auth, 'checked');
    ctx.live.publish(auth.household.id, 'shopping');
    return { ok: true };
  });

  app.post('/api/shopping/build', async (req) => {
    const auth = requireAuth(req);
    const { from, to } = parse(buildListInput, req.body);
    const r = await ctx.db.transaction((tx) => buildFromPlan(tx, auth, from, to, ctx.now()));
    ctx.live.publish(auth.household.id, 'shopping');
    return r;
  });

  app.post('/api/shopping/put-away', async (req) => {
    const { itemIds } = parse(putAwayInput, req.body);
    return inTx(req, (d) => putAway(d, itemIds), 'stock', 'shopping');
  });

  app.get('/api/running-low', async (req) => runningLow(ctx.db, requireAuth(req), ctx.now()));

  /** "Shopping list changed by someone else" (off unless people turn it on). */
  async function notifyListChanged(byUserId: string, householdId: string, byName: string, text: string | null) {
    try {
      const members = await ctx.db.select().from(users).where(eq(users.householdId, householdId));
      for (const m of members) {
        if (m.id === byUserId) continue;
        const channels = prefsOf(m).channels.listChanged ?? [];
        if (channels.length) {
          await deliver(ctx, m, channels, 'listChanged', { title: 'Shopping list', body: `${byName} added ${text ?? 'something'} to the list.`, url: '/shop', tag: 'list-changed' });
        }
      }
    } catch {
      // Notifications are a nicety.
    }
  }
}
