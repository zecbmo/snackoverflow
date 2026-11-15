import { describe, expect, it } from 'vitest';
import { contributionFields, createOff, type OffContribution, OffContributeError, parseOffResponse, parseOffSearch, SearchThrottle, splitBaseUrl } from '../src/services/off';

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

describe('sister databases', () => {
  const found = (name: string) => new Response(JSON.stringify({ status: 1, product: { product_name: name } }));
  const notFound = () => new Response(JSON.stringify({ status: 0, status_verbose: 'product not found' }), { status: 404 });

  it('asks the sisters when Open Food Facts has never heard of it', async () => {
    const asked: string[] = [];
    const off = createOff({
      baseUrl: 'https://food.example',
      sisterUrls: ['https://products.example', 'https://pets.example'],
      userAgent: 'test',
      fetch: async (url) => {
        const host = new URL(String(url)).host;
        asked.push(host);
        return host === 'pets.example' ? found('Dog biscuits') : notFound();
      },
    });
    expect((await off.lookup('5000112548167'))?.name).toBe('Dog biscuits');
    expect(asked).toEqual(['food.example', 'products.example', 'pets.example']);
  });

  it('prefers the first sister in the list when more than one knows it', async () => {
    const off = createOff({
      baseUrl: 'https://food.example',
      sisterUrls: ['https://products.example', 'https://beauty.example'],
      userAgent: 'test',
      fetch: async (url) => {
        const host = new URL(String(url)).host;
        return host === 'food.example' ? notFound() : found(host);
      },
    });
    expect((await off.lookup('1'))?.name).toBe('products.example');
  });

  it("doesn't ask the sisters when Open Food Facts has it", async () => {
    const asked: string[] = [];
    const off = createOff({
      baseUrl: 'https://food.example',
      sisterUrls: ['https://products.example'],
      userAgent: 'test',
      fetch: async (url) => {
        asked.push(new URL(String(url)).host);
        return found('Milk');
      },
    });
    expect((await off.lookup('1'))?.name).toBe('Milk');
    expect(asked).toEqual(['food.example']);
  });

  it("doesn't ask the sisters when Open Food Facts can't be reached", async () => {
    const asked: string[] = [];
    const off = createOff({
      baseUrl: 'https://food.example',
      sisterUrls: ['https://products.example'],
      userAgent: 'test',
      fetch: async (url) => {
        asked.push(new URL(String(url)).host);
        return new Response('busy', { status: 503 });
      },
    });
    expect(await off.lookup('1')).toBeNull();
    expect(asked).toEqual(['food.example']);
  });
});

