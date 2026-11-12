import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BuildListResultDto,
  CookPlanDto,
  CookResultDto,
  EarmarkDto,
  EatResultDto,
  IngredientDto,
  InviteDto,
  LocationDto,
  PlanDto,
  PlanEntryDto,
  ProductDto,
  RecipeDto,
  RunningLowDto,
  ScanAddResult,
  SessionDto,
  ShoppingItemDto,
  StockItemDto,
} from '@snackoverflow/shared';
import { runNotifications } from '../src/notify/notifications';
import { type Client, client, cookieFrom, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;
let me: SessionDto;
let loc: Record<'fridge' | 'freezer' | 'cupboard', LocationDto>;
let ing: Record<string, IngredientDto>;

beforeEach(async () => {
  t = await makeTestApp({
    off: new FakeOff({
      '3001': { name: 'Snickers', quantity: '48g', nutritionPer100g: { kcal: 488 } },
      '3002': { name: 'Maris Piper Potatoes', quantity: '2.5kg' },
      '3003': { name: 'Semi Skimmed Milk', quantity: '1 pint' },
    }),
  });
  api = await setupAdmin(t.app);
  me = await api.get<SessionDto>('/api/session');
  loc = Object.fromEntries((await api.get<LocationDto[]>('/api/locations')).map((l) => [l.type, l])) as typeof loc;
  ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
});
afterEach(async () => {
  await t.close();
});

const fishPie = () =>
  api.post<RecipeDto>('/api/recipes', {
    title: 'Fish pie',
    serves: 2,
    ingredients: [{ text: '100g potatoes', amount: 100, unit: 'g', ingredientId: ing.potatoes!.id }],
  });

async function invite(name: string) {
  const inv = await api.post<InviteDto>('/api/invites', { role: 'member' });
  const res = await client(t.app).raw('POST', `/api/invites/${inv.url.split('/invite/')[1]}/accept`, { name, email: `${name.toLowerCase()}@example.com`, password: 'a password' });
  return client(t.app, cookieFrom(res));
}

describe('planner', () => {
  it("plans a meal for two and gives each person their share of the calories", async () => {
    const sam = await invite('Sam');
    const samId = (await sam.get<SessionDto>('/api/session')).user.id;
    const r = await api.post<RecipeDto>('/api/recipes', {
      title: 'Porridge',
      serves: 2,
      ingredients: [{ text: '100g oats', amount: 100, unit: 'g', ingredientId: ing.oats!.id }],
    });
    // 100g oats at 375 kcal over 2 servings.
    expect(r.kcalPerServing).toBe(188);
    await api.post<PlanEntryDto>('/api/plan', {
      date: '2026-11-12',
      slot: 'breakfast',
      kind: 'recipe',
      recipeId: r.id,
      servings: 2,
      people: [
        { userId: me.user.id, portions: 1.5 },
        { userId: samId, portions: 0.5 },
      ],
    });
    const mine = await api.get<PlanDto>('/api/plan?from=2026-11-12&to=2026-11-12');
    expect(mine.days[0]!.entries[0]).toMatchObject({ title: 'Porridge', kcal: 282, people: [{ name: 'Alex' }, { name: 'Sam' }] });
    expect(mine.days[0]!.kcal).toBe(282);
    const everyone = await api.get<PlanDto>('/api/plan?from=2026-11-12&to=2026-11-12&person=everyone');
    expect(everyone.days[0]!.kcal).toBe(376);
    // Sam sees it on their calendar too, with their share.
    const sams = await sam.get<PlanDto>('/api/plan?from=2026-11-12&to=2026-11-12');
    expect(sams.days[0]!.entries[0]!.kcal).toBe(94);
    // Members can't look at, or plan on, someone else's calendar.
    expect((await sam.raw('GET', `/api/plan?person=${me.user.id}`)).statusCode).toBe(403);
    expect((await sam.raw('POST', '/api/plan', { date: '2026-11-13', slot: 'lunch', kind: 'text', text: 'Soup', people: [{ userId: me.user.id, portions: 1 }] })).statusCode).toBe(403);
  });

  it('logs a scanned snack in Eat mode, with calories, and takes it out of stock', async () => {
    const added = await api.post<ScanAddResult>('/api/scan/add', { barcode: '3001', locationId: loc.cupboard.id });
    t.setNow('2026-11-12T15:40:00Z');
    const r = await api.post<EatResultDto>('/api/scan/eat', { barcode: '3001' });
    expect(r.entry).toMatchObject({ title: 'Snickers', slot: 'snack', status: 'cooked', source: 'scan', detail: 'Scanned', kcal: 234 });
    expect(r.change?.item.id).toBe(added.change.item.id);
    expect(await api.get<StockItemDto[]>('/api/stock')).toEqual([]);
  });

  it('logs something eaten that was never in stock', async () => {
    t.setNow('2026-11-12T08:10:00Z');
    const r = await api.post<EatResultDto>('/api/scan/eat', { barcode: '3001' });
    expect(r.entry).toMatchObject({ slot: 'breakfast', kcal: 234 });
    expect(r.change).toBeNull();
  });

  it('plans food by the item or by weight, and eats exactly that much', async () => {
    // A four-bar multipack: one item is one bar.
    const multipack = await api.post<ProductDto>('/api/products', { name: 'Snickers 4 pack', packAmount: 192, packUnit: 'g', portionGrams: 48, nutritionPer100g: { kcal: 488 } });
    expect(multipack.portionGrams).toBe(48);
    await api.post('/api/stock', { productId: multipack.id, locationId: loc.cupboard.id });
    const bar = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'snack', kind: 'product', productId: multipack.id, servings: 1 });
    expect(bar).toMatchObject({ unitGrams: 48, kcal: 234 });
    await api.post(`/api/plan/${bar.id}/eat`, {});
    expect((await api.get<StockItemDto[]>('/api/stock')).find((s) => s.productId === multipack.id)?.remainingGrams).toBe(144);
    // Potatoes by weight: 750g of a 2.5kg bag is 0.3 of an item.
    const spuds = await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002' });
    const mash = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'product', productId: spuds.product.id, servings: 0.3 });
    expect(mash.unitGrams).toBe(2500);
    await api.post(`/api/plan/${mash.id}/eat`, {});
    expect((await api.get<StockItemDto[]>('/api/stock')).find((s) => s.id === spuds.change.item.id)?.remainingGrams).toBe(1750);
  });

  it('plans leftovers and eats them from the fridge', async () => {
    const pie = await fishPie();
    await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002' });
    const plan = await api.get<CookPlanDto>(`/api/recipes/${pie.id}/cook-plan`);
    const cooked = await api.post<CookResultDto>(`/api/recipes/${pie.id}/cook`, {
      servings: 2,
      lines: [{ takes: plan.lines[0]!.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams! })) }],
      leftovers: [{ locationId: loc.fridge.id, portions: 2 }],
    });
    const leftover = cooked.leftovers[0]!;
    const entry = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-13', slot: 'lunch', kind: 'stock', stockItemId: leftover.id, servings: 1 });
    expect(entry).toMatchObject({ title: 'Leftover fish pie', detail: 'From fridge' });
    await api.post(`/api/plan/${entry.id}/eat`, {});
    const after = (await api.get<StockItemDto[]>('/api/stock')).find((s) => s.id === leftover.id);
    expect(after?.remainingGrams).toBe(50);
  });

  it('cooking a planned meal marks it cooked; undoing the cook plans it again', async () => {
    const pie = await fishPie();
    await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002' });
    const entry = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 2 });
    const plan = await api.get<CookPlanDto>(`/api/recipes/${pie.id}/cook-plan`);
    const cooked = await api.post<CookResultDto>(`/api/recipes/${pie.id}/cook`, {
      servings: 2,
      mealPlanEntryId: entry.id,
      lines: [{ takes: plan.lines[0]!.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams! })) }],
    });
    expect((await api.get<PlanEntryDto>(`/api/plan/${entry.id}`)).status).toBe('cooked');
    await api.post(`/api/cooks/${cooked.cookId}/undo`);
    expect((await api.get<PlanEntryDto>(`/api/plan/${entry.id}`)).status).toBe('planned');
  });

  it('earmarks food for planned meals', async () => {
    const pie = await fishPie();
    await api.post('/api/plan', { date: '2026-11-14', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 4 });
    await api.post('/api/plan', { date: '2026-11-01', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 4 });
    const marks = await api.get<EarmarkDto[]>('/api/plan/earmarks');
    expect(marks).toEqual([{ ingredientId: ing.potatoes!.id, grams: 200, meals: [expect.objectContaining({ title: 'Fish pie', date: '2026-11-14', grams: 200 })] }]);
  });

  it('sends "Cooking … tonight?" at dinner time with Cooked it / Skip / Move', async () => {
    const pie = await fishPie();
    const entry = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 2 });
    t.setNow('2026-11-12T17:30:00Z');
    expect((await runNotifications(t.ctx)).app).toBe(0);
    t.setNow('2026-11-12T18:05:00Z');
    await runNotifications(t.ctx);
    const inbox = await api.get<{ items: { title: string; actions: { action: string }[]; data: Record<string, unknown> }[] }>('/api/notifications');
    const prompt = inbox.items.find((i) => i.title === 'Cooking Fish pie tonight?');
    expect(prompt?.actions.map((a) => a.action)).toEqual(['cooked', 'skip', 'move']);
    expect(prompt?.data).toMatchObject({ entryId: entry.id, recipeId: pie.id });
    // Once only.
    t.setNow('2026-11-12T18:30:00Z');
    expect((await runNotifications(t.ctx)).app).toBe(0);
    await api.patch(`/api/plan/${entry.id}`, { status: 'skipped' });
    expect((await api.get<PlanEntryDto>(`/api/plan/${entry.id}`)).status).toBe('skipped');
  });
});

