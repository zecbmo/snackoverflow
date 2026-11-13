import { describe, expect, it } from 'vitest';
import { formatAmount, isoDurationMinutes, parseIngredientLine, recipeMeals, recipeNutrition, scaleAmount, scaledLine, tidyLine } from './recipes';

describe('parseIngredientLine', () => {
  it.each([
    ['400g chopped tomatoes', { amount: 400, unit: 'g', name: 'chopped tomatoes', note: null }],
    ['2 large Maris Pipers, peeled', { amount: 2, unit: 'count', name: 'Maris Pipers', note: 'peeled' }],
    ['1 tbsp olive oil', { amount: 1, unit: 'tbsp', name: 'olive oil' }],
    ['½ tsp salt', { amount: 0.5, unit: 'tsp', name: 'salt' }],
    ['1½ tsp ground cumin', { amount: 1.5, unit: 'tsp', name: 'ground cumin' }],
    ['1 1/2 cups plain flour', { amount: 1.5, unit: 'cup_metric', name: 'plain flour' }],
    ['3/4 cup milk', { amount: 0.75, unit: 'cup_metric', name: 'milk' }],
    ['2-3 cloves garlic, crushed', { amount: 2, unit: 'count', countWord: 'clove', name: 'garlic', note: 'crushed' }],
    ['2 garlic cloves', { amount: 2, unit: 'count', name: 'garlic cloves' }],
    ['1 x 400g tin chopped tomatoes', { amount: 400, unit: 'g', name: 'chopped tomatoes' }],
    ['2 x 400g cans chickpeas, drained', { amount: 800, unit: 'g', name: 'chickpeas', note: 'drained' }],
    ['1 tin (400g) coconut milk', { amount: 1, unit: 'count', countWord: 'tin', name: 'coconut milk', note: '400g' }],
    ['500ml chicken stock', { amount: 500, unit: 'ml', name: 'chicken stock' }],
    ['1.5kg potatoes', { amount: 1.5, unit: 'kg', name: 'potatoes' }],
    ['250 g mushrooms, sliced', { amount: 250, unit: 'g', name: 'mushrooms', note: 'sliced' }],
    ['1 heaped tbsp tomato purée', { amount: 1, unit: 'tbsp', name: 'tomato purée' }],
    ['4 rashers smoked bacon', { amount: 4, unit: 'count', countWord: 'rasher', name: 'smoked bacon' }],
    ['3 eggs', { amount: 3, unit: 'count', name: 'eggs' }],
    ['a pinch of salt', { amount: null, unit: null, name: 'a pinch of salt' }],
    ['Salt and pepper', { amount: null, unit: null, name: 'Salt and pepper' }],
    ['small bunch of coriander (optional)', { amount: null, name: 'bunch of coriander', optional: true }],
    ['2 tbsp parsley, chopped, optional', { amount: 2, unit: 'tbsp', name: 'parsley', optional: true }],
  ])('reads %s', (line, expected) => {
    expect(parseIngredientLine(line)).toMatchObject(expected);
  });
});

describe('scaling and formatting', () => {
  it('scales by servings', () => {
    expect(scaleAmount(400, 4, 2)).toBe(200);
    expect(scaleAmount(null, 4, 2)).toBeNull();
  });

  it('formats friendly amounts', () => {
    expect(formatAmount(0.5)).toBe('½');
    expect(formatAmount(1.25)).toBe('1¼');
    expect(formatAmount(2.333)).toBe('2⅓');
    expect(formatAmount(3)).toBe('3');
    expect(formatAmount(0.99)).toBe('1');
    expect(formatAmount(1.1)).toBe('1.1');
    expect(formatAmount(137.4)).toBe('137');
  });

  it('reads recipe-site durations', () => {
    expect(isoDurationMinutes('PT1H15M')).toBe(75);
    expect(isoDurationMinutes('PT45M')).toBe(45);
    expect(isoDurationMinutes('P0DT0H20M')).toBe(20);
    expect(isoDurationMinutes('20 minutes')).toBeNull();
  });
});

describe('recipeNutrition', () => {
  it('adds up lines per serving and reports coverage', () => {
    const r = recipeNutrition(
      [
        { grams: 500, per100g: { kcal: 77, protein: 2, carbs: 17, fat: 0.1 } },
        { grams: 200, per100g: { kcal: 120, protein: 22.5, fat: 2.6 } },
        { grams: 5, per100g: null },
        { grams: null, per100g: { kcal: 884 } },
      ],
      2,
    );
    expect(r.perServing.kcal).toBe(312.5);
    expect(r.perServing.protein).toBe(27.5);
    expect(r.coverage).toBe(0.5);
  });
});

describe('scaledLine', () => {
  it('scales the leading amount and keeps the wording', () => {
    expect(scaledLine('400g chopped tomatoes', 400, 4, 2)).toBe('200g chopped tomatoes');
    expect(scaledLine('2 onions, chopped', 2, 4, 6)).toBe('3 onions, chopped');
    expect(scaledLine('1½ tsp cumin', 1.5, 2, 4)).toBe('3 tsp cumin');
    expect(scaledLine('1 x 400g tin chopped tomatoes', 400, 4, 2)).toBe('200g tin chopped tomatoes');
    expect(scaledLine('1 tbsp olive oil', 1, 4, 2)).toBe('½ tbsp olive oil');
    expect(scaledLine('450 grams Potatoes', 450, 2, 4)).toBe('900 grams Potatoes');
  });

  it('drops "unit(s)" import noise', () => {
    expect(scaledLine('1 unit(s) Apple', 1, 2, 4)).toBe('2 Apple');
    expect(scaledLine('2 unit(s) Garlic Clove', 2, 2, 2)).toBe('2 Garlic Clove');
    expect(tidyLine('1 sachet(s) Mixed Herbs')).toBe('1 sachet(s) Mixed Herbs');
  });

  it('leaves lines without amounts alone', () => {
    expect(scaledLine('Salt and pepper', null, 4, 2)).toBe('Salt and pepper');
    expect(scaledLine('400g tomatoes', 400, 4, 4)).toBe('400g tomatoes');
  });
});

describe('recipeMeals', () => {
  it('reads meals from tags, ignoring case', () => {
    expect(recipeMeals(['Breakfast', 'quick'])).toEqual(['breakfast']);
    expect(recipeMeals(['main course', 'german'])).toEqual(['dinner']);
    expect(recipeMeals(['lunch', 'dinner'])).toEqual(['lunch', 'dinner']);
    expect(recipeMeals(['quick'])).toEqual([]);
  });
});
