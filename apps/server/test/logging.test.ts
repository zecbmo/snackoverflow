/** Log food: one search across everything, logging as eaten (asking about stock), and per-person ticks. */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BarcodeFoodDto,
  CalorieStatsDto,
  FoodSuggestionsDto,
  OffSearchDto,
  SavedMealDto,
  StockChangeDto,
  FoodResultDto,
  IngredientDto,
  InviteDto,
  LocationDto,
  PlanDto,
  PlanEatDto,
  PlanEntryDto,
  ProductDto,
  RecipeDto,
  SessionDto,
  StockItemDto,
} from '@snackoverflow/shared';
import { loadChainSeed, syncChains } from '../src/services/chains';
import { type Client, client, cookieFrom, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let off: FakeOff;
let api: Client;
let me: SessionDto;
let loc: Record<'fridge' | 'freezer' | 'cupboard', LocationDto>;
let ing: Record<string, IngredientDto>;

beforeEach(async () => {
  off = new FakeOff({
    '5000159407236': { name: 'Snickers', brand: 'Mars', quantity: '48 g', nutritionPer100g: { kcal: 488, protein: 8.6, carbs: 60.5, fat: 23.5 } },
    '5000159461122': { name: 'Snickers Duo', brand: 'Mars', quantity: '83.4 g', nutritionPer100g: { kcal: 488 } },
  });
  t = await makeTestApp({ off });
  await syncChains(t.ctx.db, loadChainSeed(fileURLToPath(new URL('./fixtures/chains', import.meta.url))).chains);
  api = await setupAdmin(t.app);
  me = await api.get<SessionDto>('/api/session');
  loc = Object.fromEntries((await api.get<LocationDto[]>('/api/locations')).map((l) => [l.type, l])) as typeof loc;
  ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
});
afterEach(async () => {
  await t.close();
});

async function invite(name: string) {
  const inv = await api.post<InviteDto>('/api/invites', { role: 'member' });
  const res = await client(t.app).raw('POST', `/api/invites/${inv.url.split('/invite/')[1]}/accept`, { name, email: `${name.toLowerCase()}@example.com`, password: 'a password' });
  return client(t.app, cookieFrom(res));
}

const search = (q: string) => api.get<FoodResultDto[]>(`/api/foods/search?q=${encodeURIComponent(q)}`);
const day = (c: Client, date = '2026-11-12') => c.get<PlanDto>(`/api/plan?from=${date}&to=${date}`).then((p) => p.days[0]!);

async function yoghurts(count = 2) {
  const p = await api.post<ProductDto>('/api/products', {
    name: 'Greek yoghurt pot',
    packAmount: 150,
    packUnit: 'g',
    nutritionPer100g: { kcal: 100 },
  });
  await api.post('/api/stock', { productId: p.id, locationId: loc.fridge.id, count });
  return p;
}

describe('food search', () => {
  it('finds stock, recipes, generic foods and takeaway menus in one go', async () => {
    await yoghurts();
    await api.post<RecipeDto>('/api/recipes', { title: 'Banana bread', serves: 8, ingredients: [] });
    const bananas = await search('banana');
    expect(bananas.map((r) => [r.source, r.title])).toEqual([
      ['recipe', 'Banana bread'],
      ['ingredient', 'Bananas'],
    ]);
    // A generic food is measured by the item when it's sold that way.
    expect(bananas[1]).toMatchObject({ servingLabel: '1 banana (120g)', unitGrams: 120, kcalPerServing: 107, countUnit: 'banana', inStock: null });

    const yog = await search('yoghurt');
    expect(yog[0]).toMatchObject({ source: 'stock', title: 'Greek yoghurt pot', kcalPerServing: 150, inStock: { packs: 2, locationName: 'Fridge' } });

    const burger = await search('barn burger');
    expect(burger[0]).toMatchObject({ source: 'chain', title: 'Barn Burger', subtitle: 'Burger Barn · Burgers', kcalPerServing: 540, servingLabel: '1 burger' });
  });

  it('shows what is in the kitchen before anything is typed', async () => {
    await yoghurts(1);
    const r = await search('');
    expect(r.map((x) => x.source)).toEqual(['stock']);
  });
});

describe('logging as eaten', () => {
  it('logs a takeaway with a copy of its calories', async () => {
    const [item] = await search('barn burger');
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'chain', chainItemId: item!.id, eaten: true });
    expect(e).toMatchObject({ kind: 'chain', title: 'Barn Burger', detail: 'Burger Barn', kcal: 540, eaten: true, status: 'cooked' });
    expect(await day(api)).toMatchObject({ eatenKcal: 540, plannedKcal: 0 });
  });

  it('logs a generic food by the item', async () => {
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'ingredient', ingredientId: ing.bananas!.id, servings: 2, eaten: true });
    expect(e).toMatchObject({ title: 'Bananas', countUnit: 'banana', unitGrams: 120, kcal: 214, eaten: true });
  });

  it('takes it from stock only when asked, and Undo puts it back', async () => {
    const p = await yoghurts(2);
    const taken = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'product', productId: p.id, eaten: true, fromStock: true });
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(1);
    await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'product', productId: p.id, eaten: true, fromStock: false });
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(1);
    expect((await day(api)).eatenKcal).toBe(300);
    // Undo: the meal goes and the yoghurt comes back.
    expect(await api.del<{ restored: number }>(`/api/plan/${taken.id}?restoreStock=1`)).toMatchObject({ restored: 1 });
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(2);
    expect((await day(api)).eatenKcal).toBe(150);
  });

  it('takes a generic food from any pack of it', async () => {
    const p = await api.post<ProductDto>('/api/products', { name: 'Fairtrade bananas', ingredientId: ing.bananas!.id, packAmount: 5, packUnit: 'count' });
    await api.post('/api/stock', { productId: p.id, locationId: loc.cupboard.id });
    expect((await search('bananas')).find((r) => r.source === 'ingredient')?.inStock).toEqual({ packs: 1, locationName: 'Cupboard' });
    await api.post('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'ingredient', ingredientId: ing.bananas!.id, eaten: true, fromStock: true });
    const [left] = await api.get<StockItemDto[]>('/api/stock');
    expect(left!.remainingGrams).toBe(480);
  });
});

