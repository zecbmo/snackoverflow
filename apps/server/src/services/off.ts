/**
 * Open Food Facts barcode lookup. Optional: any failure (offline, timeout, not
 * found) returns null and the scan carries on as an unknown product.
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

export interface OpenFoodFacts {
  lookup(barcode: string): Promise<OffProduct | null>;
}

export const disabledOff: OpenFoodFacts = { lookup: async () => null };

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

export function createOff(opts: { baseUrl: string; userAgent: string; fetch?: FetchFn; timeoutMs?: number }): OpenFoodFacts {
  const f = opts.fetch ?? fetch;
  return {
    async lookup(barcode) {
      const url = `${opts.baseUrl.replace(/\/$/, '')}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`;
      try {
        const res = await f(url, {
          headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
        if (!res.ok) return null;
        return parseOffResponse(barcode, await res.json());
      } catch {
        return null;
      }
    },
  };
}