describe('adding to Open Food Facts', () => {
  const contribution: OffContribution = {
    barcode: '5000112548167',
    name: 'Greek style yogurt',
    brand: 'Dairy Co',
    quantity: '500 g',
    nutritionPer100g: { kcal: 97, fat: 5, protein: 6, carbs: null },
    appUuid: 'abc123',
  };

  it('sends the product, the app and the account as form fields', () => {
    const f = contributionFields(contribution, { userId: 'snackbot', password: 'secret', country: 'en:united-kingdom' });
    expect(Object.fromEntries(f)).toMatchObject({
      code: '5000112548167',
      user_id: 'snackbot',
      password: 'secret',
      app_name: 'SnackOverflow',
      app_uuid: 'abc123',
      lang: 'en',
      product_name: 'Greek style yogurt',
      brands: 'Dairy Co',
      quantity: '500 g',
      countries: 'en:united-kingdom',
      nutrition_data_per: '100g',
      'nutriment_energy-kcal': '97',
      'nutriment_energy-kcal_unit': 'kcal',
      nutriment_fat: '5',
      nutriment_proteins: '6',
    });
    expect(f.has('nutriment_carbohydrates')).toBe(false);
  });

  it("leaves out what it doesn't know", () => {
    const f = contributionFields({ ...contribution, brand: null, quantity: null, nutritionPer100g: null }, { userId: 'u', password: 'p' });
    for (const k of ['brands', 'quantity', 'countries', 'nutrition_data_per']) expect(f.has(k)).toBe(false);
  });

  it('posts to the write API and reports a refusal', async () => {
    const calls: { url: string; body: string; auth: string | null }[] = [];
    let reply = { status: 1, status_verbose: 'fields saved' };
    const off = createOff({
      baseUrl: 'https://off:off@staging.example/',
      userAgent: 'test',
      contributor: { userId: 'snackbot', password: 'secret' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get('Authorization') });
        return new Response(JSON.stringify(reply));
      },
    });
    await off.contribute(contribution);
    expect(calls[0]?.url).toBe('https://staging.example/cgi/product_jqm2.pl');
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('off:off').toString('base64')}`);
    expect(new URLSearchParams(calls[0]?.body).get('product_name')).toBe('Greek style yogurt');

    reply = { status: 0, status_verbose: 'no code or invalid code' };
    await expect(off.contribute(contribution)).rejects.toThrow(OffContributeError);
  });

  it('refuses without an account and fails gracefully offline', async () => {
    const noAccount = createOff({ baseUrl: 'https://food.example', userAgent: 'test' });
    await expect(noAccount.contribute(contribution)).rejects.toThrow('not set up');
    const offline = createOff({
      baseUrl: 'https://food.example',
      userAgent: 'test',
      contributor: { userId: 'u', password: 'p' },
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(offline.contribute(contribution)).rejects.toThrow("Couldn't reach");
    expect(await offline.hasProduct('1')).toBeNull();
  });
});

describe('splitBaseUrl', () => {
  it('moves a user and password into a header', () => {
    expect(splitBaseUrl('https://world.openfoodfacts.org/')).toEqual({ base: 'https://world.openfoodfacts.org', headers: {} });
    expect(splitBaseUrl('https://off:off@world.openfoodfacts.net').base).toBe('https://world.openfoodfacts.net');
  });
});

describe('search by name', () => {
  const body = {
    products: [
      { code: '5000159407236', product_name: 'Snickers', brands: 'Mars', quantity: '48 g', nutriments: { 'energy-kcal_100g': 488 } },
      { code: '123', product_name: 'Too short a barcode' },
      { code: '5000159461122' },
    ],
  };

  it('keeps named products with a real barcode', () => {
    expect(parseOffSearch(body).map((p) => [p.barcode, p.name, p.nutritionPer100g?.kcal])).toEqual([['5000159407236', 'Snickers', 488]]);
    expect(parseOffSearch({})).toEqual([]);
  });

  it('asks for products sold in the UK, most scanned first, and remembers the answer', async () => {
    const urls: string[] = [];
    const off = createOff({
      baseUrl: 'https://off.example',
      userAgent: 'test',
      country: 'en:united-kingdom',
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify(body));
      },
    });
    expect(await off.search('Snickers ')).toMatchObject({ status: 'ok', products: [{ name: 'Snickers' }] });
    await off.search('snickers');
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe('/cgi/search.pl');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ search_terms: 'snickers', json: '1', sort_by: 'unique_scans_n', tagtype_0: 'countries', tag_0: 'united-kingdom' });
  });

  it("keeps under Open Food Facts' limit of searches a minute", async () => {
    let now = 0;
    const throttle = new SearchThrottle(2, 1000, 10, () => now);
    const off = createOff({ baseUrl: 'https://off.example', userAgent: 'test', throttle, fetch: async () => new Response(JSON.stringify(body)) });
    expect((await off.search('a')).status).toBe('ok');
    expect((await off.search('b')).status).toBe('ok');
    expect((await off.search('c')).status).toBe('busy');
    // Answers already had don't count.
    expect((await off.search('a')).status).toBe('ok');
    now = 61_000;
    expect((await off.search('c')).status).toBe('ok');
  });

  it('fails gracefully', async () => {
    const off = createOff({
      baseUrl: 'https://off.example',
      userAgent: 'test',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(await off.search('snickers')).toEqual({ status: 'failed' });
  });
});
