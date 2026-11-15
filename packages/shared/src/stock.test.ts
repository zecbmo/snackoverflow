import { describe, expect, it } from 'vitest';
import { productInput, scanInput, useAmountInput } from './schemas';
import { amountStepper, applyStillSome, applyUse, itemsText, mergePacks, oneItem, orderForUse, quickAmounts, shouldAskOpened, stepAmount, stepperGrams } from './stock';

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

  it("doesn't ask about food whose date doesn't change once opened (potatoes)", () => {
    const after = { fractionLeft: 0.5, initialGrams: 2500, remainingGrams: 1250 };
    expect(shouldAskOpened('closed', { kind: 'grams', grams: 1250 }, after, false)).toBe(false);
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

describe('amountStepper', () => {
  const pack = { initialGrams: 500, remainingGrams: 437, displayUnit: 'g' as const, densityGPerMl: null, gramsPerCount: null, isMeal: false };

  it('edits weights in grams with steps that suit the pack size', () => {
    expect(amountStepper(pack)).toMatchObject({ unit: 'g', suffix: 'g', gramsPerUnit: 1, steps: [10, 100], value: 437, packSize: 500 });
    expect(amountStepper({ ...pack, initialGrams: 150, remainingGrams: 150 }).steps).toEqual([10, 50]);
    expect(amountStepper({ ...pack, initialGrams: 30, remainingGrams: 30 }).steps).toEqual([1, 10]);
    expect(amountStepper({ ...pack, initialGrams: 2500, remainingGrams: 2500 }).steps).toEqual([100, 500]);
  });

  it('edits liquids in ml using the density', () => {
    const milk = amountStepper({ ...pack, displayUnit: 'ml', densityGPerMl: 1.03, initialGrams: 2338.1, remainingGrams: 1169.05 });
    expect(milk).toMatchObject({ unit: 'ml', suffix: 'ml', steps: [100, 500], value: 1135, packSize: 2270 });
    expect(stepperGrams(milk, 1000)).toBe(1030);
  });

  it('edits counted food one at a time and meals in half portions', () => {
    const eggs = amountStepper({ ...pack, displayUnit: 'count', gramsPerCount: 60, initialGrams: 360, remainingGrams: 240 });
    expect(eggs).toMatchObject({ unit: 'count', suffix: '', steps: [1], value: 4, packSize: 6 });
    const stew = amountStepper({ ...pack, isMeal: true, gramsPerCount: 400, initialGrams: 1200, remainingGrams: 600 });
    expect(stew).toMatchObject({ unit: 'portion', steps: [0.5, 1], value: 1.5, packSize: 3 });
    expect(stepperGrams(stew, 2)).toBe(800);
  });

  it('falls back to grams when a count has no weight, and copes with an unknown size', () => {
    expect(amountStepper({ ...pack, displayUnit: 'count' }).unit).toBe('g');
    expect(amountStepper({ ...pack, initialGrams: null, remainingGrams: null })).toMatchObject({ steps: [100, 500], value: null, packSize: null });
  });
});

describe('stepAmount', () => {
  it('adds or takes off a step', () => {
    expect(stepAmount(440, 10)).toBe(450);
    expect(stepAmount(400, -100)).toBe(300);
    expect(stepAmount(1.5, -0.5)).toBe(1);
    expect(stepAmount(0.1, 0.5)).toBe(0.5);
  });

  it('moves an amount between steps to the next step in that direction', () => {
    expect(stepAmount(437, 10)).toBe(440);
    expect(stepAmount(437, -10)).toBe(430);
    expect(stepAmount(437, 100)).toBe(500);
    expect(stepAmount(437, -100)).toBe(400);
  });

  it('never goes below nothing', () => {
    expect(stepAmount(5, -10)).toBe(0);
    expect(stepAmount(0, -1)).toBe(0);
  });
});

describe('mergePacks', () => {
  const pack = {
    fractionLeft: 1,
    initialGrams: 900,
    remainingGrams: 900,
    state: 'closed' as const,
    bestBefore: '2026-12-01',
    openedOn: null,
    frozenOn: null,
    defrostedOn: null,
  };

  it('adds the amounts and keeps the earliest best-before', () => {
    const merged = mergePacks([pack, { ...pack, fractionLeft: 1 / 3, remainingGrams: 300, bestBefore: '2026-11-20' }]);
    expect(merged).toMatchObject({ initialGrams: 1800, remainingGrams: 1200, fractionLeft: 0.667, state: 'closed', bestBefore: '2026-11-20' });
  });

  it('takes the shortest-lived state: opened, and defrosted over that', () => {
    const opened = { ...pack, state: 'opened' as const, openedOn: '2026-11-10', bestBefore: '2026-11-13' };
    expect(mergePacks([pack, opened])).toMatchObject({ state: 'opened', openedOn: '2026-11-10', bestBefore: '2026-11-13' });
    const defrosted = { ...pack, state: 'defrosted' as const, frozenOn: '2026-10-01', defrostedOn: '2026-11-12', bestBefore: '2026-11-13' };
    expect(mergePacks([opened, defrosted])).toMatchObject({ state: 'defrosted', defrostedOn: '2026-11-12', frozenOn: '2026-10-01' });
  });

  it('merges frozen packs but never frozen with unfrozen', () => {
    const frozen = { ...pack, state: 'frozen' as const, frozenOn: '2026-11-01', bestBefore: '2027-02-01' };
    expect(mergePacks([frozen, { ...frozen, frozenOn: '2026-10-01' }])).toMatchObject({ state: 'frozen', frozenOn: '2026-10-01' });
    expect(() => mergePacks([frozen, pack])).toThrow("Frozen and unfrozen packs can't be merged.");
  });

  it('adds fractions when a size is unknown, up to one whole pack', () => {
    const unknown = { ...pack, initialGrams: null, remainingGrams: null, fractionLeft: 0.5 };
    expect(mergePacks([unknown, { ...unknown, fractionLeft: 0.25 }])).toMatchObject({ initialGrams: null, remainingGrams: null, fractionLeft: 0.75 });
    expect(mergePacks([unknown, pack]).fractionLeft).toBe(1);
  });

  it('needs two packs', () => {
    expect(() => mergePacks([pack])).toThrow();
  });
});

describe('counted food', () => {
  const apples = { displayUnit: 'count' as const, gramsPerCount: 150, countUnit: 'apple', isMeal: false, remainingGrams: 900 };
  const chicken = { displayUnit: 'g' as const, gramsPerCount: 100, countUnit: 'thigh', isMeal: false, remainingGrams: 1000 };

  it('uses counted food an item at a time, across the row when given its total', () => {
    expect(oneItem(apples)).toEqual({ grams: 150, name: 'apple', left: 6 });
    expect(oneItem(apples, 1800)?.left).toBe(12);
    expect(oneItem({ ...apples, countUnit: null })?.name).toBe('item');
    expect(oneItem({ ...apples, displayUnit: 'g', isMeal: true, gramsPerCount: 400, remainingGrams: 1200 })).toEqual({ grams: 400, name: 'portion', left: 3 });
    // A bar from a multipack of four.
    expect(oneItem({ ...chicken, itemGrams: 45, remainingGrams: 180 })).toEqual({ grams: 45, name: 'item', left: 4 });
  });

  it('never counts food measured by weight, and leaves the last one to "Used it all"', () => {
    expect(oneItem(chicken)).toBeNull();
    expect(oneItem({ ...apples, remainingGrams: 150 })).toBeNull();
    expect(oneItem({ ...apples, gramsPerCount: null })).toBeNull();
    expect(oneItem({ ...apples, remainingGrams: null })).toBeNull();
  });

  it('says how many items are left', () => {
    expect(itemsText(apples, 900)).toBe('6 apples');
    expect(itemsText(apples, 160)).toBe('1 apple');
    expect(itemsText({ ...apples, isMeal: true, gramsPerCount: 400 }, 1000)).toBe('2.5 portions');
    expect(itemsText(chicken, 1000)).toBeNull();
  });
});

describe('quickAmounts', () => {
  const chicken = { displayUnit: 'g' as const, gramsPerCount: 100, isMeal: false, remainingGrams: 1000 };

  it('offers 100g, 250g and 500g, up to what there is', () => {
    expect(quickAmounts(chicken, 1300, 250).map((x) => x.label)).toEqual(['100g', '250g', '500g']);
    expect(quickAmounts(chicken, 300, 250).map((x) => x.label)).toEqual(['100g', '250g']);
  });

  it('weighs a cup when the food has a density, and measures liquids in ml', () => {
    expect(quickAmounts({ ...chicken, densityGPerMl: 0.85 }, null, 250).at(-1)).toEqual({ label: '1 cup (213g)', grams: 212.5 });
    expect(quickAmounts({ ...chicken, displayUnit: 'ml', densityGPerMl: 1.03 }, 2338, 250)).toEqual([
      { label: '100ml', grams: 103 },
      { label: '250ml (a cup)', grams: 257.5 },
      { label: '500ml', grams: 515 },
    ]);
  });

  it('has none for counted food', () => {
    expect(quickAmounts({ ...chicken, displayUnit: 'count', countUnit: 'apple', gramsPerCount: 150 }, 900, 250)).toEqual([]);
  });
});

