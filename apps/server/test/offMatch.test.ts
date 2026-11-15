/** A scanned barcode Open Food Facts doesn't have: find the same food there by name and copy its details. */
import { afterEach, describe, expect, it } from 'vitest';
import type { LocationDto, OffMatchSearchDto, ProductDto, ScanAddResult } from '@snackoverflow/shared';
import { FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('matching an unknown scan to Open Food Facts', () => {
  it('finds products by name and their details can be saved onto the scanned product, under any name', async () => {
    const off = new FakeOff();
    off.products['5053990101573'] = {
      name: 'ORIGINAL',
      brand: 'Pringles',
      quantity: '165 g',
      servingGrams: 30,
      nutritionPer100g: { kcal: 534, protein: 4, carbs: 55, fat: 32 },
    };
    t = await makeTestApp({ off });
    const api = await setupAdmin(t.app);
    const [fridge] = await api.get<LocationDto[]>('/api/locations');

    // A multipack sleeve with its own barcode nobody knows.
    const scan = await api.post<ScanAddResult>('/api/scan/add', { barcode: '9999000011112', locationId: fridge!.id });
    expect(scan.known).toBe(false);

    const found = await api.get<OffMatchSearchDto>('/api/off/matches?q=original');
    expect(found.status).toBe('ok');
    const m = found.results[0]!;
    expect(m).toMatchObject({ barcode: '5053990101573', name: 'Pringles Original', brand: 'Pringles', packAmount: 165, packUnit: 'g', servingGrams: 30, kcalPer100g: 534 });

    // Saved the way the sheet does: the match's details, the household's own name.
    const saved = await api.patch<ProductDto>(`/api/products/${scan.product.id}`, {
      name: 'Pringles (lunchbox tube)',
      brand: m.brand,
      packAmount: m.packAmount,
      packUnit: m.packUnit,
      nutritionPer100g: m.nutritionPer100g,
      servingGrams: m.servingGrams,
    });
    expect(saved).toMatchObject({ name: 'Pringles (lunchbox tube)', brand: 'Pringles', packGrams: 165, servingGrams: 30 });
    // Its own barcode stays: the match's barcode is not taken over.
    expect(saved.barcodes).toEqual(['9999000011112']);
  });

  it('says so when Open Food Facts cannot be reached', async () => {
    const off = new FakeOff();
    off.down = true;
    t = await makeTestApp({ off });
    const api = await setupAdmin(t.app);
    expect(await api.get<OffMatchSearchDto>('/api/off/matches?q=crisps')).toEqual({ status: 'unavailable', results: [] });
  });
});
