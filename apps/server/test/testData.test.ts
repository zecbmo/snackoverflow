/** Test copies: "Reset test data" wipes the food data and fills it with made-up demo data. */
import { afterEach, describe, expect, it } from 'vitest';
import type { FoodSuggestionsDto, LocationDto, PlanDto, ProductDto, RecipeSummaryDto, SessionDto, StockItemDto, UserDto } from '@snackoverflow/shared';
import { type Client, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('reset test data', () => {
  it('replaces your food data with the demo household, keeping people and settings', async () => {
    t = await makeTestApp({ config: { TEST_MODE: true } });
    const api: Client = await setupAdmin(t.app);
    const me = await api.get<SessionDto>('/api/session');
    expect(me.features.testMode).toBe(true);
    // Some of your own testing.
    const [fridge] = await api.get<LocationDto[]>('/api/locations');
    const p = await api.post<ProductDto>('/api/products', { name: 'My test cake', packAmount: 500, packUnit: 'g' });
    await api.post('/api/stock', { productId: p.id, locationId: fridge!.id });
    await api.post('/api/plan', { date: me.today, slot: 'lunch', kind: 'text', text: 'Test sandwich', kcalPerServing: 400, eaten: true });

    const r = await api.post<{ steps: string[] }>('/api/test-data/reset');
    expect(r.steps[0]).toBe('People: Alex, Sam, Jo');

    const stock = await api.get<StockItemDto[]>('/api/stock');
    expect(stock.some((s) => s.productName === 'My test cake')).toBe(false);
    expect(stock.some((s) => s.productName === 'Chicken Thighs')).toBe(true);
    expect((await api.get<RecipeSummaryDto[]>('/api/recipes')).length).toBe(12);
    const week = await api.get<PlanDto>(`/api/plan?from=${me.today}&to=${me.today}`);
    expect(week.days[0]!.entries.map((e) => e.title)).not.toContain('Test sandwich');
    expect(week.days[0]!.eatenKcal).toBeGreaterThan(0);
    expect((await api.get<FoodSuggestionsDto>('/api/foods/suggestions')).meals.map((m) => m.name)).toEqual(['My usual breakfast']);

    // Again: the same demo data, not twice as much; the people are kept.
    await api.post('/api/test-data/reset');
    expect((await api.get<RecipeSummaryDto[]>('/api/recipes')).length).toBe(12);
    expect((await api.get<UserDto[]>('/api/users')).map((u) => u.name)).toEqual(['Alex', 'Sam', 'Jo']);
  });

  it('is refused on a real install', async () => {
    t = await makeTestApp();
    const api = await setupAdmin(t.app);
    expect((await api.get<SessionDto>('/api/session')).features.testMode).toBe(false);
    expect((await api.raw('POST', '/api/test-data/reset', {})).statusCode).toBe(403);
  });
});
