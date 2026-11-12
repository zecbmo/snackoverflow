/**
 * Optional AI clean-up for imported recipes. Only runs when someone taps it, and
 * only when AI_API_KEY is set (the feature is hidden otherwise). The model tidies
 * the title, steps and tags and matches each ingredient line to the household's
 * ingredients; everything it returns is checked before use.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { RecipeDraftDto } from '@snackoverflow/shared';
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
