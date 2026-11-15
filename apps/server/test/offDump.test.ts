/** The local copy of Open Food Facts: filtering the export, searching it, and barcodes from it. */
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { BarcodeFoodDto, FoodResultDto, OffDumpStatusDto } from '@snackoverflow/shared';
import { columnsOf, importDue, importOffDump, offImportSettled, parseDumpLine } from '../src/services/offDump';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

const HEADER = ['code', 'url', 'product_name', 'quantity', 'brands', 'categories_tags', 'countries_tags', 'product_quantity', 'unique_scans_n', 'image_small_url', 'energy-kcal_100g', 'energy_100g', 'fat_100g', 'carbohydrates_100g', 'proteins_100g', 'salt_100g'];

function line(p: Partial<Record<(typeof HEADER)[number], string>>): string {
  return HEADER.map((h) => p[h] ?? '').join('\t');
}

const UK = 'en:united-kingdom';
const ROWS = [
  line({ code: '5000159407236', product_name: 'Snickers', brands: 'Mars,Mars Inc', quantity: '48 g', countries_tags: `en:france,${UK}`, 'energy-kcal_100g': '488', fat_100g: '23.5', carbohydrates_100g: '60.5', proteins_100g: '8.6', unique_scans_n: '900' }),
  line({ code: '5000159461122', product_name: 'Snickers Duo', brands: 'Mars', quantity: '83.4 g', countries_tags: UK, energy_100g: '2042', unique_scans_n: '50' }),
  line({ code: '0000101209159', product_name: 'Pâte à tartiner', brands: 'Bovetti', quantity: '350 g', countries_tags: 'en:france', 'energy-kcal_100g': '540' }),
  line({ code: '5010000000001', product_name: '', countries_tags: UK, 'energy-kcal_100g': '100' }),
  line({ code: '5010000000002', product_name: 'Mystery water', countries_tags: UK }),
  line({ code: 'abc', product_name: 'Bad barcode', countries_tags: UK, 'energy-kcal_100g': '100' }),
  line({ code: '5010000000003', product_name: 'Crème brûlée', brands: 'Gü', quantity: '2 x 89 g', countries_tags: UK, 'energy-kcal_100g': '330' }),
];

function exportFile(rows: string[]): Uint8Array {
  return gzipSync([HEADER.join('\t'), ...rows].join('\n') + '\n');
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function app(rows = ROWS) {
  const off = new FakeOff({});
  let body = exportFile(rows);
  const urls: string[] = [];
  t = await makeTestApp({
    off,
    config: { OFF_DUMP_ENABLED: true, OFF_DUMP_URL: 'https://dump.example/en.openfoodfacts.org.products.csv.gz' },
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(body, { headers: { 'content-type': 'application/gzip' } });
    },
  });
  const api = await setupAdmin(t.app);
  return { api, off, urls, setRows: (r: string[]) => void (body = exportFile(r)) };
}

describe('reading the export', () => {
  const cols = columnsOf(HEADER.join('\t'));

  it('keeps named products with calories sold in the country', () => {
    expect(parseDumpLine(ROWS[0]!, cols, 'united-kingdom')).toMatchObject({
      barcode: '5000159407236',
      name: 'Snickers',
      brand: 'Mars',
      quantity: '48 g',
      scans: 900,
      search: 'snickers mars',
      nutritionPer100g: { kcal: 488, fat: 23.5, carbs: 60.5, protein: 8.6 },
    });
    // kJ when there's no kcal.
    expect(parseDumpLine(ROWS[1]!, cols, 'united-kingdom')?.nutritionPer100g?.kcal).toBe(488);
    // Not sold here, no name, no calories, not a barcode.
    for (const r of [ROWS[2], ROWS[3], ROWS[4], ROWS[5]]) expect(parseDumpLine(r!, cols, 'united-kingdom')).toBeNull();
    // Every country when none is set.
    expect(parseDumpLine(ROWS[2]!, cols, null)?.name).toBe('Pâte à tartiner');
    // Accents don't matter to search.
    expect(parseDumpLine(ROWS[6]!, cols, 'united-kingdom')?.search).toBe('creme brulee gu');
  });

  it('refreshes when due, and waits a while after a failure', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    expect(importDue(null, null, now, 7)).toBe(true);
    expect(importDue(daysAgo(3), null, now, 7)).toBe(false);
    expect(importDue(daysAgo(8), null, now, 7)).toBe(true);
    expect(importDue(daysAgo(8), new Date(now.getTime() - 3_600_000), now, 7)).toBe(false);
    expect(importDue(daysAgo(8), daysAgo(1), now, 7)).toBe(true);
  });
});

