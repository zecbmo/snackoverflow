/**
 * Optional AI clean-up for imported recipes. Only runs when someone taps it, and
 * only when AI_API_KEY is set (the feature is hidden otherwise). The model tidies
 * the title, steps and tags and matches each ingredient line to the household's
 * ingredients; everything it returns is checked before use.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { FOOD_GROUPS, ingredientInput, type Nutrition, type RecipeDraftDto, type UnmatchedGroupDto, type UnmatchedSuggestionDto } from '@snackoverflow/shared';
import type { Config } from '../config';
import { badRequest, HttpError } from '../http';
import type { Catalog } from './catalog';

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';
export const NOT_SET_UP = "AI clean-up isn't set up on this server.";

const UNITS = ['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup_metric', 'count', 'pinch'] as const;

/** What the model must return. Kept loose where the model may be unsure; we validate again after. */
const TidiedRecipe = z.object({
  title: z.string(),
  serves: z.number(),
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
type Tidied = z.infer<typeof TidiedRecipe>;

const SYSTEM = [
  'You tidy up recipes imported from web pages for a household food app in the UK.',
  'Return the recipe with: a clean title; the number of servings; clear, numbered-free cooking steps (one action per step, no ads or chatter); up to 8 short lowercase tags.',
  'For each ingredient line keep the original wording in "text" (lightly cleaned), and fill amount, unit and note ("finely chopped", "peeled").',
  'Units: use g, kg, ml, l, tsp, tbsp, cup_metric, pinch, or count for things counted (2 onions, 3 cloves garlic, 1 tin). Convert US cups to cup_metric only if the recipe is clearly British; otherwise keep the amount and use cup_metric.',
  'Match each line to exactly one ingredient id from the household list when it is clearly that ingredient (e.g. "2 large Maris Pipers" is Potatoes); otherwise use null. Never invent ids.',
  'Mark "optional" true only when the recipe says so. Keep the same order of ingredient lines.',
].join('\n');

function fallbackLine(l: RecipeDraftDto['ingredients'][number]) {
  return l;
}

/** Merge the model's answer onto the draft, keeping the original wherever the answer is unusable. */
export function applyTidy(draft: RecipeDraftDto, tidied: Tidied, catalog: Catalog): RecipeDraftDto {
  const lines = tidied.ingredients.length === draft.ingredients.length ? tidied.ingredients : null;
  return {
    ...draft,
    title: tidied.title.trim() || draft.title,
    serves: Number.isInteger(tidied.serves) && tidied.serves >= 1 && tidied.serves <= 100 ? tidied.serves : draft.serves,
    steps: tidied.steps.map((s) => s.trim()).filter(Boolean).length ? tidied.steps.map((s) => s.trim()).filter(Boolean) : draft.steps,
    tags: [...new Set(tidied.tags.map((t) => t.trim().toLowerCase()).filter((t) => t && t.length <= 40))].slice(0, 10),
    ingredients: draft.ingredients.map((orig, i) => {
      const t = lines?.[i];
      if (!t) return fallbackLine(orig);
      const ingredient = t.ingredientId ? catalog.ingredients.get(t.ingredientId) : undefined;
      const amount = t.amount !== null && Number.isFinite(t.amount) && t.amount > 0 && t.amount <= 100_000 ? t.amount : null;
      return {
        text: t.text.trim() || orig.text,
        amount,
        unit: amount === null ? null : t.unit,
        // An id that isn't one of ours is dropped: keep our own match instead.
        ingredientId: ingredient ? ingredient.id : orig.ingredientId,
        ingredientName: ingredient ? ingredient.name : orig.ingredientName,
        productId: orig.productId,
        note: t.note?.trim() || null,
        optional: t.optional,
        matchConfidence: ingredient ? 'high' : orig.matchConfidence,
      };
    }),
  };
}

export async function tidyRecipe(config: Config, draft: RecipeDraftDto, catalog: Catalog, f?: typeof fetch): Promise<RecipeDraftDto> {
  if (!config.AI_API_KEY) throw badRequest(NOT_SET_UP);
  if (config.AI_PROVIDER !== 'anthropic') throw badRequest(`AI provider "${config.AI_PROVIDER}" isn't supported. Use anthropic.`);
  const client = new Anthropic({ apiKey: config.AI_API_KEY, timeout: 120_000, maxRetries: 1, ...(f ? { fetch: f } : {}) });
  const ingredientList = [...catalog.ingredients.values()].map((i) => ({ id: i.id, name: i.name }));
  const input = {
    title: draft.title,
    serves: draft.serves,
    steps: draft.steps,
    tags: draft.tags,
    ingredientLines: draft.ingredients.map((l) => l.text),
  };
  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.AI_MODEL ?? DEFAULT_AI_MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(TidiedRecipe) },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Household ingredients (id and name):\n${JSON.stringify(ingredientList)}\n\nImported recipe:\n${JSON.stringify(input)}`,
        },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI key was rejected. Check AI_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(502, 'The AI service is busy. Try again in a minute.');
    throw new HttpError(502, "Couldn't reach the AI service. The recipe is unchanged; try again later.");
  }
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new HttpError(502, "The AI couldn't tidy this recipe. You can still edit it by hand.");
  }
  return applyTidy(draft, response.parsed_output, catalog);
}

// --- Unmatched recipe lines -----------------------------------------------------------

/** Typical nutrition per 100g, as the model gives it. */
export const Per100g = z
  .object({
    kcal: z.number(),
    protein: z.number(),
    carbs: z.number(),
    sugars: z.number(),
    fat: z.number(),
    saturates: z.number(),
    fibre: z.number(),
    salt: z.number(),
  })
  .nullable();

const UnmatchedAnswer = z.object({
  suggestions: z.array(
    z.object({
      key: z.string(),
      action: z.enum(['link', 'create', 'ignore']),
      ingredientId: z.string().nullable(),
      newIngredient: z
        .object({
          name: z.string(),
          foodGroup: z.enum(FOOD_GROUPS).nullable(),
          shelfLifeCategoryId: z.string().nullable(),
          aisle: z.string().nullable(),
          gramsPerCount: z.number().nullable(),
          countUnit: z.string().nullable(),
          trackRunningLow: z.boolean(),
          nutritionPer100g: Per100g,
        })
        .nullable(),
      gramsPerCount: z.number().nullable(),
      nutritionPer100g: Per100g,
      reason: z.string(),
    }),
  ),
});
type UnmatchedAnswerT = z.infer<typeof UnmatchedAnswer>;

const UNMATCHED_SYSTEM = [
  'You fix recipe ingredient lines in a UK household food app so they can be checked against stock and put on the shopping list.',
  'Each group is lines from the household\'s recipes naming the same food. For each group return one suggestion with its key:',
  '- problem "unlinked": "link" to an existing ingredient id when it is clearly that food (a cut, brand or variety of it counts: "21 Day Aged British Rump Steaks" is not Beef mince, but "lean minced beef" is), else "create" a new generic ingredient.',
  '  New ingredients get a short generic UK name ("Rump steak", "Curry powder"), a food group, the closest shelf-life category id, a shop aisle, and for counted things the grams per item and its name ("sachet", "steak").',
  '  Set trackRunningLow true for cupboard staples used a little at a time (spices, dried herbs, oils, stock cubes).',
  '- problem "noWeight": the lines count the food ("1 sachet") but the ingredient has no weight per item. "link" to the same ingredient id with gramsPerCount: a typical UK weight for one (a spice sachet about 10g, a rump steak about 225g).',
  '- problem "noNutrition": "link" to the same ingredient id with nutritionPer100g: typical UK values per 100g as sold (raw for meat and veg), from food labels or McCance and Widdowson.',
  'New ingredients also get nutritionPer100g. Values: kcal, and grams of protein, carbs, sugars, fat, saturates, fibre and salt.',
  '- "ignore" only for things never bought or stocked: water, ice, "salt and pepper to taste" when it names two foods, serving suggestions.',
  'Only use ids from the lists given; never invent ids. Keep "reason" to a few words.',
].join('\n');

/** Nutrition per 100g that adds up: nothing negative, no more than 100g of anything, at most 900 kcal. */
export function checkNutrition(n: z.infer<typeof Per100g> | undefined): Nutrition | null {
  if (!n) return null;
  const grams = [n.protein, n.carbs, n.sugars, n.fat, n.saturates, n.fibre, n.salt];
  if (!Number.isFinite(n.kcal) || n.kcal < 0 || n.kcal > 900 || grams.some((g) => !Number.isFinite(g) || g < 0 || g > 100)) return null;
  if (n.sugars > n.carbs + 0.5 || n.saturates > n.fat + 0.5 || n.protein + n.carbs + n.fat > 101) return null;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { kcal: Math.round(n.kcal), protein: r(n.protein), carbs: r(n.carbs), sugars: r(n.sugars), fat: r(n.fat), saturates: r(n.saturates), fibre: r(n.fibre), salt: r(n.salt) };
}

/** Check the model's suggestions against the groups and catalogue; anything unusable is dropped. */
export function checkUnmatchedSuggestions(answer: UnmatchedAnswerT, groups: UnmatchedGroupDto[], catalog: Catalog): UnmatchedSuggestionDto[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const out: UnmatchedSuggestionDto[] = [];
  const weight = (n: number | null) => (n !== null && Number.isFinite(n) && n > 0 && n <= 100_000 ? Math.round(n * 10) / 10 : null);
  for (const s of answer.suggestions) {
    const g = byKey.get(s.key);
    if (!g || out.some((o) => o.key === s.key)) continue;
    const base = { key: s.key, reason: s.reason.trim().slice(0, 200), ingredientId: null, ingredientName: null, newIngredient: null, gramsPerCount: null, nutritionPer100g: null };
    if (s.action === 'ignore') {
      out.push({ ...base, action: 'ignore' });
    } else if (s.action === 'link') {
      const ing = s.ingredientId ? catalog.ingredients.get(s.ingredientId) : undefined;
      if (!ing) continue;
      // A counted food needs a weight per item; keep the one it has unless the model gives one.
      const gramsPerCount = weight(s.gramsPerCount);
      const nutrition = checkNutrition(s.nutritionPer100g);
      if (g.problem === 'noWeight' && (ing.id !== g.ingredientId || !gramsPerCount)) continue;
      if (g.problem === 'noNutrition' && (ing.id !== g.ingredientId || !nutrition)) continue;
      out.push({
        ...base,
        action: 'link',
        ingredientId: ing.id,
        ingredientName: ing.name,
        gramsPerCount: ing.gramsPerCount ? null : gramsPerCount,
        nutritionPer100g: ing.nutritionPer100g?.kcal != null ? null : nutrition,
      });
    } else if (s.newIngredient && g.problem === 'unlinked') {
      const n = s.newIngredient;
      const parsed = ingredientInput.safeParse({
        name: n.name,
        foodGroup: n.foodGroup,
        shelfLifeCategoryId: n.shelfLifeCategoryId && catalog.categories.has(n.shelfLifeCategoryId) ? n.shelfLifeCategoryId : null,
        aisle: n.aisle?.trim().slice(0, 60) || null,
        gramsPerCount: weight(n.gramsPerCount),
        countUnit: n.countUnit?.trim().slice(0, 30) || null,
        trackRunningLow: n.trackRunningLow,
        nutritionPer100g: checkNutrition(n.nutritionPer100g),
      });
      if (!parsed.success) continue;
      out.push({ ...base, action: 'create', newIngredient: parsed.data });
    }
  }
  return out;
}

/** Ask the model how to fix unmatched recipe lines. Nothing is changed: the household reviews and applies. */
export async function suggestUnmatchedFixes(config: Config, groups: UnmatchedGroupDto[], catalog: Catalog, f?: typeof fetch): Promise<UnmatchedSuggestionDto[]> {
  if (!config.AI_API_KEY) throw badRequest(NOT_SET_UP);
  if (!groups.length) return [];
  const client = new Anthropic({ apiKey: config.AI_API_KEY, timeout: 120_000, maxRetries: 1, ...(f ? { fetch: f } : {}) });
  const input = {
    groups: groups.map((g) => ({ key: g.key, problem: g.problem, ingredientId: g.ingredientId, ingredientName: g.ingredientName, lines: g.lines.slice(0, 5).map((l) => l.text) })),
    ingredients: [...catalog.ingredients.values()].map((i) => ({ id: i.id, name: i.name, foodGroup: i.foodGroup })),
    shelfLifeCategories: [...catalog.categories.values()].map((c) => ({ id: c.id, name: c.name, examples: c.examples })),
  };
  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.AI_MODEL ?? DEFAULT_AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(UnmatchedAnswer) },
      system: UNMATCHED_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI key was rejected. Check AI_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(502, 'The AI service is busy. Try again in a minute.');
    throw new HttpError(502, "Couldn't reach the AI service. Nothing was changed; try again later.");
  }
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new HttpError(502, "The AI couldn't suggest fixes. You can still fix these by hand.");
  return checkUnmatchedSuggestions(response.parsed_output, groups, catalog);
}

// --- Receipts -----------------------------------------------------------------------

const ReadReceipt = z.object({
  store: z.string().nullable(),
  /** YYYY-MM-DD */
  date: z.string().nullable(),
  lines: z.array(
    z.object({
      text: z.string(),
      quantity: z.number(),
      /** Line total in pence. */
      pricePence: z.number().nullable(),
    }),
  ),
});

const RECEIPT_SYSTEM = [
  'You read UK supermarket receipts and online grocery order confirmations for a household food app.',
  'Return the store name, the date of purchase (YYYY-MM-DD) if shown, and one entry per item bought.',
  'For each item keep the wording as printed in "text" (include the pack size if printed), the quantity bought, and the line total in pence.',
  'Leave out totals, subtotals, payment lines, change, loyalty points, savings and discount lines. Keep non-food items (bags, toiletries) as printed: the app skips them itself.',
  'If a line shows a multibuy like "2 @ 1.25", quantity is 2 and the line total is 250.',
].join('\n');

/** Read a photo or PDF of a receipt into lines. Only used when AI_API_KEY is set. */
export async function readReceiptWithAi(config: Config, file: Buffer, fileType: string, f?: typeof fetch) {
  if (!config.AI_API_KEY) throw badRequest(NOT_SET_UP);
  const client = new Anthropic({ apiKey: config.AI_API_KEY, timeout: 120_000, maxRetries: 1, ...(f ? { fetch: f } : {}) });
  const data = file.toString('base64');
  const media =
    fileType === 'application/pdf'
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: fileType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data } };
  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.AI_MODEL ?? DEFAULT_AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(ReadReceipt) },
      system: RECEIPT_SYSTEM,
      messages: [{ role: 'user', content: [media, { type: 'text', text: 'Read this receipt.' }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('The AI key was rejected. Check AI_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('The AI service is busy. Try again in a minute.');
    throw new Error("Couldn't reach the AI service. Try again later, or type the receipt in.");
  }
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error("The AI couldn't read this receipt. Try a clearer photo, or type it in.");
  const out = response.parsed_output;
  const date = out.date && /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? out.date : null;
  return {
    store: out.store?.trim().slice(0, 80) || null,
    date,
    lines: out.lines
      .filter((l) => l.text.trim())
      .slice(0, 300)
      .map((l) => ({
        text: l.text.trim().slice(0, 200),
        quantity: Math.min(99, Math.max(1, Math.round(l.quantity) || 1)),
        pricePence: l.pricePence !== null && Number.isFinite(l.pricePence) && l.pricePence >= 0 ? Math.round(l.pricePence) : null,
      })),
  };
}

/** Read the text of an online-order email into lines, when the plain parser finds nothing. */
export async function readReceiptTextWithAi(config: Config, text: string, f?: typeof fetch) {
  if (!config.AI_API_KEY) throw badRequest(NOT_SET_UP);
  const client = new Anthropic({ apiKey: config.AI_API_KEY, timeout: 120_000, maxRetries: 1, ...(f ? { fetch: f } : {}) });
  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.AI_MODEL ?? DEFAULT_AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(ReadReceipt) },
      system: RECEIPT_SYSTEM,
      messages: [{ role: 'user', content: `Read this order confirmation email.\n\n${text.slice(0, 60_000)}` }],
    });
  } catch {
    throw new Error("Couldn't reach the AI service to read that email.");
  }
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error("The AI couldn't read that email.");
  const out = response.parsed_output;
  return {
    store: out.store?.trim().slice(0, 80) || null,
    date: out.date && /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? out.date : null,
    lines: out.lines
      .filter((l) => l.text.trim())
      .slice(0, 300)
      .map((l) => ({
        text: l.text.trim().slice(0, 200),
        quantity: Math.min(99, Math.max(1, Math.round(l.quantity) || 1)),
        pricePence: l.pricePence !== null && Number.isFinite(l.pricePence) && l.pricePence >= 0 ? Math.round(l.pricePence) : null,
      })),
  };
}

// --- Settings ---------------------------------------------------------------------------

/** Check a key works with a model, without spending anything (looks the model up). */
export async function testAiKey(apiKey: string, model: string, f?: typeof fetch): Promise<void> {
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 0, ...(f ? { fetch: f } : {}) });
  try {
    await client.models.retrieve(model);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw badRequest('That key was rejected. Check you copied all of it.');
    if (e instanceof Anthropic.PermissionDeniedError) throw badRequest("That key can't use the API. Check its workspace in the Claude Console.");
    if (e instanceof Anthropic.NotFoundError) throw badRequest(`The key works, but there's no model called "${model}".`);
    throw new HttpError(502, "Couldn't reach the AI service to check the key. Try again later.");
  }
}
