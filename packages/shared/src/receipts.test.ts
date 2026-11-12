import { describe, expect, it } from 'vitest';
import { expandReceiptText, looksLikeNonFood, parseReceiptLine, parseReceiptText, productNameFromReceipt, receiptKey } from './receipts';

describe('parseReceiptLine', () => {
  it.each([
    ['TES SEMI SKM MLK 4PT 1.55', { text: 'TES SEMI SKM MLK 4PT', quantity: 1, pricePence: 155 }],
    ['2 x Heinz Baked Beans 415g £2.80', { text: 'Heinz Baked Beans 415g', quantity: 2, pricePence: 280 }],
    ['Bananas Loose 5 @ £0.15  £0.75', { text: 'Bananas Loose', quantity: 1, pricePence: 75 }],
    ['Maris Piper Potatoes 2.5kg £1.29 A', { text: 'Maris Piper Potatoes 2.5kg', quantity: 1, pricePence: 129 }],
    ['Free Range Eggs x2 £5.70', { text: 'Free Range Eggs', quantity: 2, pricePence: 570 }],
  ])('reads %s', (line, expected) => {
    expect(parseReceiptLine(line)).toEqual(expected);
  });

  it('skips totals, payments and discounts', () => {
    for (const line of ['SUBTOTAL 23.40', 'TOTAL £23.40', 'VISA DEBIT 23.40', 'Clubcard savings -0.50', 'Change due 0.00', 'Thank you for shopping']) {
      expect(parseReceiptLine(line), line).toBeNull();
    }
    expect(parseReceiptLine('Mince beef 500g -1.00')).toBeNull();
  });

  it('ignores lines without a price', () => {
    expect(parseReceiptLine('Tesco Stores Ltd')).toBeNull();
  });
});

describe('parseReceiptText', () => {
  it('reads a till receipt', () => {
    const r = parseReceiptText(`TESCO
Extra Leeds
TES SEMI SKM MLK 4PT     1.55
CHKN BRST FILLETS 650G   4.25
2 x BKD BNS 415G         1.40
CARRIER BAG              0.10
SUBTOTAL                 7.30
VISA                     7.30
12/11/2026 18:04`);
    expect(r.store).toBe('Tesco');
    expect(r.date).toBe('2026-11-12');
    expect(r.lines.map((l) => l.text)).toEqual(['TES SEMI SKM MLK 4PT', 'CHKN BRST FILLETS 650G', 'BKD BNS 415G', 'CARRIER BAG']);
    expect(r.lines[2]).toMatchObject({ quantity: 2, pricePence: 140 });
  });

  it('reads an online order email', () => {
    const r = parseReceiptText(`Your Sainsbury's order has been delivered on 12 November 2026
Quantity Item Price
2 x Sainsbury's British Semi Skimmed Milk 2.27L (4 pint) £3.10
1 x Sainsbury's Basmati Rice 1kg £1.99
Delivery charge £0.00
Total £5.09`);
    expect(r.store).toBe("Sainsbury's");
    expect(r.date).toBe('2026-11-12');
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ quantity: 2, pricePence: 310 });
  });
});

describe('matching helpers', () => {
  it('expands receipt shorthand', () => {
    expect(expandReceiptText('TES SEMI SKM MLK 4PT')).toBe('semi skimmed milk 4pt');
    expect(expandReceiptText('CHKN BRST FILLETS 650G')).toBe('chicken breast fillets 650g');
    expect(productNameFromReceipt('BKD BNS 415G')).toBe('Baked beans 415g');
  });

  it('spots non-food', () => {
    expect(looksLikeNonFood('CARRIER BAG')).toBe(true);
    expect(looksLikeNonFood('Andrex Toilet Tissue 9 roll')).toBe(true);
    expect(looksLikeNonFood('Semi skimmed milk')).toBe(false);
  });

  it('remembers lines regardless of price and quantity', () => {
    expect(receiptKey('2 x TES SEMI SKM MLK 4PT £3.10')).toBe(receiptKey('TES SEMI SKM MLK 4PT'));
  });
});
