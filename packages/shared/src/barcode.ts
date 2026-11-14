/** Barcode checks shared by the server and the web app. */

/** True for a GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) whose check digit is right. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // Weights 3,1,3,1… from the right, not counting the check digit.
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * True when a barcode is the same on every pack everywhere, so it's worth adding to Open Food Facts.
 * Shop-only codes are left out: weighed and in-store items (EAN-13 starting 2, UPC-A starting 2 or 4,
 * EAN-8 starting 0 or 2) differ between shops and often carry the price or weight.
 */
export function isShareableBarcode(code: string): boolean {
  if (!isValidGtin(code)) return false;
  if (code.length === 13 && code.startsWith('2')) return false;
  if (code.length === 12 && (code.startsWith('2') || code.startsWith('4'))) return false;
  if (code.length === 8 && (code.startsWith('0') || code.startsWith('2'))) return false;
  return true;
}
