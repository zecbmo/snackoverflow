import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bestBeforeOnDefrost,
  bestBeforeOnFreeze,
  bestBeforeOnOpen,
  canDefrost,
  canFreeze,
  canOpen,
  EMPTY_SHELF_LIFE,
  estimateOnAdd,
  learnedDaysFromEdit,
  mergeShelfLife,
  parseShelfLifeCsv,
  type ShelfLife,
} from './shelfLife';

const csv = readFileSync(fileURLToPath(new URL('../../../docs/data/shelf-life-defaults.csv', import.meta.url)), 'utf8');
const categories = Object.fromEntries(parseShelfLifeCsv(csv).map((c) => [c.key, c]));
const cat = (key: string): ShelfLife => {
  const c = categories[key];
  if (!c) throw new Error(`missing category ${key}`);
  return c;
};
const today = '2026-11-12';

describe('shelf-life seed data', () => {
  it('parses every category with sensible values', () => {
    const all = Object.values(categories);
    expect(all.length).toBeGreaterThan(30);
    for (const c of all) {
      expect(c.key).not.toBe('');
      expect(c.closedDays, c.key).not.toBeNull();
      expect(['cupboard', 'fridge', 'freezer']).toContain(c.defaultLocation);
      if (c.freezable === false) expect(c.frozenDays, c.key).toBeNull();
    }
  });

  it('reads blanks as not applicable', () => {
    expect(cat('eggs')).toMatchObject({ closedDays: 21, openedDays: null, frozenDays: null, freezable: false });
    expect(cat('pesto')).toMatchObject({ closedDays: 365, openedDays: 14, frozenDays: 90, defrostedDays: 2 });
  });
});

describe('mergeShelfLife', () => {
  it('takes each field from the first layer that has it', () => {
    const merged = mergeShelfLife({ closedDays: 4, openedDays: null }, cat('raw_poultry'));
    expect(merged).toEqual({ closedDays: 4, openedDays: 1, frozenDays: 90, defrostedDays: 1, freezable: true });
  });
});

describe('estimateOnAdd', () => {
  it('uses the shelf-life table for closed packs', () => {
    expect(estimateOnAdd({ today, locationType: 'fridge', shelfLife: cat('milk') })).toEqual({
      state: 'closed',
      bestBefore: '2026-11-20',
      source: 'shelf-life',
    });
  });

  it('prefers what was learned for the product', () => {
    expect(estimateOnAdd({ today, locationType: 'fridge', shelfLife: cat('milk'), learnedClosedDays: 4 }).bestBefore).toBe(
      '2026-11-16',
    );
  });

  it('puts packs added to the freezer in frozen', () => {
    expect(estimateOnAdd({ today, locationType: 'freezer', shelfLife: cat('raw_poultry') })).toEqual({
      state: 'frozen',
      bestBefore: '2027-02-10',
      source: 'shelf-life',
    });
  });

  it('falls back to the safety defaults for unknown food', () => {
    expect(estimateOnAdd({ today, locationType: 'fridge', shelfLife: EMPTY_SHELF_LIFE })).toEqual({
      state: 'closed',
      bestBefore: '2026-11-14',
      source: 'safety-default',
    });
    expect(estimateOnAdd({ today, locationType: 'freezer', shelfLife: EMPTY_SHELF_LIFE }).bestBefore).toBe('2027-02-10');
    expect(estimateOnAdd({ today, locationType: 'cupboard', shelfLife: EMPTY_SHELF_LIFE })).toEqual({
      state: 'closed',
      bestBefore: null,
      source: 'none',
    });
  });
});

