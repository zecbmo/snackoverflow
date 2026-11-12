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
      'list_receipts_to_read',
      'get_receipt_image',
      'submit_receipt_lines',
      'add_receipt_text',
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

describe('MCP receipt tools', () => {
  it('lists receipts waiting to be read, hands over the image, and takes the lines back', async () => {
    const { rpc, call } = await setup();
    const admin = await setupAdminClient();
    // A tiny PNG uploaded with no AI key: it waits for the assistant.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const { id } = await admin.post<{ id: string }>('/api/receipts/file', { data: png.toString('base64'), type: 'image/png', source: 'photo' });
    const waiting = await call('list_receipts_to_read', {});
    expect(waiting.data).toEqual([expect.objectContaining({ id, status: 'waiting', fileType: 'image/png' })]);

    const res = await rpc('tools/call', { name: 'get_receipt_image', arguments: { id } });
    const content = res.json().result.content as { type: string; data?: string; mimeType?: string }[];
    expect(content[0]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });

    const submitted = await call('submit_receipt_lines', {
      id,
      store: 'Tesco',
      date: '2026-11-12',
      lines: [
        { text: 'TES SEMI SKM MLK 4PT', quantity: 1, pricePence: 155 },
        { text: 'CARRIER BAG', quantity: 1, pricePence: 10 },
      ],
    });
    expect(submitted.isError).toBe(false);
    expect(submitted.data).toMatchObject({ status: 'review', store: 'Tesco', date: '2026-11-12' });
    expect(submitted.data.lines).toEqual([
      expect.objectContaining({ text: 'TES SEMI SKM MLK 4PT', matchedTo: 'Milk', skipped: false }),
      expect.objectContaining({ text: 'CARRIER BAG', skipped: true }),
    ]);
    // No longer waiting.
    expect((await call('list_receipts_to_read', {})).data).toEqual([]);
  });

  it('adds a receipt from pasted order text', async () => {
    const { call } = await setup();
    const r = await call('add_receipt_text', { text: "Sainsbury's\n1 x Basmati Rice 1kg £1.99\nTotal £1.99" });
    expect(r.data).toMatchObject({ status: 'review', store: "Sainsbury's" });
    expect(r.data.lines[0]).toMatchObject({ matchedTo: 'Rice', pricePence: 199 });
  });

  it('rejects bad lines as a tool error', async () => {
    const { call } = await setup();
    const r = await call('submit_receipt_lines', { id: '00000000-0000-4000-8000-000000000000', lines: [{ text: '' }] });
    expect(r.isError).toBe(true);
  });
});

/** A signed-in browser client for the same test app (the admin made by setup()). */
async function setupAdminClient() {
  const { client, cookieFrom } = await import('./helpers');
  const res = await t!.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'correct horse battery' } });
  return client(t!.app, cookieFrom(res));
}
