import { afterEach, describe, expect, it } from 'vitest';
import type { CookPlanDto, IngredientDto, PlanEntryDto, RecipeDto, ShoppingItemDto, SwapExclusionDto, SwapGroupDto, SwapGroupSuggestionDto } from '@snackoverflow/shared';
import { makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup() {
  t = await makeTestApp();
  const api = await setupAdmin(t.app);
  const ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
  // The recipe wants chicken breasts; there are only thighs (500g) and beef mince (250g) in.
  await api.post('/api/stock/add-many', { items: [{ ingredientId: ing.chicken_thighs!.id }, { ingredientId: ing.beef_mince!.id }] });
  const recipe = await api.post<RecipeDto>('/api/recipes', {
    title: 'Chicken traybake',
    serves: 2,
    ingredients: [{ text: '300g chicken breasts', amount: 300, unit: 'g', ingredientId: ing.chicken_breast!.id }],
  });
  return { api, ing, recipe, line: recipe.ingredients[0]! };
}

describe('swap groups', () => {
  it('are made in Settings, one group per ingredient', async () => {
    const { api, ing } = await setup();
    const chicken = await api.post<SwapGroupDto>('/api/swap-groups', { name: 'Chicken', ingredientIds: [ing.chicken_breast!.id, ing.chicken_thighs!.id] });
    expect(chicken.ingredients.map((i) => i.name)).toEqual(['Chicken breasts', 'Chicken thighs']);
    // Moving thighs into another group takes them out of this one.
    await api.post('/api/swap-groups', { name: 'Thighs', ingredientIds: [ing.chicken_thighs!.id] });
    const groups = await api.get<SwapGroupDto[]>('/api/swap-groups');
    expect(groups.map((g) => [g.name, g.ingredients.map((i) => i.name)])).toEqual([
      ['Chicken', ['Chicken breasts']],
      ['Thighs', ['Chicken thighs']],
    ]);
    await api.patch(`/api/swap-groups/${chicken.id}`, { name: 'Poultry', ingredientIds: [ing.chicken_breast!.id, ing.chicken_thighs!.id] });
    await api.del(`/api/swap-groups/${groups[1]!.id}`);
    expect((await api.get<SwapGroupDto[]>('/api/swap-groups')).map((g) => [g.name, g.ingredients.length])).toEqual([['Poultry', 2]]);
  });
});

describe('swaps on a recipe that is short', () => {
  it('offers food from the same swap group as close, and the same category as loose', async () => {
    const { api, ing, recipe } = await setup();
    // No group yet: thighs and mince are both just Meat.
    let line = (await api.get<RecipeDto>(`/api/recipes/${recipe.id}`)).ingredients[0]!;
    expect(line.swaps.close).toEqual([]);
    expect(line.swaps.loose.map((s) => [s.name, s.amount])).toEqual([
      ['Chicken thighs', '500g'],
      ['Beef mince', '250g'],
    ]);
    await api.post('/api/swap-groups', { name: 'Chicken', ingredientIds: [ing.chicken_breast!.id, ing.chicken_thighs!.id] });
    line = (await api.get<RecipeDto>(`/api/recipes/${recipe.id}`)).ingredients[0]!;
    expect(line.swaps.close.map((s) => s.name)).toEqual(['Chicken thighs']);
    expect(line.swaps.loose.map((s) => s.name)).toEqual(['Beef mince']);
  });

  it('stops offering a pair the household says is not a swap, either way round, until it is brought back', async () => {
    const { api, ing, recipe } = await setup();
    const res = await api.post<SwapExclusionDto[]>('/api/swap-exclusions', { ingredientId: ing.chicken_breast!.id, otherIngredientId: ing.beef_mince!.id });
    expect(res.map((x) => x.ingredients.map((i) => i.name).sort())).toEqual([['Beef mince', 'Chicken breasts']]);
    // Saying it twice, or the other way round, is the same pair.
    await api.post('/api/swap-exclusions', { ingredientId: ing.beef_mince!.id, otherIngredientId: ing.chicken_breast!.id });
    expect(await api.get<SwapExclusionDto[]>('/api/swap-exclusions')).toHaveLength(1);
    let line = (await api.get<RecipeDto>(`/api/recipes/${recipe.id}`)).ingredients[0]!;
    expect(line.swaps.loose.map((s) => s.name)).toEqual(['Chicken thighs']);
    // Only that pair: mince is still offered for other foods.
    const sausages = await api.post<RecipeDto>('/api/recipes', { title: 'Bangers', serves: 2, ingredients: [{ text: '400g sausages', amount: 400, unit: 'g', ingredientId: ing.sausages!.id }] });
    expect(sausages.ingredients[0]!.swaps.loose.map((s) => s.name)).toContain('Beef mince');
    await api.del(`/api/swap-exclusions/${res[0]!.id}`);
    line = (await api.get<RecipeDto>(`/api/recipes/${recipe.id}`)).ingredients[0]!;
    expect(line.swaps.loose.map((s) => s.name)).toEqual(['Chicken thighs', 'Beef mince']);
    expect((await api.raw('POST', '/api/swap-exclusions', { ingredientId: ing.beef_mince!.id, otherIngredientId: ing.beef_mince!.id })).statusCode).toBe(400);
  });

  it('offers nothing when there is enough of the real thing', async () => {
    const { api, ing, recipe } = await setup();
    await api.post('/api/stock/add-many', { items: [{ ingredientId: ing.chicken_breast!.id }] });
    expect((await api.get<RecipeDto>(`/api/recipes/${recipe.id}`)).ingredients[0]!.swaps).toEqual({ close: [], loose: [] });
  });
});

describe('a swap chosen for a planned meal', () => {
  it('is kept on the meal, used by the shopping list and by cooking', async () => {
    const { api, ing, recipe, line } = await setup();
    const plain = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-14', slot: 'dinner', kind: 'recipe', recipeId: recipe.id, servings: 2 });
    // Without a swap, the list wants chicken breasts.
    expect((await api.get<ShoppingItemDto[]>('/api/shopping')).map((i) => i.text)).toEqual(['Chicken breasts']);

    const swapped = await api.patch<PlanEntryDto>(`/api/plan/${plain.id}`, { swaps: { [line.id]: ing.chicken_thighs!.id } });
    expect(swapped.swaps).toEqual([{ recipeIngredientId: line.id, ingredientId: ing.chicken_thighs!.id, from: 'Chicken breasts', to: 'Chicken thighs' }]);
    // The thighs in stock cover it, so nothing to buy.
    expect(await api.get('/api/shopping')).toEqual([]);

    const cook = await api.get<CookPlanDto>(`/api/recipes/${recipe.id}/cook-plan?servings=2&entry=${plain.id}`);
    expect(cook.lines[0]).toMatchObject({ ingredientName: 'Chicken thighs', swappedFrom: 'Chicken breasts', neededGrams: 300, shortGrams: 0 });

    // Clearing the swap puts chicken breasts back on the list.
    await api.patch(`/api/plan/${plain.id}`, { swaps: null });
    expect((await api.get<ShoppingItemDto[]>('/api/shopping')).map((i) => i.text)).toEqual(['Chicken breasts']);
  });

  it('can be chosen when adding to the calendar, or on the recipe page before cooking', async () => {
    const { api, ing, recipe, line } = await setup();
    const entry = await api.post<PlanEntryDto>('/api/plan', {
      date: '2026-11-14',
      slot: 'dinner',
      kind: 'recipe',
      recipeId: recipe.id,
      servings: 2,
      swaps: { [line.id]: ing.beef_mince!.id, 'b6f0a8a8-0000-4000-8000-000000000000': ing.beef_mince!.id },
    });
    // Only swaps for this recipe's lines are kept.
    expect(entry.swaps.map((s) => s.to)).toEqual(['Beef mince']);
    const cook = await api.get<CookPlanDto>(`/api/recipes/${recipe.id}/cook-plan?servings=2&swaps=${line.id}:${ing.chicken_thighs!.id}`);
    expect(cook.lines[0]).toMatchObject({ ingredientName: 'Chicken thighs', swappedFrom: 'Chicken breasts' });
  });
});

describe('setting up swap groups for you', () => {
  /** A fake Anthropic Messages API answering with the given JSON. */
  const fakeClaude = (answer: () => unknown) =>
    (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify(answer()) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

  it('suggests groups with AI to review, keeping only ones that check out, and adds the chosen ones', async () => {
    let answer: unknown = { groups: [] };
    t = await makeTestApp({ fetch: fakeClaude(() => answer), config: { AI_API_KEY: 'test-key' } });
    const api = await setupAdmin(t.app);
    const ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
    const sugar = await api.post<SwapGroupDto>('/api/swap-groups', { name: 'Sugar', ingredientIds: [ing.caster_sugar!.id] });
    answer = {
      groups: [
        { existingGroupId: null, name: 'Chicken', ingredientIds: [ing.chicken_breast!.id, ing.chicken_thighs!.id], reason: 'Cuts of chicken' },
        // Extends the existing group (matched by name too), leaving out what's already in it.
        { existingGroupId: null, name: 'sugar', ingredientIds: [ing.caster_sugar!.id, ing.sugar!.id], reason: 'White sugars' },
        // Thighs are taken by the first group; one food left is no group.
        { existingGroupId: null, name: 'Thighs', ingredientIds: [ing.chicken_thighs!.id, 'made-up'], reason: '' },
      ],
    };
    const out = await api.post<SwapGroupSuggestionDto[]>('/api/swap-groups/suggest', {});
    expect(out).toEqual([
      { groupId: null, name: 'Chicken', ingredients: [expect.objectContaining({ name: 'Chicken breasts' }), expect.objectContaining({ name: 'Chicken thighs' })], reason: 'Cuts of chicken' },
      { groupId: sugar.id, name: 'Sugar', ingredients: [expect.objectContaining({ name: 'Granulated sugar' })], reason: 'White sugars' },
    ]);
    // Nothing saved until applied.
    expect((await api.get<SwapGroupDto[]>('/api/swap-groups')).map((g) => g.name)).toEqual(['Sugar']);
    await api.post('/api/swap-groups/save', { groups: out.map((g) => ({ id: g.groupId, name: g.name, ingredientIds: g.ingredients.map((i) => i.id) })) });
    expect((await api.get<SwapGroupDto[]>('/api/swap-groups')).map((g) => [g.name, g.ingredients.map((i) => i.name)])).toEqual([
      ['Chicken', ['Chicken breasts', 'Chicken thighs']],
      ['Sugar', ['Caster sugar', 'Granulated sugar']],
    ]);
  });

  it('lets an assistant list and save them over MCP', async () => {
    t = await makeTestApp({ config: { MCP_TOKEN: 'mcp-test-token-1234567890' } });
    const api = await setupAdmin(t.app);
    const ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
    let id = 0;
    const call = async (name: string, args: object) => {
      const res = await t!.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer mcp-test-token-1234567890', accept: 'application/json' },
        payload: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
      });
      const result = res.json().result as { content: { text: string }[]; isError?: boolean };
      return { isError: Boolean(result.isError), text: result.content[0]!.text };
    };
    const listed = JSON.parse((await call('list_swap_groups', {})).text) as { groups: unknown[]; ungrouped: { id: string; category: string | null }[] };
    expect(listed.groups).toEqual([]);
    expect(listed.ungrouped.find((i) => i.id === ing.cheddar!.id)).toMatchObject({ category: 'Dairy' });
    expect((await call('save_swap_groups', { groups: [{ name: 'Cheese', ingredientIds: ['00000000-0000-4000-8000-000000000000'] }] })).isError).toBe(true);
    const saved = JSON.parse((await call('save_swap_groups', { groups: [{ name: 'Chicken', ingredientIds: [ing.chicken_breast!.id, ing.chicken_thighs!.id] }] })).text) as SwapGroupDto[];
    expect(saved.map((g) => [g.name, g.ingredients.length])).toEqual([['Chicken', 2]]);
    // Thighs go elsewhere with replace: one group per food.
    await call('save_swap_groups', { groups: [{ id: saved[0]!.id, name: 'Chicken', ingredientIds: [ing.chicken_breast!.id], replace: true }] });
    expect(JSON.parse((await call('list_swap_groups', {})).text).groups[0].ingredients).toHaveLength(1);
  });
});
