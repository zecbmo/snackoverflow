import { describe, expect, it } from 'vitest';
import { kcalRange, macroSummary, nutrientValue, per100g, servingLabel } from './chains';

describe('chain menu helpers', () => {
  it('shows nutrients without false precision, and nothing when not published', () => {
    expect(nutrientValue(508.4, 'kcal')).toBe('508');
    expect(nutrientValue(9.5)).toBe('9.5');
    expect(nutrientValue(27)).toBe('27');
    expect(nutrientValue(2.25)).toBe('2.3');
    expect(nutrientValue(0.254)).toBe('0.25');
    expect(nutrientValue(null)).toBe('');
  });

  it('works out per 100g only when the serving weight is known', () => {
    expect(per100g({ servingG: 200 }, 500)).toBe(250);
    expect(per100g({ servingG: null }, 500)).toBeNull();
    expect(per100g({ servingG: 200 }, null)).toBeNull();
  });

  it('describes calorie ranges, servings and macros', () => {
    expect(kcalRange({ kcalMin: 170.2, kcalMax: 540 })).toBe('170–540 kcal');
    expect(kcalRange({ kcalMin: 300, kcalMax: 300 })).toBe('300 kcal');
    expect(kcalRange({ kcalMin: null, kcalMax: null })).toBe('');
    expect(servingLabel({ serving: 'Medium', servingG: 114 })).toBe('Medium · 114g');
    expect(servingLabel({ serving: '114g', servingG: 114 })).toBe('114g');
    expect(servingLabel({ serving: null, servingG: null })).toBe('');
    expect(macroSummary({ protein: 28, carbs: 44, fat: 27.04 })).toBe('P 28g · C 44g · F 27g');
    expect(macroSummary({ protein: null, carbs: null, fat: null })).toBe('');
  });
});
