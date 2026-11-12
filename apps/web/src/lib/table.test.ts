import { describe, expect, it } from 'vitest';
import { groupRows, matchesSearch, sortRows } from './table';

describe('matchesSearch', () => {
  it('needs every word, in any order, ignoring case and accents', () => {
    expect(matchesSearch('Semi Skimmed Milk · Fridge', 'milk fridge')).toBe(true);
    expect(matchesSearch('Semi Skimmed Milk', 'skimmed oat')).toBe(false);
    expect(matchesSearch('Crème fraîche', 'creme')).toBe(true);
    expect(matchesSearch('Anything', '   ')).toBe(true);
  });
});

describe('sortRows', () => {
  const rows = [
    { name: 'Spinach', date: '2026-11-14' },
    { name: 'bread', date: null },
    { name: 'Apples', date: '2026-11-12' },
    { name: 'Item 10', date: '2026-11-20' },
    { name: 'Item 9', date: '2026-11-20' },
  ];
  it('sorts text naturally and keeps empty values last both ways', () => {
    expect(sortRows(rows, (r) => r.name).map((r) => r.name)).toEqual(['Apples', 'bread', 'Item 9', 'Item 10', 'Spinach']);
    expect(sortRows(rows, (r) => r.date).map((r) => r.name)).toEqual(['Apples', 'Spinach', 'Item 10', 'Item 9', 'bread']);
    expect(sortRows(rows, (r) => r.date, 'desc').map((r) => r.name)).toEqual(['Item 10', 'Item 9', 'Spinach', 'Apples', 'bread']);
  });
  it('sorts numbers as numbers', () => {
    expect(sortRows([{ n: 10 }, { n: 9 }, { n: 100 }], (r) => r.n).map((r) => r.n)).toEqual([9, 10, 100]);
  });
});

describe('groupRows', () => {
  const rows = [
    { name: 'Milk', where: 'Fridge' },
    { name: 'Peas', where: 'Freezer' },
    { name: 'Rice', where: 'Cupboard' },
    { name: 'Ham', where: 'Fridge' },
    { name: 'Tea', where: 'Pantry' },
  ];
  it('keeps first-seen order without an order list', () => {
    expect(groupRows(rows, (r) => r.where).map((g) => [g.key, g.rows.map((r) => r.name)])).toEqual([
      ['Fridge', ['Milk', 'Ham']],
      ['Freezer', ['Peas']],
      ['Cupboard', ['Rice']],
      ['Pantry', ['Tea']],
    ]);
  });
  it('follows an order list, unknown groups last', () => {
    expect(groupRows(rows, (r) => r.where, ['Cupboard', 'Fridge', 'Freezer']).map((g) => g.key)).toEqual(['Cupboard', 'Fridge', 'Freezer', 'Pantry']);
  });
});
