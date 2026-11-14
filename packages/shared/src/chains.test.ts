import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAIN_CATEGORIES, CHAIN_MENU_HEADER, chainItemKey, parseChainMenu } from './chains';
import { parseCsv } from './csv';

const dataDir = fileURLToPath(new URL('../../../docs/data/', import.meta.url));

describe('chain menu files', () => {
  it('gives every chain a known category and a unique key', () => {
    const rows = parseCsv(readFileSync(`${dataDir}chains.csv`, 'utf8'));
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) expect([r.key, (CHAIN_CATEGORIES as readonly string[]).includes(r.category ?? '')]).toEqual([r.key, true]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('reads every menu file cleanly, each for a listed chain', () => {
    const keys = new Set(parseCsv(readFileSync(`${dataDir}chains.csv`, 'utf8')).map((r) => r.key));
    const dir = `${dataDir}chain-menus/`;
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.csv')) : [];
    for (const f of files) {
      const text = readFileSync(dir + f, 'utf8');
      expect([f, text.split(/\r?\n/)[0]]).toEqual([f, CHAIN_MENU_HEADER.join(',')]);
      expect([f, keys.has(f.replace(/\.csv$/, ''))]).toEqual([f, true]);
      const { items, problems } = parseChainMenu(text);
      expect([f, problems]).toEqual([f, []]);
      expect([f, items.length > 0]).toEqual([f, true]);
      for (const i of items) expect([f, i.name, i.kcal <= 5000]).toEqual([f, i.name, true]);
    }
  });
});

describe('parseChainMenu', () => {
  const header = CHAIN_MENU_HEADER.join(',');

  it('reads nutrition per serving, leaving unpublished values empty', () => {
    const { items, problems } = parseChainMenu(`${header}\nBig Burger,Burgers,1 burger,215,508,25,9.5,43,8.6,3,26,2.2\n"Fries, salted (Medium)",Sides,Medium,,337,,,,,,,\n`);
    expect(problems).toEqual([]);
    expect(items).toEqual([
      { key: 'big-burger--1-burger', name: 'Big Burger', section: 'Burgers', serving: '1 burger', servingG: 215, kcal: 508, fat: 25, saturates: 9.5, carbs: 43, sugars: 8.6, fibre: 3, protein: 26, salt: 2.2 },
      { key: 'fries-salted-medium', name: 'Fries, salted (Medium)', section: 'Sides', serving: 'Medium', servingG: null, kcal: 337, fat: null, saturates: null, carbs: null, sugars: null, fibre: null, protein: null, salt: null },
    ]);
  });

  it('skips rows without a name or kcal, and repeats, and says why', () => {
    const { items, problems } = parseChainMenu(`${header}\n,Sides,,,100,,,,,,,\nMystery,Sides,,,,,,,,,,\nCola (Small),Drinks,Small,,90,,,,,,,\nCola (Small),Drinks,Small,,95,,,,,,,\nBad,Sides,,,lots,,,,,,,\n`);
    expect(items.map((i) => i.name)).toEqual(['Cola (Small)']);
    expect(problems).toEqual(['row 2: no item name', 'row 3: Mystery has no kcal', 'row 5: Cola (Small) (Small) is listed twice', 'row 6: kcal "lots" isn\'t a number', 'row 6: Bad has no kcal']);
  });
});

describe('chainItemKey', () => {
  it('joins the name and serving, without repeating a size already in the name', () => {
    expect(chainItemKey('Big Mac', '1 burger')).toBe('big-mac--1-burger');
    expect(chainItemKey('Latte (Medium)', 'Medium')).toBe('latte-medium');
    expect(chainItemKey('Café Crème & Jam', null)).toBe('cafe-creme-and-jam');
  });
});