describe('shopping list', () => {
  it('builds the list from the plan, rounded up to whole packs', async () => {
    const pie = await fishPie();
    await api.post('/api/plan', { date: '2026-11-13', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 2 });
    const r = await api.post<BuildListResultDto>('/api/shopping/build', { from: '2026-11-12', to: '2026-11-18' });
    expect(r).toMatchObject({ added: 1, covered: 0 });
    expect(r.surplus).toEqual([{ ingredientId: ing.potatoes!.id, name: 'Potatoes', grams: 900 }]);
    const list = await api.get<ShoppingItemDto[]>('/api/shopping');
    // 100g of potatoes and none in stock: buy the smallest bag (1kg) and know 900g will be spare.
    expect(list).toEqual([
      expect.objectContaining({ text: 'Potatoes', aisle: 'Veg', foodGroup: 'Vegetables', reason: 'plan', packs: 1, packGrams: 1000, packLabel: '1kg', needLabel: '100g', surplusGrams: 900, surplusLabel: '900g', forMeals: 'Fish pie', grams: 100 }),
    ]);
    // Rebuilding updates rather than duplicating; with potatoes in stock it's covered.
    await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002' });
    const again = await api.post<BuildListResultDto>('/api/shopping/build', { from: '2026-11-12', to: '2026-11-18' });
    expect(again).toMatchObject({ added: 0, covered: 1 });
    expect(await api.get('/api/shopping')).toEqual([]);
  });

  it("shows what the plan is short by on items added by hand too", async () => {
    // The plan wants 520g of tomatoes; 500g are in stock and a pack was added to the list by hand.
    const salad = await api.post<RecipeDto>('/api/recipes', {
      title: 'Tomato salad',
      serves: 2,
      ingredients: [{ text: '520g tomatoes', amount: 520, unit: 'g', ingredientId: ing.tomatoes!.id }],
    });
    const vine = await api.post<ProductDto>('/api/products', { name: 'Vine Tomatoes', packAmount: 500, packUnit: 'g', ingredientId: ing.tomatoes!.id });
    expect(vine.foodGroup).toBe('Vegetables');
    await api.post('/api/stock', { productId: vine.id, locationId: loc.fridge.id });
    expect((await api.get<StockItemDto[]>('/api/stock')).find((s) => s.productId === vine.id)?.foodGroup).toBe('Vegetables');
    await api.post('/api/plan', { date: '2026-11-13', slot: 'lunch', kind: 'recipe', recipeId: salad.id, servings: 2 });
    await api.post('/api/shopping', { productId: vine.id });
    const item = (await api.get<ShoppingItemDto[]>('/api/shopping')).find((i) => i.productId === vine.id);
    expect(item).toMatchObject({ reason: 'manual', needLabel: '20g', foodGroup: 'Vegetables' });
    // A product can have its own category.
    const snack = await api.patch<ProductDto>(`/api/products/${vine.id}`, { foodGroup: 'Snacks' });
    expect(snack).toMatchObject({ foodGroup: 'Snacks', ownFoodGroup: 'Snacks' });
  });

  it('adds manual items, merges duplicates, ticks and clears', async () => {
    await api.post('/api/shopping', { text: 'Birthday candles' });
    await api.post('/api/shopping', { ingredientId: ing.milk!.id });
    const { items } = await api.post<{ items: ShoppingItemDto[] }>('/api/shopping', { ingredientId: ing.milk!.id });
    expect(items).toHaveLength(2);
    const milk = items.find((i) => i.text === 'Milk')!;
    expect(milk).toMatchObject({ packs: 2, aisle: 'Dairy', addedByName: 'Alex', packLabel: '568ml' });
    await api.patch(`/api/shopping/${milk.id}`, { checked: true });
    await api.post('/api/shopping/clear-checked');
    expect((await api.get<ShoppingItemDto[]>('/api/shopping')).map((i) => i.text)).toEqual(['Birthday candles']);
  });

  it('puts ticked items away in one tap using the usual product and place', async () => {
    const first = await api.post<ScanAddResult>('/api/scan/add', { barcode: '3003', locationId: loc.fridge.id });
    await api.post(`/api/stock/${first.change.item.id}/use`, { amount: { kind: 'all' } });
    const { items } = await api.post<{ items: ShoppingItemDto[] }>('/api/shopping', { ingredientId: ing.milk!.id, packs: 2 });
    await api.post('/api/shopping', { text: 'Birthday candles' });
    const candles = (await api.get<ShoppingItemDto[]>('/api/shopping')).find((i) => i.text === 'Birthday candles')!;
    await api.patch(`/api/shopping/${items[0]!.id}`, { checked: true });
    await api.patch(`/api/shopping/${candles.id}`, { checked: true });
    const r = await api.post<{ added: number; needsScan: ShoppingItemDto[] }>('/api/shopping/put-away', {});
    expect(r.added).toBe(2);
    expect(r.needsScan.map((i) => i.text)).toEqual(['Birthday candles']);
    const stock = await api.get<StockItemDto[]>('/api/stock');
    expect(stock).toHaveLength(2);
    expect(stock.every((s) => s.productName === 'Semi Skimmed Milk' && s.locationType === 'fridge')).toBe(true);
  });

  it('spots staples running low from how fast they get used', async () => {
    // Milk is a "track running low" staple. A pint every few days...
    for (const day of ['2026-10-20', '2026-10-27', '2026-11-03']) {
      t.setNow(`${day}T09:00:00Z`);
      const s = await api.post<ScanAddResult>('/api/scan/add', { barcode: '3003', locationId: loc.fridge.id });
      await api.post(`/api/stock/${s.change.item.id}/use`, { amount: { kind: 'all' } });
    }
    t.setNow('2026-11-12T09:00:00Z');
    const low = await api.get<RunningLowDto[]>('/api/running-low');
    expect(low).toEqual([expect.objectContaining({ name: 'Milk', onHandGrams: 0, daysLeft: 0, onList: false })]);
    await api.post('/api/shopping', { ingredientId: ing.milk!.id, reason: 'running-low' });
    expect((await api.get<RunningLowDto[]>('/api/running-low'))[0]!.onList).toBe(true);
  });
});
