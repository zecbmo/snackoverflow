import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  LocationDto,
  ProductDto,
  ScanAddResult,
  ScanUseResult,
  StockChangeDto,
  StockItemDto,
  WasteSummaryDto,
} from '@snackoverflow/shared';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

const MILK = '5000000000001';
const CHICKEN = '5000000000002';
const MYSTERY = '5000000000003';
const BEANS = '5000000000004';

let t: TestApp;
let api: Client;
let loc: Record<'fridge' | 'freezer' | 'cupboard', LocationDto>;

beforeEach(async () => {
  t = await makeTestApp({
    off: new FakeOff({
      [MILK]: { name: 'Semi Skimmed Milk', brand: 'Dairy Co', quantity: '2.27 l' },
      [CHICKEN]: { name: 'British Chicken Thighs', quantity: '1kg', categories: ['en:meats'] },
      [BEANS]: { name: 'Baked Beans in Tomato Sauce', quantity: '415g' },
    }),
  });
  api = await setupAdmin(t.app);
  const all = await api.get<LocationDto[]>('/api/locations');
  loc = Object.fromEntries(all.map((l) => [l.type, l])) as typeof loc;
});
afterEach(async () => {
  await t.close();
});

const scanAdd = (barcode: string, locationId?: string) => api.post<ScanAddResult>('/api/scan/add', { barcode, locationId });

describe('scan in', () => {
  it('looks up a new barcode, links the ingredient and estimates the date', async () => {
    const r = await scanAdd(MILK, loc.fridge.id);
    expect(r.known).toBe(true);
    expect(r.estimated).toBe(true);
    expect(r.product).toMatchObject({
      name: 'Semi Skimmed Milk',
      brand: 'Dairy Co',
      ingredientName: 'Milk',
      packAmount: 2.27,
      packUnit: 'l',
      displayUnit: 'ml',
      source: 'off',
    });
    // 2.27 litres of milk at 1.03 g/ml.
    expect(r.product.packGrams).toBeCloseTo(2338.1, 1);
    expect(r.change.item).toMatchObject({ state: 'closed', bestBefore: '2026-11-20', locationName: 'Fridge', fractionLeft: 1 });
  });

  it('remembers the product: no second lookup, one pack per scan', async () => {
    await scanAdd(MILK, loc.fridge.id);
    await scanAdd(MILK, loc.fridge.id);
    await scanAdd(MILK);
    expect(t.off.calls).toEqual([MILK]);
    const stock = await api.get<StockItemDto[]>('/api/stock');
    expect(stock).toHaveLength(3);
    // The last location is remembered.
    expect(stock.every((s) => s.locationId === loc.fridge.id)).toBe(true);
  });

  it('adds unknown barcodes to name later, and fills in the size once named', async () => {
    const r = await scanAdd(MYSTERY, loc.cupboard.id);
    expect(r.known).toBe(false);
    expect(r.change.item.productName).toBe('Unnamed product');
    expect(r.change.item.bestBefore).toBeNull();
    expect(await api.get<ProductDto[]>('/api/products?unnamed=1')).toHaveLength(1);
    const beans = (await api.get<{ id: string; name: string }[]>('/api/ingredients')).find((i) => i.name === 'Baked beans')!;
    const named = await api.patch<ProductDto>(`/api/products/${r.product.id}`, {
      name: 'Spicy beans',
      packAmount: 400,
      packUnit: 'g',
      ingredientId: beans.id,
    });
    expect(named).toMatchObject({ name: 'Spicy beans', packGrams: 400, ingredientName: 'Baked beans' });
    const [item] = await api.get<StockItemDto[]>('/api/stock');
    expect(item).toMatchObject({ initialGrams: 400, remainingGrams: 400, productName: 'Spicy beans' });
    // Next scan is recognised by everyone.
    expect((await scanAdd(MYSTERY)).known).toBe(true);
  });

  it('puts packs scanned into the freezer in frozen', async () => {
    const r = await scanAdd(CHICKEN, loc.freezer.id);
    expect(r.change.item).toMatchObject({ state: 'frozen', bestBefore: '2027-02-10', frozenOn: '2026-11-12' });
  });

  it('learns from date changes', async () => {
    const first = await scanAdd(MILK, loc.fridge.id);
    await api.patch(`/api/stock/${first.change.item.id}`, { bestBefore: '2026-11-16' });
    const second = await scanAdd(MILK, loc.fridge.id);
    expect(second.change.item.bestBefore).toBe('2026-11-16');
    expect(second.product.learnedClosedDays).toBe(4);
  });
});

