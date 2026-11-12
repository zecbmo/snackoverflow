import { and, asc, count, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { IngredientInput, LocationDto } from '@snackoverflow/shared';
import { ingredientInput, locationInput, productInput, shelfLifeInput, updateProductInput } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { barcodes, ingredients, locations, products, shelfLifeCategories, stockEvents, stockItems } from '../db/schema';
import { badRequest, conflict, notFound, parse } from '../http';
import { latestPrices, pricingOn } from '../services/pricing';
import {
  barcodesFor,
  categoryDto,
  findProductByBarcode,
  ingredientDto,
  loadCatalog,
  measuresFor,
  packFields,
  productDto,
} from '../services/catalog';

type LocationRow = typeof locations.$inferSelect;
const locationDto = (l: LocationRow): LocationDto => ({ id: l.id, name: l.name, type: l.type, icon: l.icon, sortOrder: l.sortOrder });

export async function catalogRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // --- Locations -------------------------------------------------------------------
  app.get('/api/locations', async (req) => {
    const auth = requireAuth(req);
    const rows = await ctx.db
      .select()
      .from(locations)
      .where(eq(locations.householdId, auth.household.id))
      .orderBy(asc(locations.sortOrder), asc(locations.createdAt));
    return rows.map(locationDto);
  });

  app.post('/api/locations', async (req) => {
    const auth = requireAuth(req);
    const input = parse(locationInput, req.body);
    const [{ n } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(locations)
      .where(eq(locations.householdId, auth.household.id));
    const [l] = await ctx.db
      .insert(locations)
      .values({ ...input, icon: input.icon ?? null, householdId: auth.household.id, sortOrder: n })
      .returning();
    ctx.live.publish(auth.household.id, 'locations');
    return locationDto(l!);
  });

  app.patch<{ Params: { id: string } }>('/api/locations/:id', async (req) => {
    const auth = requireAuth(req);
    const input = parse(locationInput.partial(), req.body);
    if (input.type) {
      const [{ n } = { n: 0 }] = await ctx.db
        .select({ n: count() })
        .from(stockItems)
        .where(and(eq(stockItems.locationId, req.params.id), isNull(stockItems.finishedAt)));
      const [current] = await ctx.db.select().from(locations).where(eq(locations.id, req.params.id));
      if (n > 0 && current && current.type !== input.type) {
        throw badRequest('Empty this location before changing its type.');
      }
    }
    const [l] = await ctx.db
      .update(locations)
      .set(input)
      .where(and(eq(locations.id, req.params.id), eq(locations.householdId, auth.household.id)))
      .returning();
    if (!l) throw notFound();
    ctx.live.publish(auth.household.id, 'locations', 'stock');
    return locationDto(l);
  });

  app.delete<{ Params: { id: string } }>('/api/locations/:id', async (req) => {
    const auth = requireAuth(req);
    const [{ n } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(stockItems)
      .where(and(eq(stockItems.locationId, req.params.id), isNull(stockItems.finishedAt)));
    if (n > 0) throw conflict(`Move the ${n} item${n === 1 ? '' : 's'} out of here first.`);
    // Finished packs keep their history; point them at another location of the household.
    const others = await ctx.db
      .select()
      .from(locations)
      .where(eq(locations.householdId, auth.household.id))
      .orderBy(asc(locations.sortOrder));
    const fallback = others.find((l) => l.id !== req.params.id);
    if (!fallback) throw badRequest('You need at least one location.');
    await ctx.db.update(stockItems).set({ locationId: fallback.id }).where(eq(stockItems.locationId, req.params.id));
    await ctx.db.delete(locations).where(and(eq(locations.id, req.params.id), eq(locations.householdId, auth.household.id)));
    ctx.live.publish(auth.household.id, 'locations');
    return { ok: true };
  });

  // --- Shelf-life categories --------------------------------------------------------
  app.get('/api/shelf-life', async (req) => {
    const auth = requireAuth(req);
    const rows = await ctx.db
      .select()
      .from(shelfLifeCategories)
      .where(eq(shelfLifeCategories.householdId, auth.household.id))
      .orderBy(asc(shelfLifeCategories.name));
    return rows.map(categoryDto);
  });

  app.patch<{ Params: { id: string } }>('/api/shelf-life/:id', async (req) => {
    const auth = requireAuth(req);
    const input = parse(shelfLifeInput, req.body);
    const [c] = await ctx.db
      .update(shelfLifeCategories)
      .set(input)
      .where(and(eq(shelfLifeCategories.id, req.params.id), eq(shelfLifeCategories.householdId, auth.household.id)))
      .returning();
    if (!c) throw notFound();
    ctx.live.publish(auth.household.id, 'ingredients', 'stock');
    return categoryDto(c);
  });

  // --- Ingredients ------------------------------------------------------------------
  app.get<{ Querystring: { q?: string } }>('/api/ingredients', async (req) => {
    const auth = requireAuth(req);
    const catalog = await loadCatalog(ctx.db, auth.household.id);
    const q = req.query.q?.trim().toLowerCase();
    return [...catalog.ingredients.values()]
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => ingredientDto(i, catalog));
  });

  const ingredientValues = (input: Partial<IngredientInput>) => {
    const { shelfLife, ...rest } = input;
    return { ...rest, ...(shelfLife ?? {}) };
  };

  app.post('/api/ingredients', async (req) => {
    const auth = requireAuth(req);
    const input = parse(ingredientInput, req.body);
    const [i] = await ctx.db
      .insert(ingredients)
      .values({ ...ingredientValues(input), name: input.name, householdId: auth.household.id })
      .returning();
    ctx.live.publish(auth.household.id, 'ingredients');
    return ingredientDto(i!, await loadCatalog(ctx.db, auth.household.id));
  });

  app.patch<{ Params: { id: string } }>('/api/ingredients/:id', async (req) => {
    const auth = requireAuth(req);
    const input = parse(ingredientInput.partial(), req.body);
    const [i] = await ctx.db
      .update(ingredients)
      .set(ingredientValues(input))
      .where(and(eq(ingredients.id, req.params.id), eq(ingredients.householdId, auth.household.id)))
      .returning();
    if (!i) throw notFound();
    ctx.live.publish(auth.household.id, 'ingredients', 'stock');
    return ingredientDto(i, await loadCatalog(ctx.db, auth.household.id));
  });

  app.delete<{ Params: { id: string } }>('/api/ingredients/:id', async (req) => {
    const auth = requireAuth(req);
    await ctx.db.delete(ingredients).where(and(eq(ingredients.id, req.params.id), eq(ingredients.householdId, auth.household.id)));
    ctx.live.publish(auth.household.id, 'ingredients', 'products');
    return { ok: true };
  });

  // --- Products -----------------------------------------------------------------------
  app.get<{ Querystring: { q?: string; unnamed?: string } }>('/api/products', async (req) => {
    const auth = requireAuth(req);
    const q = req.query.q?.trim();
    const conditions = [eq(products.householdId, auth.household.id)];
    if (req.query.unnamed === '1') conditions.push(isNull(products.name));
    if (q) {
      const byCode = await ctx.db
        .select({ id: barcodes.productId })
        .from(barcodes)
        .where(and(eq(barcodes.householdId, auth.household.id), eq(barcodes.code, q)));
      const nameMatch = or(ilike(products.name, `%${q.replace(/[%_\\]/g, '\\$&')}%`), ilike(products.brand, `%${q.replace(/[%_\\]/g, '\\$&')}%`));
      conditions.push(byCode.length ? or(nameMatch, inArray(products.id, byCode.map((b) => b.id)))! : nameMatch!);
    }
    const rows = await ctx.db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(asc(products.name))
      .limit(200);
    const [catalog, codes, latest] = await Promise.all([
      loadCatalog(ctx.db, auth.household.id),
      barcodesFor(ctx.db, rows.map((r) => r.id)),
      pricingOn(ctx, auth.household) ? latestPrices(ctx.db, auth.household.id) : null,
    ]);
    return rows.map((p) => productDto(p, codes.get(p.id) ?? [], catalog, latest?.get(p.id)?.pricePence ?? null));
  });

  app.get<{ Params: { id: string } }>('/api/products/:id', async (req) => {
    const auth = requireAuth(req);
    const [p] = await ctx.db
      .select()
      .from(products)
      .where(and(eq(products.id, req.params.id), eq(products.householdId, auth.household.id)));
    if (!p) throw notFound('No such product.');
    const [catalog, codes, latest] = await Promise.all([
      loadCatalog(ctx.db, auth.household.id),
      barcodesFor(ctx.db, [p.id]),
      pricingOn(ctx, auth.household) ? latestPrices(ctx.db, auth.household.id) : null,
    ]);
    return productDto(p, codes.get(p.id) ?? [], catalog, latest?.get(p.id)?.pricePence ?? null);
  });

  async function saveBarcodes(householdId: string, productId: string, codes: string[] | undefined) {
    if (!codes) return;
    for (const code of codes) {
      const existing = await findProductByBarcode(ctx.db, householdId, code);
      if (existing && existing.id !== productId) throw conflict(`Barcode ${code} already belongs to ${existing.name ?? 'another product'}.`);
    }
    await ctx.db.delete(barcodes).where(eq(barcodes.productId, productId));
    if (codes.length) await ctx.db.insert(barcodes).values(codes.map((code) => ({ householdId, code, productId })));
  }

  app.post('/api/products', async (req) => {
    const auth = requireAuth(req);
    const input = parse(productInput, req.body);
    const catalog = await loadCatalog(ctx.db, auth.household.id);
    const pack = packFields(input.packAmount, input.packUnit, ctx.seed.units, measuresFor(input.ingredientId ?? null, catalog));
    const created = await ctx.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(products)
        .values({
          householdId: auth.household.id,
          name: input.name,
          brand: input.brand ?? null,
          imageUrl: input.imageUrl ?? null,
          ingredientId: input.ingredientId ?? null,
          shelfLifeCategoryId: input.shelfLifeCategoryId ?? null,
          nutritionPer100g: input.nutritionPer100g ?? null,
          source: 'manual',
          ...pack,
        })
        .returning();
      return p!;
    });
    await saveBarcodes(auth.household.id, created.id, input.barcodes);
    ctx.live.publish(auth.household.id, 'products');
    return productDto(created, input.barcodes ?? [], catalog);
  });

  app.patch<{ Params: { id: string } }>('/api/products/:id', async (req) => {
    const auth = requireAuth(req);
    const input = parse(updateProductInput, req.body);
    const [current] = await ctx.db
      .select()
      .from(products)
      .where(and(eq(products.id, req.params.id), eq(products.householdId, auth.household.id)));
    if (!current) throw notFound('No such product.');
    const catalog = await loadCatalog(ctx.db, auth.household.id);
    const { barcodes: codes, packAmount, packUnit, ...rest } = input;
    const patch: Partial<typeof products.$inferInsert> = { ...rest };
    const ingredientId = input.ingredientId !== undefined ? input.ingredientId : current.ingredientId;
    if (packAmount !== undefined || packUnit !== undefined || input.ingredientId !== undefined) {
      Object.assign(
        patch,
        packFields(
          packAmount !== undefined ? packAmount : current.packAmount,
          packUnit !== undefined ? packUnit : current.packUnit,
          ctx.seed.units,
          measuresFor(ingredientId ?? null, catalog),
        ),
      );
    }
    const [p] = await ctx.db.update(products).set(patch).where(eq(products.id, current.id)).returning();
    // Packs of unknown size learn their size once the product has one.
    if (patch.packGrams && !current.packGrams) {
      const packs = await ctx.db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.productId, current.id), isNull(stockItems.initialGrams)));
      for (const s of packs) {
        await ctx.db
          .update(stockItems)
          .set({ initialGrams: patch.packGrams, remainingGrams: Math.round(patch.packGrams * s.fractionLeft * 1000) / 1000 })
          .where(eq(stockItems.id, s.id));
      }
    }
    await saveBarcodes(auth.household.id, current.id, codes);
    const allCodes = await barcodesFor(ctx.db, [current.id]);
    ctx.live.publish(auth.household.id, 'products', 'stock');
    return productDto(p!, allCodes.get(current.id) ?? [], catalog);
  });

  /** Merge a duplicate into another product: its barcodes and stock move across. */
  app.post<{ Params: { id: string }; Body: { intoId?: string } }>('/api/products/:id/merge', async (req) => {
    const auth = requireAuth(req);
    const intoId = req.body?.intoId;
    if (!intoId || intoId === req.params.id) throw badRequest('Pick the product to merge into.');
    const both = await ctx.db
      .select()
      .from(products)
      .where(and(eq(products.householdId, auth.household.id), inArray(products.id, [req.params.id, intoId])));
    if (both.length !== 2) throw notFound('No such product.');
    await ctx.db.transaction(async (tx) => {
      await tx.update(barcodes).set({ productId: intoId }).where(eq(barcodes.productId, req.params.id));
      await tx.update(stockItems).set({ productId: intoId }).where(eq(stockItems.productId, req.params.id));
      await tx.update(stockEvents).set({ productId: intoId }).where(eq(stockEvents.productId, req.params.id));
      await tx.delete(products).where(eq(products.id, req.params.id));
    });
    ctx.live.publish(auth.household.id, 'products', 'stock');
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/products/:id', async (req) => {
    const auth = requireAuth(req);
    const [{ n } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(stockItems)
      .where(and(eq(stockItems.productId, req.params.id), isNull(stockItems.finishedAt)));
    if (n > 0) throw conflict('There is still some of this in stock. Use or bin it first.');
    await ctx.db.delete(products).where(and(eq(products.id, req.params.id), eq(products.householdId, auth.household.id)));
    ctx.live.publish(auth.household.id, 'products');
    return { ok: true };
  });
}
