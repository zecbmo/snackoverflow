import { afterEach, describe, expect, it } from 'vitest';
import type { CalorieStatsDto, InviteDto, ScanAddResult, SessionDto, SpendingDto, UserDto, WasteReportDto } from '@snackoverflow/shared';
import { type Client, client, cookieFrom, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;

async function start(pricing = false) {
  t = await makeTestApp({
    off: new FakeOff({
      '7001': { name: 'Baby Spinach', quantity: '200g' },
      '7002': { name: 'Sliced White Bread', quantity: '800g' },
    }),
  });
  api = await setupAdmin(t.app);
  if (pricing) await api.patch('/api/household', { settings: { pricingEnabled: true } });
}
afterEach(async () => {
  await t.close();
});

const meal = (date: string, kcal: number, eaten = true) => api.post('/api/plan', { date, slot: 'dinner', kind: 'text', text: 'Dinner', kcalPerServing: kcal, eaten });

describe('dashboard', () => {
  it('shows calories eaten per day with a target and averages', async () => {
    await start();
    const me = await api.patch<UserDto>('/api/me', { kcalTarget: 2000 });
    expect(me.kcalTarget).toBe(2000);
    await meal('2026-11-12', 500); // today: still being logged
    await meal('2026-11-11', 2000);
    await meal('2026-11-11', 999, false); // planned, never marked eaten
    await meal('2026-11-10', 2400);
    await meal('2026-10-20', 1000); // inside 30 days, outside 7
    const s = await api.get<CalorieStatsDto>('/api/stats/calories');
    expect(s).toMatchObject({ name: 'Alex', target: 2000, today: '2026-11-12', avg7: 2200, avg30: 1800 });
    expect(s.days).toHaveLength(30);
    expect(s.days.at(-1)).toEqual({ date: '2026-11-12', kcal: 500 });
    expect(s.days.at(-2)).toEqual({ date: '2026-11-11', kcal: 2000 });
    expect((await api.get<CalorieStatsDto>('/api/stats/calories?person=household')).target).toBeNull();
    expect((await api.raw('GET', '/api/stats/calories?person=not-an-id')).statusCode).toBe(400);
    // Members see their own and the household's; admins can see anyone's.
    const inv = await api.post<InviteDto>('/api/invites', { role: 'member' });
    const res = await client(t.app).raw('POST', `/api/invites/${inv.url.split('/invite/')[1]}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'a password' });
    const sam = client(t.app, cookieFrom(res));
    const samId = (await sam.get<SessionDto>('/api/session')).user.id;
    const adminId = (await api.get<SessionDto>('/api/session')).user.id;
    expect((await sam.get<CalorieStatsDto>('/api/stats/calories')).name).toBe('Sam');
    expect((await sam.raw('GET', `/api/stats/calories?person=${adminId}`)).statusCode).toBe(403);
    expect((await api.get<CalorieStatsDto>(`/api/stats/calories?person=${samId}`)).name).toBe('Sam');
  });

  it('reports waste by period, item and category, compared at the same point last month', async () => {
    await start(true);
    const bread = await api.post<ScanAddResult>('/api/scan/add', { barcode: '7002' });
    await api.post(`/api/products/${bread.product.id}/prices`, { pricePence: 140 });
    // 5 October: a whole loaf binned. 20 October: another (after the 12th, so not in the comparison).
    t.setNow('2026-10-05T12:00:00Z');
    await api.post(`/api/stock/${bread.change.item.id}/discard`, {});
    const bread2 = await api.post<ScanAddResult>('/api/scan/add', { barcode: '7002' });
    t.setNow('2026-10-20T12:00:00Z');
    await api.post(`/api/stock/${bread2.change.item.id}/discard`, {});
    // November: half a loaf and a bag of spinach.
    t.setNow('2026-11-12T12:00:00Z');
    const bread3 = await api.post<ScanAddResult>('/api/scan/add', { barcode: '7002' });
    await api.post(`/api/stock/${bread3.change.item.id}/discard`, { amount: { kind: 'fraction', fraction: 0.5 } });
    const spinach = await api.post<ScanAddResult>('/api/scan/add', { barcode: '7001' });
    await api.post(`/api/stock/${spinach.change.item.id}/discard`, {});

    const r = await api.get<WasteReportDto>('/api/stats/waste-report?period=month');
    expect(r.periods).toHaveLength(6);
    expect(r.periods.slice(-2)).toEqual([
      { start: '2026-10-01', label: 'Oct', grams: 1600, pence: 280, items: 2 },
      { start: '2026-11-01', label: 'Nov', grams: 600, pence: 70, items: 2 },
    ]);
    // 600g against 800g by 12 October.
    expect(r.changePercent).toBe(-25);
    expect(r.byItem[0]).toMatchObject({ grams: 400, items: 1, pence: 70 });
    expect(r.byItem[1]).toMatchObject({ grams: 200, items: 1, pence: null });
    expect(r.byCategory.map((c) => c.grams).reduce((a, b) => a + b)).toBe(600);

    const weeks = await api.get<WasteReportDto>('/api/stats/waste-report?period=week');
    expect(weeks.periods).toHaveLength(8);
    expect(weeks.periods.at(-1)).toMatchObject({ start: '2026-11-09', grams: 600 });

    // Pricing off: no money anywhere, and no spending.
    await api.patch('/api/household', { settings: { pricingEnabled: false } });
    expect((await api.get<WasteReportDto>('/api/stats/waste-report')).periods.at(-1)!.pence).toBeNull();
    expect(await api.get('/api/stats/spending')).toBeNull();
  });

  it('adds up spending from receipts', async () => {
    await start(true);
    const { id } = await api.post<{ id: string }>('/api/receipts/text', { text: 'TESCO\nSPINACH 200G   1.20\nCARRIER BAG   0.10\nBREAD 800G   1.40\nTOTAL   2.70\n12/11/2026' });
    await api.post(`/api/receipts/${id}/confirm`);
    const s = await api.get<SpendingDto>('/api/stats/spending?period=week');
    expect(s.periods.at(-1)).toMatchObject({ start: '2026-11-09', pence: 260, receipts: 1 });
  });
});
