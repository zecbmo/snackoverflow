/** Helpers for the fast food and takeaway pages. Pure, so they're unit-tested. */
import type { ChainDto, ChainMenuItemDto } from '@snackoverflow/shared';

export type Nutrient = 'kcal' | 'fat' | 'saturates' | 'carbs' | 'sugars' | 'fibre' | 'protein' | 'salt';

export const NUTRIENTS: { key: Nutrient; label: string; unit: string }[] = [
  { key: 'kcal', label: 'Energy', unit: 'kcal' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'saturates', label: 'Saturates', unit: 'g' },
  { key: 'carbs', label: 'Carbohydrate', unit: 'g' },
  { key: 'sugars', label: 'Sugars', unit: 'g' },
  { key: 'fibre', label: 'Fibre', unit: 'g' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'salt', label: 'Salt', unit: 'g' },
];

/** "12", "2.3", "0.25" → at most two significant decimals, no trailing zeros; "" when not published. */
export function nutrientValue(n: number | null | undefined, key: Nutrient = 'fat'): string {
  if (n === null || n === undefined) return '';
  if (key === 'kcal') return String(Math.round(n));
  const digits = n < 1 ? 2 : 1;
  return String(Number(n.toFixed(digits)));
}

/** The same nutrient per 100g, when the chain publishes the serving's weight. */
export function per100g(item: Pick<ChainMenuItemDto, 'servingG'>, value: number | null): number | null {
  if (value === null || !item.servingG) return null;
  return (value / item.servingG) * 100;
}

/** "170–540 kcal", "300 kcal", or "" for a chain with no menu yet. */
export function kcalRange(c: Pick<ChainDto, 'kcalMin' | 'kcalMax'>): string {
  if (c.kcalMin === null || c.kcalMax === null) return '';
  const lo = Math.round(c.kcalMin);
  const hi = Math.round(c.kcalMax);
  return lo === hi ? `${lo} kcal` : `${lo}–${hi} kcal`;
}

/** "Medium · 340g", "1 burger", "" */
export function servingLabel(item: Pick<ChainMenuItemDto, 'serving' | 'servingG'>): string {
  const g = item.servingG ? `${nutrientValue(item.servingG, 'kcal')}g` : '';
  if (item.serving && g && !item.serving.toLowerCase().includes(g.toLowerCase())) return `${item.serving} · ${g}`;
  return item.serving || g;
}

/** "P 28g · C 44g · F 27g", leaving out what isn't published. */
export function macroSummary(item: Pick<ChainMenuItemDto, 'protein' | 'carbs' | 'fat'>): string {
  return (
    [
      ['P', item.protein],
      ['C', item.carbs],
      ['F', item.fat],
    ] as const
  )
    .filter(([, v]) => v !== null)
    .map(([l, v]) => `${l} ${nutrientValue(v)}g`)
    .join(' · ');
}
