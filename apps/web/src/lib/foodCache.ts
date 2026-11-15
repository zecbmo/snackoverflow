/**
 * Log food without signal: the foods you've seen lately (your kitchen, favourites, usual and
 * recent foods, and recent searches) are kept on the device, so search still finds them offline.
 */
import { type FoodResultDto, matchesSearch, searchRank } from '@snackoverflow/shared';

const KEY = 'so.food.cache';
const MAX = 300;

function load(): FoodResultDto[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FoodResultDto[]) : [];
  } catch {
    return [];
  }
}

const idOf = (f: FoodResultDto) => `${f.source}:${f.id}:${f.title}`;

/** Remember foods (newest first), keeping the list small. Open Food Facts results aren't kept: they need signal to pick. */
export function rememberFoods(foods: FoodResultDto[]) {
  if (!foods.length) return;
  const keep = foods.filter((f) => f.source !== 'off');
  const ids = new Set(keep.map(idOf));
  const next = [...keep, ...load().filter((f) => !ids.has(idOf(f)))].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // No storage: offline search just finds less.
  }
}

/** Search what's remembered, best matches first. */
export function searchRemembered(q: string): FoodResultDto[] {
  const all = load();
  if (!q.trim()) return all.slice(0, 20);
  return all
    .filter((f) => matchesSearch(`${f.title} ${f.subtitle ?? ''}`, q))
    .sort((a, b) => (searchRank(a.title, q) ?? 9) - (searchRank(b.title, q) ?? 9))
    .slice(0, 30);
}
