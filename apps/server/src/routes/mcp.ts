/**
 * MCP endpoint so Claude (or another assistant) can add and fix recipes (and unmatched recipe lines) directly,
 * e.g. from a photo of a recipe card, doing the clean-up with the user's own
 * assistant, so no API key is needed here. A minimal stateless Streamable HTTP
 * server: JSON-RPC 2.0 over POST /mcp, answered as application/json.
 * Off unless MCP_TOKEN is set; assistants send it as a Bearer token.
 */
import { timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FOOD_GROUPS, type RecipeInput, recipeInput, receiptLinesInput, swapGroupsSaveInput, unmatchedFixInput, unmatchedIgnoreInput } from '@snackoverflow/shared';
import type { Auth } from '../context';
import { receipts, users } from '../db/schema';
import { HttpError } from '../http';
import { completeRecipeLines, draftLines, getRecipe, listRecipes, saveRecipe } from '../services/recipes';
import { loadCatalog } from '../services/catalog';
import { theHousehold } from '../services/household';
import { getReceipt, receiptFromText, setReceiptLines } from '../services/receipts';
import { applyUnmatchedFixes, listUnmatched, setUnmatchedIgnored } from '../services/unmatched';
import { listScans, saveScanRecipe, scanImages } from '../services/recipeScans';
import { listSwapGroups, saveSwapGroups } from '../services/swapGroups';
import { useItUpInputs } from '../services/optimiser';

/** A tool result that is already MCP content (e.g. an image), not JSON to wrap in text. */
class RawContent {
  constructor(public content: object[]) {}
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ingredientLineSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The line as written, e.g. "2 large Maris Pipers, peeled".' },
    amount: { type: ['number', 'null'], description: 'Amount, e.g. 2. Leave out to read it from text.' },
    unit: { type: ['string', 'null'], description: 'g, kg, ml, l, tsp, tbsp, cup_metric, pinch, or count for counted things.' },
    ingredientId: { type: ['string', 'null'], description: 'Id from list_ingredients. Leave out to let the app match it from text.' },
    note: { type: ['string', 'null'], description: 'Preparation, e.g. "finely chopped".' },
    optional: { type: 'boolean' },
  },
  required: ['text'],
} as const;

const recipeProperties = {
  title: { type: 'string' },
  serves: { type: 'integer', minimum: 1, maximum: 100 },
  steps: { type: 'array', items: { type: 'string' }, description: 'One step per entry, without numbers.' },
  tags: { type: 'array', items: { type: 'string' }, description: 'Short lowercase tags, e.g. "vegetarian", "quick".' },
  prepMinutes: { type: ['integer', 'null'] },
  cookMinutes: { type: ['integer', 'null'] },
  sourceUrl: { type: ['string', 'null'], description: 'Where the recipe came from, if anywhere.' },
  imageUrl: { type: ['string', 'null'] },
  ingredients: { type: 'array', items: ingredientLineSchema },
} as const;

const receiptLineSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The item exactly as printed, including any pack size, e.g. "TES SEMI SKM MLK 4PT".' },
    quantity: { type: 'integer', minimum: 1, description: 'How many were bought (1 unless the receipt shows more).' },
    pricePence: { type: ['integer', 'null'], description: 'The line total in pence, e.g. 155 for £1.55. Null if not printed.' },
  },
  required: ['text'],
} as const;

const NUTRITION_SCHEMA = { type: ['object', 'null'], description: 'Per 100g: kcal, and grams of protein, carbs, sugars, fat, saturates, fibre, salt.', properties: { kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, sugars: { type: 'number' }, fat: { type: 'number' }, saturates: { type: 'number' }, fibre: { type: 'number' }, salt: { type: 'number' } } };

