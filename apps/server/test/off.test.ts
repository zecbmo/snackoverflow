import { describe, expect, it } from 'vitest';
import { createOff, parseOffResponse } from '../src/services/off';

describe('Open Food Facts', () => {
  it('parses a product', () => {
    const p = parseOffResponse('123', {
      status: 1,
      product: {
        product_name: 'Semi Skimmed Milk',
        brands: 'Dairy Co, Other',
        quantity: '2.27 l',
        image_front_small_url: 'https://images.example/milk.jpg',
        categories_tags: ['en:dairies', 'en:milks'],
        nutriments: { 'energy-kcal_100g': 50, proteins_100g: '3.6', fat_100g: 1.8 },
      },
    });
    expect(p).toMatchObject({
      name: 'Semi Skimmed Milk',
      brand: 'Dairy Co',
      quantity: '2.27 l',
      categories: ['en:dairies', 'en:milks'],
      nutritionPer100g: { kcal: 50, protein: 3.6, fat: 1.8, carbs: null },
    });
  });

  it('builds the quantity from product_quantity when the label text is missing', () => {
    const p = parseOffResponse('1', { status: 1, product: { product_name: 'Rice', product_quantity: 1000, product_quantity_unit: 'g' } });
    expect(p?.quantity).toBe('1000 g');
  });

  it('returns null for unknown products', () => {
    expect(parseOffResponse('1', { status: 0, status_verbose: 'product not found' })).toBeNull();
  });

  it('fails gracefully when the service is down', async () => {
    const off = createOff({
      baseUrl: 'https://off.example',
      userAgent: 'test',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(await off.lookup('123')).toBeNull();
  });

  it('sends a User-Agent', async () => {
    let ua: string | null = null;
    const off = createOff({
      baseUrl: 'https://off.example/',
      userAgent: 'SnackOverflow/test',
      fetch: async (_url, init) => {
        ua = new Headers(init?.headers).get('User-Agent');
        return new Response(JSON.stringify({ status: 1, product: { product_name: 'X' } }));
      },
    });
    expect((await off.lookup('123'))?.name).toBe('X');
    expect(ua).toBe('SnackOverflow/test');
  });
});
