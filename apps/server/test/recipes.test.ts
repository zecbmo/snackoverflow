import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CookPlanDto,
  CookResultDto,
  IngredientDto,
  LocationDto,
  RecipeDraftDto,
  RecipeDto,
  RecipeSummaryDto,
  ScanAddResult,
  StockItemDto,
} from '@snackoverflow/shared';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;
let loc: Record<'fridge' | 'freezer' | 'cupboard', LocationDto>;
let ing: Record<string, IngredientDto>;

beforeEach(async () => {
  t = await makeTestApp({
    off: new FakeOff({
      '2001': { name: 'Maris Piper Potatoes', quantity: '2.5kg' },
      '2002': { name: 'Brown Onions', quantity: '1kg' },
      '2003': { name: 'Chopped Tomatoes', quantity: '400g' },
      '2004': { name: 'Basmati Rice', quantity: '1kg' },
      '2005': { name: 'Beef Mince', quantity: '500g' },
    }),
  });
  api = await setupAdmin(t.app);
  loc = Object.fromEntries((await api.get<LocationDto[]>('/api/locations')).map((l) => [l.type, l])) as typeof loc;
  ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
});
afterEach(async () => {
  await t.close();
});

const scan = (barcode: string, locationId = loc.cupboard.id) => api.post<ScanAddResult>('/api/scan/add', { barcode, locationId });

async function chilli(): Promise<RecipeDto> {
  return api.post<RecipeDto>('/api/recipes', {
    title: 'Chilli',
    serves: 4,
    steps: ['Fry the onion.', 'Brown the mince.', 'Simmer with tomatoes.'],
    tags: ['Dinner', 'freezes well'],
    prepMinutes: 15,
    cookMinutes: 45,
    ingredients: [
      { text: '2 onions, chopped', amount: 2, unit: 'count', ingredientId: ing.onions!.id },
      { text: '500g beef mince', amount: 500, unit: 'g', ingredientId: ing.beef_mince!.id },
      { text: '1 x 400g tin chopped tomatoes', amount: 400, unit: 'g', ingredientId: ing.chopped_tomatoes!.id },
      { text: '1 tbsp olive oil', amount: 1, unit: 'tbsp', ingredientId: ing.olive_oil!.id },
      { text: 'Salt and pepper' },
    ],
  });
}

