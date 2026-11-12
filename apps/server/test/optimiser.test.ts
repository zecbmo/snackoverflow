import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CookPlanDto, CookResultDto, IngredientDto, LocationDto, RecipeDto, RecipeScore, ScanAddResult } from '@snackoverflow/shared';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;
let ing: Record<string, IngredientDto>;
let loc: Record<'fridge' | 'freezer' | 'cupboard', LocationDto>;

beforeEach(async () => {
  t = await makeTestApp({
    off: new FakeOff({
      '5001': { name: 'Chicken Thighs', quantity: '600g' },
      '5002': { name: 'Baby Spinach', quantity: '200g' },
      '5003': { name: 'Basmati Rice', quantity: '1kg' },
      '5004': { name: 'Beef Mince', quantity: '500g' },
    }),
  });
  api = await setupAdmin(t.app);
  ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
  loc = Object.fromEntries((await api.get<LocationDto[]>('/api/locations')).map((l) => [l.type, l])) as typeof loc;
});
afterEach(async () => {
  await t.close();
});

const recipe = (title: string, lines: [string, number][], extra: Record<string, unknown> = {}) =>
  api.post<RecipeDto>('/api/recipes', {
    title,
    serves: 2,
    ingredients: lines.map(([key, grams]) => ({ text: `${grams}g ${key}`, amount: grams, unit: 'g', ingredientId: ing[key]!.id })),
    ...extra,
  });

async function stockUp() {
  const chicken = await api.post<ScanAddResult>('/api/scan/add', { barcode: '5001', locationId: loc.fridge.id });
  await api.patch(`/api/stock/${chicken.change.item.id}`, { bestBefore: '2026-11-14' });
  const spinach = await api.post<ScanAddResult>('/api/scan/add', { barcode: '5002', locationId: loc.fridge.id });
  await api.patch(`/api/stock/${spinach.change.item.id}`, { bestBefore: '2026-11-13' });
  await api.post('/api/scan/add', { barcode: '5003', locationId: loc.cupboard.id });
}

describe('optimiser', () => {
  it('scores recipes for Cook now, Nearly there and Use it up', async () => {
    await stockUp();
    const curry = await recipe('Chicken & spinach curry', [['chicken_thighs', 500], ['spinach', 200], ['rice', 150]]);
    const flatbreads = await recipe('Spinach & yogurt flatbreads', [['spinach', 100], ['greek_yogurt', 170]]);
    const chilli = await recipe('Chilli', [['beef_mince', 500], ['rice', 150]]);
    const { scores } = await api.get<{ scores: RecipeScore[] }>('/api/optimiser/recipes');
    const by = Object.fromEntries(scores.map((s) => [s.recipeId, s]));
    expect(by[curry.id]).toMatchObject({ cookNow: true, missing: [] });
    expect(by[curry.id]!.reason).toBe('Uses the chicken thighs going off Saturday and the spinach going off tomorrow.');
    expect(by[flatbreads.id]).toMatchObject({ cookNow: false, missing: [{ name: 'Greek yogurt', grams: 170 }] });
    expect(by[chilli.id]).toMatchObject({ cookNow: false, missing: [{ name: 'Beef mince' }] });
    expect(by[curry.id]!.score).toBeGreaterThan(by[flatbreads.id]!.score);
    expect(by[flatbreads.id]!.score).toBeGreaterThan(by[chilli.id]!.score);
  });

  it('suggests meals, skipping recent recipes and excluded tags', async () => {
    await stockUp();
    const curry = await recipe('Curry', [['chicken_thighs', 500], ['spinach', 200]]);
    const pud = await recipe('Spinach pudding', [['spinach', 200]], { tags: ['dessert'] });
    await recipe('Rice', [['rice', 150]]);
    await api.patch('/api/household', { settings: { excludedTags: ['dessert'] } });
    let s = await api.get<{ recipes: RecipeScore[] }>('/api/optimiser/suggest');
    expect(s.recipes[0]!.recipeId).toBe(curry.id);
    expect(s.recipes.some((r) => r.recipeId === pud.id)).toBe(false);
    // Cooked it: not suggested again within the no-repeat window.
    const plan = await api.get<CookPlanDto>(`/api/recipes/${curry.id}/cook-plan`);
    await api.post<CookResultDto>(`/api/recipes/${curry.id}/cook`, { servings: 2, lines: plan.lines.map((l) => ({ takes: l.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams! })) })) });
    s = await api.get<{ recipes: RecipeScore[] }>('/api/optimiser/suggest');
    expect(s.recipes.some((r) => r.recipeId === curry.id)).toBe(false);
  });

  it('plans the week around what will go off, using leftovers first', async () => {
    await stockUp();
    const mince = await api.post<ScanAddResult>('/api/scan/add', { barcode: '5004', locationId: loc.fridge.id });
    await api.patch(`/api/stock/${mince.change.item.id}`, { bestBefore: '2026-11-16' });
    const curry = await recipe('Curry', [['chicken_thighs', 500], ['spinach', 200], ['rice', 150]]);
    const chilli = await recipe('Chilli', [['beef_mince', 500], ['rice', 150]]);
    await recipe('Plain rice', [['rice', 150]]);
    const picks = await api.post<{ date: string; kind: string; recipeId: string | null; title: string; reason: string }[]>('/api/optimiser/plan-week', {
      from: '2026-11-12',
      to: '2026-11-14',
      slots: ['dinner'],
    });
    expect(picks.map((p) => [p.date, p.recipeId])).toEqual([
      ['2026-11-12', curry.id],
      ['2026-11-13', chilli.id],
      ['2026-11-14', expect.any(String)],
    ]);
    // Slots already planned are left alone.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'text', text: 'Out for dinner' });
    const again = await api.post<{ date: string }[]>('/api/optimiser/plan-week', { from: '2026-11-12', to: '2026-11-13', slots: ['dinner'] });
    expect(again.map((p) => p.date)).toEqual(['2026-11-13']);
  });

  it('reports surplus left after the plan, with ideas to use it', async () => {
    await stockUp();
    const curry = await recipe('Curry', [['chicken_thighs', 500], ['spinach', 200]]);
    const hints = await api.get<{ name: string; grams: number; ideas: number; topIdea: { recipeId: string } | null }[]>('/api/optimiser/surplus');
    expect(hints.find((h) => h.name === 'Chicken thighs')).toMatchObject({ grams: 600, ideas: 1, topIdea: { recipeId: curry.id } });
    // Planning the curry uses it up.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'recipe', recipeId: curry.id, servings: 2 });
    const after = await api.get<{ name: string; grams: number }[]>('/api/optimiser/surplus');
    expect(after.find((h) => h.name === 'Chicken thighs')?.grams).toBe(100);
    expect(after.find((h) => h.name === 'Spinach')).toBeUndefined();
  });
});
