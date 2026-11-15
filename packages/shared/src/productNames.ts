/**
 * Names for products that arrive from a barcode database. Open Food Facts names are whatever
 * someone typed: some are all capitals, and some only make sense beside their brand (a tube of
 * Pringles is just "Original").
 */

/** Words that stay lower case inside a title ("Salt and Vinegar"). */
const SMALL_WORDS = new Set(['and', 'of', 'with', 'in', 'the', 'a', 'an', 'for', 'to', 'on', 'no', 'or', 'by', 'x']);

function titleWord(word: string, first: boolean): string {
  // Sizes and counts stay as they are, in lower case ("500ML" -> "500ml").
  if (/\d/.test(word)) return word.toLowerCase();
  const lower = word.toLowerCase();
  if (!first && SMALL_WORDS.has(lower)) return lower;
  // Capitalise after the start and after a hyphen or apostrophe-free join ("SEMI-SKIMMED" -> "Semi-Skimmed").
  return lower.replace(/(^|[-/(])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

/**
 * A name typed all in capitals ("WALKERS READY SALTED 6 PACK") becomes title case. A name with
 * any lower case in it is left exactly as it is: someone chose that ("iced coffee", "McVitie's").
 */
export function tidyCapitals(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!/\p{Lu}{2}/u.test(trimmed) || /\p{Ll}/u.test(trimmed)) return trimmed;
  return trimmed
    .split(' ')
    .map((w, i) => titleWord(w, i === 0))
    .join(' ');
}

const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '');

/** How long a brand can be and still go in front of a name: "Pringles", "Ben & Jerry's", not a company's full legal name. */
const MAX_BRAND_CHARS = 20;
const MAX_BRAND_WORDS = 3;
/**
 * Words that describe a variety rather than name a thing: flavours, sizes and the like. A name
 * made only of these ("Original", "Salt & Vinegar", "Zero Sugar") doesn't say what the product
 * is, so it needs its brand. A name with any other word in it ("Snickers", "Dairy Milk") is
 * taken to be the product's own name and is left alone.
 */
const DESCRIPTORS = new Set(
  (
    'original classic ready salted salt sea vinegar cheese cheesy onion sour cream chive chives chicken beef prawn cocktail bbq barbecue ' +
    'sweet chilli chili hot spicy mild medium smoky smoked bacon paprika plain natural light lite zero sugar free diet max regular ' +
    'large small mini big extra strong mature vanilla chocolate milk dark white strawberry raspberry lemon lime orange apple mango ' +
    'peach cherry berry berries mint caramel honey nut nutty hazelnut almond peanut butter coconut coffee tomato garlic herb herbs ' +
    'pepper black red green mushroom curry thai mexican texas cheddar unsweetened sweetened crunchy smooth thick thin sliced ' +
    'wholemeal wholegrain mixed fruit fruity tropical summer golden roast roasted flame grilled lightly no added the and with of ' +
    'flavour flavor flavoured taste style recipe multipack pack packs share sharing bag size grab'
  ).split(' '),
);

function onlyDescribes(name: string): boolean {
  const words = name.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.length > 0 && words.every((w) => DESCRIPTORS.has(w));
}

/**
 * The name a product gets when it's first scanned: capitals tidied, and the brand put in front
 * when the name alone doesn't say what it is (Pringles "Original" becomes "Pringles Original").
 * That's only when the name is nothing but a variety. A food that matches one of the household's
 * generic foods (`generic`: milk, chicken thighs) is already called what it is, so "Tesco" isn't
 * added to every staple, and long brands (a company's full name) are never added.
 */
export function scannedProductName(name: string, brand: string | null | undefined, opts: { generic: boolean }): string {
  const tidy = tidyCapitals(name);
  const b = brand ? tidyCapitals(brand) : '';
  if (!b || opts.generic) return tidy;
  if (b.length > MAX_BRAND_CHARS || b.split(' ').length > MAX_BRAND_WORDS) return tidy;
  // Already says the brand ("Pringles Original", "Coca-Cola Zero").
  if (plain(tidy).includes(plain(b))) return tidy;
  return onlyDescribes(tidy) ? `${b} ${tidy}` : tidy;
}

/**
 * The size of one serving in grams (or ml), from what a barcode database holds: a number when
 * it has one, else the first weight in the label's wording ("30 g", "1 biscuit (12.5 g)",
 * "250ml"). Null when there's nothing usable: no weight ("1 portion"), or a silly one.
 */
export function parseServingGrams(size: string | null | undefined, quantity?: number | string | null): number | null {
  const ok = (n: number) => (Number.isFinite(n) && n >= 1 && n <= 2000 ? Math.round(n * 10) / 10 : null);
  const given = typeof quantity === 'string' ? Number(quantity.replace(',', '.')) : quantity;
  if (given != null && ok(given) !== null) return ok(given);
  const m = size?.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  const unit = m[2]!.toLowerCase();
  return ok(unit === 'kg' || unit === 'l' ? n * 1000 : unit === 'cl' ? n * 10 : n);
}
