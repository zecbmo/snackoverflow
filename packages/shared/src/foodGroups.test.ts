import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { FOOD_GROUPS, isFoodGroup } from './foodGroups';

describe('food groups', () => {
  it('gives every seeded ingredient one of the known groups', () => {
    const csv = readFileSync(fileURLToPath(new URL('../../../docs/data/ingredients.csv', import.meta.url)), 'utf8');
    const rows = parseCsv(csv);
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) expect([r.key, isFoodGroup(r.food_group)]).toEqual([r.key, true]);
  });

  it('has the seventeen groups, each once', () => {
    expect(FOOD_GROUPS).toHaveLength(17);
    expect(new Set(FOOD_GROUPS).size).toBe(17);
  });
});
