import { describe, expect, it } from 'vitest';
import { parsePounds } from './money';

describe('parsePounds', () => {
  it('reads prices people type', () => {
    expect(parsePounds('1.55')).toBe(155);
    expect(parsePounds('£2')).toBe(200);
    expect(parsePounds('0,99')).toBe(99);
    expect(parsePounds('85p')).toBe(85);
    expect(parsePounds(' 3.1 ')).toBe(310);
  });

  it('rejects anything else', () => {
    expect(parsePounds('')).toBeNull();
    expect(parsePounds('abc')).toBeNull();
    expect(parsePounds('0')).toBeNull();
    expect(parsePounds('1.555')).toBeNull();
  });
});