describe('using stock', () => {
  it('uses part of a pack, asks if it is opened, and opening never extends the date', async () => {
    const { change } = await scanAdd(MILK, loc.fridge.id);
    const used = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/use`, { amount: { kind: 'fraction', fraction: 0.25 } });
    expect(used.askOpened).toBe(true);
    expect(used.askStillSome).toBe(false);
    expect(used.item.fractionLeft).toBe(0.75);
    const opened = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/open`);
    // Milk: 8 days closed, 3 once opened.
    expect(opened.item).toMatchObject({ state: 'opened', bestBefore: '2026-11-15', openedOn: '2026-11-12' });
    expect(opened.item.actions.open).not.toBeNull();
  });

  it('asks "still some left?" when the numbers run out', async () => {
    const { change } = await scanAdd(BEANS, loc.cupboard.id);
    const r = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/use`, { amount: { kind: 'grams', grams: 500 } });
    expect(r.askStillSome).toBe(true);
    expect(await api.get('/api/stock')).toHaveLength(0);
    const yes = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/still-some`, { answer: 'yes' });
    expect(yes.item.fractionLeft).toBe(0.25);
    expect(await api.get('/api/stock')).toHaveLength(1);
    await api.post(`/api/stock/${change.item.id}/still-some`, { answer: 'none' });
    expect(await api.get('/api/stock')).toHaveLength(0);
  });

  it('scanning in Use mode takes the pack that expires first', async () => {
    const a = await scanAdd(MILK, loc.fridge.id);
    t.setNow('2026-11-14T12:00:00Z');
    await scanAdd(MILK, loc.fridge.id);
    const r = await api.post<ScanUseResult>('/api/scan/use', { barcode: MILK });
    expect(r.status).toBe('used');
    if (r.status !== 'used') return;
    expect(r.change.item.id).toBe(a.change.item.id);
    expect(r.packsLeft).toBe(1);
    expect(r.change.item.fractionLeft).toBe(0);
  });

  it('reports items not in stock', async () => {
    expect(await api.post<ScanUseResult>('/api/scan/use', { barcode: '0000000000000' })).toEqual({
      status: 'not-in-stock',
      product: null,
    });
    await scanAdd(BEANS);
    const item = (await api.get<StockItemDto[]>('/api/stock'))[0]!;
    await api.post(`/api/stock/${item.id}/use`, { amount: { kind: 'all' } });
    expect((await api.post<ScanUseResult>('/api/scan/use', { barcode: BEANS })).status).toBe('not-in-stock');
  });

  it('counts binned food as waste, separately from use', async () => {
    const a = await scanAdd(CHICKEN, loc.fridge.id);
    const b = await scanAdd(BEANS, loc.cupboard.id);
    await api.post(`/api/stock/${a.change.item.id}/discard`, {});
    await api.post(`/api/stock/${b.change.item.id}/use`, { amount: { kind: 'all' } });
    expect(await api.get<WasteSummaryDto>('/api/stats/waste')).toEqual({ thisMonthGrams: 1000, lastMonthGrams: 0, thisMonthItems: 1 });
  });
});

describe('freeze and defrost', () => {
  it('freezes, defrosts to the fridge with a short date, and never refreezes', async () => {
    const { change } = await scanAdd(CHICKEN, loc.fridge.id);
    expect(change.item.bestBefore).toBe('2026-11-15');
    const frozen = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/freeze`);
    expect(frozen.item).toMatchObject({ state: 'frozen', locationType: 'freezer', bestBefore: '2027-02-10' });
    t.setNow('2026-12-20T12:00:00Z');
    const thawed = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/defrost`);
    expect(thawed.item).toMatchObject({ state: 'defrosted', locationType: 'fridge', bestBefore: '2026-12-21' });
    expect(thawed.item.actions.freeze).toBe('Defrosted food must not be frozen again.');
    const again = await api.raw('POST', `/api/stock/${change.item.id}/freeze`, {});
    expect(again.statusCode).toBe(400);
  });

  it('lets people freeze food past its date, with a warning first', async () => {
    const { change } = await scanAdd(CHICKEN, loc.fridge.id);
    t.setNow('2026-11-16T12:00:00Z');
    const item = (await api.get<{ item: StockItemDto }>(`/api/stock/${change.item.id}`)).item;
    expect(item.actions.freeze).toBeNull();
    expect(item.actions.freezeWarning).toMatch(/past its best-before/);
    const frozen = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/freeze`, {});
    expect(frozen.item.state).toBe('frozen');
  });

  it('moving into the freezer freezes it', async () => {
    const { change } = await scanAdd(CHICKEN, loc.fridge.id);
    const moved = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/move`, { locationId: loc.freezer.id });
    expect(moved.item.state).toBe('frozen');
    const back = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/move`, { locationId: loc.fridge.id });
    expect(back.item.state).toBe('defrosted');
  });

  it('moves between cupboard and fridge without changing the date', async () => {
    const { change } = await scanAdd(BEANS, loc.cupboard.id);
    const moved = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/move`, { locationId: loc.fridge.id });
    expect(moved.item).toMatchObject({ locationType: 'fridge', bestBefore: change.item.bestBefore, state: 'closed' });
  });
});

