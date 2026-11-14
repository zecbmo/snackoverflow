import { afterEach, describe, expect, it } from 'vitest';
import type {
  CookPlanDto,
  IngredientDto,
  RecipeDto,
  ShoppingItemDto,
  UnmatchedFixResultDto,
  UnmatchedGroupDto,
  UnmatchedSuggestionDto,
} from '@snackoverflow/shared';
import { type Client, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(opts: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp(opts);
  const api = await setupAdmin(t.app);
  const ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
  return { api, ing };
}

/** The recipe from the bug report: a weighed steak and a counted sachet, neither in the catalogue. */
const steakCurry = (api: Client, ing: Record<string, IngredientDto>) =>
  api.post<RecipeDto>('/api/recipes', {
    title: 'Curried rump steak',
    serves: 2,
    ingredients: [
      { text: '250 grams 21 Day Aged British Rump Steaks', amount: 250, unit: 'g' },
      { text: '1 sachet(s) Curry Powder', amount: 1, unit: 'count' },
      { text: '100g potatoes', amount: 100, unit: 'g', ingredientId: ing.potatoes!.id },
      { text: 'Fresh mint (optional)', optional: true },
    ],
  });

const groupNamed = (groups: UnmatchedGroupDto[], name: string) => groups.find((g) => g.name.toLowerCase().includes(name))!;

describe('unmatched recipe lines', () => {
  it('lists lines not linked to stock, grouped by food across recipes', async () => {
    const { api, ing } = await setup();
    await steakCurry(api, ing);
    await api.post('/api/recipes', { title: 'Steak night', serves: 2, ingredients: [{ text: '2 rump steaks', amount: 2, unit: 'count' }] });
    const groups = await api.get<UnmatchedGroupDto[]>('/api/unmatched');
    // Linked, weighed lines and optional lines aren't listed.
    expect(groups.map((g) => g.key).sort()).toEqual(['21 day aged british rump steak', 'curry powder', 'rump steak']);
    expect(groupNamed(groups, 'curry')).toMatchObject({ key: 'curry powder', problem: 'unlinked', ignored: false, lines: [expect.objectContaining({ recipeTitle: 'Curried rump steak', text: '1 sachet(s) Curry Powder' })] });
  });

  it('shows an unlinked line on the cook screen as not linked, not short', async () => {
    const { api, ing } = await setup();
    const r = await steakCurry(api, ing);
    const plan = await api.get<CookPlanDto>(`/api/recipes/${r.id}/cook-plan`);
    const steak = plan.lines.find((l) => l.text.includes('Steak'))!;
    expect(steak).toMatchObject({ ingredientName: null, neededGrams: null, shortGrams: null });
  });

  it('fixes a group with a new ingredient, and the plan then puts it on the shopping list', async () => {
    const { api, ing } = await setup();
    const r = await steakCurry(api, ing);
    await api.post('/api/plan', { date: '2026-11-14', slot: 'dinner', kind: 'recipe', recipeId: r.id, servings: 2 });
    expect((await api.get<ShoppingItemDto[]>('/api/shopping')).map((i) => i.text)).toEqual(['Potatoes']);

    const groups = await api.get<UnmatchedGroupDto[]>('/api/unmatched');
    const steak = groupNamed(groups, 'steak');
    const curry = groupNamed(groups, 'curry');
    const meat = (await api.get<{ id: string; key: string }[]>('/api/shelf-life')).find((c) => c.key === 'raw_red_meat')!;
    const out = await api.post<UnmatchedFixResultDto>('/api/unmatched/fix', {
      fixes: [
        { lineIds: steak.lines.map((l) => l.id), newIngredient: { name: 'Rump steak', foodGroup: 'Meat', shelfLifeCategoryId: meat.id, nutritionPer100g: { kcal: 125, protein: 22, fat: 4 } } },
        {
          lineIds: curry.lines.map((l) => l.id),
          newIngredient: { name: 'Curry powder', foodGroup: 'Herbs & Spices', gramsPerCount: 10, countUnit: 'sachet', trackRunningLow: true, nutritionPer100g: { kcal: 325 } },
        },
      ],
    });
    expect(out).toEqual({ linked: 2, created: [expect.objectContaining({ name: 'Rump steak' }), expect.objectContaining({ name: 'Curry powder' })] });
    expect(await api.get('/api/unmatched')).toEqual([]);

    const recipe = await api.get<RecipeDto>(`/api/recipes/${r.id}`);
    expect(recipe.ingredients.map((l) => [l.ingredientName, l.grams])).toEqual([
      ['Rump steak', 250],
      ['Curry powder', 10],
      ['Potatoes', 100],
      [null, null],
    ]);
    // The steak the cook screen said was short is now on the list for the planned meal.
    const list = await api.get<ShoppingItemDto[]>('/api/shopping');
    expect(list.map((i) => i.text).sort()).toEqual(['Curry powder', 'Potatoes', 'Rump steak']);
    expect(list.find((i) => i.text === 'Rump steak')).toMatchObject({ reason: 'plan', grams: 250, forMeals: 'Curried rump steak' });
  });

  it('links to an existing ingredient, reusing one with the same name instead of making a copy', async () => {
    const { api, ing } = await setup();
    await steakCurry(api, ing);
    const steak = groupNamed(await api.get<UnmatchedGroupDto[]>('/api/unmatched'), 'steak');
    const out = await api.post<UnmatchedFixResultDto>('/api/unmatched/fix', { fixes: [{ lineIds: steak.lines.map((l) => l.id), newIngredient: { name: 'beef mince' } }] });
    expect(out).toEqual({ linked: 1, created: [] });
    expect((await api.get<IngredientDto[]>('/api/ingredients')).filter((i) => i.name.toLowerCase() === 'beef mince')).toHaveLength(1);
  });

  it('asks for a weight per item when a linked line counts the food, and works out grams once given', async () => {
    const { api, ing } = await setup();
    const curry = await api.post<IngredientDto>('/api/ingredients', { name: 'Curry powder', foodGroup: 'Herbs & Spices' });
    const r = await api.post<RecipeDto>('/api/recipes', { title: 'Curry', serves: 2, ingredients: [{ text: '2 sachets curry powder', amount: 2, unit: 'count', ingredientId: curry.id }] });
    void ing;
    const [g] = await api.get<UnmatchedGroupDto[]>('/api/unmatched');
    expect(g).toMatchObject({ key: `noWeight:${curry.id}`, problem: 'noWeight', ingredientId: curry.id, name: 'Curry powder' });
    await api.post('/api/unmatched/fix', { fixes: [{ lineIds: g!.lines.map((l) => l.id), ingredientId: curry.id, gramsPerCount: 10 }] });
    expect((await api.get<RecipeDto>(`/api/recipes/${r.id}`)).ingredients[0]!.grams).toBe(20);
    // Weighed now, so the next thing it needs is nutrition for the recipe's calories.
    expect((await api.get<UnmatchedGroupDto[]>('/api/unmatched')).map((x) => x.problem)).toEqual(['noNutrition']);
  });

  it('works out grams again when an ingredient gets a weight per item on the Ingredients page', async () => {
    const { api } = await setup();
    const curry = await api.post<IngredientDto>('/api/ingredients', { name: 'Curry powder' });
    const r = await api.post<RecipeDto>('/api/recipes', { title: 'Curry', serves: 2, ingredients: [{ text: '1 sachet curry powder', amount: 1, unit: 'count', ingredientId: curry.id }] });
    await api.patch(`/api/ingredients/${curry.id}`, { gramsPerCount: 12 });
    expect((await api.get<RecipeDto>(`/api/recipes/${r.id}`)).ingredients[0]!.grams).toBe(12);
  });

  it('leaves groups unmatched on purpose, and brings them back', async () => {
    const { api } = await setup();
    await api.post('/api/recipes', { title: 'Soup', serves: 2, ingredients: [{ text: '500ml water', amount: 500, unit: 'ml' }] });
    await api.post('/api/unmatched/ignore', { keys: ['water'] });
    expect(await api.get<UnmatchedGroupDto[]>('/api/unmatched')).toEqual([expect.objectContaining({ key: 'water', ignored: true })]);
    await api.post('/api/unmatched/ignore', { keys: ['water'], ignored: false });
    expect((await api.get<UnmatchedGroupDto[]>('/api/unmatched'))[0]!.ignored).toBe(false);
  });

  it('lists ingredients with no nutrition, so recipe calories leave them out, and takes nutrition as a fix', async () => {
    const { api } = await setup();
    const sumac = await api.post<IngredientDto>('/api/ingredients', { name: 'Sumac' });
    const r = await api.post<RecipeDto>('/api/recipes', { title: 'Salad', serves: 2, ingredients: [{ text: '10g sumac', amount: 10, unit: 'g', ingredientId: sumac.id }] });
    const [g] = await api.get<UnmatchedGroupDto[]>('/api/unmatched');
    expect(g).toMatchObject({ key: `noNutrition:${sumac.id}`, problem: 'noNutrition', ingredientId: sumac.id, lines: [expect.objectContaining({ recipeId: r.id })] });
    await api.post('/api/unmatched/fix', { fixes: [{ lineIds: g!.lines.map((l) => l.id), ingredientId: sumac.id, nutritionPer100g: { kcal: 300, protein: 5 } }] });
    expect(await api.get('/api/unmatched')).toEqual([]);
    // 10g at 300 kcal per 100g, for 2: 15 kcal a serving.
    expect((await api.get<RecipeDto>(`/api/recipes/${r.id}`)).nutritionPerServing.kcal).toBe(15);
  });

  it('refuses a fix that names neither an ingredient nor a new one', async () => {
    const { api, ing } = await setup();
    await steakCurry(api, ing);
    const steak = groupNamed(await api.get<UnmatchedGroupDto[]>('/api/unmatched'), 'steak');
    const res = await api.raw('POST', '/api/unmatched/fix', { fixes: [{ lineIds: steak.lines.map((l) => l.id) }] });
    expect(res.statusCode).toBe(400);
  });
});

/** A fake Anthropic Messages API answering with the given JSON. */
function fakeClaude(answer: () => unknown, calls: Record<string, unknown>[]) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push(body);
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(answer()) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } },
    );
  }) as typeof fetch;
}

