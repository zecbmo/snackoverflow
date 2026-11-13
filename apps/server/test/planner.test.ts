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
  StockChangeDto,
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

describe('people on a meal', () => {
  const porridge = () =>
    api.post<RecipeDto>('/api/recipes', {
      title: 'Porridge',
      serves: 2,
      ingredients: [{ text: '100g oats', amount: 100, unit: 'g', ingredientId: ing.oats!.id }],
    });
  const day = (c: Client) => c.get<PlanDto>('/api/plan?from=2026-11-12&to=2026-11-12').then((p) => p.days[0]!);

  it('counts only your own portions, and shows meals with free portions to everyone', async () => {
    const sam = await invite('Sam');
    const r = await porridge();
    // One serving, mine: on my calendar only.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'breakfast', kind: 'recipe', recipeId: r.id, servings: 1, people: [{ userId: me.user.id, portions: 1 }] });
    // Three servings, one mine and two free: Sam sees it (to know it's being cooked) with no calories.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'recipe', recipeId: r.id, servings: 3, people: [{ userId: me.user.id, portions: 1 }] });
    const mine = await day(api);
    expect(mine.entries.map((e) => e.kcal)).toEqual([188, 188]);
    expect(mine.kcal).toBe(376);
    const sams = await day(sam);
    expect(sams.entries).toHaveLength(1);
    expect(sams.entries[0]).toMatchObject({ slot: 'dinner', kcal: 0, servings: 3, people: [{ name: 'Alex', portions: 1 }] });
    expect(sams.kcal).toBe(0);
    // Nobody named: every portion is free, and nobody gets the calories.
    await api.post('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'recipe', recipeId: r.id, servings: 2 });
    expect((await day(api)).kcal).toBe(376);
    expect((await day(sam)).entries).toHaveLength(2);
  });

  it("lets members take a free portion or give theirs back, but not hand out anyone else's", async () => {
    const sam = await invite('Sam');
    const samId = (await sam.get<SessionDto>('/api/session')).user.id;
    const r = await porridge();
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'recipe', recipeId: r.id, servings: 3, people: [{ userId: me.user.id, portions: 1 }] });
    // Sam takes one of the free portions.
    const taken = await sam.patch<PlanEntryDto>(`/api/plan/${e.id}`, {
      people: [
        { userId: me.user.id, portions: 1 },
        { userId: samId, portions: 1 },
      ],
    });
    expect(taken.people.map((p) => p.name)).toEqual(['Alex', 'Sam']);
    expect((await day(sam)).kcal).toBe(188);
    // Sam can't take Alex's portion, or more than there are.
    expect((await sam.raw('PATCH', `/api/plan/${e.id}`, { people: [{ userId: samId, portions: 2 }] })).statusCode).toBe(403);
    expect(
      (
        await sam.raw('PATCH', `/api/plan/${e.id}`, {
          people: [
            { userId: me.user.id, portions: 1 },
            { userId: samId, portions: 3 },
          ],
        })
      ).statusCode,
    ).toBe(400);
    // Giving it back.
    await sam.patch(`/api/plan/${e.id}`, { people: [{ userId: me.user.id, portions: 1 }] });
    expect((await day(sam)).kcal).toBe(0);
    // Fewer servings than portions handed out: the extra come back off the last people.
    await api.patch(`/api/plan/${e.id}`, {
      people: [
        { userId: me.user.id, portions: 1 },
        { userId: samId, portions: 2 },
      ],
    });
    const trimmed = await api.patch<PlanEntryDto>(`/api/plan/${e.id}`, { servings: 2 });
    expect(trimmed.people.map((p) => [p.name, p.portions])).toEqual([
      ['Alex', 1],
      ['Sam', 1],
    ]);
  });

  it("makes a batch cook nobody's calories, on everyone's calendar", async () => {
    const sam = await invite('Sam');
    const r = await porridge();
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'dinner', kind: 'recipe', recipeId: r.id, servings: 6, people: [{ userId: me.user.id, portions: 1 }] });
    const batch = await api.patch<PlanEntryDto>(`/api/plan/${e.id}`, { batch: true });
    expect(batch).toMatchObject({ batch: true, people: [] });
    expect((await day(api)).entries[0]).toMatchObject({ batch: true, kcal: 0 });
    expect((await day(sam)).entries[0]).toMatchObject({ batch: true, kcal: 0 });
    // Only recipes are batch cooked.
    const note = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'text', text: 'Soup' });
    expect((await api.raw('PATCH', `/api/plan/${note.id}`, { batch: true })).statusCode).toBe(400);
  });

  it('gives food logged as already eaten to the person logging it', async () => {
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-12', slot: 'lunch', kind: 'text', text: 'Sandwich', kcalPerServing: 400, eaten: true });
    expect(e.people.map((p) => p.userId)).toEqual([me.user.id]);
    expect((await day(api)).kcal).toBe(400);
  });
});