const TOOLS = [
  {
    name: 'list_ingredients',
    description:
      "List the household's ingredients (id and name). Recipe lines should be matched to these ids so the app can check stock, plan shopping and count calories.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional filter by name.' } } },
  },
  {
    name: 'search_recipes',
    description: "Search the household's saved recipes by title or tag. Returns ids, titles and serving counts.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'get_recipe',
    description: 'Get one recipe in full: ingredients (with matched ingredient ids and grams), steps and nutrition per serving.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'parse_ingredient_lines',
    description:
      'Read ingredient lines the way the app does and show the amount, unit and matched ingredient for each. Use this to check matches before create_recipe.',
    inputSchema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'] },
  },
  {
    name: 'create_recipe',
    description:
      'Save a new recipe. Lines without ingredientId are matched automatically from their text. Returns the saved recipe with its id.',
    inputSchema: { type: 'object', properties: recipeProperties, required: ['title', 'ingredients', 'steps'] },
  },
  {
    name: 'update_recipe',
    description: 'Replace an existing recipe completely (send every field, including all ingredients and steps). Returns the saved recipe.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...recipeProperties }, required: ['id', 'title', 'ingredients', 'steps'] },
  },
  {
    name: 'list_unmatched',
    description:
      "List recipe lines the app can't check against stock or put on the shopping list, grouped by food. problem \"unlinked\": not linked to an ingredient; \"noWeight\": counted (\"1 sachet\") but the ingredient has no weight per item. \"noNutrition\": the ingredient has no nutrition, so recipes' calories leave it out (fix with its ingredientId and nutritionPer100g). Also returns the food groups and shelf-life categories for new ingredients. Fix with fix_unmatched, or ignore_unmatched for things never bought (water).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fix_unmatched',
    description:
      'Fix groups from list_unmatched. Each fix links lineIds to an existing ingredientId (from list_ingredients) or to newIngredient, which is created (one with the same name as an existing ingredient reuses it). gramsPerCount sets the weight of one item on that ingredient, needed when lines count the food ("1 sachet" of curry powder is about 10g, a rump steak about 225g).',
    inputSchema: {
      type: 'object',
      properties: {
        fixes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              lineIds: { type: 'array', items: { type: 'string' } },
              ingredientId: { type: ['string', 'null'] },
              newIngredient: {
                type: ['object', 'null'],
                properties: {
                  name: { type: 'string', description: 'Short generic UK name, e.g. "Rump steak".' },
                  foodGroup: { type: ['string', 'null'], description: 'One of the food groups from list_unmatched.' },
                  shelfLifeCategoryId: { type: ['string', 'null'] },
                  aisle: { type: ['string', 'null'] },
                  gramsPerCount: { type: ['number', 'null'] },
                  countUnit: { type: ['string', 'null'], description: 'What one item is called, e.g. "sachet".' },
                  trackRunningLow: { type: 'boolean', description: 'True for staples used a little at a time (spices, oils).' },
                  nutritionPer100g: NUTRITION_SCHEMA,
                },
                required: ['name'],
              },
              gramsPerCount: { type: ['number', 'null'] },
              nutritionPer100g: NUTRITION_SCHEMA,
            },
            required: ['lineIds'],
          },
        },
      },
      required: ['fixes'],
    },
  },
  {
    name: 'ignore_unmatched',
    description: 'Leave groups unmatched on purpose (by key from list_unmatched), for things never bought or stocked such as water.',
    inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } }, required: ['keys'] },
  },
  {
    name: 'list_swap_groups',
    description:
      "List the household's swap groups (foods that can stand in for each other in a recipe, like broccoli and tenderstem broccoli) and the ingredients in no group yet, with their category. A recipe short of a food then offers the others from its group as close swaps.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_swap_groups',
    description:
      'Make or extend swap groups. Group foods a home cook would use instead of each other weight for weight: varieties, cuts and forms of the same thing (chicken breasts and thighs; cheddar and red leicester; onions and shallots), not just the same category (the app already offers same-category foods as looser swaps). An ingredient is in one group at most; adding it to a group moves it. With id, the foods are added to that group (replace: true makes it exactly these); without id, a group is made, or merged into one of the same name.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: ['string', 'null'] },
              name: { type: 'string', description: 'Short and plain, e.g. "Broccoli", "Hard cheese".' },
              ingredientIds: { type: 'array', items: { type: 'string' } },
              replace: { type: 'boolean' },
            },
            required: ['name', 'ingredientIds'],
          },
        },
      },
      required: ['groups'],
    },
  },
  {
    name: 'list_recipe_photos',
    description:
      'List recipe photos the household has added that still need reading (a cookbook page, or both sides of a recipe card; each entry is one recipe). Read each with get_recipe_photos, then save it with save_recipe_from_photos.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recipe_photos',
    description: 'Get the photos of one recipe waiting to be read. All the photos are the same recipe.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'save_recipe_from_photos',
    description:
      'Save the recipe read from a set of recipe photos (id from list_recipe_photos). Send every ingredient line and step as written; match lines to ingredient ids from list_ingredients where you can (the app matches the rest from the text). Recipe cards often give amounts for 2 and 4 people: use the smallest. The photos are deleted once it is saved.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...recipeProperties }, required: ['id', 'title', 'ingredients', 'steps'] },
  },
  {
    name: 'list_food_going_off',
    description:
      'Food the household has that goes off within a week and no planned meal will use (earliest first), plus what else they have in. Use it to suggest or create_recipe a recipe that uses it up.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_receipts_to_read',
    description:
      'List receipt photos and PDFs the household has added that still need reading (the app has no AI key of its own, or reading failed). Read each with get_receipt_image, then send the items with submit_receipt_lines.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_receipt_image',
    description: 'Get the photo (or PDF) of a receipt waiting to be read. Read every item line on it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'submit_receipt_lines',
    description:
      'Send the items read from a receipt. Copy each item line as printed, with the quantity and the line total in pence. Leave out totals, subtotals, payment, change, loyalty points and savings lines; keep non-food lines (the app skips them). The household then reviews the matches and adds it all to stock.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        store: { type: ['string', 'null'], description: 'Shop name, e.g. "Tesco".' },
        date: { type: ['string', 'null'], description: 'Date of purchase as YYYY-MM-DD, if printed.' },
        lines: { type: 'array', items: receiptLineSchema },
      },
      required: ['id', 'lines'],
    },
  },
  {
    name: 'add_receipt_text',
    description:
      'Add a receipt from text: a pasted till receipt or an online grocery order (one item per line with its price on the same line). Use this when the user gives you the text of an order email. Returns the matched lines for the household to review.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/** What an assistant needs back after sending receipt lines: what each matched to. */
function receiptSummary(r: Awaited<ReturnType<typeof getReceipt>>) {
  return {
    id: r.id,
    status: r.status,
    store: r.store,
    date: r.purchasedOn,
    message: 'Saved. The household will check the matches in the app and add it all to stock.',
    lines: r.lines.map((l) => ({
      text: l.text,
      quantity: l.quantity,
      pricePence: l.pricePence,
      matchedTo: l.productName ?? l.ingredientName,
      confidence: l.confidence,
      skipped: l.skip,
    })),
  };
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function mcpRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** The assistant acts for this install's household, as its first admin. */
  async function actor(): Promise<Auth> {
    const household = await theHousehold(ctx.db);
    if (!household) throw new HttpError(503, 'Snack Overflow is not set up yet.');
    const members = await ctx.db.select().from(users).where(eq(users.householdId, household.id)).orderBy(asc(users.createdAt));
    const owner = members.find((u) => u.role === 'admin') ?? members[0];
    if (!owner) throw new HttpError(503, 'Snack Overflow has no users yet.');
    return { user: owner, household };
  }

  async function completeLines(auth: Auth, input: RecipeInput): Promise<RecipeInput> {
    return completeRecipeLines(input, await loadCatalog(ctx.db, auth.household.id), ctx.seed);
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const auth = await actor();
    switch (name) {
      case 'list_ingredients': {
        const q = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        const catalog = await loadCatalog(ctx.db, auth.household.id);
        return [...catalog.ingredients.values()]
          .filter((i) => !q || i.name.toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((i) => ({ id: i.id, name: i.name }));
      }
      case 'search_recipes': {
        const q = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        const all = await listRecipes(ctx.db, auth);
        return all
          .filter((r) => !q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q)))
          .map((r) => ({ id: r.id, title: r.title, serves: r.serves, tags: r.tags, kcalPerServing: r.kcalPerServing }));
      }
      case 'get_recipe':
        return getRecipe(ctx.db, auth, z.string().parse(args.id));
      case 'parse_ingredient_lines':
        return draftLines(ctx.db, auth, ctx.seed, z.array(z.string()).max(100).parse(args.lines));
      case 'create_recipe':
      case 'update_recipe': {
        const parsed = recipeInput.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        const input = await completeLines(auth, parsed.data);
        const id = name === 'update_recipe' ? z.string().parse(args.id) : undefined;
        const savedId = await saveRecipe(ctx.db, auth, ctx.seed, input, id);
        ctx.live.publish(auth.household.id, 'recipes');
        return getRecipe(ctx.db, auth, savedId);
      }
      case 'list_unmatched': {
        const [groups, catalog] = await Promise.all([listUnmatched(ctx.db, auth, ctx.seed.units), loadCatalog(ctx.db, auth.household.id)]);
        return {
          groups: groups
            .filter((g) => !g.ignored)
            .map((g) => ({ key: g.key, name: g.name, problem: g.problem, ingredientId: g.ingredientId, ingredientName: g.ingredientName, lines: g.lines.map((l) => ({ id: l.id, recipe: l.recipeTitle, text: l.text })) })),
          foodGroups: FOOD_GROUPS,
          shelfLifeCategories: [...catalog.categories.values()].map((c) => ({ id: c.id, name: c.name, examples: c.examples })),
        };
      }
      case 'fix_unmatched': {
        const parsed = unmatchedFixInput.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        const result = await applyUnmatchedFixes(ctx.db, auth, ctx.seed.units, parsed.data.fixes);
        ctx.live.publish(auth.household.id, 'recipes', 'ingredients', 'plan', 'shopping');
        const left = (await listUnmatched(ctx.db, auth, ctx.seed.units)).filter((g) => !g.ignored).length;
        return { ...result, groupsLeft: left };
      }
      case 'ignore_unmatched': {
        const parsed = unmatchedIgnoreInput.safeParse({ keys: args.keys, ignored: true });
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        await setUnmatchedIgnored(ctx.db, auth, parsed.data.keys, true);
        ctx.live.publish(auth.household.id, 'recipes', 'household');
        return { ok: true };
      }
      case 'list_swap_groups': {
        const [groups, catalog] = await Promise.all([listSwapGroups(ctx.db, auth.household.id), loadCatalog(ctx.db, auth.household.id)]);
        return {
          groups,
          ungrouped: [...catalog.ingredients.values()]
            .filter((i) => !i.swapGroupId)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((i) => ({ id: i.id, name: i.name, category: i.foodGroup })),
        };
      }
      case 'save_swap_groups': {
        const parsed = swapGroupsSaveInput.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        const catalog = await loadCatalog(ctx.db, auth.household.id);
        const unknown = parsed.data.groups.flatMap((g) => g.ingredientIds).filter((id) => !catalog.ingredients.has(id));
        if (unknown.length) throw new Error(`Not ingredients of this household: ${unknown.join(', ')}. Use ids from list_swap_groups.`);
        const groups = await saveSwapGroups(ctx.db, auth.household.id, parsed.data.groups);
        ctx.live.publish(auth.household.id, 'ingredients', 'recipes');
        return groups;
      }
      case 'list_recipe_photos': {
        const scans = await listScans(ctx.db, auth);
        return scans.filter((x) => x.status !== 'done').map((x) => ({ id: x.id, photos: x.imageCount, status: x.status, error: x.error, added: x.createdAt }));
      }
      case 'get_recipe_photos': {
        const id = z.string().parse(args.id);
        const photos = await scanImages(ctx.db, auth.household.id, id);
        if (!photos.length) throw new Error('Those photos have already been read.');
        return new RawContent([
          ...photos.map((p) => ({ type: 'image', data: p.data.toString('base64'), mimeType: p.type })),
          { type: 'text', text: `These ${photos.length} photo(s) are one recipe. Read it, then call save_recipe_from_photos with id "${id}".` },
        ]);
      }
      case 'save_recipe_from_photos': {
        const id = z.string().parse(args.id);
        const parsed = recipeInput.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        const recipeId = await saveScanRecipe(ctx, auth, id, parsed.data);
        return getRecipe(ctx.db, auth, recipeId);
      }
      case 'list_food_going_off': {
        const { goingOff, alsoHave, today } = await useItUpInputs(ctx.db, auth, ctx.now(), ctx.config.PRICING_ENABLED);
        return { today, goingOff: goingOff.map(({ ingredientId, name, amount, bestBefore }) => ({ ingredientId, name, amount, bestBefore })), alsoHave };
      }
      case 'list_receipts_to_read': {
        const rows = await ctx.db
          .select({ id: receipts.id, createdAt: receipts.createdAt, source: receipts.source, status: receipts.status, fileType: receipts.fileType })
          .from(receipts)
          .where(and(eq(receipts.householdId, auth.household.id), inArray(receipts.status, ['waiting', 'failed']), isNotNull(receipts.fileType)))
          .orderBy(desc(receipts.createdAt));
        return rows.map((r) => ({ id: r.id, created: r.createdAt.toISOString(), source: r.source, status: r.status, fileType: r.fileType }));
      }
      case 'get_receipt_image': {
        const id = z.string().parse(args.id);
        const [r] = await ctx.db.select().from(receipts).where(and(eq(receipts.id, id), eq(receipts.householdId, auth.household.id)));
        if (!r) throw new Error('No such receipt.');
        if (!r.file || !r.fileType) throw new Error('That receipt has no image (it may already be done).');
        const data = r.file.toString('base64');
        const ask = { type: 'text', text: 'Read every item line on this receipt, then call submit_receipt_lines.' };
        if (r.fileType === 'application/pdf') {
          return new RawContent([{ type: 'resource', resource: { uri: `snackoverflow://receipts/${r.id}.pdf`, mimeType: 'application/pdf', blob: data } }, ask]);
        }
        return new RawContent([{ type: 'image', data, mimeType: r.fileType }, ask]);
      }
      case 'submit_receipt_lines': {
        const id = z.string().parse(args.id);
        const parsed = receiptLinesInput.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        const [r] = await ctx.db
          .select({ id: receipts.id, status: receipts.status })
          .from(receipts)
          .where(and(eq(receipts.id, id), eq(receipts.householdId, auth.household.id)));
        if (!r) throw new Error('No such receipt.');
        if (r.status === 'done') throw new Error('That receipt has already been added to stock.');
        await setReceiptLines(ctx.db, auth.household.id, ctx.seed, id, parsed.data);
        ctx.live.publish(auth.household.id, 'receipts');
        return receiptSummary(await getReceipt(ctx.db, auth, id, ctx.now()));
      }
      case 'add_receipt_text': {
        const text = z.string().min(3).max(50_000).parse(args.text);
        const id = await receiptFromText(ctx, auth.household.id, auth.user.id, text, 'mcp');
        return receiptSummary(await getReceipt(ctx.db, auth, id, ctx.now()));
      }
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
  }

  async function handle(msg: RpcRequest): Promise<object | null> {
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      let result: unknown;
      switch (msg.method) {
        case 'initialize': {
          const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
          result = {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'snack-overflow', version: '0.1.0' },
            instructions:
              "Snack Overflow is a household food app. Use list_ingredients and parse_ingredient_lines to match recipe lines to the household's ingredients, then create_recipe to save. To tidy up recipe lines that aren't linked to stock, use list_unmatched, then fix_unmatched or ignore_unmatched. To set up swaps (foods that stand in for each other), use list_swap_groups and save_swap_groups. Recipe photos waiting to be read: list_recipe_photos, get_recipe_photos, save_recipe_from_photos.",
          };
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call': {
          const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          try {
            const out = await callTool(name, args);
            result = out instanceof RawContent ? { content: out.content } : { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
          } catch (e) {
            if (e instanceof RpcError) throw e;
            result = { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
          break;
        }
        default:
          if (isNotification) return null;
          throw new RpcError(-32601, `Method not found: ${msg.method}`);
      }
      return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) {
      if (isNotification) return null;
      const err = e instanceof RpcError ? e : new RpcError(-32603, e instanceof Error ? e.message : 'Internal error');
      return { jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message } };
    }
  }

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const token = ctx.config.MCP_TOKEN;
    if (!token) {
      void reply.status(404).send({ error: 'Not found.' });
      return false;
    }
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given || !tokenMatches(given, token)) {
      void reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Wrong or missing MCP token.' });
      return false;
    }
    return true;
  };

  app.post('/mcp', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const body = req.body as RpcRequest | RpcRequest[] | undefined;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter((r) => r !== null);
      return out.length ? reply.send(out) : reply.status(202).send();
    }
    const out = await handle(body);
    return out ? reply.send(out) : reply.status(202).send();
  });

  // Stateless server: no server-to-client stream and no sessions to end.
  app.get('/mcp', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return reply.status(405).header('Allow', 'POST').send({ error: 'Use POST.' });
  });
  app.delete('/mcp', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return reply.status(405).header('Allow', 'POST').send({ error: 'Use POST.' });
  });
}

