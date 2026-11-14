/**
 * AI jobs around the kitchen, each run only when someone taps it and only with an AI key:
 * reading a product from photos of its pack, reading recipes from photos, making up a recipe
 * that uses food going off, and planning a week. Everything the model returns is checked
 * against the household's own data before use (swap groups too), and nothing is saved without the household
 * (or, for recipe photos, the "read them all" button) asking for it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { CalendarDate, ProductPhotoReadDto, RecipeDraftDto, SwapGroupDto, SwapGroupSuggestionDto } from '@snackoverflow/shared';
import type { Config } from '../config';
import { badRequest, HttpError } from '../http';
import { checkNutrition, DEFAULT_AI_MODEL, NOT_SET_UP, Per100g } from './ai';
import type { Catalog } from './catalog';
import type { WeekPickDto } from './optimiser';

export type Photo = { data: Buffer; type: string };
type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
const IMAGE_TYPES: ImageType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** One structured request to the model, with friendly errors. */
async function ask<S extends z.ZodType>(
  config: Config,
  f: typeof fetch | undefined,
  schema: S,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[] | string,
  opts: { what: string; effort?: 'low' | 'medium' | 'high' },
): Promise<z.infer<S>> {
  if (!config.AI_API_KEY) throw badRequest(NOT_SET_UP);
  const client = new Anthropic({ apiKey: config.AI_API_KEY, timeout: 180_000, maxRetries: 1, ...(f ? { fetch: f } : {}) });
  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.AI_MODEL ?? DEFAULT_AI_MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: opts.effort ?? 'low', format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI key was rejected. Check it in Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(502, 'The AI service is busy. Try again in a minute.');
    throw new HttpError(502, `Couldn't reach the AI service to ${opts.what}. Try again later.`);
  }
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new HttpError(502, `The AI couldn't ${opts.what}.`);
  return response.parsed_output as z.infer<S>;
}

const imageBlocks = (photos: Photo[]): Anthropic.Beta.BetaContentBlockParam[] =>
  photos.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.type as ImageType, data: p.data.toString('base64') } }));

export function checkPhotos(photos: Photo[]): void {
  if (!photos.length) throw badRequest('Add a photo.');
  for (const p of photos) {
    if (!IMAGE_TYPES.includes(p.type as ImageType)) throw badRequest('Use a photo (JPEG, PNG or WebP).');
    if (!p.data.length) throw badRequest('That photo is empty.');
    if (p.data.length > 8 * 1024 * 1024) throw badRequest('That photo is too big. Try a smaller one.');
  }
}

const ingredientList = (catalog: Catalog) => [...catalog.ingredients.values()].map((i) => ({ id: i.id, name: i.name }));

// --- A product from photos of its pack ---------------------------------------------------

const ProductOut = z.object({
  readable: z.boolean(),
  name: z.string(),
  brand: z.string().nullable(),
  packAmount: z.number().nullable(),
  packUnit: z.enum(['g', 'kg', 'ml', 'l', 'count']).nullable(),
  ingredientId: z.string().nullable(),
  nutritionPer100g: Per100g,
});

const PRODUCT_SYSTEM = [
  'You read photos of a food product\'s packaging for a UK household food app, to fill in a product its barcode scanner did not recognise.',
  'Return: "name" as a shopper would say it, without the brand ("Greek Style Natural Yogurt"); the brand; the pack size as printed (amount and unit: g, kg, ml, l, or count for things like 6 eggs).',
  'Match it to one ingredient id from the household list when it clearly is that food (Maris Piper potatoes are Potatoes), else null. Chocolate bars, crisps and ready meals usually match nothing.',
  'Copy nutrition per 100g from the label when it is visible (per 100ml for drinks), else null. Never guess label values you cannot see.',
  'Set "readable" false when the photos do not show a food product clearly enough to name it.',
].join('\n');