describe('opening', () => {
  it('never extends a date', () => {
    // Pesto lasts 14 days once opened, but this jar's date is in 5 days.
    expect(bestBeforeOnOpen({ today, current: '2026-11-17', shelfLife: cat('pesto') })).toBe('2026-11-17');
  });

  it('shortens a long date', () => {
    expect(bestBeforeOnOpen({ today, current: '2027-06-01', shelfLife: cat('pesto') })).toBe('2026-11-26');
  });

  it('gives unknown food the 2-day perishable rule', () => {
    expect(bestBeforeOnOpen({ today, current: null, shelfLife: EMPTY_SHELF_LIFE })).toBe('2026-11-14');
  });

  it('is hidden for food that does not change once opened', () => {
    expect(canOpen('closed', cat('eggs')).ok).toBe(false);
    expect(canOpen('closed', cat('milk')).ok).toBe(true);
    expect(canOpen('opened', cat('milk')).ok).toBe(false);
    expect(canOpen('frozen', cat('milk')).ok).toBe(false);
  });
});

describe('freezing', () => {
  it('sets the frozen date', () => {
    expect(bestBeforeOnFreeze({ today, shelfLife: cat('bread') })).toBe('2027-02-10');
  });

  it('allows freezing up to and including the date', () => {
    expect(canFreeze({ today, state: 'closed', bestBefore: today, shelfLife: cat('raw_poultry') }).ok).toBe(true);
  });

  it('refuses once the date has passed', () => {
    const r = canFreeze({ today, state: 'closed', bestBefore: '2026-11-11', shelfLife: cat('raw_poultry') });
    expect(r).toEqual({ ok: false, reason: 'Too late to freeze: it is past its date.' });
  });

  it('never refreezes defrosted food', () => {
    expect(canFreeze({ today, state: 'defrosted', bestBefore: '2026-11-13', shelfLife: cat('raw_poultry') }).ok).toBe(false);
  });

  it('refuses food that does not freeze', () => {
    expect(canFreeze({ today, state: 'closed', bestBefore: '2026-11-20', shelfLife: cat('eggs') }).ok).toBe(false);
  });

  it('lets unknown food be frozen', () => {
    expect(canFreeze({ today, state: 'opened', bestBefore: null, shelfLife: EMPTY_SHELF_LIFE }).ok).toBe(true);
  });
});

describe('defrosting', () => {
  it('gives a short date from the table', () => {
    expect(bestBeforeOnDefrost({ today, shelfLife: cat('raw_poultry') })).toBe('2026-11-13');
    expect(bestBeforeOnDefrost({ today, shelfLife: cat('pesto') })).toBe('2026-11-14');
  });

  it('defaults to 24 hours', () => {
    expect(bestBeforeOnDefrost({ today, shelfLife: EMPTY_SHELF_LIFE })).toBe('2026-11-13');
  });

  it('only applies to frozen packs', () => {
    expect(canDefrost('frozen').ok).toBe(true);
    expect(canDefrost('closed').ok).toBe(false);
  });
});

describe('learning from edits', () => {
  it('learns closed days from a closed pack', () => {
    expect(learnedDaysFromEdit({ state: 'closed', addedOn: '2026-11-10', frozenOn: null, newBestBefore: '2026-11-14' })).toEqual({
      kind: 'closed',
      days: 4,
    });
  });

  it('learns frozen days only for packs that went straight into the freezer', () => {
    expect(
      learnedDaysFromEdit({ state: 'frozen', addedOn: '2026-11-10', frozenOn: '2026-11-10', newBestBefore: '2027-01-10' }),
    ).toEqual({ kind: 'frozen', days: 61 });
    expect(
      learnedDaysFromEdit({ state: 'frozen', addedOn: '2026-11-01', frozenOn: '2026-11-10', newBestBefore: '2027-01-10' }),
    ).toBeNull();
  });

  it('does not learn from opened or defrosted packs', () => {
    expect(learnedDaysFromEdit({ state: 'opened', addedOn: '2026-11-10', frozenOn: null, newBestBefore: '2026-11-14' })).toBeNull();
    expect(learnedDaysFromEdit({ state: 'defrosted', addedOn: '2026-11-10', frozenOn: null, newBestBefore: '2026-11-14' })).toBeNull();
  });
});
