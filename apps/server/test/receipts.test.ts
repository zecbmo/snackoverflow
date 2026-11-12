import { afterEach, describe, expect, it } from 'vitest';
import type { IngredientDto, LocationDto, ReceiptDto, ScanAddResult, ShoppingItemDto, StockItemDto } from '@snackoverflow/shared';
import { prices } from '../src/db/schema';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;
let ing: Record<string, IngredientDto>;

async function start(opts: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp({ off: new FakeOff({ '4001': { name: 'Tesco British Semi Skimmed Milk 4 Pints', quantity: '2.272 l' } }), ...opts });
  api = await setupAdmin(t.app);
  ing = Object.fromEntries((await api.get<IngredientDto[]>('/api/ingredients')).map((i) => [i.key ?? i.name, i]));
}
afterEach(async () => {
  await t.close();
});

const TILL = `TESCO
TES SEMI SKM MLK 4PT     1.55
CHKN BRST FILLETS 650G   4.25
2 x BKD BNS 415G         1.40
CARRIER BAG              0.10
TOTAL                    7.30
VISA                     7.30
12/11/2026`;

describe('receipts', () => {
  it('reads a pasted receipt, matches lines and skips non-food', async () => {
    await start();
    await api.post('/api/shopping', { ingredientId: ing.milk!.id });
    const { id } = await api.post<{ id: string }>('/api/receipts/text', { text: TILL });
    const r = await api.get<ReceiptDto>(`/api/receipts/${id}`);
    expect(r).toMatchObject({ status: 'review', store: 'Tesco', purchasedOn: '2026-11-12', lineCount: 3, totalPence: 720 });
    const [milk, chicken, beans, bag] = r.lines;
    expect(milk).toMatchObject({ ingredientName: 'Milk', matchSource: 'list', confidence: 'high', onList: true, skip: false });
    expect(chicken).toMatchObject({ ingredientName: 'Chicken breasts', matchSource: 'ingredient', confidence: 'low' });
    expect(beans).toMatchObject({ ingredientName: 'Baked beans', quantity: 2 });
    expect(bag).toMatchObject({ skip: true });
    // Defaults for the review: usual place and an estimated date.
    expect(milk!.bestBefore).toBe('2026-11-20');
    expect(chicken!.bestBefore).toBe('2026-11-15');
  });

  it('adds it all to stock, ticks the list, saves prices and remembers the wording', async () => {
    await start();
    await api.post('/api/shopping', { ingredientId: ing.milk!.id });
    const { id } = await api.post<{ id: string }>('/api/receipts/text', { text: TILL });
    const r = await api.post<{ added: number; ticked: number; prices: number }>(`/api/receipts/${id}/confirm`);
    expect(r).toEqual({ added: 4, ticked: 1, prices: 3 });
    const stock = await api.get<StockItemDto[]>('/api/stock');
    expect(stock.map((s) => s.productName).sort()).toEqual(['Baked beans 415g', 'Baked beans 415g', 'Chicken breast fillets 650g', 'Semi skimmed milk 4pt']);
    // Pack sizes come from the receipt wording: 4 pints of milk, 650g of chicken.
    expect(stock.find((s) => s.productName.startsWith('Semi'))?.initialGrams).toBeCloseTo(4 * 568 * 1.03, 0);
    expect(stock.find((s) => s.productName.startsWith('Chicken'))?.initialGrams).toBe(650);
    expect((await api.get<ShoppingItemDto[]>('/api/shopping'))[0]!.checked).toBe(true);
    const saved = await t.ctx.db.select().from(prices);
    expect(saved.map((p) => p.pricePence).sort((a, b) => a - b)).toEqual([70, 155, 425]);
    // The photo is gone and it can't be added twice.
    expect((await api.raw('POST', `/api/receipts/${id}/confirm`, {})).statusCode).toBe(409);
    // Next time the same wording is matched straight to the same product.
    const again = await api.post<{ id: string }>('/api/receipts/text', { text: TILL });
    const r2 = await api.get<ReceiptDto>(`/api/receipts/${again.id}`);
    expect(r2.lines[0]).toMatchObject({ matchSource: 'alias', confidence: 'high', productName: 'Semi skimmed milk 4pt' });
    expect(r2.lines[3]).toMatchObject({ skip: true });
  });

  it('lets lines be fixed before adding', async () => {
    await start();
    const { id } = await api.post<{ id: string }>('/api/receipts/text', { text: 'MYSTERY THING 2.00\nCARRIER BAG 0.10' });
    const r = await api.get<ReceiptDto>(`/api/receipts/${id}`);
    expect(r.lines[0]).toMatchObject({ matchSource: 'none', ingredientId: null });
    const locs = await api.get<LocationDto[]>('/api/locations');
    const fixed = await api.patch<ReceiptDto>(`/api/receipts/${id}/lines/${r.lines[0]!.id}`, { ingredientId: ing.chocolate!.id, locationId: locs.find((l) => l.type === 'cupboard')!.id });
    expect(fixed.lines[0]).toMatchObject({ ingredientName: 'Chocolate', confidence: 'high' });
    const done = await api.post<{ added: number }>(`/api/receipts/${id}/confirm`);
    expect(done.added).toBe(1);
  });

  it('refuses text with nothing priced', async () => {
    await start();
    expect((await api.raw('POST', '/api/receipts/text', { text: 'hello there\nnothing here' })).statusCode).toBe(400);
  });

  it('links a barcode to a receipt product the first time it is scanned', async () => {
    await start();
    const { id } = await api.post<{ id: string }>('/api/receipts/text', { text: 'TES SEMI SKM MLK 4PT 1.55' });
    await api.post(`/api/receipts/${id}/confirm`);
    const scanned = await api.post<ScanAddResult>('/api/scan/add', { barcode: '4001' });
    expect(scanned.product).toMatchObject({ name: 'Semi skimmed milk 4pt', barcodes: ['4001'] });
    expect(scanned.known).toBe(true);
  });

  it('does not link a barcode for a different pack size', async () => {
    await start();
    const { id } = await api.post<{ id: string }>('/api/receipts/text', { text: 'TES SEMI SKM MLK 2PT 0.95' });
    await api.post(`/api/receipts/${id}/confirm`);
    const scanned = await api.post<ScanAddResult>('/api/scan/add', { barcode: '4001' });
    expect(scanned.product.name).toBe('Tesco British Semi Skimmed Milk 4 Pints');
  });

  it('waits for an assistant when AI is not set up, then takes lines from it', async () => {
    await start();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const { id } = await api.post<{ id: string }>('/api/receipts/file', { data: png, type: 'image/png', source: 'photo' });
    expect((await api.get<ReceiptDto>(`/api/receipts/${id}`)).status).toBe('waiting');
    expect((await api.raw('GET', `/api/receipts/${id}/file`)).headers['content-type']).toBe('image/png');
    const r = await api.post<ReceiptDto>(`/api/receipts/${id}/lines`, {
      store: 'Aldi',
      date: '2026-11-11',
      lines: [{ text: 'Maris Piper Potatoes 2.5kg', quantity: 1, pricePence: 129 }],
    });
    expect(r).toMatchObject({ status: 'review', store: 'Aldi', lines: [expect.objectContaining({ ingredientName: 'Potatoes' })] });
    await api.post(`/api/receipts/${id}/confirm`);
    expect((await api.raw('GET', `/api/receipts/${id}/file`)).statusCode).toBe(404);
  });

  it('reads photos with AI when a key is set', async () => {
    const calls: unknown[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      const body = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: JSON.stringify({ store: 'Tesco', date: '2026-11-12', lines: [{ text: 'TES SEMI SKM MLK 4PT', quantity: 1, pricePence: 155 }] }) }],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await start({ config: { AI_API_KEY: 'test-key' }, fetch: fakeFetch });
    const { id } = await api.post<{ id: string }>('/api/receipts/file', { data: Buffer.from('fake image').toString('base64'), type: 'image/jpeg', source: 'photo' });
    let r = await api.get<ReceiptDto>(`/api/receipts/${id}`);
    for (let i = 0; i < 50 && r.status === 'reading'; i++) {
      await new Promise((res) => setTimeout(res, 20));
      r = await api.get<ReceiptDto>(`/api/receipts/${id}`);
    }
    expect(r).toMatchObject({ status: 'review', store: 'Tesco', lines: [expect.objectContaining({ ingredientName: 'Milk', pricePence: 155 })] });
    const sent = calls[0] as { messages: { content: { type: string }[] }[] };
    expect(sent.messages[0]!.content[0]!.type).toBe('image');
  });
});