describe('AI suggestions for unmatched lines', () => {
  it('is refused when no key is set', async () => {
    const { api } = await setup();
    expect((await api.raw('POST', '/api/unmatched/suggest', {})).statusCode).toBe(400);
  });

  it('suggests fixes to review, dropping any that use ids it was not given', async () => {
    const calls: Record<string, unknown>[] = [];
    let mince = '';
    const fetchFn = fakeClaude(
      () => ({
        suggestions: [
          {
            key: '21 day aged british rump steak',
            action: 'create',
            ingredientId: null,
            newIngredient: {
              name: 'Rump steak',
              foodGroup: 'Meat',
              shelfLifeCategoryId: 'not-a-real-id',
              aisle: 'Meat',
              gramsPerCount: 225,
              countUnit: 'steak',
              trackRunningLow: false,
              nutritionPer100g: { kcal: 125, protein: 22, carbs: 0, sugars: 0, fat: 4, saturates: 1.6, fibre: 0, salt: 0.1 },
            },
            gramsPerCount: null,
            nutritionPer100g: null,
            reason: 'A cut of beef',
          },
          { key: 'curry powder', action: 'link', ingredientId: 'made-up', newIngredient: null, gramsPerCount: 10, nutritionPer100g: null, reason: 'Spice' },
          { key: 'not a group', action: 'ignore', ingredientId: null, newIngredient: null, gramsPerCount: null, nutritionPer100g: null, reason: '' },
          { key: 'water', action: 'link', ingredientId: mince, newIngredient: null, gramsPerCount: null, nutritionPer100g: null, reason: '' },
        ],
      }),
      calls,
    );
    const { api, ing } = await setup({ fetch: fetchFn, config: { AI_API_KEY: 'test-key' } });
    mince = ing.beef_mince!.id;
    await steakCurry(api, ing);
    await api.post('/api/recipes', { title: 'Soup', serves: 2, ingredients: [{ text: '500ml water', amount: 500, unit: 'ml' }] });
    const out = await api.post<UnmatchedSuggestionDto[]>('/api/unmatched/suggest', {});
    expect(out).toEqual([
      expect.objectContaining({
        key: '21 day aged british rump steak',
        action: 'create',
        newIngredient: expect.objectContaining({ name: 'Rump steak', foodGroup: 'Meat', shelfLifeCategoryId: null, gramsPerCount: 225, nutritionPer100g: expect.objectContaining({ kcal: 125 }) }),
      }),
      expect.objectContaining({ key: 'water', action: 'link', ingredientId: mince, ingredientName: 'Beef mince' }),
    ]);
    // The model saw the groups, the household's ingredients and the shelf-life categories.
    const sent = JSON.parse(((calls[0]!.messages as { content: string }[])[0]!).content) as { groups: { key: string }[]; ingredients: unknown[]; shelfLifeCategories: unknown[] };
    expect(sent.groups.map((g) => g.key).sort()).toEqual(['21 day aged british rump steak', 'curry powder', 'water']);
    expect(sent.ingredients.length).toBeGreaterThan(10);
    expect(sent.shelfLifeCategories.length).toBeGreaterThan(5);
    // Nothing changed until applied.
    expect((await api.get<UnmatchedGroupDto[]>('/api/unmatched')).length).toBe(3);
  });
});

