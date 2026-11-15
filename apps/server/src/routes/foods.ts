/**
 * Log food: one search across the kitchen, recipes, foods and takeaway menus; suggestions;
 * favourites; saved meals; Open Food Facts by name; barcodes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type BarcodeFoodDto,
  favouriteInput,
  type FoodResultDto,
  foodSearchQuery,
  type FoodSuggestionsDto,
  foodSuggestionsQuery,
  logSavedMealInput,
  type OffSearchDto,
  savedMealInput,
} from '@snackoverflow/shared';
import { requireAdmin, requireAuth } from '../auth/session';
import { badRequest, parse } from '../http';
import { barcodeFood, deleteSavedMeal, foodSuggestions, logSavedMeal, productFood, saveMeal, searchFoods, searchOff, setFavourite } from '../services/foodSearch';
import { offDumpStatus, startOffImport } from '../services/offDump';
import type { StockDeps } from '../services/stock';

const barcodeParam = z.object({ code: z.string().trim().regex(/^[0-9A-Za-z-]{4,64}$/, 'Not a valid barcode') });

export async function foodRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const inTx = async <T>(req: FastifyRequest, fn: (d: StockDeps) => Promise<T>): Promise<T> => {
    const auth = requireAuth(req);
    const result = await ctx.db.transaction((tx) => fn({ db: tx, auth, now: ctx.now() }));
    ctx.live.publish(auth.household.id, 'plan');
    ctx.live.publish(auth.household.id, 'stock');
    return result;
  };

  /** With no query: what's in the kitchen, use-first order. */
  app.get('/api/foods/search', async (req): Promise<FoodResultDto[]> => {
    const auth = requireAuth(req);
    const { q } = parse(foodSearchQuery, req.query);
    return searchFoods(ctx, auth, q);
  });

  app.get('/api/foods/suggestions', async (req): Promise<FoodSuggestionsDto> => {
    const auth = requireAuth(req);
    const { slot } = parse(foodSuggestionsQuery, req.query);
    return foodSuggestions(ctx.db, auth, ctx.now(), slot);
  });

  /** Open Food Facts by name. Only on request: it allows about 10 searches a minute. */
  app.get('/api/foods/off', async (req): Promise<OffSearchDto> => {
    const auth = requireAuth(req);
    const { q } = parse(foodSearchQuery, req.query);
    return searchOff(ctx, auth, q);
  });

  /** A barcode scanned, typed or picked from Open Food Facts: becomes (or is) one of your products. */
  app.get<{ Params: { code: string } }>('/api/foods/barcode/:code', async (req): Promise<BarcodeFoodDto> => {
    const auth = requireAuth(req);
    const { code } = parse(barcodeParam, req.params);
    return barcodeFood(ctx, auth, code);
  });

  app.get<{ Params: { id: string } }>('/api/foods/product/:id', async (req): Promise<FoodResultDto> => {
    const auth = requireAuth(req);
    return productFood(ctx.db, auth, ctx.now(), req.params.id);
  });

  /** Settings: the local copy of Open Food Facts. */
  app.get('/api/off-dump', async (req) => {
    requireAuth(req);
    return offDumpStatus(ctx);
  });

  /** Refresh it now (admins). It runs in the background; poll the status. */
  app.post('/api/off-dump/import', async (req) => {
    requireAdmin(req);
    if (!ctx.config.OFF_DUMP_ENABLED) throw badRequest('Set OFF_DUMP_ENABLED to keep a copy of Open Food Facts.');
    await startOffImport(ctx, req.log);
    return offDumpStatus(ctx);
  });

  app.post('/api/foods/favourites', async (req) => {
    const auth = requireAuth(req);
    const { kind, id, on } = parse(favouriteInput, req.body);
    await setFavourite(ctx.db, auth, kind, id, on);
    return { ok: true };
  });

  app.post('/api/foods/meals', async (req) => {
    const auth = requireAuth(req);
    const { name, entryIds } = parse(savedMealInput, req.body);
    return saveMeal(ctx.db, auth, name, entryIds);
  });

  app.delete<{ Params: { id: string } }>('/api/foods/meals/:id', async (req) => {
    const auth = requireAuth(req);
    await deleteSavedMeal(ctx.db, auth, req.params.id);
    return { ok: true };
  });

  /** Log a saved meal as eaten: every food in it, for you. */
  app.post<{ Params: { id: string } }>('/api/foods/meals/:id/log', async (req) => {
    const input = parse(logSavedMealInput, req.body);
    return inTx(req, (d) => logSavedMeal(d, req.params.id, input));
  });
}
