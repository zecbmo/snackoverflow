import { afterEach, describe, expect, it } from 'vitest';
import type { RecipeDto } from '@snackoverflow/shared';
import { makeTestApp, setupAdmin, type TestApp } from './helpers';

const TOKEN = 'mcp-test-token-1234567890';
let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(token: string | null = TOKEN) {
  t = await makeTestApp({ config: { MCP_TOKEN: token ?? undefined } });
  await setupAdmin(t.app);
  let id = 0;
  const rpc = async (method: string, params?: object, auth = `Bearer ${TOKEN}`) =>
    t!.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: auth, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) },
    });
  const call = async (name: string, args: object) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const result = res.json().result as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(result.isError), data: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) };
  };
  return { rpc, call };
}

describe('MCP endpoint', () => {
  it('is hidden when no token is configured', async () => {
    const { rpc } = await setup(null);
    expect((await rpc('initialize')).statusCode).toBe(404);
  });

  it('rejects a wrong token', async () => {
    const { rpc } = await setup();
    expect((await rpc('initialize', {}, 'Bearer nope')).statusCode).toBe(401);
    expect((await rpc('initialize', {}, '')).statusCode).toBe(401);
  });

  it('initialises, accepts notifications and lists its tools', async () => {
    const { rpc } = await setup();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.statusCode).toBe(200);
    expect(init.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snack-overflow' } },
    });
    const note = await t!.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(note.statusCode).toBe(202);
    const tools = (await rpc('tools/list')).json().result.tools as { name: string; inputSchema: object }[];
    expect(tools.map((x) => x.name)).toEqual([
      'list_ingredients',
      'search_recipes',
      'get_recipe',
      'parse_ingredient_lines',
      'create_recipe',
      'update_recipe',
    ]);
    expect((await rpc('nope/method')).json().error.code).toBe(-32601);
    expect((await t!.app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(405);
  });

  it('creates, finds, reads and updates a recipe, matching lines from text', async () => {
    const { call } = await setup();
    const ings = await call('list_ingredients', { query: 'potato' });
    expect(ings.data.map((i: { name: string }) => i.name)).toContain('Potatoes');

    const created = await call('create_recipe', {
      title: 'Cheesy mash',
      serves: 2,
      steps: ['Boil the potatoes.', 'Mash with the butter and cheese.'],
      tags: ['side'],
      ingredients: [{ text: '500g potatoes, peeled' }, { text: '25g butter' }, { text: '50g grated cheddar', optional: true }],
    });
    expect(created.isError).toBe(false);
    const recipe = created.data as RecipeDto;
    expect(recipe.ingredients.map((i) => [i.ingredientName, i.grams])).toEqual([
      ['Potatoes', 500],
      ['Butter', 25],
      ['Cheddar', 50],
    ]);
    expect(recipe.ingredients[2]!.optional).toBe(true);

    const found = await call('search_recipes', { query: 'mash' });
    expect(found.data).toMatchObject([{ id: recipe.id, title: 'Cheesy mash', serves: 2 }]);

    const got = await call('get_recipe', { id: recipe.id });
    expect(got.data.steps).toEqual(['Boil the potatoes.', 'Mash with the butter and cheese.']);

    const updated = await call('update_recipe', { id: recipe.id, title: 'Cheesy mash for four', serves: 4, steps: ['Make the mash.'], ingredients: [{ text: '1kg potatoes' }] });
    expect(updated.data).toMatchObject({ title: 'Cheesy mash for four', serves: 4 });
    expect(updated.data.ingredients).toHaveLength(1);
  });

  it('shows how lines would be read before saving', async () => {
    const { call } = await setup();
    const r = await call('parse_ingredient_lines', { lines: ['2 tbsp olive oil', 'a pinch of salt'] });
    expect(r.data[0]).toMatchObject({ amount: 2, unit: 'tbsp', ingredientName: 'Olive oil' });
    expect(r.data[1]).toMatchObject({ amount: null });
  });

  it('reports bad tool input as a tool error', async () => {
    const { call } = await setup();
    const r = await call('create_recipe', { title: '', ingredients: [], steps: [] });
    expect(r.isError).toBe(true);
    expect(r.data).toMatch(/title/);
  });
});
