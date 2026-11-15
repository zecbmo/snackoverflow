import { describe, expect, it } from 'vitest';
import { matchesSearch, searchRank } from './search';

describe('matchesSearch', () => {
  it('needs every word, ignoring case and accents', () => {
    expect(matchesSearch('Crème fraîche', 'creme FRAICHE')).toBe(true);
    expect(matchesSearch('Greek yogurt', 'yogurt greek')).toBe(true);
    expect(matchesSearch('Greek yogurt', 'greek milk')).toBe(false);
    expect(matchesSearch('Anything', '  ')).toBe(true);
  });
});

describe('searchRank', () => {
  it('puts names that start with the query first', () => {
    expect(searchRank('Banana', 'ban')).toBe(0);
    expect(searchRank('Ripe banana', 'ban')).toBe(1);
    expect(searchRank('Urban salad', 'ban')).toBe(2);
    expect(searchRank('Chicken thighs, British', 'british chicken')).toBe(3);
    expect(searchRank('Apples', 'pear')).toBeNull();
  });
});
