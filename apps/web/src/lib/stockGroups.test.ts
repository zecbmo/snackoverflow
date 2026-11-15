import { describe, expect, it } from 'vitest';
import type { StockItemDto } from '@snackoverflow/shared';
import { groupStock, groupSummary, phoneMeta, phoneShowsDate } from './stockGroups';
import { amountLabel, toneFor } from './format';

const base: StockItemDto = {
  id: '1',
  productId: 'p',
  productName: 'Potatoes',
  brand: null,
  imageUrl: null,
  ingredientId: null,
  locationId: 'cup',
  locationName: 'Cupboard',
  locationType: 'cupboard',
  state: 'closed',
  bestBefore: '2026-11-18',
  addedOn: '2026-11-01',
  openedOn: null,
  frozenOn: null,
  fractionLeft: 1,
  initialGrams: 2500,
  remainingGrams: 2500,
  displayUnit: 'g',
  densityGPerMl: null,
  gramsPerCount: null,
  countUnit: null,
  itemGrams: null,
  addedAt: '2026-11-01T10:00:00Z',
  isMeal: false,
  actions: { open: null, freeze: null, defrost: "It isn't frozen.", freezeWarning: null },
  foodGroup: null,
  kcalPer100g: null,
};

describe('groupStock', () => {
  it('shows one row per product and location, packs hidden inside', () => {
    const items = [
      base,
      { ...base, id: '2', fractionLeft: 0.16, remainingGrams: 400, bestBefore: '2026-11-25' },
      { ...base, id: '3', locationId: 'frz', locationName: 'Freezer', state: 'frozen' as const },
    ];
    const groups = groupStock(items);
    expect(groups).toHaveLength(2);
    expect(groupSummary(groups[0]!)).toBe('Cupboard · 2 packs · 2.9kg');
    expect(groups[0]!.first.id).toBe('1');
  });

  it('describes identical full packs as a multiple', () => {
    const groups = groupStock([base, { ...base, id: '2' }]);
    expect(groupSummary(groups[0]!)).toBe('Cupboard · 2 × 2.5kg');
  });

  it('describes a single opened pack', () => {
    const g = groupStock([{ ...base, state: 'opened', fractionLeft: 0.05, remainingGrams: 120 }]);
    expect(groupSummary(g[0]!)).toBe('Cupboard · opened · ~120g');
  });
});

describe('format', () => {
  it('colours by freshness, blue when frozen', () => {
    expect(toneFor({ state: 'closed', bestBefore: '2026-11-13' }, '2026-11-12')).toBe('red');
    expect(toneFor({ state: 'closed', bestBefore: '2026-11-15' }, '2026-11-12')).toBe('amber');
    expect(toneFor({ state: 'closed', bestBefore: '2026-12-15' }, '2026-11-12')).toBe('green');
    expect(toneFor({ state: 'frozen', bestBefore: '2026-11-13' }, '2026-11-12')).toBe('blue');
  });

  it('describes packs of unknown size', () => {
    expect(amountLabel({ ...base, initialGrams: null, remainingGrams: null, fractionLeft: 0.5 })).toBe('about half left');
  });
});

describe('meals', () => {
  it('counts leftovers in portions', () => {
    const meal = { ...base, isMeal: true, productName: 'Chilli', gramsPerCount: 350, initialGrams: 700, remainingGrams: 700, locationName: 'Fridge' };
    expect(groupSummary(groupStock([meal])[0]!)).toBe('Fridge · 2 portions');
    expect(amountLabel({ ...meal, remainingGrams: 350 })).toBe('1 portion');
  });
});

describe('a phone row', () => {
  it('says where, then how much', () => {
    expect(phoneMeta('Cupboard', '2L', 1, '')).toBe('Cupboard · 2L');
    expect(phoneMeta('Fridge', '~1.9L', 1, 'Opened')).toBe('Fridge · ~1.9L · opened');
    expect(phoneMeta('Cupboard', '5 items', 1, '')).toBe('Cupboard · 5 items');
  });

  it('falls back to the pack count when the amount is not known', () => {
    expect(phoneMeta('Cupboard', '', 1, '')).toBe('Cupboard · 1 pack');
    expect(phoneMeta('Freezer', '', 3, 'Frozen')).toBe('Freezer · 3 packs · frozen');
  });

  it('spells the date out only when it is close', () => {
    expect(phoneShowsDate('red')).toBe(true);
    expect(phoneShowsDate('amber')).toBe(true);
    expect(phoneShowsDate('green')).toBe(false);
    expect(phoneShowsDate('blue')).toBe(false);
    expect(phoneShowsDate('grey')).toBe(false);
  });
});
