/**
 * Open Food Facts barcode lookup, and adding new products to it.
 *
 * Lookups try Open Food Facts first, then its sister databases (Open Products Facts, Open Pet Food
 * Facts, Open Beauty Facts) for things that aren't food. Optional: any failure (offline, timeout,
 * not found) returns null and the scan carries on as an unknown product.
 */
import type { Nutrition } from '@snackoverflow/shared';

export interface OffProduct {
  barcode: string;
  name: string | null;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
  categories: string[];
  nutritionPer100g: Nutrition | null;
}

/** A product this household named, to add to Open Food Facts. */
export interface OffContribution {
  barcode: string;
  name: string;
  brand: string | null;
  /** As printed on the pack, e.g. "500 g" or "4 x 125 g". */
  quantity: string | null;
  nutritionPer100g: Nutrition | null;
  /** Stands for the person adding it (salted, so it says nothing about them) so moderators can tell people apart. */
  appUuid: string;
}

export class OffContributeError extends Error {}

export interface OpenFoodFacts {
  lookup(barcode: string): Promise<OffProduct | null>;
  /** Whether Open Food Facts itself (not a sister database) has this barcode; null when it can't be reached. */
  hasProduct(barcode: string): Promise<boolean | null>;
  /** Adds a new product to Open Food Facts. Throws OffContributeError when it can't. */
  contribute(product: OffContribution): Promise<void>;
}

export const disabledOff: OpenFoodFacts = {
  lookup: async () => null,
  hasProduct: async () => null,
  contribute: async () => {
    throw new OffContributeError('Adding to Open Food Facts is not set up.');
  },
};

type FetchFn = typeof fetch;

const FIELDS = [
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'quantity',
  'product_quantity',
  'product_quantity_unit',
  'image_front_small_url',
  'image_front_url',
  'categories_tags',
  'nutriments',
].join(',');

const APP_NAME = 'SnackOverflow';
const APP_VERSION = '0.1';

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function parseOffResponse(barcode: string, body: unknown): OffProduct | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { status?: unknown; product?: Record<string, unknown> };
  if (!(b.status === 1 || b.status === 'success') || !b.product) return null;
  const p = b.product;
  const str = (k: string) => (typeof p[k] === 'string' && (p[k] as string).trim() !== '' ? (p[k] as string).trim() : null);
  const n = (p.nutriments ?? {}) as Record<string, unknown>;
  const nutrition: Nutrition = {
    kcal: num(n['energy-kcal_100g']),
    protein: num(n.proteins_100g),
    carbs: num(n.carbohydrates_100g),
    sugars: num(n.sugars_100g),
    fat: num(n.fat_100g),
    saturates: num(n['saturated-fat_100g']),
    fibre: num(n.fiber_100g),
    salt: num(n.salt_100g),
  };
  const hasNutrition = Object.values(nutrition).some((v) => v !== null);
  let quantity = str('quantity');
  if (!quantity && num(p.product_quantity) !== null) {
    quantity = `${num(p.product_quantity)} ${str('product_quantity_unit') ?? 'g'}`;
  }
  const brand = str('brands')?.split(',')[0]?.trim() ?? null;
  return {
    barcode,
    name: str('product_name_en') ?? str('product_name') ?? str('generic_name'),
    brand,
    quantity,
    imageUrl: str('image_front_small_url') ?? str('image_front_url'),
    categories: Array.isArray(p.categories_tags) ? (p.categories_tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    nutritionPer100g: hasNutrition ? nutrition : null,
  };
}

/**
 * A base URL may carry a user and password (the staging server needs `https://off:off@world.openfoodfacts.net`).
 * fetch refuses URLs with credentials, so they move into an Authorization header.
 */
export function splitBaseUrl(raw: string): { base: string; headers: Record<string, string> } {
  try {
    const u = new URL(raw);
    const headers: Record<string, string> = {};
    if (u.username || u.password) {
      headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
      u.username = '';
      u.password = '';
    }
    return { base: u.toString().replace(/\/$/, ''), headers };
  } catch {
    return { base: raw.replace(/\/$/, ''), headers: {} };
  }
}

/** Open Food Facts' field names for our nutrition, all per 100g. */
const NUTRIENTS: [keyof Nutrition, string, string][] = [
  ['kcal', 'energy-kcal', 'kcal'],
  ['fat', 'fat', 'g'],
  ['saturates', 'saturated-fat', 'g'],
  ['carbs', 'carbohydrates', 'g'],
  ['sugars', 'sugars', 'g'],
  ['fibre', 'fiber', 'g'],
  ['protein', 'proteins', 'g'],
  ['salt', 'salt', 'g'],
];

