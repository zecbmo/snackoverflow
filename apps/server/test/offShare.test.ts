import { afterEach, describe, expect, it } from 'vitest';
import type { OffShareResultDto, ProductDto, ScanAddResult, SessionDto } from '@snackoverflow/shared';
import type { Config } from '../src/config';
import { packQuantityText } from '../src/services/offShare';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

const KNOWN = '5000112548167';
const NEW = '5012345678900';
const ACCOUNT: Partial<Config> = { OFF_CONTRIBUTE_USER_ID: 'snackbot', OFF_CONTRIBUTE_PASSWORD: 'secret' };

let t: TestApp;
let api: Client;
async function start(config: Partial<Config> = ACCOUNT) {
  t = await makeTestApp({ config, off: new FakeOff({ [KNOWN]: { name: 'Semi skimmed milk', quantity: '2.27 l' } }) });
  api = await setupAdmin(t.app);
}
/** Scan an unknown barcode in and name it, like the "What is it?" sheet. */
async function nameNew(code = NEW, patch: Record<string, unknown> = {}): Promise<ProductDto> {
  const r = await api.post<ScanAddResult>('/api/scan/add', { barcode: code });
  expect(r.known).toBe(false);
  return api.patch<ProductDto>(`/api/products/${r.product.id}`, {
    name: 'Greek style yogurt',
    brand: 'Dairy Co',
    packAmount: 4,
    packUnit: 'count',
    portionGrams: 125,
    ...patch,
  });
}

describe('adding products to Open Food Facts', () => {
  afterEach(async () => {
    await t.close();
  });

  it('is offered only when an account is set up', async () => {
    await start({});
    expect((await api.get<SessionDto>('/api/session')).features.offContribute).toBe(false);
    const p = await nameNew();
    expect((await api.raw('POST', `/api/products/${p.id}/off`)).statusCode).toBe(400);
    expect(t.off.contributed).toHaveLength(0);
  });

  it('is not offered when online lookups are off', async () => {
    await start({ ...ACCOUNT, OFF_ENABLED: false });
    expect((await api.get<SessionDto>('/api/session')).features.offContribute).toBe(false);
  });

  it('adds a named product and remembers that it did', async () => {
    await start();
    expect((await api.get<SessionDto>('/api/session')).features.offContribute).toBe(true);
    const p = await nameNew();
    expect(p.offSharedAt).toBeNull();
    const r = await api.post<OffShareResultDto>(`/api/products/${p.id}/off`);
    expect(r.added).toEqual([NEW]);
    expect(r.product.offSharedAt).not.toBeNull();
    expect(t.off.contributed).toEqual([
      expect.objectContaining({
        barcode: NEW,
        name: 'Greek style yogurt',
        brand: 'Dairy Co',
        quantity: '4 x 125 g',
        appUuid: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    ]);
    // The app uuid stands for the person without naming them.
    expect(JSON.stringify(t.off.contributed)).not.toContain('admin@example.com');
  });

  it('never overwrites a barcode Open Food Facts already has', async () => {
    await start();
    const p = await nameNew();
    t.off.products[NEW] = { name: 'Someone else got there first' };
    const r = await api.post<OffShareResultDto>(`/api/products/${p.id}/off`);
    expect(r).toMatchObject({ added: [], alreadyThere: [NEW] });
    expect(t.off.contributed).toHaveLength(0);
  });

  it("won't send products that came from Open Food Facts, have no name or only a shop barcode", async () => {
    await start();
    const fromOff = (await api.post<ScanAddResult>('/api/scan/add', { barcode: KNOWN })).product;
    expect((await api.raw('POST', `/api/products/${fromOff.id}/off`)).statusCode).toBe(400);

    const unnamed = (await api.post<ScanAddResult>('/api/scan/add', { barcode: NEW })).product;
    expect((await api.raw('POST', `/api/products/${unnamed.id}/off`)).statusCode).toBe(400);

    // A weighed-item code from the shop's own scales.
    const weighed = await nameNew('2012345678903');
    expect((await api.raw('POST', `/api/products/${weighed.id}/off`)).statusCode).toBe(400);
    expect(t.off.contributed).toHaveLength(0);
  });

  it('says so when Open Food Facts is down, and can try again', async () => {
    await start();
    const p = await nameNew();
    t.off.down = true;
    const res = await api.raw('POST', `/api/products/${p.id}/off`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("Couldn't reach Open Food Facts") });
    expect((await api.get<ProductDto>(`/api/products/${p.id}`)).offSharedAt).toBeNull();
    t.off.down = false;
    expect((await api.post<OffShareResultDto>(`/api/products/${p.id}/off`)).added).toEqual([NEW]);
  });

  it('404s for a product that is not this household’s', async () => {
    await start();
    expect((await api.raw('POST', '/api/products/00000000-0000-0000-0000-000000000000/off')).statusCode).toBe(404);
  });
});

describe('packQuantityText', () => {
  it('writes the pack size the way Open Food Facts does', () => {
    expect(packQuantityText({ packAmount: 500, packUnit: 'g', portionGrams: null })).toBe('500 g');
    expect(packQuantityText({ packAmount: 2.272, packUnit: 'l', portionGrams: null })).toBe('2.272 l');
    expect(packQuantityText({ packAmount: 4, packUnit: 'count', portionGrams: 125 })).toBe('4 x 125 g');
    expect(packQuantityText({ packAmount: 6, packUnit: 'count', portionGrams: null })).toBeNull();
    expect(packQuantityText({ packAmount: null, packUnit: null, portionGrams: null })).toBeNull();
  });
});