describe('each person ticks their own portion', () => {
  it('counts calories only for the people who have eaten, and anyone can tick for anyone', async () => {
    const sam = await invite('Sam');
    const samId = (await sam.get<SessionDto>('/api/session')).user.id;
    const e = await api.post<PlanEntryDto>('/api/plan', {
      date: '2026-11-12',
      slot: 'dinner',
      kind: 'text',
      text: 'Lasagne',
      kcalPerServing: 600,
      servings: 2,
      people: [
        { userId: me.user.id, portions: 1 },
        { userId: samId, portions: 1 },
      ],
    });
    expect(await day(api)).toMatchObject({ eatenKcal: 0, plannedKcal: 600 });

    // I had mine.
    const mine = await api.post<PlanEatDto>(`/api/plan/${e.id}/eat`, {});
    expect(mine.entry).toMatchObject({ eaten: true, status: 'planned' });
    expect(await day(api)).toMatchObject({ eatenKcal: 600, plannedKcal: 0 });
    expect(await day(sam)).toMatchObject({ eatenKcal: 0, plannedKcal: 600 });

    // I tick Sam's for them; now everyone's eaten, so the meal's done.
    const theirs = await api.post<PlanEatDto>(`/api/plan/${e.id}/eat`, { people: [samId] });
    expect(theirs.entry.status).toBe('cooked');
    expect(await day(sam)).toMatchObject({ eatenKcal: 600, plannedKcal: 0 });

    // Sam didn't have it after all.
    await sam.post(`/api/plan/${e.id}/uneat`, {});
    expect(await day(sam)).toMatchObject({ eatenKcal: 0, plannedKcal: 600 });
    expect(await day(api)).toMatchObject({ eatenKcal: 600 });

    // The dashboard counts only what's eaten.
    expect((await api.get<CalorieStatsDto>('/api/stats/calories')).days.at(-1)).toMatchObject({ date: '2026-11-12', kcal: 600 });
  });

  it('gives a free portion to whoever ticks it', async () => {
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'text', text: 'Soup', kcalPerServing: 200, servings: 2 });
    const r = await api.post<PlanEatDto>(`/api/plan/${e.id}/eat`, {});
    expect(r.entry.people).toEqual([expect.objectContaining({ userId: me.user.id, portions: 2, eaten: true })]);
    expect((await day(api)).eatenKcal).toBe(400);
  });

  it('skipping clears the ticks', async () => {
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'text', text: 'Soup', kcalPerServing: 200, eaten: true });
    await api.patch(`/api/plan/${e.id}`, { status: 'skipped' });
    expect(await day(api)).toMatchObject({ eatenKcal: 0, plannedKcal: 0 });
  });
});

