/**
 * Unit conversion. Everything is stored in grams; conversion happens only at the
 * edges (input and display). The conversion numbers come from the seed data
 * (docs/data/unit-conversions.csv) and are passed in as a UnitTable, so no
 * food-specific numbers live in code. Metric prefixes (1000) are definitions.
 */
import { parseCsv } from './csv';

export type BaseUnit = 'g' | 'ml';
export type DisplayUnit = 'g' | 'ml' | 'count';

export interface UnitTable {
  /** Fixed units: key -> size in grams or millilitres. */
  fixed: Record<string, { value: number; base: BaseUnit }>;
  /** Densities in g/ml keyed by ingredient key. */
  densities: Record<string, number>;
  /** Typical weight in grams of one item, keyed by item key. */
  counts: Record<string, number>;
  /** Density used for liquids with no density of their own (water). */
  defaultDensity: number;
}

/** Per-ingredient measures used to turn ml and counts into grams. */
export interface Measures {
  densityGPerMl?: number | null;
  gramsPerCount?: number | null;
}

export function parseUnitTable(csv: string): UnitTable {
  const table: UnitTable = { fixed: {}, densities: {}, counts: {}, defaultDensity: 1 };
  for (const row of parseCsv(csv)) {
    const value = Number(row.value);
    if (!row.key || !Number.isFinite(value)) continue;
    if (row.type === 'fixed' && (row.unit === 'g' || row.unit === 'ml')) {
      table.fixed[row.key] = { value, base: row.unit };
    } else if (row.type === 'density') {
      table.densities[row.key] = value;
      if (row.key === 'water') table.defaultDensity = value;
    } else if (row.type === 'count') {
      table.counts[row.key] = value;
    }
  }
  return table;
}

/** Spellings people and recipe sites use, mapped to the keys in the unit table. */
const UNIT_ALIASES: Record<string, string> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  gr: 'g',
  grm: 'g',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  ml: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  cl: 'cl',
  centilitre: 'cl',
  centilitres: 'cl',
  l: 'l',
  ltr: 'l',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tbsp: 'tbsp',
  tbs: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  cup: 'cup_metric',
  cups: 'cup_metric',
  cup_metric: 'cup_metric',
  cup_us: 'cup_us',
  'fl oz': 'fl_oz_uk',
  floz: 'fl_oz_uk',
  fl_oz_uk: 'fl_oz_uk',
  pint: 'pint_uk',
  pints: 'pint_uk',
  pt: 'pint_uk',
  pint_uk: 'pint_uk',
  pinch: 'pinch',
  pinches: 'pinch',
  count: 'count',
  x: 'count',
  each: 'count',
  item: 'count',
  items: 'count',
  pcs: 'count',
  pack: 'count',
};

export function normaliseUnit(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[u] ?? u;
}

function fixedUnit(table: UnitTable, unit: string): { value: number; base: BaseUnit } | undefined {
  if (unit === 'cl') {
    const ml = table.fixed.ml;
    return ml ? { value: ml.value * 10, base: 'ml' } : undefined;
  }
  return table.fixed[unit];
}

/** The base kind of a unit: mass, volume or count. Returns null for unknown units. */
export function unitKind(unit: string, table: UnitTable): 'mass' | 'volume' | 'count' | null {
  const u = normaliseUnit(unit);
  if (u === 'count') return 'count';
  const f = fixedUnit(table, u);
  if (!f) return null;
  return f.base === 'g' ? 'mass' : 'volume';
}

/**
 * Convert an amount in any unit to grams. Volumes use the ingredient's density
 * (water when it has none); counts need the ingredient's weight per item.
 * Returns null when it can't be converted (unknown unit, count with no weight).
 */
export function toGrams(amount: number, unit: string, table: UnitTable, measures: Measures = {}): number | null {
  if (!Number.isFinite(amount)) return null;
  const u = normaliseUnit(unit);
  if (u === 'count') {
    return measures.gramsPerCount ? amount * measures.gramsPerCount : null;
  }
  const f = fixedUnit(table, u);
  if (!f) return null;
  if (f.base === 'g') return amount * f.value;
  return amount * f.value * (measures.densityGPerMl ?? table.defaultDensity);
}

/** Convert grams back to an amount in the given unit; null if impossible. */
export function fromGrams(grams: number, unit: string, table: UnitTable, measures: Measures = {}): number | null {
  const oneUnit = toGrams(1, unit, table, measures);
  return oneUnit ? grams / oneUnit : null;
}

