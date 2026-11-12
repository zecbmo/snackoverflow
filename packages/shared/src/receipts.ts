/**
 * Reading receipts: pasted till receipts and online-order emails into lines
 * (item, quantity, price), spotting non-food lines, and the keys used to
 * remember how a household's receipts word things.
 */

export interface ReceiptLineText {
  text: string;
  quantity: number;
  /** Line total in pence, when printed. */
  pricePence: number | null;
}

export interface ParsedReceipt {
  store: string | null;
  /** ISO date, when one is printed. */
  date: string | null;
  lines: ReceiptLineText[];
}

const STORES: [RegExp, string][] = [
  [/\btesco\b/i, 'Tesco'],
  [/\bsainsbury'?s?\b/i, "Sainsbury's"],
  [/\basda\b/i, 'Asda'],
  [/\bmorrisons\b/i, 'Morrisons'],
  [/\baldi\b/i, 'Aldi'],
  [/\blidl\b/i, 'Lidl'],
  [/\bwaitrose\b/i, 'Waitrose'],
  [/\bco-?op\b/i, 'Co-op'],
  [/\bocado\b/i, 'Ocado'],
  [/\bm\s?&\s?s\b|marks (and|&) spencer/i, 'M&S'],
  [/\biceland\b/i, 'Iceland'],
];

/** Lines on a receipt that are never items. */
const NOT_ITEMS =
  /\b(sub-?total|total|balance|change|cash|card|visa|mastercard|debit|credit|contactless|vat|savings?|you saved|clubcard|nectar|points|promotion|multibuy|discount|coupon|voucher|refund|delivery charge|bag charge|thank you|receipt|vat no|tel|www\.|store|till|op(erator)?\b|auth|aid:|pan seq)/i;

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function findDate(text: string): string | null {
  const dmy = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    const m = Number(dmy[2]);
    const d = Number(dmy[1]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const long = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i);
  if (long) return `${long[3]}-${MONTHS[long[2]!.toLowerCase()]}-${long[1]!.padStart(2, '0')}`;
  return null;
}

const PRICE = /(?:£\s?)?(-?\d{1,4}\.\d{2})\s*[A-Z*]?\s*$/;

/** Read one line: "2 x Heinz Baked Beans 415g £2.80", "TES SEMI SKM MLK 4PT 1.55", "Bananas Loose 5 @ £0.15  £0.75". */
export function parseReceiptLine(raw: string): ReceiptLineText | null {
  let line = raw.replace(/\s+/g, ' ').trim();
  if (line.length < 3 || NOT_ITEMS.test(line)) return null;
  let pricePence: number | null = null;
  const p = line.match(PRICE);
  if (p) {
    pricePence = Math.round(Number(p[1]) * 100);
    if (pricePence < 0) return null; // a discount line
    line = line.slice(0, p.index).trim();
  }
  let quantity = 1;
  const lead = line.match(/^(\d{1,2})\s*(?:x|×|\*)\s+/i);
  if (lead) {
    quantity = Number(lead[1]);
    line = line.slice(lead[0].length);
  } else {
    const trail = line.match(/\s+(?:x|×|qty:?)\s*(\d{1,2})$/i);
    if (trail) {
      quantity = Number(trail[1]);
      line = line.slice(0, trail.index);
    }
  }
  // "5 @ £0.15" unit-price notes.
  line = line.replace(/\s+\d+\s*@\s*£?\d+\.\d{2}.*$/, '').trim();
  // Only priced lines with words are items.
  if (pricePence === null || !/[a-z]{2}/i.test(line)) return null;
  return { text: line, quantity: Math.max(1, quantity), pricePence };
}

/** Read a pasted receipt or the text of an online-order email. Only lines with a price count as items. */
export function parseReceiptText(text: string): ParsedReceipt {
  const rows = text.split(/\r?\n/);
  const head = rows.slice(0, 12).join(' ');
  const store = STORES.find(([re]) => re.test(head))?.[1] ?? STORES.find(([re]) => re.test(text))?.[1] ?? null;
  const lines = rows.map(parseReceiptLine).filter((l): l is ReceiptLineText => l !== null);
  return { store, date: findDate(text), lines };
}

/** Things supermarkets sell that aren't food: skipped automatically. */
const NON_FOOD =
  /\b(bags?|carrier|bag for life|toilet|loo roll|kitchen roll|tissues?|nappies|wipes|washing|detergent|fabric|conditioner|softener|shampoo|shower gel|soap|toothpaste|toothbrush|deodorant|razor|bleach|cleaner|spray|sponges?|foil|cling film|bin bags?|batteries|light bulb|candles?|card|magazine|newspaper|flowers|plants?|cat food|dog food|cat litter|paracetamol|ibuprofen|plasters|vitamins?)\b/i;

export function looksLikeNonFood(text: string): boolean {
  return NON_FOOD.test(text);
}

/** Common receipt shorthand, expanded so it can be matched to products and ingredients. */
const ABBREVIATIONS: Record<string, string> = {
  skm: 'skimmed',
  ssk: 'semi skimmed',
  semi: 'semi',
  mlk: 'milk',
  chkn: 'chicken',
  chk: 'chicken',
  brst: 'breast',
  brsts: 'breasts',
  fil: 'fillets',
  fllt: 'fillet',
  thgh: 'thigh',
  thghs: 'thighs',
  bf: 'beef',
  mnce: 'mince',
  pot: 'potatoes',
  pots: 'potatoes',
  tom: 'tomatoes',
  toms: 'tomatoes',
  chpd: 'chopped',
  chop: 'chopped',
  onin: 'onions',
  oni: 'onions',
  grn: 'green',
  red: 'red',
  ppr: 'pepper',
  pepp: 'peppers',
  mush: 'mushrooms',
  mshrm: 'mushrooms',
  ched: 'cheddar',
  chs: 'cheese',
  mat: 'mature',
  yog: 'yogurt',
  yghrt: 'yogurt',
  grk: 'greek',
  btr: 'butter',
  brd: 'bread',
  wht: 'white',
  wmeal: 'wholemeal',
  frz: 'frozen',
  org: 'organic',
  ff: 'free from',
  fr: 'free range',
  eggs: 'eggs',
  bnna: 'bananas',
  ban: 'bananas',
  appl: 'apples',
  pst: 'pasta',
  rce: 'rice',
  bsmt: 'basmati',
  flr: 'flour',
  sug: 'sugar',
  ol: 'olive',
  oil: 'oil',
  bns: 'beans',
  bkd: 'baked',
  saus: 'sausages',
  bcn: 'bacon',
  smk: 'smoked',
  crm: 'cream',
  dbl: 'double',
  sgl: 'single',
  spin: 'spinach',
  crt: 'carrots',
  crrt: 'carrots',
  lttc: 'lettuce',
  cuc: 'cucumber',
  avo: 'avocado',
  lmn: 'lemons',
};

/** Store-brand prefixes that say nothing about the food. */
const BRAND_PREFIXES = /^(tes|tesco|sains|js|sainsbury'?s|asda|ext\.? special|morr|morrisons|m&s|co-?op|wr|waitrose|ess(ential)?|finest|ttd|taste the difference|value|everyday)\s+/i;

export function expandReceiptText(text: string): string {
  const words = text
    .toLowerCase()
    .replace(BRAND_PREFIXES, '')
    .replace(/[^a-z0-9.&'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w);
  return words.join(' ').trim();
}

/** How a receipt line is remembered: case, prices and quantities don't matter. */
export function receiptKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/£?\d+\.\d{2}/g, ' ')
    .replace(/^\d{1,2}\s*[x×*]\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A tidy product name from receipt text: "TES SEMI SKM MLK 4PT" -> "Semi skimmed milk 4pt". */
export function productNameFromReceipt(text: string): string {
  const e = expandReceiptText(text);
  return e ? e.charAt(0).toUpperCase() + e.slice(1) : text.trim();
}

/** "£1.55" */
export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}