describe('macros', () => {
  it("copies a takeaway's macros and adds up what was eaten each day", async () => {
    const [burger] = await search('barn burger');
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'chain', chainItemId: burger!.id, servings: 2, eaten: true });
    expect(e.nutritionPerServing).toMatchObject({ protein: 28, carbs: 44, fat: 27 });
    // A note with only calories counts as missing macros.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'text', text: 'Crisps', kcalPerServing: 130, eaten: true });
    // Planned food doesn't count.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'ingredient', ingredientId: ing.bananas!.id });
    expect((await day(api)).eatenMacros).toEqual({ protein: 56, carbs: 88, fat: 54, missing: 1 });
  });
});

describe('suggestions, favourites and saved meals', () => {
  const logBanana = (date: string, servings = 1) =>
    api.post<PlanEntryDto>('/api/plan', { date, slot: 'snack', kind: 'ingredient', ingredientId: ing.bananas!.id, servings, eaten: true });

  it('suggests what you usually have at a meal, with your usual amount, and what you had lately', async () => {
    await logBanana('2026-11-10');
    t.setNow('2026-11-12T12:01:00Z');
    await logBanana('2026-11-11', 2);
    const [burger] = await search('barn burger');
    t.setNow('2026-11-12T12:02:00Z');
    await api.post('/api/plan', { date: '2026-11-11', slot: 'lunch', kind: 'chain', chainItemId: burger!.id, eaten: true });
    t.setNow('2026-11-12T12:03:00Z');
    await api.post('/api/plan', { date: '2026-11-11', slot: 'lunch', kind: 'text', text: 'Office cake', kcalPerServing: 350, eaten: true });
    const s = await api.get<FoodSuggestionsDto>('/api/foods/suggestions?slot=snack');
    expect(s.usual.map((r) => [r.title, r.usualServings])).toEqual([['Bananas', 2]]);
    expect(s.recent.map((r) => r.title)).toEqual(['Office cake', 'Barn Burger']);
    expect(s.recent[0]).toMatchObject({ source: 'quick', kcalPerServing: 350 });
    // Search knows your usual amount too.
    expect((await search('banana')).find((r) => r.source === 'ingredient')?.usualServings).toBe(2);
  });

  it('stars foods to find them first', async () => {
    const p = await yoghurts(1);
    await api.post('/api/foods/favourites', { kind: 'product', id: p.id, on: true });
    let s = await api.get<FoodSuggestionsDto>('/api/foods/suggestions');
    expect(s.favourites.map((r) => [r.title, r.favourite, r.source])).toEqual([['Greek yoghurt pot', true, 'stock']]);
    expect((await search('yoghurt'))[0]!.favourite).toBe(true);
    await api.post('/api/foods/favourites', { kind: 'product', id: p.id, on: false });
    s = await api.get<FoodSuggestionsDto>('/api/foods/suggestions');
    expect(s.favourites).toEqual([]);
    expect((await api.raw('POST', '/api/foods/favourites', { kind: 'recipe', id: p.id, on: true })).statusCode).toBe(404);
  });

  it('saves a breakfast to log again in one tap, taking from stock when asked', async () => {
    const p = await yoghurts(2);
    const a = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-11', slot: 'breakfast', kind: 'product', productId: p.id, eaten: true, fromStock: false });
    const b = await logBanana('2026-11-11');
    const meal = await api.post<SavedMealDto>('/api/foods/meals', { name: 'My usual breakfast', entryIds: [a.id, b.id] });
    expect(meal).toMatchObject({ name: 'My usual breakfast', kcal: 257, items: [{ title: 'Greek yoghurt pot' }, { title: 'Bananas' }] });
    expect((await api.get<FoodSuggestionsDto>('/api/foods/suggestions')).meals.map((m) => m.name)).toEqual(['My usual breakfast']);

    const r = await api.post<{ entries: PlanEntryDto[]; stockEventIds: string[] }>(`/api/foods/meals/${meal.id}/log`, { date: '2026-11-12', slot: 'breakfast', fromStock: true });
    expect(r.entries.map((e) => [e.title, e.eaten])).toEqual([
      ['Greek yoghurt pot', true],
      ['Bananas', true],
    ]);
    expect(r.stockEventIds).toHaveLength(1);
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(1);
    expect((await day(api)).eatenKcal).toBe(257);

    await api.del(`/api/foods/meals/${meal.id}`);
    expect((await api.get<FoodSuggestionsDto>('/api/foods/suggestions')).meals).toEqual([]);
  });
});

