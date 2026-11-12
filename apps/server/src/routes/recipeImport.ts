import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importRecipeInput, type RecipeDraftDto } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { parse } from '../http';
import { tidyRecipe } from '../services/ai';
import { loadCatalog } from '../services/catalog';
import { importRecipe } from '../services/recipeImport';

const draftLineSchema = z.object({
  text: z.string().max(300),
  amount: z.number().nullable(),
  unit: z.string().max(30).nullable(),
  ingredientId: z.string().nullable(),
  ingredientName: z.string().nullable(),
  productId: z.string().nullable(),
  note: z.string().max(200).nullable(),
  optional: z.boolean(),
  matchConfidence: z.enum(['high', 'low', 'none']),
});

const tidyInput = z.object({
  draft: z.object({
    title: z.string().max(200),
    serves: z.number().int().min(1).max(100),
    steps: z.array(z.string().max(4000)).max(100),
    imageUrl: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    tags: z.array(z.string().max(40)).max(30),
    prepMinutes: z.number().nullable(),
    cookMinutes: z.number().nullable(),
    ingredients: z.array(draftLineSchema).max(100),
  }),
});

export async function recipeImportRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Read a recipe from a web page (schema.org JSON-LD) into a draft for review. */
  app.post('/api/recipes/import', async (req): Promise<RecipeDraftDto> => {
    const auth = requireAuth(req);
    const { url } = parse(importRecipeInput, req.body);
    const catalog = await loadCatalog(ctx.db, auth.household.id);
    return importRecipe(url, catalog, ctx.seed, ctx.fetch);
  });

  /** Optional AI clean-up of a draft (only when AI_API_KEY is set). */
  app.post('/api/recipes/tidy', async (req): Promise<RecipeDraftDto> => {
    const auth = requireAuth(req);
    const { draft } = parse(tidyInput, req.body);
    const catalog = await loadCatalog(ctx.db, auth.household.id);
    return tidyRecipe(ctx.config, draft, catalog, ctx.fetch);
  });
}
