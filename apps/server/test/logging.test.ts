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
    // One row for the food: the bag in the kitchen, eaten a banana at a time (not a whole bag), and no second "Bananas" row.
    const found = await search('bananas');
    expect(found.find((r) => r.source === 'stock')).toMatchObject({ inStock: { packs: 1, locationName: 'Cupboard' }, eatBy: { unit: 'banana', grams: 120 } });
    expect(found.find((r) => r.source === 'ingredient')).toBeUndefined();
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
  it('searches Open Food Facts by name; a result only becomes one of your foods once you log it', async () => {
    const r = await api.get<OffSearchDto>('/api/foods/off?q=snickers');
    expect(r.status).toBe('ok');
    expect(r.results[0]).toMatchObject({ source: 'off', id: '5000159407236', title: 'Snickers', subtitle: 'Mars · 48 g', kcalPerServing: 234, servingLabel: '1 pack (48 g)' });
    // Picking one makes it a product behind the scenes (with its nutrition), so it can be logged...
    const picked = await api.get<BarcodeFoodDto>('/api/foods/barcode/5000159407236');
    expect(picked).toMatchObject({ named: true, food: { source: 'product', title: 'Snickers', kcalPerServing: 234 } });
    // ...but just looking doesn't make it one of your foods: it stays under Open Food Facts.
    expect((await api.get<OffSearchDto>('/api/foods/off?q=snickers')).results.map((x) => x.title)).toEqual(['Snickers', 'Snickers Duo']);
    expect((await search('snickers')).filter((x) => x.source === 'product')).toEqual([]);
    // Logged: now it's one of yours, ordinary search finds it, and Open Food Facts stops offering it.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'product', productId: picked.productId, eaten: true, fromStock: false });
    expect((await search('snickers'))[0]).toMatchObject({ source: 'product', title: 'Snickers' });
    expect((await api.get<OffSearchDto>('/api/foods/off?q=snickers')).results.map((x) => x.title)).toEqual(['Snickers Duo']);
  });

  it('shows calories by the 100g for a product whose pack size nobody knows', async () => {
    const p = await api.post<ProductDto>('/api/products', { name: 'Mystery ice cream', nutritionPer100g: { kcal: 220 } });
    expect(await api.get<FoodResultDto>(`/api/foods/product/${p.id}`)).toMatchObject({ kcalPerServing: 220, servingLabel: '100g', unitGrams: 100 });
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'product', productId: p.id, servings: 1.5, eaten: true, fromStock: false });
    expect(e).toMatchObject({ kcal: 330, unitGrams: 100 });
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
    expect((await day(api)).entries[0]).toMatchObject({ slot: 'lunch', kcal: 78, servings: 0.1667 });
  });

  it('without log, a use is just a use', async () => {
    await yoghurts(1);
    const [pack] = await api.get<StockItemDto[]>('/api/stock');
    const r = await api.post<StockChangeDto>(`/api/stock/${pack!.id}/use`, { amount: { kind: 'all' } });
    expect(r.entryId).toBeUndefined();
    expect((await day(api)).entries).toEqual([]);
  });
});

