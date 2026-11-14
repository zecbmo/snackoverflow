import { describe, expect, it } from 'vitest';
import { isShareableBarcode, isValidGtin } from './barcode';

describe('isValidGtin', () => {
  it('accepts codes with the right check digit', () => {
    expect(isValidGtin('5000112548167')).toBe(true); // EAN-13
    expect(isValidGtin('96385074')).toBe(true); // EAN-8
    expect(isValidGtin('036000291452')).toBe(true); // UPC-A
    expect(isValidGtin('15000112548164')).toBe(true); // GTIN-14
  });

  it('rejects a wrong check digit, odd lengths and letters', () => {
    expect(isValidGtin('5000112548168')).toBe(false);
    expect(isValidGtin('500011254816')).toBe(false);
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('50001125481A7')).toBe(false);
    expect(isValidGtin('')).toBe(false);
  });
});

describe('isShareableBarcode', () => {
  it('shares ordinary product barcodes', () => {
    expect(isShareableBarcode('5000112548167')).toBe(true);
    expect(isShareableBarcode('036000291452')).toBe(true);
    expect(isShareableBarcode('96385074')).toBe(true);
  });

  it('keeps shop-only and weighed-item codes to itself', () => {
    // Real, valid codes: they're left out for their prefix alone.
    for (const code of ['2012345678903', '212345678992', '412345678996', '01234565', '21234569']) expect(isValidGtin(code)).toBe(true);
    expect(isShareableBarcode('2012345678903')).toBe(false); // EAN-13 starting 2
    expect(isShareableBarcode('212345678992')).toBe(false); // UPC-A starting 2
    expect(isShareableBarcode('412345678996')).toBe(false); // UPC-A starting 4
    expect(isShareableBarcode('01234565')).toBe(false); // EAN-8 starting 0
    expect(isShareableBarcode('21234569')).toBe(false); // EAN-8 starting 2
  });

  it('never shares something that is not a valid barcode', () => {
    expect(isShareableBarcode('5000112548168')).toBe(false);
    expect(isShareableBarcode('ABC-123')).toBe(false);
  });
});