describe('the local copy', () => {
  it('imports products sold in the UK, then search and barcodes use it with no network', async () => {
    const { api, off, urls } = await app();
    expect(await importOffDump(t!.ctx)).toEqual({ lines: 7, products: 3, removed: 0 });
    expect(urls).toEqual(['https://dump.example/en.openfoodfacts.org.products.csv.gz']);
    expect(await api.get<OffDumpStatusDto>('/api/off-dump')).toMatchObject({ enabled: true, country: 'united-kingdom', products: 3, last: { status: 'done', lines: 7, products: 3 } });

    // As you type, most scanned first.
    const results = await api.get<FoodResultDto[]>('/api/foods/search?q=snick');
    expect(results.filter((r) => r.source === 'off').map((r) => [r.title, r.kcalPerServing])).toEqual([
      ['Snickers', 234],
      ['Snickers Duo', 407],
    ]);
    expect((await api.get<FoodResultDto[]>('/api/foods/search?q=creme brulee')).map((r) => r.title)).toContain('Crème brûlée');

    // Picking one (or scanning it) uses the copy: Open Food Facts isn't asked.
    const picked = await api.get<BarcodeFoodDto>('/api/foods/barcode/5000159407236');
    expect(picked).toMatchObject({ named: true, food: { source: 'product', title: 'Snickers', kcalPerServing: 234 } });
    expect(off.calls).toEqual([]);
    // It's yours now, so it isn't offered again from Open Food Facts.
    expect((await api.get<FoodResultDto[]>('/api/foods/search?q=snick')).map((r) => [r.source, r.title])).toEqual([
      ['product', 'Snickers'],
      ['off', 'Snickers Duo'],
    ]);
  });

  it('drops products the export no longer lists, unless the new export looks cut short', async () => {
    const { setRows } = await app();
    await importOffDump(t!.ctx);
    // Far fewer than before: probably a broken download, so nothing is removed.
    setRows([ROWS[0]!]);
    expect((await importOffDump(t!.ctx)).removed).toBe(0);
    setRows([ROWS[0]!, ROWS[6]!]);
    expect((await importOffDump(t!.ctx)).removed).toBe(1);
  });

  it('records a failed download and keeps the copy it had', async () => {
    const { api, setRows } = await app();
    await importOffDump(t!.ctx);
    setRows([ROWS[2]!]);
    await expect(importOffDump(t!.ctx)).rejects.toThrow('No products sold in united kingdom');
    expect(await api.get<OffDumpStatusDto>('/api/off-dump')).toMatchObject({ products: 3, last: { status: 'failed', error: expect.stringContaining('No products') } });
  });

  it('admins refresh it from Settings', async () => {
    const { api } = await app();
    const started = await api.post<OffDumpStatusDto>('/api/off-dump/import');
    expect(started.last?.status).toBe('running');
    await offImportSettled();
    expect((await api.get<OffDumpStatusDto>('/api/off-dump')).last?.status).toBe('done');
  });
});

describe('without a local copy', () => {
  it("doesn't offer refreshing", async () => {
    t = await makeTestApp();
    const api: Client = await setupAdmin(t.app);
    expect((await api.raw('POST', '/api/off-dump/import', {})).statusCode).toBe(400);
    expect(await api.get<OffDumpStatusDto>('/api/off-dump')).toMatchObject({ enabled: false, products: 0, last: null });
  });
});