function trimNumber(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

/**
 * Format a quantity for display: "120g", "2.9kg", "568ml", "2.27L", "3".
 * `display` is how the product is sold: by weight, by volume or by count.
 */
export function formatQuantity(
  grams: number,
  display: DisplayUnit = 'g',
  measures: Measures = {},
  defaultDensity = 1,
): string {
  if (display === 'count' && measures.gramsPerCount) {
    const n = grams / measures.gramsPerCount;
    return trimNumber(n, n < 10 ? 1 : 0);
  }
  if (display === 'ml') {
    const ml = grams / (measures.densityGPerMl ?? defaultDensity);
    if (ml >= 1000) return `${trimNumber(ml / 1000, 2)}L`;
    return `${trimNumber(ml, 0)}ml`;
  }
  if (grams >= 1000) return `${trimNumber(grams / 1000, grams >= 10_000 ? 1 : 2)}kg`;
  if (grams < 10) return `${trimNumber(grams, 1)}g`;
  return `${trimNumber(grams, 0)}g`;
}

/** What's needed to say an amount the way a food is measured. */
export interface FoodUnit {
  displayUnit?: DisplayUnit | null;
  packUnit?: string | null;
  densityGPerMl?: number | null;
  gramsPerCount?: number | null;
  countUnit?: string | null;
}

/** Grams said the way the food is measured: "568ml" or "1.2L" for liquids, "6 eggs", otherwise "300g" or "2.5kg". */
export function amountText(grams: number, food?: FoodUnit | null): string {
  if (food?.displayUnit === 'ml' || food?.packUnit === 'ml') return formatQuantity(grams, 'ml', { densityGPerMl: food.densityGPerMl ?? undefined });
  if ((food?.displayUnit === 'count' || food?.packUnit === 'count') && food.gramsPerCount) {
    const n = Math.round((grams / food.gramsPerCount) * 2) / 2;
    return food.countUnit ? `${n} ${food.countUnit}${n === 1 ? '' : 's'}` : String(n);
  }
  return formatQuantity(grams);
}

export interface ParsedQuantity {
  amount: number;
  unit: string;
}

function firstWordUnit(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('fl oz') || t.startsWith('fl. oz')) return 'fl oz';
  return t.split(/[\s.]+/)[0] ?? t;
}

/**
 * Parse a pack quantity as printed on a label or in Open Food Facts:
 * "500 g", "2.27 l", "1kg", "4 x 125g", "6x330ml", "4 pints", "12".
 * Multipacks are multiplied out. Returns null when there's nothing usable.
 */
export function parsePackQuantity(text: string | null | undefined): ParsedQuantity | null {
  if (!text) return null;
  const s = text.toLowerCase().replace(/(\d),(\d)/g, '$1.$2').trim();
  const multi = s.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*([a-z][a-z ._]*)?/);
  if (multi) {
    const n = Number(multi[1]);
    const each = Number(multi[2]);
    const unit = multi[3] ? normaliseUnit(firstWordUnit(multi[3])) : 'count';
    return { amount: n * each, unit };
  }
  const single = s.match(/(\d+(?:\.\d+)?)\s*([a-z][a-z ._]*)?/);
  if (!single) return null;
  const amount = Number(single[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = single[2] ? normaliseUnit(firstWordUnit(single[2])) : 'count';
  return { amount, unit };
}

/** Pack sizes as written in docs/data/pack-sizes.csv: "1000;3 count" with a default unit. */
export function parsePackSizes(list: string, defaultUnit: string): ParsedQuantity[] {
  return list
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
      if (!m) return null;
      return { amount: Number(m[1]), unit: normaliseUnit(m[2] || defaultUnit) };
    })
    .filter((p): p is ParsedQuantity => p !== null);
}

/** A pack size as printed: "2.27L", "500g", "1kg", "6 pack". */
export function formatPackSize(amount: number | null | undefined, unit: string | null | undefined): string {
  if (!amount || !unit) return '';
  const u = normaliseUnit(unit);
  const n = String(Number(amount.toFixed(2)));
  if (u === 'l') return `${n}L`;
  if (u === 'count') return `${n} pack`;
  if (u === 'pint_uk') return `${n} pint${amount === 1 ? '' : 's'}`;
  return `${n}${u}`;
}