describe('unmatched lines over MCP', () => {
  const TOKEN = 'mcp-test-token-1234567890';
  it('lists and fixes them', async () => {
    const { api, ing } = await setup({ config: { MCP_TOKEN: TOKEN } });
    await steakCurry(api, ing);
    let id = 0;
    const call = async (name: string, args: object) => {
      const res = await t!.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
        payload: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
      });
      const result = res.json().result as { content: { text: string }[]; isError?: boolean };
      expect(result.isError ?? false).toBe(false);
      return JSON.parse(result.content[0]!.text);
    };
    const listed = (await call('list_unmatched', {})) as { groups: { key: string; lines: { id: string }[] }[]; foodGroups: string[]; shelfLifeCategories: unknown[] };
    expect(listed.groups.map((g) => g.key).sort()).toEqual(['21 day aged british rump steak', 'curry powder']);
    expect(listed.foodGroups).toContain('Herbs & Spices');
    const curry = listed.groups.find((g) => g.key === 'curry powder')!;
    const fixed = await call('fix_unmatched', { fixes: [{ lineIds: curry.lines.map((l) => l.id), newIngredient: { name: 'Curry powder', foodGroup: 'Herbs & Spices', gramsPerCount: 10, nutritionPer100g: { kcal: 325 } } }] });
    expect(fixed).toMatchObject({ linked: 1, created: [expect.objectContaining({ name: 'Curry powder' })], groupsLeft: 1 });
    await call('ignore_unmatched', { keys: ['21 day aged british rump steak'] });
    expect((await call('list_unmatched', {})).groups).toEqual([]);
  });
});
