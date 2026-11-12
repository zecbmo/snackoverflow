/**
 * MCP endpoint so Claude (or another assistant) can add and fix recipes directly,
 * e.g. from a photo of a recipe card, doing the clean-up with the user's own
 * assistant, so no API key is needed here. A minimal stateless Streamable HTTP
 * server: JSON-RPC 2.0 over POST /mcp, answered as application/json.
 * Off unless MCP_TOKEN is set; assistants send it as a Bearer token.
 */
import { timingSafeEqual } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type RecipeInput, recipeInput } from '@snackoverflow/shared';
import type { Auth } from '../context';
import { users } from '../db/schema';
import { HttpError } from '../http';
import { draftLine, draftLines, getRecipe, listRecipes, saveRecipe } from '../services/recipes';
import { loadCatalog } from '../services/catalog';
import { theHousehold } from '../services/household';

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
];

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

  /** Fill in amount/unit/ingredient from the text for lines the assistant left them out of. */
  async function completeLines(auth: Auth, input: RecipeInput): Promise<RecipeInput> {
    const catalog = await loadCatalog(ctx.db, auth.household.id);
    return {
      ...input,
      ingredients: input.ingredients.map((l) => {
        if (l.ingredientId && l.amount != null) return l;
        const d = draftLine(l.text, catalog, ctx.seed);
        return {
          ...l,
          amount: l.amount ?? d.amount,
          unit: l.unit ?? d.unit,
          ingredientId: l.ingredientId && catalog.ingredients.has(l.ingredientId) ? l.ingredientId : d.ingredientId,
          note: l.note ?? d.note,
        };
      }),
    };
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
              "Snack Overflow is a household food app. Use list_ingredients and parse_ingredient_lines to match recipe lines to the household's ingredients, then create_recipe to save.",
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
            result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
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