describe('a diary line owns the food it took', () => {
  /** One 1kg pack of chicken in the fridge, 177 kcal per 100g. */
  async function chicken() {
    const p = await api.post<ProductDto>('/api/products', { name: 'British chicken thighs', ingredientId: ing.chicken_thighs!.id, packAmount: 1000, packUnit: 'g', nutritionPer100g: { kcal: 177 } });
    await api.post('/api/stock', { productId: p.id, locationId: loc.fridge.id });
    const [pack] = await api.get<StockItemDto[]>('/api/stock');
    return { product: p, pack: pack! };
  }
  const left = async () => (await api.get<StockItemDto[]>('/api/stock')).map((s) => s.remainingGrams);
  const ate = (packId: string, grams: number, slot = 'dinner') =>
    api.post<StockChangeDto>(`/api/stock/${packId}/use`, { amount: { kind: 'grams', grams }, log: { date: '2026-11-12', slot } });

  it('unticking puts it back, and ticking again takes it once', async () => {
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    expect(await left()).toEqual([750]);
    expect((await day(api)).entries[0]).toMatchObject({ fromStock: true, stockGrams: 250, kcal: 443 });
    // Untick: the chicken goes back, and the pack is closed again as if nothing happened.
    await api.post(`/api/plan/${r.entryId}/uneat`, {});
    expect(await left()).toEqual([1000]);
    expect((await api.get<StockItemDto[]>('/api/stock'))[0]!.state).toBe('closed');
    // Tick: it remembers it's from stock, without being told.
    await api.post<PlanEatDto>(`/api/plan/${r.entryId}/eat`, {});
    expect(await left()).toEqual([750]);
    // Ticking again changes nothing: it can't be taken twice.
    await api.post<PlanEatDto>(`/api/plan/${r.entryId}/eat`, { fromStock: true });
    expect(await left()).toEqual([750]);
    expect((await day(api)).entries[0]).toMatchObject({ eaten: true, stockGrams: 250 });
  });

  it('a new amount takes or returns the difference, and counts for your calories', async () => {
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    await api.patch(`/api/plan/${r.entryId}`, { servings: 0.4 });
    expect(await left()).toEqual([600]);
    expect((await day(api)).entries[0]).toMatchObject({ kcal: 708, stockGrams: 400, people: [{ portions: 0.4, eaten: true }] });
    await api.patch(`/api/plan/${r.entryId}`, { servings: 0.1 });
    expect(await left()).toEqual([900]);
    expect((await day(api)).eatenKcal).toBe(177);
  });

  it('removing it puts the food back', async () => {
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    await api.del(`/api/plan/${r.entryId}`);
    expect(await left()).toEqual([1000]);
    expect((await day(api)).entries).toEqual([]);
  });

  it('puts it back even when the pack has changed since', async () => {
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    // Later on, someone corrects the pack: the use can't simply be undone any more.
    t.setNow('2026-11-12T18:00:00Z');
    await api.patch(`/api/stock/${pack.id}`, { remainingGrams: 700 });
    await api.del(`/api/plan/${r.entryId}`);
    expect(await left()).toEqual([950]);
  });

  it('"ate it elsewhere" puts it back; switching it on takes it again', async () => {
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    const off = await api.patch<PlanEntryDto>(`/api/plan/${r.entryId}`, { fromStock: false });
    expect(off).toMatchObject({ fromStock: false, stockGrams: 0 });
    expect(await left()).toEqual([1000]);
    expect((await day(api)).eatenKcal).toBe(443);
    const on = await api.patch<PlanEntryDto>(`/api/plan/${r.entryId}`, { fromStock: true });
    expect(on).toMatchObject({ fromStock: true, stockGrams: 250 });
    expect(await left()).toEqual([750]);
  });

  it('skipping or "not done yet" puts it back too', async () => {
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    await api.patch(`/api/plan/${r.entryId}`, { status: 'planned' });
    expect(await left()).toEqual([1000]);
  });

  it('more of the same food at the same meal adds to the line; Undo takes just that off', async () => {
    const { pack } = await chicken();
    const first = await ate(pack.id, 250);
    const second = await ate(pack.id, 100);
    expect(second.entryId).toBe(first.entryId);
    expect(second.entryWas).toBe(0.25);
    const d = await day(api);
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0]).toMatchObject({ servings: 0.35, kcal: 620, stockGrams: 350 });
    expect(await left()).toEqual([650]);
    // Undo the second one: back to the first amount.
    await api.patch(`/api/plan/${second.entryId}`, { servings: second.entryWas });
    expect(await left()).toEqual([750]);
    expect((await day(api)).entries[0]).toMatchObject({ servings: 0.25, kcal: 443 });
    // A different meal is its own line.
    const lunch = await ate(pack.id, 100, 'lunch');
    expect(lunch.entryId).not.toBe(first.entryId);
    expect(lunch.entryWas).toBeUndefined();
  });

  it('Log food adds to the line too, when asked to merge', async () => {
    const { product } = await chicken();
    const log = () => api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'product', productId: product.id, servings: 0.1, eaten: true, fromStock: true, merge: true });
    const a = await log();
    const b = await log();
    expect(b.id).toBe(a.id);
    expect(b.mergedFrom).toBe(0.1);
    expect(b).toMatchObject({ servings: 0.2, kcal: 354 });
    expect(await left()).toEqual([800]);
    // Logged without taking it (ate it elsewhere): a line of its own.
    const c = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'product', productId: product.id, servings: 0.1, eaten: true, fromStock: false, merge: true });
    expect(c.id).not.toBe(a.id);
    expect(c.fromStock).toBe(false);
    expect(await left()).toEqual([800]);
  });

  it("isn't from stock when there was nothing in stock to take", async () => {
    const { product, pack } = await chicken();
    await api.post(`/api/stock/${pack.id}/use`, { amount: { kind: 'all' } });
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'product', productId: product.id, servings: 0.25, eaten: true, fromStock: true });
    expect(e).toMatchObject({ fromStock: false, stockGrams: 0, eaten: true });
    // A pack arrives later: changing the line doesn't raid it.
    await api.post('/api/stock', { productId: product.id, locationId: loc.fridge.id });
    await api.patch(`/api/plan/${e.id}`, { servings: 0.5 });
    expect(await left()).toEqual([1000]);
  });

  it('a food set by weight can be passed to someone else, still eaten, without touching stock', async () => {
    await invite('Sam');
    const sam = (await api.get<{ id: string; name: string }[]>('/api/users')).find((u) => u.name === 'Sam')!;
    const { pack } = await chicken();
    const r = await ate(pack.id, 250);
    const moved = await api.patch<PlanEntryDto>(`/api/plan/${r.entryId}`, { people: [{ userId: sam.id, portions: 0.25 }] });
    expect(moved.people).toEqual([{ userId: sam.id, name: 'Sam', portions: 0.25, eaten: true }]);
    expect(await left()).toEqual([750]);
    expect((await day(api)).eatenKcal).toBe(0);
  });

  it('a planned snack ticked as eaten comes out of stock without being asked, and back on untick', async () => {
    const p = await yoghurts(2);
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'product', productId: p.id, servings: 1, people: [{ userId: me.user.id, portions: 1 }] });
    expect(e.fromStock).toBeNull();
    const eaten = await api.post<PlanEatDto>(`/api/plan/${e.id}/eat`, {});
    expect(eaten.entry).toMatchObject({ fromStock: true, stockGrams: 150 });
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(1);
    await api.post(`/api/plan/${e.id}/uneat`, {});
    expect(await api.get<StockItemDto[]>('/api/stock')).toHaveLength(2);
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
