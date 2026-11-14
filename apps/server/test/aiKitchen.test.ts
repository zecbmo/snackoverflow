import { afterEach, describe, expect, it } from 'vitest';
import type { IngredientDto, ProductPhotoReadDto, RecipeDraftDto, RecipeDto, RecipeScanDto, ScanAddResult } from '@snackoverflow/shared';
import { readAllScans } from '../src/services/recipeScans';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

type Body = { messages: { content: string | { type: string; text?: string; source?: { media_type: string } }[] }[]; system: string };

/** A fake Anthropic Messages API: each call answers with the next JSON from `answers`. */
function fakeClaude(answers: (() => unknown)[], calls: Body[]) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Body & { model: string };
    calls.push(body);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!();
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } },
    );
  }) as typeof fetch;
}

const PHOTO = Buffer.from('fake jpeg bytes').toString('base64');

async function setup(answers: (() => unknown)[] = [], key: string | null = 'test-key') {
  const calls: Body[] = [];
  t = await makeTestApp({
    fetch: fakeClaude(answers, calls),
    config: { AI_API_KEY: key ?? undefined, MCP_TOKEN: 'mcp-test-token-1234567890' },
    off: new FakeOff({}),
  });
  const api = await setupAdmin(t.app);
  const ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
  return { api, ing, calls };
}

const recipeAnswer = (ids: Record<string, IngredientDto>, extra: object = {}) => ({
  readable: true,
  title: 'Spinach and potato curry',
  serves: 2,
  prepMinutes: 10,
  cookMinutes: 25,
  steps: ['Boil the potatoes.', 'Wilt the spinach.'],
  tags: ['dinner', 'Veggie'],
  ingredients: [
    { text: '200g spinach', amount: 200, unit: 'g', ingredientId: ids.spinach!.id, note: null, optional: false },
    { text: '500g potatoes, peeled', amount: 500, unit: 'g', ingredientId: ids.potatoes!.id, note: 'peeled', optional: false },
    { text: '1 tsp garam masala', amount: 1, unit: 'tsp', ingredientId: 'not-an-id', note: null, optional: false },
  ],
  ...extra,
});

async function unknownProduct(api: Client) {
  const r = await api.post<ScanAddResult>('/api/scan/add', { barcode: '5099999999999' });
  return r.product;
}

