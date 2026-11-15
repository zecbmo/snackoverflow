import { describe, expect, it } from 'vitest';
import { macroTotals, nutritionFor } from './nutrition';

describe('nutritionFor', () => {
  it('scales per-100g figures to a serving', () => {
    expect(nutritionFor({ kcal: 488, protein: 8.6, carbs: 60.5, fat: 23.5, salt: null }, 48)).toEqual({ kcal: 234.2, protein: 4.1, carbs: 29, fat: 11.3 });
  });
  it('is null without figures or a weight', () => {
    expect(nutritionFor(null, 100)).toBeNull();
    expect(nutritionFor({ kcal: 100 }, null)).toBeNull();
    expect(nutritionFor({}, 100)).toBeNull();
  });
});

describe('macroTotals', () => {
  it('adds up eaten servings and counts foods without macros', () => {
    expect(
      macroTotals([
        { nutritionPerServing: { protein: 10, carbs: 20, fat: 5 }, servings: 2 },
        { nutritionPerServing: { kcal: 300 }, servings: 1 },
        { nutritionPerServing: null, servings: 1 },
        { nutritionPerServing: { protein: 1, carbs: 1, fat: 1 }, servings: 0 },
      ]),
    ).toEqual({ protein: 20, carbs: 40, fat: 10, missing: 2 });
  });
});