export async function readProductPhotos(config: Config, photos: Photo[], catalog: Catalog, f?: typeof fetch): Promise<ProductPhotoReadDto> {
  checkPhotos(photos);
  const out = await ask(
    config,
    f,
    ProductOut,
    PRODUCT_SYSTEM,
    [...imageBlocks(photos), { type: 'text', text: `Household ingredients (id and name):\n${JSON.stringify(ingredientList(catalog))}` }],
    { what: 'read that pack' },
  );
  if (!out.readable || !out.name.trim()) throw badRequest("Couldn't make out the product. Try a photo of the front of the pack, in good light.");
  const ing = out.ingredientId ? catalog.ingredients.get(out.ingredientId) : undefined;
  const amount = out.packAmount !== null && Number.isFinite(out.packAmount) && out.packAmount > 0 && out.packAmount <= 1_000_000 ? out.packAmount : null;
  return {
    name: out.name.trim().slice(0, 120),
    brand: out.brand?.trim().slice(0, 120) || null,
    packAmount: amount,
    packUnit: amount === null ? null : out.packUnit,
    ingredientId: ing?.id ?? null,
    ingredientName: ing?.name ?? null,
    nutritionPer100g: checkNutrition(out.nutritionPer100g ?? undefined),
  };
}

// --- Recipes: from photos, or made up to use food going off -------------------------------

const UNITS = ['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup_metric', 'count', 'pinch'] as const;

const RecipeOut = z.object({
  readable: z.boolean(),
  title: z.string(),
  serves: z.number(),
  prepMinutes: z.number().nullable(),
  cookMinutes: z.number().nullable(),
  steps: z.array(z.string()),
  tags: z.array(z.string()),
  ingredients: z.array(
    z.object({
      text: z.string(),
      amount: z.number().nullable(),
      unit: z.enum(UNITS).nullable(),
      ingredientId: z.string().nullable(),
      note: z.string().nullable(),
      optional: z.boolean(),
    }),
  ),
});
type RecipeOutT = z.infer<typeof RecipeOut>;

const LINES_RULES = [
  'For each ingredient line give the wording in "text" ("2 large Maris Pipers, peeled"), the amount, the unit (g, kg, ml, l, tsp, tbsp, cup_metric, pinch, or count for counted things like 2 onions or 1 sachet) and any note ("peeled").',
  'Match each line to one ingredient id from the household list when it clearly is that food; otherwise null. Never invent ids.',
  'Steps: one action per step, without numbers. Tags: up to 8 short lowercase tags, including breakfast, lunch or dinner when it is obviously one.',
].join('\n');

/** The model's recipe as a draft, keeping only what checks out. */
export function recipeDraftFrom(out: RecipeOutT, catalog: Catalog): RecipeDraftDto {
  const mins = (n: number | null) => (n !== null && Number.isInteger(Math.round(n)) && n >= 0 && n <= 2000 ? Math.round(n) : null);
  return {
    title: out.title.trim().slice(0, 200) || 'Untitled recipe',
    serves: Number.isFinite(out.serves) && out.serves >= 1 && out.serves <= 100 ? Math.round(out.serves) : 2,
    steps: out.steps.map((s) => s.trim()).filter(Boolean).slice(0, 100),
    imageUrl: null,
    sourceUrl: null,
    tags: [...new Set(out.tags.map((t) => t.trim().toLowerCase()).filter((t) => t && t.length <= 40))].slice(0, 10),
    prepMinutes: mins(out.prepMinutes),
    cookMinutes: mins(out.cookMinutes),
    ingredients: out.ingredients
      .filter((l) => l.text.trim())
      .slice(0, 100)
      .map((l) => {
        const ing = l.ingredientId ? catalog.ingredients.get(l.ingredientId) : undefined;
        const amount = l.amount !== null && Number.isFinite(l.amount) && l.amount > 0 && l.amount <= 100_000 ? l.amount : null;
        return {
          text: l.text.trim().slice(0, 300),
          amount,
          unit: amount === null ? null : l.unit,
          ingredientId: ing?.id ?? null,
          ingredientName: ing?.name ?? null,
          productId: null,
          note: l.note?.trim().slice(0, 200) || null,
          optional: l.optional,
          matchConfidence: ing ? ('high' as const) : ('none' as const),
        };
      }),
  };
}

const PHOTO_RECIPE_SYSTEM = [
  'You read photos of a recipe (a cookbook page, a magazine, or both sides of a recipe-kit card) for a UK household food app.',
  'All the photos are the same recipe. Return its title, how many it serves, prep and cook minutes if shown, every ingredient line and every step, as written.',
  'Recipe-kit cards often list amounts for 2 and 4 people: use the smallest.',
  LINES_RULES,
  'Set "readable" false when the photos do not show a recipe clearly enough to read.',
].join('\n');