describe('the list follows the plan', () => {
  it('adds what the plan needs on its own, and takes it off when the plan changes', async () => {
    const pie = await fishPie();
    const e = await api.post<PlanEntryDto>('/api/plan', { date: '2026-11-13', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 2 });
    // No "build" step: reading the list brings it up to date.
    const list = await api.get<ShoppingItemDto[]>('/api/shopping');
    expect(list).toEqual([expect.objectContaining({ text: 'Potatoes', reason: 'plan', packs: 1, forMeals: 'Fish pie' })]);
    // Ticked (bought, not put away yet) still counts as coming: no second item.
    await api.patch(`/api/shopping/${list[0]!.id}`, { checked: true });
    expect(await api.get<ShoppingItemDto[]>('/api/shopping')).toHaveLength(1);
    await api.patch(`/api/shopping/${list[0]!.id}`, { checked: false });
    // Take the meal off the plan and the potatoes come off the list; things added by hand stay.
    await api.post('/api/shopping', { text: 'Kitchen roll' });
    await api.del(`/api/plan/${e.id}`);
    expect((await api.get<ShoppingItemDto[]>('/api/shopping')).map((i) => i.text)).toEqual(['Kitchen roll']);
  });

  it("lets an item's category be set on the list", async () => {
    await api.post('/api/shopping', { text: 'Birthday candles' });
    const [item] = await api.get<ShoppingItemDto[]>('/api/shopping');
    expect(item!.foodGroup).toBeNull();
    await api.patch(`/api/shopping/${item!.id}`, { foodGroup: 'Sweets & Confectionery' });
    expect((await api.get<ShoppingItemDto[]>('/api/shopping'))[0]!.foodGroup).toBe('Sweets & Confectionery');
    expect((await api.raw('PATCH', `/api/shopping/${item!.id}`, { foodGroup: 'Not a group' })).statusCode).toBe(400);
    await api.patch(`/api/shopping/${item!.id}`, { foodGroup: null });
    expect((await api.get<ShoppingItemDto[]>('/api/shopping'))[0]!.foodGroup).toBeNull();
  });
});

describe('cook plan', () => {
  it('scales each line to the servings being cooked and says what is in stock', async () => {
    const pie = await api.post<RecipeDto>('/api/recipes', {
      title: 'Apple pie',
      serves: 2,
      ingredients: [
        { text: '1 unit(s) Apple', amount: 1, unit: 'count', ingredientId: ing.apples!.id },
        { text: '450 grams Potatoes', amount: 450, unit: 'g', ingredientId: ing.potatoes!.id },
      ],
    });
    await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002' });
    const plan = await api.get<CookPlanDto>(`/api/recipes/${pie.id}/cook-plan?servings=4`);
    expect(plan.lines.map((l) => [l.text, l.originalText])).toEqual([
      ['2 Apple', '1 Apple'],
      ['900 grams Potatoes', '450 grams Potatoes'],
    ]);
    expect(plan.lines[0]!.inStockGrams).toBe(0);
    expect(plan.lines[1]).toMatchObject({ neededGrams: 900, inStockGrams: 2500 });
  });
});

