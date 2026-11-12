import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  addDays,
  addStockInput,
  adjustStockInput,
  defrostStockInput,
  discardStockInput,
  freezeStockInput,
  moveStockInput,
  type ScanAddResult,
  type ScanUseResult,
  scanInput,
  type StockEventDto,
  stillSomeInput,
  todayIn,
  useStockInput,
  type WasteSummaryDto,
} from '@snackoverflow/shared';
import { requireAdmin, requireAuth } from '../auth/session';
import { backupsEnabled, listBackups, openBackup, runBackup } from '../backup';
import {
  barcodes,
  households,
  ingredients,
  invites,
  locations,
  products,
  shelfLifeCategories,
  stockEvents,
  stockItems,
  users,
} from '../db/schema';
import { badRequest, HttpError, notFound, parse } from '../http';
import { barcodesFor, findProductByBarcode, loadCatalog, productDto } from '../services/catalog';
import { productById, resolveBarcode } from '../services/scan';
import {
  addPack,
  adjustPack,
  answerStillSome,
  defrostPack,
  discardPack,
  freezePack,
  getStockItem,
  itemHistory,
  listStock,
  movePack,
  openPack,
  packsForUse,
  type StockDeps,
  undoEvent,
  usePack,
} from '../services/stock';

export async function stockRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const deps = (req: FastifyRequest): StockDeps => ({ db: ctx.db, auth: requireAuth(req), now: ctx.now() });
  /** Run a stock change in a transaction and tell every phone. */
  const change = async <T>(req: FastifyRequest, fn: (d: StockDeps) => Promise<T>): Promise<T> => {
    const auth = requireAuth(req);
    const result = await ctx.db.transaction((tx) => fn({ db: tx, auth, now: ctx.now() }));
    ctx.live.publish(auth.household.id, 'stock');
    return result;
  };

  app.get('/api/stock', async (req) => {
    const d = deps(req);
    return listStock(d.db, d.auth, d.now);
  });

  app.get<{ Params: { id: string } }>('/api/stock/:id', async (req) => {
    const d = deps(req);
    const item = await getStockItem(d.db, d.auth, d.now, req.params.id);
    const history = await itemHistory(d.db, d.auth, req.params.id);
    const people = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.householdId, d.auth.household.id));
    const names = new Map(people.map((p) => [p.id, p.name]));
    const events: StockEventDto[] = history.map((e) => ({
      id: e.id,
      type: e.type,
      stockItemId: e.stockItemId,
      productId: e.productId,
      productName: item.productName,
      grams: e.grams,
      fraction: e.fraction,
      userName: e.userId ? (names.get(e.userId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
      undoneAt: e.undoneAt?.toISOString() ?? null,
    }));
    return { item, events };
  });

  /** Packs of one product (for the item detail screen), including other locations. */
  app.get<{ Params: { id: string } }>('/api/products/:id/stock', async (req) => {
    const d = deps(req);
    const all = await listStock(d.db, d.auth, d.now);
    return all.filter((s) => s.productId === req.params.id);
  });

  app.post('/api/stock', async (req) => {
    const input = parse(addStockInput, req.body);
    return change(req, async (d) => {
      const product = await productById({ ...ctx, db: d.db }, d.auth, input.productId);
      if (!product) throw notFound('No such product.');
      const catalog = await loadCatalog(d.db, d.auth.household.id);
      const changes = [];
      for (let i = 0; i < input.count; i++) {
        changes.push(await addPack(d, { product, locationId: input.locationId, bestBefore: input.bestBefore, catalog }));
      }
      return changes;
    });
  });

  app.post<{ Params: { id: string } }>('/api/stock/:id/use', async (req) => {
    const { amount } = parse(useStockInput, req.body);
    return change(req, (d) => usePack(d, req.params.id, amount));
  });

  app.post<{ Params: { id: string } }>('/api/stock/:id/discard', async (req) => {
    const { amount } = parse(discardStockInput, req.body);
    return change(req, (d) => discardPack(d, req.params.id, amount));
  });

  app.post<{ Params: { id: string } }>('/api/stock/:id/open', async (req) => change(req, (d) => openPack(d, req.params.id)));

  app.post<{ Params: { id: string } }>('/api/stock/:id/freeze', async (req) => {
    const { locationId } = parse(freezeStockInput, req.body);
    return change(req, (d) => freezePack(d, req.params.id, locationId));
  });

  app.post<{ Params: { id: string } }>('/api/stock/:id/defrost', async (req) => {
    const { locationId } = parse(defrostStockInput, req.body);
    return change(req, (d) => defrostPack(d, req.params.id, locationId));
  });

  app.post<{ Params: { id: string } }>('/api/stock/:id/move', async (req) => {
    const { locationId } = parse(moveStockInput, req.body);
    return change(req, (d) => movePack(d, req.params.id, locationId));
  });

  app.post<{ Params: { id: string } }>('/api/stock/:id/still-some', async (req) => {
    const { answer } = parse(stillSomeInput, req.body);
    return change(req, (d) => answerStillSome(d, req.params.id, answer));
  });

  app.patch<{ Params: { id: string } }>('/api/stock/:id', async (req) => {
    const input = parse(adjustStockInput, req.body);
    return change(req, (d) => adjustPack(d, req.params.id, input));
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/undo', async (req) => change(req, (d) => undoEvent(d, req.params.id)));

  // --- Scanning ----------------------------------------------------------------------
  app.post('/api/scan/add', async (req): Promise<ScanAddResult> => {
    const auth = requireAuth(req);
    const input = parse(scanInput, req.body);
    const locationId = input.locationId ?? auth.user.lastLocationId ?? (await firstLocation(auth.household.id));
    if (!locationId) throw badRequest('Add a location first.');
    const resolved = await resolveBarcode(ctx, auth, input.barcode);
    const added = await change(req, (d) => addPack(d, { product: resolved.product, locationId }));
    if (auth.user.lastLocationId !== locationId) {
      await ctx.db.update(users).set({ lastLocationId: locationId }).where(eq(users.id, auth.user.id));
    }
    const { estimated, ...changeDto } = added;
    const product = await productFor(auth.household.id, resolved.product.id);
    return { status: 'added', known: resolved.known, product, change: changeDto, estimated };
  });

  app.post('/api/scan/use', async (req): Promise<ScanUseResult> => {
    const auth = requireAuth(req);
    const input = parse(scanInput, req.body);
    const product = await findProductByBarcode(ctx.db, auth.household.id, input.barcode);
    if (!product) return { status: 'not-in-stock', product: null };
    const packs = await packsForUse(ctx.db, auth, product.id, input.locationId);
    const first = packs[0];
    const dto = await productFor(auth.household.id, product.id);
    if (!first) return { status: 'not-in-stock', product: dto };
    const used = await change(req, (d) => usePack(d, first.id, { kind: 'all' }));
    return { status: 'used', product: dto, change: used, packsLeft: packs.length - 1 };
  });

  async function firstLocation(householdId: string): Promise<string | null> {
    const [l] = await ctx.db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.householdId, householdId))
      .orderBy(asc(locations.sortOrder))
      .limit(1);
    return l?.id ?? null;
  }

  async function productFor(householdId: string, productId: string) {
    const [p] = await ctx.db.select().from(products).where(eq(products.id, productId));
    if (!p) throw notFound();
    const [catalog, codes] = await Promise.all([loadCatalog(ctx.db, householdId), barcodesFor(ctx.db, [p.id])]);
    return productDto(p, codes.get(p.id) ?? [], catalog);
  }

  // --- Stats ------------------------------------------------------------------------------
  app.get('/api/stats/waste', async (req): Promise<WasteSummaryDto> => {
    const auth = requireAuth(req);
    const today = todayIn(auth.household.timeZone, ctx.now());
    const monthStart = `${today.slice(0, 8)}01`;
    const lastMonthStart = `${addDays(monthStart, -1).slice(0, 8)}01`;
    const localDay = sql<string>`((${stockEvents.createdAt} AT TIME ZONE ${auth.household.timeZone})::date)`;
    const [row] = await ctx.db
      .select({
        thisMonth: sql<number>`coalesce(sum(${stockEvents.grams}) filter (where ${localDay} >= ${monthStart}::date), 0)`,
        lastMonth: sql<number>`coalesce(sum(${stockEvents.grams}) filter (where ${localDay} >= ${lastMonthStart}::date and ${localDay} < ${monthStart}::date), 0)`,
        items: sql<number>`count(*) filter (where ${localDay} >= ${monthStart}::date)`,
      })
      .from(stockEvents)
      .where(and(eq(stockEvents.householdId, auth.household.id), eq(stockEvents.type, 'discard'), isNull(stockEvents.undoneAt)));
    return {
      thisMonthGrams: Number(row?.thisMonth ?? 0),
      lastMonthGrams: Number(row?.lastMonth ?? 0),
      thisMonthItems: Number(row?.items ?? 0),
    };
  });

  // --- Export and backups (admin) -------------------------------------------------------------
  app.get('/api/export', async (req, reply) => {
    const auth = requireAdmin(req);
    const h = auth.household.id;
    const [household] = await ctx.db.select().from(households).where(eq(households.id, h));
    const data = {
      exportedAt: ctx.now().toISOString(),
      household,
      users: (await ctx.db.select().from(users).where(eq(users.householdId, h))).map(({ passwordHash: _p, ...u }) => u),
      locations: await ctx.db.select().from(locations).where(eq(locations.householdId, h)),
      shelfLifeCategories: await ctx.db.select().from(shelfLifeCategories).where(eq(shelfLifeCategories.householdId, h)),
      ingredients: await ctx.db.select().from(ingredients).where(eq(ingredients.householdId, h)),
      products: await ctx.db.select().from(products).where(eq(products.householdId, h)),
      barcodes: await ctx.db.select().from(barcodes).where(eq(barcodes.householdId, h)),
      stockItems: await ctx.db.select().from(stockItems).where(eq(stockItems.householdId, h)),
      stockEvents: await ctx.db.select().from(stockEvents).where(eq(stockEvents.householdId, h)),
      invites: (await ctx.db.select().from(invites).where(eq(invites.householdId, h))).map(({ tokenHash: _t, ...i }) => i),
    };
    reply.header('Content-Disposition', `attachment; filename="snackoverflow-export-${todayIn(auth.household.timeZone, ctx.now())}.json"`);
    return data;
  });

  app.get('/api/backups', async (req) => {
    requireAdmin(req);
    return { enabled: backupsEnabled(ctx.config), backups: await listBackups(ctx.config) };
  });

  app.post('/api/backups', async (req) => {
    requireAdmin(req);
    if (!backupsEnabled(ctx.config)) throw badRequest('Backups are not set up (BACKUP_DIR).');
    try {
      return await runBackup(ctx.config, ctx.now());
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
    }
  });

  app.get<{ Params: { name: string } }>('/api/backups/:name', async (req, reply) => {
    requireAdmin(req);
    const stream = openBackup(ctx.config, req.params.name);
    if (!stream) throw notFound();
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${req.params.name}"`);
    return reply.send(stream);
  });
}