describe('a product from photos of its pack', () => {
  it('is refused without an AI key', async () => {
    const { api } = await setup([], null);
    const p = await unknownProduct(api);
    expect((await api.raw('POST', `/api/products/${p.id}/read-photos`, { photos: [{ data: PHOTO, type: 'image/jpeg' }] })).statusCode).toBe(400);
  });

  it('reads the pack and fills in the form, keeping only what checks out', async () => {
    let yogurt = '';
    const { api, ing, calls } = await setup([
      () => ({
        readable: true,
        name: 'Greek Style Natural Yogurt',
        brand: 'Brookside',
        packAmount: 500,
        packUnit: 'g',
        ingredientId: yogurt,
        nutritionPer100g: { kcal: 115, protein: 5, carbs: 6, sugars: 6, fat: 8, saturates: 5, fibre: 0, salt: 0.1 },
      }),
    ]);
    yogurt = ing.greek_yogurt!.id;
    const p = await unknownProduct(api);
    const out = await api.post<ProductPhotoReadDto>(`/api/products/${p.id}/read-photos`, {
      photos: [
        { data: PHOTO, type: 'image/jpeg' },
        { data: PHOTO, type: 'image/jpeg' },
      ],
    });
    expect(out).toEqual({
      name: 'Greek Style Natural Yogurt',
      brand: 'Brookside',
      packAmount: 500,
      packUnit: 'g',
      ingredientId: yogurt,
      ingredientName: 'Greek yogurt',
      nutritionPer100g: { kcal: 115, protein: 5, carbs: 6, sugars: 6, fat: 8, saturates: 5, fibre: 0, salt: 0.1 },
    });
    // Both photos went to the model as images. Nothing was saved yet.
    const content = calls[0]!.messages[0]!.content as { type: string }[];
    expect(content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect((await api.get<{ name: string | null }>(`/api/products/${p.id}`)).name).toBeNull();
  });

  it('drops label values that cannot be right, and says when it cannot read the pack', async () => {
    const { api } = await setup([
      () => ({ readable: true, name: 'Thing', brand: null, packAmount: -3, packUnit: 'g', ingredientId: 'made-up', nutritionPer100g: { kcal: 5000, protein: 1, carbs: 1, sugars: 1, fat: 1, saturates: 1, fibre: 1, salt: 1 } }),
      () => ({ readable: false, name: '', brand: null, packAmount: null, packUnit: null, ingredientId: null, nutritionPer100g: null }),
    ]);
    const p = await unknownProduct(api);
    const first = await api.post<ProductPhotoReadDto>(`/api/products/${p.id}/read-photos`, { photos: [{ data: PHOTO, type: 'image/jpeg' }] });
    expect(first).toMatchObject({ name: 'Thing', packAmount: null, packUnit: null, ingredientId: null, nutritionPer100g: null });
    const second = await api.raw('POST', `/api/products/${p.id}/read-photos`, { photos: [{ data: PHOTO, type: 'image/jpeg' }] });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/Couldn't make out the product/);
  });

  it('only takes photos', async () => {
    const { api } = await setup();
    const p = await unknownProduct(api);
    expect((await api.raw('POST', `/api/products/${p.id}/read-photos`, { photos: [{ data: PHOTO, type: 'application/pdf' }] })).statusCode).toBe(400);
  });
});

describe('a recipe that uses food going off', () => {
  it("says so when nothing's going off", async () => {
    const { api } = await setup();
    const r = await api.raw('POST', '/api/recipes/use-it-up', {});
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Nothing's going off/);
  });

  it('builds a draft around what is going off, to check before saving', async () => {
    let ids: Record<string, IngredientDto> = {};
    const { api, ing, calls } = await setup([() => recipeAnswer(ids)]);
    ids = ing;
    // Spinach keeps 5 days; potatoes three weeks.
    await api.post('/api/stock/add-many', { items: [{ ingredientId: ing.spinach!.id }, { ingredientId: ing.potatoes!.id }] });
    const draft = await api.post<RecipeDraftDto>('/api/recipes/use-it-up', { serves: 2, request: 'vegetarian, quick' });
    expect(draft).toMatchObject({ title: 'Spinach and potato curry', serves: 2, prepMinutes: 10, tags: ['dinner', 'veggie', 'use it up'] });
    expect(draft.ingredients.map((l) => [l.ingredientName, l.matchConfidence])).toEqual([
      ['Spinach', 'high'],
      ['Potatoes', 'high'],
      [null, 'none'],
    ]);
    const sent = JSON.parse(calls[0]!.messages[0]!.content as string) as { goingOff: { name: string }[]; alsoHave: string[]; wishes: string };
    expect(sent.goingOff.map((g) => g.name)).toEqual(['Spinach']);
    expect(sent.alsoHave).toContain('Potatoes');
    expect(sent.wishes).toBe('vegetarian, quick');
    expect(await api.get<RecipeDto[]>('/api/recipes')).toEqual([]);
  });
});

describe('planning a week with AI', () => {
  it('fills only empty slots, with the household’s own recipes, once each', async () => {
    let picks: object[] = [];
    const { api, ing } = await setup([() => ({ picks })]);
    const pie = await api.post<RecipeDto>('/api/recipes', { title: 'Fish pie', serves: 2, ingredients: [{ text: '500g potatoes', amount: 500, unit: 'g', ingredientId: ing.potatoes!.id }] });
    const soup = await api.post<RecipeDto>('/api/recipes', { title: 'Soup', serves: 2, ingredients: [] });
    // Thursday's dinner is already planned.
    await api.post('/api/plan', { date: '2026-11-13', slot: 'dinner', kind: 'recipe', recipeId: soup.id, servings: 2 });
    picks = [
      { date: '2026-11-12', slot: 'dinner', kind: 'recipe', id: pie.id, reason: 'Uses the potatoes.' },
      { date: '2026-11-13', slot: 'dinner', kind: 'recipe', id: soup.id, reason: 'Taken already.' },
      { date: '2026-11-14', slot: 'dinner', kind: 'recipe', id: pie.id, reason: 'Twice is too many.' },
      { date: '2026-11-14', slot: 'dinner', kind: 'recipe', id: 'made-up', reason: 'Not a recipe.' },
      { date: '2026-11-15', slot: 'dinner', kind: 'recipe', id: soup.id, reason: 'Something warm.' },
      { date: '2026-11-30', slot: 'dinner', kind: 'recipe', id: soup.id, reason: 'Out of range.' },
    ];
    const out = await api.post<{ date: string; recipeId: string; reason: string; missing: string[] }[]>('/api/optimiser/plan-week-ai', {
      from: '2026-11-12',
      to: '2026-11-15',
      slots: ['dinner'],
      request: 'something warm at the weekend',
    });
    expect(out.map((p) => [p.date, p.recipeId, p.reason])).toEqual([
      ['2026-11-12', pie.id, 'Uses the potatoes.'],
      ['2026-11-15', soup.id, 'Something warm.'],
    ]);
    expect(out[0]!.missing).toEqual(['Potatoes']);
  });
});

describe('the recipe photo bank', () => {
  it('keeps photos until read, reads them all with AI into recipes, and lets the photos go', async () => {
    let ids: Record<string, IngredientDto> = {};
    let n = 0;
    const { api, ing } = await setup([
      () => recipeAnswer(ids, { title: `Card ${++n}` }),
      () => recipeAnswer(ids, { title: `Card ${++n}` }),
      () => ({ ...recipeAnswer(ids), readable: false, ingredients: [] }),
    ]);
    ids = ing;
    // Both sides of one card, then two pages each their own recipe.
    await api.post('/api/recipe-scans', { photos: [{ data: PHOTO, type: 'image/jpeg' }, { data: PHOTO, type: 'image/jpeg' }] });
    await api.post('/api/recipe-scans', { photos: [{ data: PHOTO, type: 'image/jpeg' }, { data: PHOTO, type: 'image/png' }], separate: true });
    let scans = await api.get<RecipeScanDto[]>('/api/recipe-scans');
    expect(scans.map((s) => [s.status, s.imageCount]).sort()).toEqual([
      ['waiting', 1],
      ['waiting', 1],
      ['waiting', 2],
    ]);
    const image = await api.raw('GET', `/api/recipe-scans/${scans[0]!.id}/images/0`);
    expect(image.headers['content-type']).toMatch(/^image\//);

    // The route starts it in the background; here we wait for it to finish.
    const auth = { user: (await t!.ctx.db.query.users.findFirst())!, household: (await t!.ctx.db.query.households.findFirst())! };
    const { started, finished } = await readAllScans(t!.ctx, auth);
    expect(started).toBe(3);
    await finished;

    scans = await api.get<RecipeScanDto[]>('/api/recipe-scans');
    expect(scans.filter((s) => s.status === 'done').map((s) => s.recipeTitle).sort()).toEqual(['Card 1', 'Card 2']);
    expect(scans.filter((s) => s.status === 'done').every((s) => s.imageCount === 0)).toBe(true);
    expect(scans.find((s) => s.status === 'failed')).toMatchObject({ imageCount: 1, error: expect.stringMatching(/Couldn't read a recipe/) });
    // Saved recipes: the unknown line was matched from its text (or left for Unmatched ingredients).
    const recipes = await api.get<RecipeDto[]>('/api/recipes');
    expect(recipes.map((r) => r.title).sort()).toEqual(['Card 1', 'Card 2']);
    const full = await api.get<RecipeDto>(`/api/recipes/${recipes[0]!.id}`);
    expect(full.ingredients.map((l) => l.ingredientName)).toEqual(['Spinach', 'Potatoes', null]);
  });

  it('needs AI to read them all, and can be read by an assistant over MCP instead', async () => {
    const { api } = await setup([], null);
    const { ids } = await api.post<{ ids: string[] }>('/api/recipe-scans', { photos: [{ data: PHOTO, type: 'image/jpeg' }] });
    expect((await api.raw('POST', '/api/recipe-scans/read-all', {})).statusCode).toBe(400);
    let rpc = 0;
    const call = async (name: string, args: object) =>
      (
        await t!.app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { authorization: 'Bearer mcp-test-token-1234567890', accept: 'application/json' },
          payload: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } },
        })
      ).json().result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
    const listed = JSON.parse((await call('list_recipe_photos', {})).content[0]!.text!) as { id: string; photos: number }[];
    expect(listed).toEqual([expect.objectContaining({ id: ids[0], photos: 1 })]);
    const photos = await call('get_recipe_photos', { id: ids[0] });
    expect(photos.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg', data: PHOTO });
    const saved = await call('save_recipe_from_photos', { id: ids[0], title: 'Card from Claude', serves: 2, steps: ['Cook it.'], ingredients: [{ text: '200g spinach' }] });
    expect(saved.isError ?? false).toBe(false);
    expect(JSON.parse(saved.content[0]!.text!)).toMatchObject({ title: 'Card from Claude', ingredients: [expect.objectContaining({ ingredientName: 'Spinach', grams: 200 })] });
    expect(JSON.parse((await call('list_recipe_photos', {})).content[0]!.text!)).toEqual([]);
  });
});