describe('review 2: cooking', () => {
  const cookPie = async (body: Record<string, unknown>) => {
    const pie = await fishPie();
    await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002' });
    const plan = await api.get<CookPlanDto>(`/api/recipes/${pie.id}/cook-plan`);
    const lines = [{ takes: plan.lines[0]!.takes.map((tk) => ({ stockItemId: tk.stockItemId, grams: tk.grams! })) }];
    return { pie, res: await api.raw('POST', `/api/recipes/${pie.id}/cook`, { servings: 2, lines, ...body }) };
  };

  it("doesn't ask whether potatoes are opened (their date doesn't change)", async () => {
    const { res } = await cookPie({});
    expect(res.statusCode).toBe(200);
    expect((res.json() as CookResultDto).askOpened).toEqual([]);
  });

  it('keeps half portions, never more than was cooked', async () => {
    const { res } = await cookPie({ leftovers: [{ locationId: loc.fridge.id, portions: 1.5 }] });
    const cooked = res.json() as CookResultDto;
    // 100g of potatoes for 2 servings: 1.5 servings is 75g.
    expect(cooked.leftovers[0]).toMatchObject({ remainingGrams: 75 });
    const { res: tooMany } = await cookPie({ leftovers: [{ locationId: loc.fridge.id, portions: 3 }] });
    expect(tooMany.statusCode).toBe(400);
    const { res: odd } = await cookPie({ leftovers: [{ locationId: loc.fridge.id, portions: 0.3 }] });
    expect(odd.statusCode).toBe(400);
  });

  it('splits kept servings into smaller portions with their share of the calories', async () => {
    const { pie, res } = await cookPie({ leftovers: [{ locationId: loc.fridge.id, portions: 2 }], split: 2 });
    const kept = (res.json() as CookResultDto).leftovers[0]!;
    expect(kept.productName).toBe('Fish pie (half portions)');
    // Two servings (100g) kept as four portions of 25g.
    expect(kept.remainingGrams).toBe(100);
    const products = await api.get<ProductDto[]>('/api/products?q=Fish pie');
    const half = products.find((p) => p.name === 'Fish pie (half portions)')!;
    expect(half).toMatchObject({ isMeal: true });
    // Eating one portion of it counts half a serving's calories.
    const recipe = await api.get<RecipeDto>(`/api/recipes/${pie.id}`);
    const entry = await api.post<PlanEntryDto>('/api/plan', {
      date: '2026-11-12',
      slot: 'lunch',
      kind: 'stock',
      stockItemId: kept.id,
      servings: 1,
      people: [{ userId: me.user.id, portions: 1 }],
    });
    // (Within a calorie: the recipe's figure per serving is rounded, the portion's is worked out per 100g.)
    expect(Math.abs(entry.kcal! - recipe.kcalPerServing! / 2)).toBeLessThanOrEqual(1);
  });
});

describe('review 2: adding stock by hand', () => {
  it('adds foods, known products and new names in one go, each to its usual place', async () => {
    const spuds = await api.post<ScanAddResult>('/api/scan/add', { barcode: '3002', locationId: loc.cupboard.id });
    const added = await api.post<StockChangeDto[]>('/api/stock/add-many', {
      items: [
        // A food: uses the product bought last time for it (and where it went).
        { ingredientId: ing.potatoes!.id, count: 2 },
        // A food never bought before: a simple product is made for it.
        { ingredientId: ing.tomatoes!.id },
        // Just a name.
        { text: 'Birthday cake', locationId: loc.fridge.id, bestBefore: '2026-11-20' },
      ],
    });
    expect(added).toHaveLength(4);
    expect(added.slice(0, 2).map((c) => [c.item.productId, c.item.locationId])).toEqual([
      [spuds.change.item.productId, loc.cupboard.id],
      [spuds.change.item.productId, loc.cupboard.id],
    ]);
    expect(added[2]!.item).toMatchObject({ productName: 'Tomatoes', ingredientId: ing.tomatoes!.id });
    expect(added[3]!.item).toMatchObject({ productName: 'Birthday cake', locationId: loc.fridge.id, bestBefore: '2026-11-20' });
    // Typed again by name, it's the same product (remembered).
    const again = await api.post<StockChangeDto[]>('/api/stock/add-many', { items: [{ text: 'birthday cake' }] });
    expect(again[0]!.item.productId).toBe(added[3]!.item.productId);
    // Each pack can be undone like any other change.
    await api.post(`/api/events/${again[0]!.eventId}/undo`);
    expect((await api.get<StockItemDto[]>('/api/stock')).some((s) => s.id === again[0]!.item.id)).toBe(false);
    expect((await api.raw('POST', '/api/stock/add-many', { items: [{ count: 1 }] })).statusCode).toBe(400);
  });
});
