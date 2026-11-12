import { afterEach, describe, expect, it } from 'vitest';
import type { IngredientDto, PriceDto, ProductDto, RecipeDto, ScanAddResult, ShoppingEstimateDto, ShoppingItemDto } from '@snackoverflow/shared';
import { prices } from '../src/db/schema';
import { refreshPrices } from '../src/services/pricing';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;

async function start(opts: Parameters<typeof makeTestApp>[0] = {}, pricing = true) {
  t = await makeTestApp({
    off: new FakeOff({
      '6001': { name: 'Maris Piper Potatoes', quantity: '2.5kg' },
      '6002': { name: 'Semi Skimmed Milk', quantity: '2.27 l' },
    }),
    ...opts,
  });
  api = await setupAdmin(t.app);
  if (pricing) await api.patch('/api/household', { settings: { pricingEnabled: true } });
}
afterEach(async () => {
  await t.close();
});

const ingredient = async (key: string) => (await api.get<IngredientDto[]>('/api/ingredients')).find((i) => i.key === key)!;

describe('pricing', () => {
  it('estimates the list from typed prices', async () => {
    await start();
    const milk = await api.post<ScanAddResult>('/api/scan/add', { barcode: '6002' });
    await api.post(`/api/products/${milk.product.id}/prices`, { pricePence: 155, store: 'Tesco' });
    expect((await api.get<ProductDto>(`/api/products/${milk.product.id}`)).pricePence).toBe(155);
    expect(await api.get<PriceDto[]>(`/api/products/${milk.product.id}/prices`)).toEqual([expect.objectContaining({ pricePence: 155, store: 'Tesco', source: 'manual' })]);
    await api.post('/api/shopping', { productId: milk.product.id, packs: 2 });
    await api.post('/api/shopping', { text: 'Birthday candles' });
    const list = await api.get<ShoppingItemDto[]>('/api/shopping');
    expect(list.find((i) => i.productId === milk.product.id)?.pricePence).toBe(310);
    expect(await api.get<ShoppingEstimateDto>('/api/shopping/estimate')).toEqual({ enabled: true, totalPence: 310, priced: 1, unpriced: 1 });
  });

  it('prices a plan item from what that ingredient costs per gram', async () => {
    await start();
    const potatoes = await ingredient('potatoes');
    const bag = await api.post<ScanAddResult>('/api/scan/add', { barcode: '6001' });
    await api.post(`/api/products/${bag.product.id}/prices`, { pricePence: 129 });
    await api.post(`/api/stock/${bag.change.item.id}/use`, { amount: { kind: 'all' } });
    const pie = await api.post<RecipeDto>('/api/recipes', {
      title: 'Fish pie',
      serves: 2,
      ingredients: [{ text: '100g potatoes', amount: 100, unit: 'g', ingredientId: potatoes.id }],
    });
    await api.post('/api/plan', { date: '2026-11-13', slot: 'dinner', kind: 'recipe', recipeId: pie.id, servings: 2 });
    await api.post('/api/shopping/build', { from: '2026-11-12', to: '2026-11-18' });
    const [item] = await api.get<ShoppingItemDto[]>('/api/shopping');
    // A 1kg bag at the 2.5kg bag's price per gram: 129 × 1000 / 2500 ≈ 52p.
    expect(item).toMatchObject({ packGrams: 1000, pricePence: 52 });
  });

  it('caches Open Prices and asks once a week at most', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ items: [{ price: 1.35, currency: 'GBP', date: '2026-11-01', location: { osm_name: 'Tesco Extra' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await start({ fetch: fakeFetch });
    const milk = await api.post<ScanAddResult>('/api/scan/add', { barcode: '6002' });
    expect(await refreshPrices(t.ctx, t.ctx.now())).toBe(1);
    expect(await refreshPrices(t.ctx, t.ctx.now())).toBe(0);
    expect(calls).toBe(1);
    expect((await api.get<ProductDto>(`/api/products/${milk.product.id}`)).pricePence).toBe(135);
    const [row] = await t.ctx.db.select().from(prices);
    expect(row).toMatchObject({ source: 'open-prices', store: 'Tesco Extra', date: '2026-11-01' });
  });

  it('copes with Open Prices being down', async () => {
    const fakeFetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await start({ fetch: fakeFetch });
    await api.post<ScanAddResult>('/api/scan/add', { barcode: '6002' });
    expect(await refreshPrices(t.ctx, t.ctx.now())).toBe(0);
    expect(await t.ctx.db.select().from(prices)).toEqual([]);
  });

  it('hides prices everywhere when pricing is off', async () => {
    await start({}, false);
    const milk = await api.post<ScanAddResult>('/api/scan/add', { barcode: '6002' });
    expect((await api.raw('POST', `/api/products/${milk.product.id}/prices`, { pricePence: 155 })).statusCode).toBe(400);
    await t.ctx.db.insert(prices).values({ householdId: (await api.get<{ id: string }>('/api/household')).id, productId: milk.product.id, pricePence: 155, date: '2026-11-12', source: 'receipt' });
    await api.post('/api/shopping', { productId: milk.product.id });
    expect((await api.get<ShoppingItemDto[]>('/api/shopping'))[0]!.pricePence).toBeNull();
    expect((await api.get<ProductDto>(`/api/products/${milk.product.id}`)).pricePence).toBeNull();
    expect(await api.get<ShoppingEstimateDto>('/api/shopping/estimate')).toEqual({ enabled: false, totalPence: null, priced: 0, unpriced: 0 });
    expect(await refreshPrices(t.ctx, t.ctx.now())).toBe(0);
  });
});
