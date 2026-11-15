import { describe, expect, it } from 'vitest';
import { parseServingGrams, scannedProductName, tidyCapitals } from './productNames';

describe('tidyCapitals', () => {
  it('turns a name typed all in capitals into title case', () => {
    expect(tidyCapitals('WALKERS READY SALTED')).toBe('Walkers Ready Salted');
    expect(tidyCapitals('SALT AND VINEGAR CRISPS 6 X 25G')).toBe('Salt and Vinegar Crisps 6 x 25g');
    expect(tidyCapitals('SEMI-SKIMMED MILK')).toBe('Semi-Skimmed Milk');
    expect(tidyCapitals('  COLA   330ML ')).toBe('Cola 330ml');
  });

  it('leaves names with any lower case alone', () => {
    expect(tidyCapitals("McVitie's Digestives")).toBe("McVitie's Digestives");
    expect(tidyCapitals('iced coffee')).toBe('iced coffee');
    expect(tidyCapitals('BBQ sauce')).toBe('BBQ sauce');
  });
});

describe('scannedProductName', () => {
  const branded = { generic: false };

  it("puts the brand in front of a short name that doesn't say what it is", () => {
    expect(scannedProductName('Original', 'Pringles', branded)).toBe('Pringles Original');
    expect(scannedProductName('SALT & VINEGAR', 'WALKERS', branded)).toBe('Walkers Salt & Vinegar');
    expect(scannedProductName('Chicken & Mushroom', 'Pot Noodle', branded)).toBe('Pot Noodle Chicken & Mushroom');
  });

  it('leaves a name that already has the brand in it', () => {
    expect(scannedProductName('Pringles Original', 'Pringles', branded)).toBe('Pringles Original');
    expect(scannedProductName('Coca-Cola Zero', 'Coca Cola', branded)).toBe('Coca-Cola Zero');
    expect(scannedProductName('Snickers', 'Snickers', branded)).toBe('Snickers');
  });

  it("doesn't add the brand to everyday foods, long names or long company names", () => {
    expect(scannedProductName('Semi Skimmed Milk', 'Tesco', { generic: true })).toBe('Semi Skimmed Milk');
    expect(scannedProductName('Thick Cut Seville Orange Marmalade', 'Frank Cooper', branded)).toBe('Thick Cut Seville Orange Marmalade');
    expect(scannedProductName('Original', 'The Kellogg Company of Great Britain Ltd', branded)).toBe('Original');
    expect(scannedProductName('Original', null, branded)).toBe('Original');
  });

  it("leaves a name that is the product's own name", () => {
    expect(scannedProductName('Snickers', 'Mars', branded)).toBe('Snickers');
    expect(scannedProductName('Dairy Milk', 'Cadbury', branded)).toBe('Dairy Milk');
    expect(scannedProductName('Milk Chocolate', 'Cadbury', branded)).toBe('Cadbury Milk Chocolate');
  });
});

describe('parseServingGrams', () => {
  it('reads a serving size from the number or the wording on the label', () => {
    expect(parseServingGrams('30 g', 30)).toBe(30);
    expect(parseServingGrams('1 biscuit (12.5 g)')).toBe(12.5);
    expect(parseServingGrams('250ml')).toBe(250);
    expect(parseServingGrams('2 slices (80g)', '80')).toBe(80);
    expect(parseServingGrams('0,33 l')).toBe(330);
  });

  it('has nothing to say without a weight', () => {
    expect(parseServingGrams('1 portion')).toBeNull();
    expect(parseServingGrams(null, null)).toBeNull();
    expect(parseServingGrams('', 0)).toBeNull();
  });
});