export async function readRecipePhotos(config: Config, photos: Photo[], catalog: Catalog, f?: typeof fetch): Promise<RecipeDraftDto> {
  checkPhotos(photos);
  const out = await ask(
    config,
    f,
    RecipeOut,
    PHOTO_RECIPE_SYSTEM,
    [...imageBlocks(photos), { type: 'text', text: `Household ingredients (id and name):\n${JSON.stringify(ingredientList(catalog))}` }],
    { what: 'read that recipe' },
  );
  if (!out.readable || !out.ingredients.length) throw new Error("Couldn't read a recipe in these photos. Try clearer photos of the ingredients and the method.");
  return recipeDraftFrom(out, catalog);
}

export interface UseItUpFood {
  name: string;
  ingredientId: string;
  amount: string;
  bestBefore: CalendarDate | null;
}

const USE_IT_UP_SYSTEM = [
  'You make up a recipe for a UK household that uses food they have before it goes off.',
  'Build the recipe around the food going off soonest. Use other food they have where it fits; keep anything they would need to buy to a few everyday items.',
  'A sensible home recipe: realistic amounts for the servings, clear steps, normal UK ingredients and measures.',
  LINES_RULES,
  'Set "readable" true.',
].join('\n');

export async function useItUpRecipe(
  config: Config,
  input: { goingOff: UseItUpFood[]; alsoHave: string[]; serves: number; request: string | null; today: CalendarDate },
  catalog: Catalog,
  f?: typeof fetch,
): Promise<RecipeDraftDto> {
  if (!input.goingOff.length) throw badRequest("Nothing's going off soon, so there's nothing to use up.");
  const out = await ask(
    config,
    f,
    RecipeOut,
    USE_IT_UP_SYSTEM,
    JSON.stringify({
      today: input.today,
      serves: input.serves,
      goingOff: input.goingOff,
      alsoHave: input.alsoHave,
      wishes: input.request,
      householdIngredients: ingredientList(catalog),
    }),
    { what: 'make up a recipe', effort: 'medium' },
  );
  const draft = recipeDraftFrom(out, catalog);
  if (!draft.ingredients.length) throw new HttpError(502, "The AI couldn't make up a recipe. Try again.");
  return { ...draft, tags: [...new Set([...draft.tags, 'use it up'])] };
}

// --- Planning a week ----------------------------------------------------------------------

export interface WeekContext {
  today: CalendarDate;
  slots: { date: CalendarDate; slot: string }[];
  recipes: { id: string; title: string; tags: string[]; kcalPerServing: number | null; cookNow: boolean; missing: string[]; usesGoingOff: string[]; recentlyHad: boolean }[];
  leftovers: { id: string; title: string; portions: number; frozen: boolean; bestBefore: CalendarDate | null }[];
  goingOff: { name: string; amount: string; bestBefore: CalendarDate | null }[];
  people: { name: string; kcalTarget: number | null }[];
  request: string | null;
}

const WeekOut = z.object({
  picks: z.array(z.object({ date: z.string(), slot: z.string(), kind: z.enum(['recipe', 'stock']), id: z.string(), reason: z.string() })),
});

const WEEK_SYSTEM = [
  'You plan meals for a UK household from their own saved recipes, to use food before it goes off and keep shopping small.',
  'Fill the empty slots you are given (date and slot) with one pick each: a recipe id (kind "recipe") or a leftover or freezer portion id (kind "stock").',
  'Priorities, in order: what the household asked for; leftovers before their best-before; recipes that use food going off soonest, on or before its date; recipes they can cook now; variety (no recipe twice, avoid ones recently had); calories near each person\'s daily target.',
  'Leave a slot out rather than make a poor pick. Each "reason" is one short friendly sentence, e.g. "Uses the spinach going off Thursday."',
].join('\n');