describe('Open Food Facts and barcodes', () => {
  it('searches Open Food Facts by name, leaving out what you already have', async () => {
    const r = await api.get<OffSearchDto>('/api/foods/off?q=snickers');
    expect(r.status).toBe('ok');
    expect(r.results[0]).toMatchObject({ source: 'off', id: '5000159407236', title: 'Snickers', subtitle: 'Mars · 48 g', kcalPerServing: 234, servingLabel: '1 pack (48 g)' });
    // Picking one makes it your product, with its nutrition.
    const picked = await api.get<BarcodeFoodDto>('/api/foods/barcode/5000159407236');
    expect(picked).toMatchObject({ named: true, food: { source: 'product', title: 'Snickers', kcalPerServing: 234 } });
    expect((await api.get<OffSearchDto>('/api/foods/off?q=snickers')).results.map((x) => x.title)).toEqual(['Snickers Duo']);
    // Now it's one of yours, ordinary search finds it.
    expect((await search('snickers'))[0]).toMatchObject({ source: 'product', title: 'Snickers' });
  });

  it("says when Open Food Facts can't be reached", async () => {
    off.down = true;
    expect(await api.get<OffSearchDto>('/api/foods/off?q=snickers')).toEqual({ status: 'unavailable', results: [] });
  });

  it('names an unknown barcode, and asks Open Food Facts again later', async () => {
    const unknown = await api.get<BarcodeFoodDto>('/api/foods/barcode/0123456789');
    expect(unknown).toMatchObject({ named: false, food: { title: 'Unnamed product', kcalPerServing: null } });
    // Open Food Facts learns it; the next scan picks it up.
    off.products['0123456789'] = { name: 'Flapjack', quantity: '90 g', nutritionPer100g: { kcal: 450 } };
    const again = await api.get<BarcodeFoodDto>('/api/foods/barcode/0123456789');
    expect(again).toMatchObject({ named: true, productId: unknown.productId, food: { title: 'Flapjack', kcalPerServing: 405 } });
  });

  it('a barcode named by hand shows its calories', async () => {
    const unknown = await api.get<BarcodeFoodDto>('/api/foods/barcode/0987654321');
    await api.patch(`/api/products/${unknown.productId}`, { name: 'Corner shop samosa', packAmount: 120, packUnit: 'g', nutritionPer100g: { kcal: 250 } });
    expect(await api.get<FoodResultDto>(`/api/foods/product/${unknown.productId}`)).toMatchObject({ title: 'Corner shop samosa', kcalPerServing: 300, servingLabel: '1 pack (120g)' });
  });
});

