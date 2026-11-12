import { describe, expect, it } from 'vitest';
import { scaledLine } from './recipeText';

describe('scaledLine', () => {
  it('scales the leading amount and keeps the wording', () => {
    expect(scaledLine('400g chopped tomatoes', 400, 'g', 4, 2)).toBe('200g chopped tomatoes');
    expect(scaledLine('2 onions, chopped', 2, 'count', 4, 6)).toBe('3 onions, chopped');
    expect(scaledLine('1½ tsp cumin', 1.5, 'tsp', 2, 4)).toBe('3 tsp cumin');
    expect(scaledLine('1 x 400g tin chopped tomatoes', 400, 'g', 4, 2)).toBe('200g tin chopped tomatoes');
    expect(scaledLine('1 tbsp olive oil', 1, 'tbsp', 4, 2)).toBe('½ tbsp olive oil');
  });

  it('leaves lines without amounts alone', () => {
    expect(scaledLine('Salt and pepper', null, null, 4, 2)).toBe('Salt and pepper');
    expect(scaledLine('400g tomatoes', 400, 'g', 4, 4)).toBe('400g tomatoes');
  });
});
