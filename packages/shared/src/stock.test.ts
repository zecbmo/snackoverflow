import { describe, expect, it } from 'vitest';
import { productInput, scanInput, useAmountInput } from './schemas';
import { applyStillSome, applyUse, orderForUse, shouldAskOpened } from './stock';

const fullPack = { fractionLeft: 1, initialGrams: 400, remainingGrams: 400 };

describe('applyUse', () => {
  it('uses it all', () => {
    const r = applyUse(fullPack, { kind: 'all' });
    expect(r.after).toEqual({ fractionLeft: 0, initialGrams: 400, remainingGrams: 0 });
    expect(r.usedGrams).toBe(400);
    expect(r.askStillSome).toBe(false);
  });

  it('treats "some" as a share of what is left', () => {
    const half = applyUse(fullPack, { kind: 'fraction', fraction: 0.5 });
    expect(half.after.remainingGrams).toBe(200);
    const quarterOfHalf = applyUse(half.after, { kind: 'fraction', fraction: 0.5 });
    expect(quarterOfHalf.after).toEqual({ fractionLeft: 0.25, initialGrams: 400, remainingGrams: 100 });
    expect(quarterOfHalf.usedGrams).toBe(100);
  });

  it('uses exact grams', () => {
    const r = applyUse(fullPack, { kind: 'grams', grams: 150 });
    expect(r.after.remainingGrams).toBe(250);
    expect(r.after.fractionLeft).toBe(0.625);
  });

  it('asks "still some left?" when the numbers run out', () => {
    expect(applyUse(fullPack, { kind: 'grams', grams: 380 }).askStillSome).toBe(true);
    const over = applyUse(fullPack, { kind: 'grams', grams: 900 });
    expect(over.after.fractionLeft).toBe(0);
    expect(over.usedGrams).toBe(400);
    expect(over.askStillSome).toBe(true);
  });

  it('works on packs of unknown size by fraction', () => {
    const r = applyUse({ fractionLeft: 1, initialGrams: null, remainingGrams: null }, { kind: 'fraction', fraction: 0.75 });
    expect(r.after).toEqual({ fractionLeft: 0.25, initialGrams: null, remainingGrams: null });
    expect(r.usedGrams).toBeNull();
    expect(r.usedFraction).toBe(0.75);
  });

  it('refuses exact grams on packs of unknown size', () => {
    expect(() => applyUse({ fractionLeft: 1, initialGrams: null, remainingGrams: null }, { kind: 'grams', grams: 5 })).toThrow();
  });
});

describe('applyStillSome', () => {
  const empty = { fractionLeft: 0, initialGrams: 400, remainingGrams: 0 };
  it('restores some when there is still some', () => {
    expect(applyStillSome(empty, 'yes').fractionLeft).toBe(0.25);
    expect(applyStillSome({ ...empty, fractionLeft: 0.5, remainingGrams: 200 }, 'yes').fractionLeft).toBe(0.5);
  });
  it('marks nearly gone', () => {
    expect(applyStillSome(empty, 'nearly-gone')).toEqual({ fractionLeft: 0.1, initialGrams: 400, remainingGrams: 40 });
  });
  it('finishes it', () => {
    expect(applyStillSome(fullPack, 'none').fractionLeft).toBe(0);
  });
});

describe('shouldAskOpened', () => {
  it('asks only for closed packs used in part', () => {
    const after = { fractionLeft: 0.5, initialGrams: 400, remainingGrams: 200 };
    expect(shouldAskOpened('closed', { kind: 'fraction', fraction: 0.5 }, after)).toBe(true);
    expect(shouldAskOpened('opened', { kind: 'fraction', fraction: 0.5 }, after)).toBe(false);
    expect(shouldAskOpened('closed', { kind: 'all' }, { ...after, fractionLeft: 0 })).toBe(false);
  });
});

describe('orderForUse', () => {
  it('takes the pack that expires first, undated last', () => {
    const packs = [
      { id: 'a', bestBefore: '2026-11-20', addedAt: '2026-11-01T10:00:00Z' },
      { id: 'b', bestBefore: null, addedAt: '2026-10-01T10:00:00Z' },
      { id: 'c', bestBefore: '2026-11-14', addedAt: '2026-11-05T10:00:00Z' },
      { id: 'd', bestBefore: '2026-11-14', addedAt: '2026-11-02T10:00:00Z' },
    ];
    expect(orderForUse(packs).map((p) => p.id)).toEqual(['d', 'c', 'a', 'b']);
  });
});

describe('schemas', () => {
  it('validates scan input', () => {
    expect(scanInput.safeParse({ barcode: '5000112637922' }).success).toBe(true);
    expect(scanInput.safeParse({ barcode: '<script>' }).success).toBe(false);
  });

  it('validates use amounts', () => {
    expect(useAmountInput.parse({ kind: 'fraction', fraction: 0.25 })).toEqual({ kind: 'fraction', fraction: 0.25 });
    expect(useAmountInput.safeParse({ kind: 'fraction', fraction: 0 }).success).toBe(false);
    expect(useAmountInput.safeParse({ kind: 'grams', grams: -1 }).success).toBe(false);
  });

  it('trims product names and rejects empty ones', () => {
    expect(productInput.parse({ name: '  Milk ' }).name).toBe('Milk');
    expect(productInput.safeParse({ name: '   ' }).success).toBe(false);
  });
});