describe('using stock and logging it as eaten', () => {
  it('uses a pack and logs it in one go, and Undo puts both back', async () => {
    await yoghurts(2);
    const [pack] = await api.get<StockItemDto[]>('/api/stock');
    const r = await api.post<StockChangeDto>(`/api/stock/${pack!.id}/use`, { amount: { kind: 'all' }, log: { slot: 'snack', date: '2026-11-12' } });
    expect(r.entryId).toBeTruthy();
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(1);
    const d = await day(api);
    expect(d.entries[0]).toMatchObject({ title: 'Greek yoghurt pot', kcal: 150, eaten: true, servings: 1 });
    expect(d.eatenKcal).toBe(150);
    // Undo: the meal goes and the yoghurt comes back.
    await api.del(`/api/plan/${r.entryId}?restoreStock=1`);
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(2);
    expect((await day(api)).eatenKcal).toBe(0);
  });

  it('logs what was used: one apple from a bag', async () => {
    const p = await api.post<ProductDto>('/api/products', { name: 'Gala apples', ingredientId: ing.apples!.id, packAmount: 900, packUnit: 'g', nutritionPer100g: { kcal: 52 } });
    await api.post('/api/stock', { productId: p.id, locationId: loc.fridge.id });
    const [bag] = await api.get<StockItemDto[]>('/api/stock');
    const r = await api.post<StockChangeDto>(`/api/stock/${bag!.id}/use`, { amount: { kind: 'grams', grams: 150 }, log: { date: '2026-11-12' } });
    expect(r.item.remainingGrams).toBeCloseTo(750, 0);
    // The time of day picks the meal: 12:00 is lunch.
    expect((await day(api)).entries[0]).toMatchObject({ slot: 'lunch', kcal: 78, servings: 0.167 });
  });

  it('without log, a use is just a use', async () => {
    await yoghurts(1);
    const [pack] = await api.get<StockItemDto[]>('/api/stock');
    const r = await api.post<StockChangeDto>(`/api/stock/${pack!.id}/use`, { amount: { kind: 'all' } });
    expect(r.entryId).toBeUndefined();
    expect((await day(api)).entries).toEqual([]);
  });
});

describe('using from a stock row with several packs', () => {
  async function chicken() {
    const p = await api.post<ProductDto>('/api/products', { name: 'British chicken thighs', ingredientId: ing.chicken_thighs!.id, packAmount: 1000, packUnit: 'g', nutritionPer100g: { kcal: 177 } });
    await api.post('/api/stock', { productId: p.id, locationId: loc.fridge.id, bestBefore: '2026-11-14' });
    await api.post('/api/stock', { productId: p.id, locationId: loc.fridge.id, bestBefore: '2026-11-16' });
    const [open, next] = await api.get<StockItemDto[]>('/api/stock');
    // The open pack has 300g left.
    await api.post(`/api/stock/${open!.id}/use`, { amount: { kind: 'grams', grams: 700 } });
    return { open: open!, next: next! };
  }

  it('is measured in grams, not thighs', async () => {
    const { open } = await chicken();
    const [item] = (await api.get<StockItemDto[]>('/api/stock')).filter((s) => s.id === open.id);
    expect(item).toMatchObject({ displayUnit: 'g', itemGrams: null });
  });

  it('takes the rest from the next pack when the open one runs out, and Undo puts both back', async () => {
    const { open, next } = await chicken();
    const r = await api.post<StockChangeDto>(`/api/stock/${open.id}/use`, { amount: { kind: 'grams', grams: 500 } });
    expect(r.eventIds).toHaveLength(2);
    expect(r.item).toMatchObject({ id: next.id, remainingGrams: 800 });
    expect((await api.get<StockItemDto[]>('/api/stock')).map((s) => s.remainingGrams)).toEqual([800]);
    for (const e of [...r.eventIds!].reverse()) await api.post(`/api/events/${e}/undo`);
    expect((await api.get<StockItemDto[]>('/api/stock')).map((s) => s.remainingGrams)).toEqual([300, 1000]);
  });

  it('logs everything it took, from both packs', async () => {
    const { open } = await chicken();
    const r = await api.post<StockChangeDto>(`/api/stock/${open.id}/use`, { amount: { kind: 'grams', grams: 500 }, log: { date: '2026-11-12', slot: 'dinner' } });
    expect((await day(api)).entries[0]).toMatchObject({ title: 'British chicken thighs', servings: 0.5, kcal: 885 });
    await api.del(`/api/plan/${r.entryId}?restoreStock=1`);
    expect((await api.get<StockItemDto[]>('/api/stock')).map((s) => s.remainingGrams)).toEqual([300, 1000]);
  });

  it('uses what there is when asked for more', async () => {
    const { open } = await chicken();
    const r = await api.post<StockChangeDto>(`/api/stock/${open.id}/use`, { amount: { kind: 'grams', grams: 5000 } });
    expect(r.message).toContain('That was all there was');
    expect(await api.get<StockItemDto[]>('/api/stock')).toEqual([]);
  });

  it('knows how big a cup is, from the seed data', async () => {
    expect(await api.get('/api/units')).toEqual({ cupMl: 250 });
  });
});