describe('recipes', () => {
  it('saves a recipe, works out grams and calories per serving', async () => {
    const r = await chilli();
    expect(r).toMatchObject({ title: 'Chilli', serves: 4, totalMinutes: 60, tags: ['dinner', 'freezes well'] });
    const grams = r.ingredients.map((l) => l.grams);
    // 2 onions at 150g each; 1 tbsp of oil at 0.92 g/ml.
    expect(grams).toEqual([300, 500, 400, 13.8, null]);
    expect(r.ingredients[0]).toMatchObject({ ingredientName: 'Onions', note: null });
    // 300g onion (40) + 500g mince (220) + 400g tomatoes (22) + 13.8g oil (884), over 4 servings.
    expect(r.kcalPerServing).toBe(Math.round((120 + 1100 + 88 + 122) / 4));
    expect(r.nutritionCoverage).toBe(0.8);
  });

  it('lists, updates and deletes', async () => {
    const r = await chilli();
    expect(await api.get<RecipeSummaryDto[]>('/api/recipes')).toMatchObject([{ id: r.id, title: 'Chilli', ingredientCount: 5 }]);
    const updated = await api.put<RecipeDto>(`/api/recipes/${r.id}`, { title: 'Big chilli', serves: 8, ingredients: [{ text: '1kg beef mince', amount: 1, unit: 'kg', ingredientId: ing.beef_mince!.id }] });
    expect(updated).toMatchObject({ title: 'Big chilli', serves: 8 });
    expect(updated.ingredients.map((l) => l.grams)).toEqual([1000]);
    await api.del(`/api/recipes/${r.id}`);
    expect(await api.get('/api/recipes')).toEqual([]);
  });

  it('reads typed lines and suggests ingredients', async () => {
    const drafts = await api.post<RecipeDraftDto['ingredients']>('/api/recipes/parse-lines', {
      lines: ['2 large Maris Pipers, peeled', '1 x 400g tin chopped tomatoes', 'a pinch of saffron', ''],
    });
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toMatchObject({ amount: 2, unit: 'count', ingredientName: 'Potatoes', note: 'peeled' });
    expect(drafts[1]).toMatchObject({ amount: 400, unit: 'g', ingredientName: 'Chopped tomatoes' });
    expect(drafts[2]).toMatchObject({ ingredientId: null, matchConfidence: 'none' });
  });

  it('validates input', async () => {
    expect((await api.raw('POST', '/api/recipes', { title: '' })).statusCode).toBe(400);
    expect((await api.raw('GET', '/api/recipes/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('cooking', () => {
  it('plans deductions from the packs that go off first', async () => {
    const r = await chilli();
    const older = await scan('2002', loc.cupboard.id); // 1kg onions
    await api.patch(`/api/stock/${older.change.item.id}`, { bestBefore: '2026-11-14' });
    await scan('2002', loc.cupboard.id);
    await scan('2005', loc.fridge.id); // 500g mince
    const plan = await api.get<CookPlanDto>(`/api/recipes/${r.id}/cook-plan?servings=2`);
    expect(plan).toMatchObject({ servings: 2, serves: 4 });
    const [onions, mince, tomatoes, , salt] = plan.lines;
    expect(onions).toMatchObject({ neededGrams: 150, shortGrams: 0 });
    expect(onions!.takes).toEqual([expect.objectContaining({ stockItemId: older.change.item.id, grams: 150 })]);
    expect(mince).toMatchObject({ neededGrams: 250, shortGrams: 0 });
    expect(tomatoes).toMatchObject({ neededGrams: 200, shortGrams: 200, takes: [] });
    expect(salt).toMatchObject({ neededGrams: null, takes: [] });
  });

  it('cooks: deducts stock, asks about opened packs, keeps leftovers, and can be undone', async () => {
    const r = await chilli();
    const onions = await scan('2002');
    const mince = await scan('2005', loc.fridge.id);
    const tins = await scan('2003');
    const plan = await api.get<CookPlanDto>(`/api/recipes/${r.id}/cook-plan`);
    const result = await api.post<CookResultDto>(`/api/recipes/${r.id}/cook`, {
      servings: 4,
      lines: plan.lines.map((l) => ({ takes: l.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams ?? undefined })) })),
      leftovers: [{ locationId: loc.fridge.id, portions: 2 }],
    });
    // The onion bag was used in part and was closed: ask if it's opened now.
    expect(result.askOpened.map((i) => i.id)).toEqual([onions.change.item.id]);
    // Mince and the tin were used up.
    const stock = await api.get<StockItemDto[]>('/api/stock');
    expect(stock.find((s) => s.id === mince.change.item.id)).toBeUndefined();
    expect(stock.find((s) => s.id === tins.change.item.id)).toBeUndefined();
    expect(stock.find((s) => s.id === onions.change.item.id)?.remainingGrams).toBe(700);
    // Leftovers: 2 portions in the fridge, eat within 2 days.
    expect(result.leftovers).toHaveLength(1);
    expect(result.leftovers[0]).toMatchObject({ productName: 'Chilli', isMeal: true, locationType: 'fridge', bestBefore: '2026-11-14', state: 'closed' });
    // Undo puts everything back.
    await api.post(`/api/cooks/${result.cookId}/undo`);
    const after = await api.get<StockItemDto[]>('/api/stock');
    expect(after.map((s) => s.id).sort()).toEqual([onions.change.item.id, mince.change.item.id, tins.change.item.id].sort());
    expect(after.find((s) => s.id === onions.change.item.id)?.remainingGrams).toBe(1000);
  });

  it('batch cooks into fridge and freezer portions, rice dishes keeping 1 day', async () => {
    const r = await api.post<RecipeDto>('/api/recipes', {
      title: 'Egg fried rice',
      serves: 2,
      ingredients: [{ text: '200g basmati rice', amount: 200, unit: 'g', ingredientId: ing.rice!.id }],
    });
    await scan('2004');
    const plan = await api.get<CookPlanDto>(`/api/recipes/${r.id}/cook-plan?servings=6`);
    expect(plan.lines[0]!.neededGrams).toBe(600);
    expect(plan.portionGrams).toBe(100);
    const result = await api.post<CookResultDto>(`/api/recipes/${r.id}/cook`, {
      servings: 6,
      lines: [{ takes: plan.lines[0]!.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams! })) }],
      leftovers: [
        { locationId: loc.fridge.id, portions: 2 },
        { locationId: loc.freezer.id, portions: 4 },
      ],
    });
    const [fridge, freezer] = result.leftovers;
    expect(fridge).toMatchObject({ locationType: 'fridge', bestBefore: '2026-11-13', remainingGrams: 200 });
    expect(freezer).toMatchObject({ locationType: 'freezer', state: 'frozen', remainingGrams: 400, bestBefore: '2026-12-12' });
  });

  it('refuses to undo a cook after its food has changed', async () => {
    const r = await chilli();
    const onions = await scan('2002');
    const plan = await api.get<CookPlanDto>(`/api/recipes/${r.id}/cook-plan`);
    const result = await api.post<CookResultDto>(`/api/recipes/${r.id}/cook`, {
      servings: 4,
      lines: [{ takes: plan.lines[0]!.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams! })) }],
    });
    await api.post(`/api/stock/${onions.change.item.id}/use`, { amount: { kind: 'fraction', fraction: 0.5 } });
    expect((await api.raw('POST', `/api/cooks/${result.cookId}/undo`, {})).statusCode).toBe(409);
  });
});
