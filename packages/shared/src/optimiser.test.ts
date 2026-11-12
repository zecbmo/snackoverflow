import { describe, expect, it } from 'vitest';
import { type Lot, planWeek, rankRecipes, riskWeight, type ScoringRecipe, scoreRecipe, surplusLots, surplusSummary } from './optimiser';

const today = '2026-11-12'; // Thursday
const lot = (ingredientId: string, grams: number, bestBefore: string | null, extra: Partial<Lot> = {}): Lot => ({ ingredientId, grams, bestBefore, frozen: false, coming: false, ...extra });

const recipe = (id: string, lines: [string, number][], extra: Partial<ScoringRecipe> = {}): ScoringRecipe => ({
  id,
  title: id,
  serves: 2,
  tags: [],
  lines: lines.map(([ingredientId, grams]) => ({ ingredientId, name: ingredientId, grams, optional: false })),
  ...extra,
});

const rules = { recent: new Set<string>(), excludedTags: [], maxExtraIngredients: 3 };

describe('surplusLots', () => {
  it('takes planned meals from the earliest-expiring food first', () => {
    const lots = [lot('potato', 2500, '2026-12-01'), lot('potato', 500, '2026-11-15')];
    const left = surplusLots(lots, [{ ingredientId: 'potato', grams: 600, date: '2026-11-13' }]);
    expect(left).toEqual([expect.objectContaining({ grams: 2400, bestBefore: '2026-12-01' })]);
  });

  it("can't use food that goes off before the meal", () => {
    const left = surplusLots([lot('spinach', 200, '2026-11-13')], [{ ingredientId: 'spinach', grams: 200, date: '2026-11-16' }]);
    expect(left).toEqual([expect.objectContaining({ grams: 200 })]);
  });

  it('counts what the shopping list will bring in, after stock', () => {
    const left = surplusLots([lot('potato', 2500, null, { coming: true }), lot('potato', 100, '2026-11-14')], [{ ingredientId: 'potato', grams: 400, date: '2026-11-13' }]);
    expect(left).toEqual([expect.objectContaining({ grams: 2200, coming: true })]);
  });
});

describe('riskWeight', () => {
  it('is highest for food going off soonest', () => {
    expect(riskWeight(lot('x', 1, today), today)).toBe(1);
    expect(riskWeight(lot('x', 1, '2026-11-14'), today)).toBe(0.5);
    expect(riskWeight(lot('x', 1, '2026-11-26'), today)).toBeLessThan(0.15);
  });

  it('ignores frozen, expired and not-yet-bought food', () => {
    expect(riskWeight(lot('x', 1, today, { frozen: true }), today)).toBe(0);
    expect(riskWeight(lot('x', 1, '2026-11-11'), today)).toBe(0);
    expect(riskWeight(lot('x', 1, null, { coming: true }), today)).toBe(0);
  });
});

describe('scoreRecipe', () => {
  const surplus = [lot('chicken', 600, '2026-11-14'), lot('spinach', 200, '2026-11-13'), lot('rice', 1000, '2027-06-01')];

  it('knows what can be cooked now and gives a reason', () => {
    const s = scoreRecipe(recipe('curry', [['chicken', 500], ['spinach', 200], ['rice', 150]]), surplus, { on: today });
    expect(s).toMatchObject({ cookNow: true, missing: [], extraCostPence: 0 });
    expect(s.reason).toBe('Uses the chicken going off Saturday and the spinach going off tomorrow.');
    expect(s.score).toBeGreaterThan(3);
  });

  it('lists what is missing and costs it', () => {
    const s = scoreRecipe(recipe('flatbreads', [['spinach', 100], ['yogurt', 170]]), surplus, { on: today, priceOf: () => 85 });
    expect(s).toMatchObject({ cookNow: false, missing: [{ ingredientId: 'yogurt', grams: 170 }], extraCostPence: 85 });
    expect(s.reason).toBe('Uses the spinach going off tomorrow; needs yogurt.');
  });

  it('scales to the servings planned', () => {
    const s = scoreRecipe(recipe('curry', [['chicken', 500]]), surplus, { on: today, servings: 4 });
    expect(s.missing).toEqual([{ ingredientId: 'chicken', name: 'chicken', grams: 400 }]);
  });
});

describe('rankRecipes', () => {
  const surplus = [lot('spinach', 200, '2026-11-13'), lot('pasta', 500, '2027-06-01')];
  const recipes = [
    recipe('pasta', [['pasta', 200]]),
    recipe('spinach pasta', [['pasta', 200], ['spinach', 200]]),
    recipe('pudding', [['spinach', 200]], { tags: ['dessert'] }),
    recipe('feast', [['a', 1], ['b', 1], ['c', 1], ['d', 1]]),
  ];

  it('puts recipes that save food first, and respects the rules', () => {
    const ranked = rankRecipes(recipes, surplus, { on: today }, { ...rules, excludedTags: ['dessert'] });
    expect(ranked.map((r) => r.recipeId)).toEqual(['spinach pasta', 'pasta']);
  });

  it('skips recent recipes', () => {
    const ranked = rankRecipes(recipes, surplus, { on: today }, { ...rules, recent: new Set(['spinach pasta']), excludedTags: ['dessert'] });
    expect(ranked[0]!.recipeId).toBe('pasta');
  });
});

describe('planWeek', () => {
  it('spreads at-risk food across the week without reusing it', () => {
    const lots = [lot('chicken', 500, '2026-11-14'), lot('mince', 500, '2026-11-16'), lot('rice', 2000, '2027-06-01')];
    const recipes = [recipe('chicken rice', [['chicken', 500], ['rice', 150]]), recipe('chilli', [['mince', 500], ['rice', 150]]), recipe('plain rice', [['rice', 150]])];
    const picks = planWeek(
      recipes,
      lots,
      [],
      [
        { date: '2026-11-12', slot: 'dinner' },
        { date: '2026-11-13', slot: 'dinner' },
        { date: '2026-11-14', slot: 'dinner' },
      ],
      {},
      rules,
    );
    expect(picks.map((p) => p.choice.recipeId)).toEqual(['chicken rice', 'chilli', 'plain rice']);
    expect(picks[0]!.alternatives.length).toBeGreaterThan(0);
  });
});

describe('surplusSummary', () => {
  it('reports surplus that would go off unused', () => {
    const s = surplusSummary([lot('potato', 2100, '2026-11-20'), lot('rice', 1000, '2027-06-01'), lot('peas', 500, null, { frozen: true })], today);
    expect(s).toEqual([{ ingredientId: 'potato', grams: 2100, goesOffBy: '2026-11-20' }]);
  });
});