/** Ask the model for a week's picks, then keep only ones that fit the empty slots and are the household's own. */
export async function planWeekWithAi(config: Config, ctx: WeekContext, missingOf: (recipeId: string) => string[], f?: typeof fetch): Promise<WeekPickDto[]> {
  if (!ctx.slots.length) return [];
  const out = await ask(config, f, WeekOut, WEEK_SYSTEM, JSON.stringify(ctx), { what: 'plan your week', effort: 'medium' });
  const open = new Set(ctx.slots.map((s) => `${s.date}|${s.slot}`));
  const recipes = new Map(ctx.recipes.map((r) => [r.id, r]));
  const leftovers = new Map(ctx.leftovers.map((l) => [l.id, l]));
  const usedRecipes = new Set<string>();
  const picks: WeekPickDto[] = [];
  for (const p of out.picks) {
    const slotKey = `${p.date}|${p.slot}`;
    if (!open.has(slotKey)) continue;
    const reason = p.reason.trim().slice(0, 200);
    if (p.kind === 'recipe') {
      const r = recipes.get(p.id);
      if (!r || usedRecipes.has(r.id)) continue;
      usedRecipes.add(r.id);
      picks.push({ date: p.date, slot: p.slot, kind: 'recipe', recipeId: r.id, stockItemId: null, title: r.title, reason, missing: missingOf(r.id), alternatives: [] });
    } else {
      const l = leftovers.get(p.id);
      if (!l) continue;
      // Each portion once: a pot of 2 portions can fill 2 slots.
      if (picks.filter((x) => x.stockItemId === l.id).length >= Math.max(1, Math.floor(l.portions))) continue;
      picks.push({ date: p.date, slot: p.slot, kind: 'stock', recipeId: null, stockItemId: l.id, title: l.title, reason, missing: [], alternatives: [] });
    }
    open.delete(slotKey);
  }
  return picks.sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
}


// --- Swap groups --------------------------------------------------------------------------

const SwapGroupsOut = z.object({
  groups: z.array(z.object({ existingGroupId: z.string().nullable(), name: z.string(), ingredientIds: z.array(z.string()), reason: z.string() })),
});

const SWAP_SYSTEM = [
  'You set up swap groups for a UK household food app. A swap group is foods a home cook would happily use instead of each other in most recipes, weight for weight:',
  'varieties, cuts and forms of the same thing (broccoli and tenderstem broccoli; chicken breasts and chicken thighs; cheddar and red leicester; onions and shallots; spinach and baby spinach; caster and granulated sugar; stock cubes and stock paste).',
  'Do not group foods just for being the same kind (chicken and pork, carrots and peas): the app already offers those as looser swaps.',
  'Each ingredient goes in one group at most. Add to an existing group (its existingGroupId) rather than making a second one for the same food. New groups need at least two foods.',
  'Group names are short and plain ("Broccoli", "Chicken", "Hard cheese"). Only use ingredient ids from the list; never invent ids. Leave out anything with no good partner. "reason" is a few words.',
].join('\n');

/** Check the model's groups: real ids, one group per food, new groups of two or more. */
export function checkSwapGroupSuggestions(out: z.infer<typeof SwapGroupsOut>, catalog: Catalog, existing: SwapGroupDto[]): SwapGroupSuggestionDto[] {
  const groupOf = new Map(existing.flatMap((g) => g.ingredients.map((i) => [i.id, g.id] as const)));
  const used = new Set<string>();
  const result: SwapGroupSuggestionDto[] = [];
  for (const g of out.groups) {
    const name = g.name.trim().slice(0, 60);
    const target = (g.existingGroupId && existing.find((e) => e.id === g.existingGroupId)) || existing.find((e) => e.name.trim().toLowerCase() === name.toLowerCase());
    const ids = [...new Set(g.ingredientIds)].filter((id) => {
      if (!catalog.ingredients.has(id) || used.has(id)) return false;
      const current = groupOf.get(id);
      // Already in this group: nothing to add. In another group: leave it there.
      return current === undefined;
    });
    if (target ? ids.length < 1 : ids.length < 2 || !name) continue;
    ids.forEach((id) => used.add(id));
    result.push({
      groupId: target?.id ?? null,
      name: target?.name ?? name,
      ingredients: ids.map((id) => ({ id, name: catalog.ingredients.get(id)!.name })),
      reason: g.reason.trim().slice(0, 200),
    });
  }
  return result;
}

/** Ask the model which of the household's foods can stand in for each other. Nothing is saved. */
export async function suggestSwapGroups(config: Config, catalog: Catalog, existing: SwapGroupDto[], f?: typeof fetch): Promise<SwapGroupSuggestionDto[]> {
  const input = {
    ingredients: [...catalog.ingredients.values()].map((i) => ({ id: i.id, name: i.name, category: i.foodGroup })),
    existingGroups: existing.map((g) => ({ id: g.id, name: g.name, ingredientIds: g.ingredients.map((i) => i.id) })),
  };
  const out = await ask(config, f, SwapGroupsOut, SWAP_SYSTEM, JSON.stringify(input), { what: 'suggest swap groups' });
  return checkSwapGroupSuggestions(out, catalog, existing);
}