/** The form fields for Open Food Facts' product write API (product_jqm2.pl). */
export function contributionFields(c: OffContribution, opts: { userId: string; password: string; country?: string | undefined }): URLSearchParams {
  const f = new URLSearchParams({
    code: c.barcode,
    user_id: opts.userId,
    password: opts.password,
    app_name: APP_NAME,
    app_version: APP_VERSION,
    app_uuid: c.appUuid,
    comment: `Added with ${APP_NAME}`,
    lang: 'en',
    product_name: c.name,
  });
  if (c.brand) f.set('brands', c.brand);
  if (c.quantity) f.set('quantity', c.quantity);
  if (opts.country) f.set('countries', opts.country);
  const n = c.nutritionPer100g;
  if (n && NUTRIENTS.some(([k]) => n[k] != null)) {
    f.set('nutrition_data_per', '100g');
    for (const [k, field, unit] of NUTRIENTS) {
      const v = n[k];
      if (v == null) continue;
      f.set(`nutriment_${field}`, String(v));
      f.set(`nutriment_${field}_unit`, unit);
    }
  }
  return f;
}

type Fetched = { kind: 'found'; product: OffProduct } | { kind: 'missing' } | { kind: 'failed' };

export function createOff(opts: {
  baseUrl: string;
  /** Sister databases tried, together, when Open Food Facts doesn't know a barcode. */
  sisterUrls?: string[];
  userAgent: string;
  /** An Open Food Facts account for adding products; without one, contribute() refuses. */
  contributor?: { userId: string; password: string } | null;
  /** Taxonomy name for where the product is sold, e.g. "en:united-kingdom". */
  country?: string | undefined;
  fetch?: FetchFn;
  timeoutMs?: number;
}): OpenFoodFacts {
  const f = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 5000;
  const main = splitBaseUrl(opts.baseUrl);
  const sisters = (opts.sisterUrls ?? []).filter((u) => u.trim() !== '').map(splitBaseUrl);

  async function fetchFrom(site: { base: string; headers: Record<string, string> }, barcode: string): Promise<Fetched> {
    const url = `${site.base}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`;
    try {
      const res = await f(url, {
        headers: { ...site.headers, 'User-Agent': opts.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      // An unknown barcode is a 404 (or a 200 with status 0).
      if (res.status === 404) return { kind: 'missing' };
      if (!res.ok) return { kind: 'failed' };
      const product = parseOffResponse(barcode, await res.json());
      return product ? { kind: 'found', product } : { kind: 'missing' };
    } catch {
      return { kind: 'failed' };
    }
  }

  return {
    async lookup(barcode) {
      const food = await fetchFrom(main, barcode);
      if (food.kind === 'found') return food.product;
      // Only ask the others when Open Food Facts answered "not found": if it can't be reached, they likely can't either.
      if (food.kind === 'failed' || sisters.length === 0) return null;
      const others = await Promise.all(sisters.map((s) => fetchFrom(s, barcode)));
      for (const o of others) if (o.kind === 'found') return o.product;
      return null;
    },

    async hasProduct(barcode) {
      const r = await fetchFrom(main, barcode);
      return r.kind === 'failed' ? null : r.kind === 'found';
    },

    async contribute(c) {
      if (!opts.contributor) throw new OffContributeError('Adding to Open Food Facts is not set up.');
      let res: Response;
      try {
        res = await f(`${main.base}/cgi/product_jqm2.pl`, {
          method: 'POST',
          headers: { ...main.headers, 'User-Agent': opts.userAgent, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: contributionFields(c, { ...opts.contributor, country: opts.country }).toString(),
          signal: AbortSignal.timeout(timeout * 2),
        });
      } catch {
        throw new OffContributeError("Couldn't reach Open Food Facts. Try again later.");
      }
      const body = (await res.json().catch(() => null)) as { status?: unknown; status_verbose?: unknown } | null;
      if (!res.ok || body?.status !== 1) {
        const why = typeof body?.status_verbose === 'string' ? `: ${body.status_verbose}` : '';
        throw new OffContributeError(`Open Food Facts didn't take it${why}.`);
      }
    },
  };
}