describe('undo', () => {
  it('undoes the latest change', async () => {
    const { change } = await scanAdd(MILK, loc.fridge.id);
    const used = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/use`, { amount: { kind: 'all' } });
    expect(await api.get('/api/stock')).toHaveLength(0);
    await api.post(`/api/events/${used.eventId}/undo`);
    const [item] = await api.get<StockItemDto[]>('/api/stock');
    expect(item).toMatchObject({ id: change.item.id, fractionLeft: 1 });
  });

  it('undoes a scan by removing the pack', async () => {
    const { change } = await scanAdd(MILK, loc.fridge.id);
    await api.post(`/api/events/${change.eventId}/undo`);
    expect(await api.get('/api/stock')).toHaveLength(0);
  });

  it('will not undo a change that something later depends on', async () => {
    const { change } = await scanAdd(MILK, loc.fridge.id);
    const open = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/open`);
    t.setNow('2026-11-12T12:01:00Z');
    await api.post(`/api/stock/${change.item.id}/use`, { amount: { kind: 'fraction', fraction: 0.5 } });
    const r = await api.raw('POST', `/api/events/${open.eventId}/undo`, {});
    expect(r.statusCode).toBe(409);
  });

  it('undoes freezing, putting the pack back as it was', async () => {
    const { change } = await scanAdd(CHICKEN, loc.fridge.id);
    const frozen = await api.post<StockChangeDto>(`/api/stock/${change.item.id}/freeze`);
    await api.post(`/api/events/${frozen.eventId}/undo`);
    const [item] = await api.get<StockItemDto[]>('/api/stock');
    expect(item).toMatchObject({ state: 'closed', locationType: 'fridge', bestBefore: '2026-11-15', frozenOn: null });
  });
});

describe('locations and products', () => {
  it('will not delete a location with food in it', async () => {
    await scanAdd(BEANS, loc.cupboard.id);
    expect((await api.raw('DELETE', `/api/locations/${loc.cupboard.id}`)).statusCode).toBe(409);
    const shed = await api.post<LocationDto>('/api/locations', { name: 'Garage freezer', type: 'freezer' });
    expect(shed.sortOrder).toBe(3);
    await api.del(`/api/locations/${shed.id}`);
    expect(await api.get('/api/locations')).toHaveLength(3);
  });

  it('creates products by hand with barcodes, and rejects duplicate barcodes', async () => {
    const p = await api.post<ProductDto>('/api/products', { name: 'Oat milk', packAmount: 1, packUnit: 'l', barcodes: ['12345678'] });
    expect(p).toMatchObject({ packGrams: 1000, displayUnit: 'ml', barcodes: ['12345678'] });
    const dup = await api.raw('POST', '/api/products', { name: 'Other', barcodes: ['12345678'] });
    expect(dup.statusCode).toBe(409);
    expect((await scanAdd('12345678')).product.id).toBe(p.id);
  });

  it('merges duplicate products', async () => {
    const a = await scanAdd(MYSTERY, loc.cupboard.id);
    const b = await scanAdd(BEANS, loc.cupboard.id);
    await api.post(`/api/products/${a.product.id}/merge`, { intoId: b.product.id });
    const stock = await api.get<StockItemDto[]>('/api/stock');
    expect(stock.every((s) => s.productId === b.product.id)).toBe(true);
    expect((await scanAdd(MYSTERY)).product.id).toBe(b.product.id);
  });

  it('validates input', async () => {
    const r = await api.raw('POST', `/api/stock/00000000-0000-4000-8000-000000000000/use`, { amount: { kind: 'fraction', fraction: 2 } });
    expect(r.statusCode).toBe(400);
    expect((await api.raw('POST', '/api/scan/add', { barcode: 'not a barcode!' })).statusCode).toBe(400);
  });
});
