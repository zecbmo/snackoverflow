import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoodResultDto } from '@snackoverflow/shared';
import { rememberFoods, searchRemembered } from './foodCache';

const food = (title: string, source: FoodResultDto['source'] = 'product'): FoodResultDto => ({
  source,
  id: title,
  title,
  subtitle: null,
  kcalPerServing: 100,
  servingLabel: '1 pack',
  unitGrams: null,
  eatBy: null,
  ingredientId: null,
  displayUnit: 'g',
  countUnit: null,
  inStock: null,
  nutritionPerServing: null,
  favourite: false,
  usualServings: null,
});

describe('food cache for offline search', () => {
  beforeEach(() => {
    // The tests run in Node: a small in-memory localStorage.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });

  it('finds remembered foods, best match first, newest kept once', () => {
    rememberFoods([food('Ripe banana'), food('Banana bread')]);
    rememberFoods([food('Banana bread'), food('Snickers', 'off')]);
    expect(searchRemembered('banana').map((f) => f.title)).toEqual(['Banana bread', 'Ripe banana']);
    // Open Food Facts results need signal to pick, so they aren't kept.
    expect(searchRemembered('snickers')).toEqual([]);
  });
});
