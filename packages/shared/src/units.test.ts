import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import {
  amountText,
  formatPackSize,
  formatQuantity,
  fromGrams,
  normaliseUnit,
  parsePackQuantity,
  parsePackSizes,
  parseUnitTable,
  toGrams,
  unitKind,
} from './units';

const seed = (file: string) => readFileSync(fileURLToPath(new URL(`../../../docs/data/${file}`, import.meta.url)), 'utf8');
const table = parseUnitTable(seed('unit-conversions.csv'));

describe('parseCsv', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    const rows = parseCsv('a,b,c\n1,"x, y","say ""hi"""\r\n2,,\n');
    expect(rows).toEqual([
      { a: '1', b: 'x, y', c: 'say "hi"' },
      { a: '2', b: '', c: '' },
    ]);
  });
});

describe('seed unit table', () => {
  it('loads fixed units, densities and counts from the CSV', () => {
    expect(table.fixed.kg).toEqual({ value: 1000, base: 'g' });
    expect(table.fixed.tbsp).toEqual({ value: 15, base: 'ml' });
    expect(table.densities.plain_flour).toBe(0.53);
    expect(table.counts.onion).toBe(150);
    expect(table.defaultDensity).toBe(1);
  });
});

describe('toGrams', () => {
  it('converts weights', () => {
    expect(toGrams(2.5, 'kg', table)).toBe(2500);
    expect(toGrams(1, 'lb', table)).toBeCloseTo(453.6);
    expect(toGrams(4, 'ounces', table)).toBeCloseTo(113.4);
  });

  it('converts volumes through density, defaulting to water', () => {
    expect(toGrams(500, 'ml', table)).toBe(500);
    expect(toGrams(1, 'litre', table, { densityGPerMl: 1.03 })).toBeCloseTo(1030);
    expect(toGrams(1, 'cup', table, { densityGPerMl: table.densities.plain_flour })).toBeCloseTo(132.5);
    expect(toGrams(2, 'tbsp', table, { densityGPerMl: 0.92 })).toBeCloseTo(27.6);
    expect(toGrams(1, 'pint', table, { densityGPerMl: 1.03 })).toBeCloseTo(585.04);
    expect(toGrams(33, 'cl', table)).toBeCloseTo(330);
  });

  it('converts counts with a per-item weight', () => {
    expect(toGrams(2, 'count', table, { gramsPerCount: table.counts.onion })).toBe(300);
    expect(toGrams(2, 'count', table)).toBeNull();
  });

  it('returns null for unknown units', () => {
    expect(toGrams(1, 'handful', table)).toBeNull();
  });

  it('converts back from grams', () => {
    expect(fromGrams(2500, 'kg', table)).toBe(2.5);
    expect(fromGrams(300, 'count', table, { gramsPerCount: 150 })).toBe(2);
  });
});

describe('units', () => {
  it('normalises spellings', () => {
    expect(normaliseUnit('Litres')).toBe('l');
    expect(normaliseUnit('tbsp.')).toBe('tbsp');
    expect(normaliseUnit('fl oz')).toBe('fl_oz_uk');
  });

  it('knows unit kinds', () => {
    expect(unitKind('kg', table)).toBe('mass');
    expect(unitKind('tsp', table)).toBe('volume');
    expect(unitKind('each', table)).toBe('count');
    expect(unitKind('bunch', table)).toBeNull();
  });
});

describe('amountText', () => {
  it('says liquids in ml and litres, counted food as a count, the rest by weight', () => {
    expect(amountText(568, { packUnit: 'ml', densityGPerMl: 1.03 })).toBe('551ml');
    expect(amountText(2340, { displayUnit: 'ml', densityGPerMl: 1.03 })).toBe('2.27L');
    expect(amountText(360, { packUnit: 'count', gramsPerCount: 60, countUnit: 'egg' })).toBe('6 eggs');
    expect(amountText(1200, { packUnit: 'g' })).toBe('1.2kg');
    expect(amountText(300, null)).toBe('300g');
  });
});

describe('formatQuantity', () => {
  it('formats weights', () => {
    expect(formatQuantity(120)).toBe('120g');
    expect(formatQuantity(2900)).toBe('2.9kg');
    expect(formatQuantity(2500)).toBe('2.5kg');
    expect(formatQuantity(0.3)).toBe('0.3g');
  });

  it('formats liquids using density', () => {
    expect(formatQuantity(2272 * 1.03, 'ml', { densityGPerMl: 1.03 })).toBe('2.27L');
    expect(formatQuantity(568, 'ml')).toBe('568ml');
  });

  it('formats counts', () => {
    expect(formatQuantity(348, 'count', { gramsPerCount: 58 })).toBe('6');
    expect(formatQuantity(87, 'count', { gramsPerCount: 58 })).toBe('1.5');
  });
});

describe('parsePackQuantity', () => {
  it.each([
    ['500 g', { amount: 500, unit: 'g' }],
    ['2.27 l', { amount: 2.27, unit: 'l' }],
    ['2,27 L', { amount: 2.27, unit: 'l' }],
    ['1kg', { amount: 1, unit: 'kg' }],
    ['4 x 125g', { amount: 500, unit: 'g' }],
    ['6x330ml', { amount: 1980, unit: 'ml' }],
    ['4 pints', { amount: 4, unit: 'pint_uk' }],
    ['12', { amount: 12, unit: 'count' }],
    ['400 g e', { amount: 400, unit: 'g' }],
  ])('parses %s', (text, expected) => {
    expect(parsePackQuantity(text)).toEqual(expected);
  });

  it('gives up on nonsense', () => {
    expect(parsePackQuantity('')).toBeNull();
    expect(parsePackQuantity('family size')).toBeNull();
    expect(parsePackQuantity(null)).toBeNull();
  });
});

describe('parsePackSizes', () => {
  it('reads every row of pack-sizes.csv', () => {
    const rows = parseCsv(seed('pack-sizes.csv'));
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      const sizes = parsePackSizes(row.pack_sizes ?? '', row.unit ?? 'g');
      expect(sizes.length, row.ingredient).toBeGreaterThan(0);
      for (const s of sizes) expect(s.amount, row.ingredient).toBeGreaterThan(0);
    }
  });

  it('mixes weights and counts', () => {
    expect(parsePackSizes('1000;3 count', 'g')).toEqual([
      { amount: 1000, unit: 'g' },
      { amount: 3, unit: 'count' },
    ]);
  });
});

describe('formatPackSize', () => {
  it('shows the pack as printed', () => {
    expect(formatPackSize(2.27, 'l')).toBe('2.27L');
    expect(formatPackSize(500, 'g')).toBe('500g');
    expect(formatPackSize(4, 'pint_uk')).toBe('4 pints');
    expect(formatPackSize(null, 'g')).toBe('');
  });
});
