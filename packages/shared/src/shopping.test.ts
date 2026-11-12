import { describe, expect, it } from 'vitest';
import { choosePacks, estimateRunOut, portionShare, slotForTime } from './shopping';

describe('choosePacks', () => {
  it('rounds up to the pack that wastes least', () => {
    // Fish pie needs 100g of potatoes and there are none: buy the smallest bag.
    expect(choosePacks(100, [1000, 2000, 2500])).toEqual({ packGrams: 1000, packs: 1, surplusGrams: 900 });
    expect(choosePacks(1900, [1000, 2000, 2500])).toEqual({ packGrams: 2000, packs: 1, surplusGrams: 100 });
    expect(choosePacks(2100, [1000, 2000, 2500])).toEqual({ packGrams: 2500, packs: 1, surplusGrams: 400 });
  });

  it('buys several packs when needed', () => {
    expect(choosePacks(1000, [400])).toEqual({ packGrams: 400, packs: 3, surplusGrams: 200 });
  });

  it('prefers fewer packs on a tie', () => {
    expect(choosePacks(1000, [500, 1000])).toEqual({ packGrams: 1000, packs: 1, surplusGrams: 0 });
  });

  it('buys the shortfall when pack sizes are unknown', () => {
    expect(choosePacks(250.4, [])).toEqual({ packGrams: 251, packs: 1, surplusGrams: 0 });
  });

  it('buys nothing when nothing is short', () => {
    expect(choosePacks(0, [500])).toBeNull();
  });
});

describe('estimateRunOut', () => {
  const today = '2026-11-12';
  it('estimates from recent use', () => {
    const r = estimateRunOut({
      uses: [
        { grams: 100, day: '2026-10-29' },
        { grams: 100, day: '2026-11-05' },
        { grams: 80, day: '2026-11-10' },
      ],
      onHandGrams: 60,
      today,
    });
    expect(r).toEqual({ gramsPerDay: 20, daysLeft: 3, runsOutOn: '2026-11-15' });
  });

  it('needs at least two uses', () => {
    expect(estimateRunOut({ uses: [{ grams: 100, day: '2026-11-05' }], onHandGrams: 0, today })).toBeNull();
  });

  it('ignores old uses', () => {
    expect(
      estimateRunOut({
        uses: [
          { grams: 100, day: '2026-01-01' },
          { grams: 100, day: '2026-02-01' },
        ],
        onHandGrams: 0,
        today,
      }),
    ).toBeNull();
  });
});

describe('meal slots and shares', () => {
  it('picks a slot by time of day', () => {
    expect(slotForTime(7)).toBe('breakfast');
    expect(slotForTime(13)).toBe('lunch');
    expect(slotForTime(16)).toBe('snack');
    expect(slotForTime(19)).toBe('dinner');
    expect(slotForTime(23)).toBe('snack');
  });

  it('splits household meals evenly and respects named portions', () => {
    expect(portionShare(4, [], 'a', 2)).toBe(2);
    expect(portionShare(2, [{ userId: 'a', portions: 1.5 }, { userId: 'b', portions: 0.5 }], 'a', 3)).toBe(1.5);
    expect(portionShare(2, [{ userId: 'b', portions: 2 }], 'a', 3)).toBe(0);
  });
});
