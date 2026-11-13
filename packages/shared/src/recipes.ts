/**
 * Recipe maths: reading ingredient lines as written ("2 large Maris Pipers,
 * peeled"), scaling servings and working out nutrition per serving.
 */
import type { Nutrition } from './schemas';
import { normaliseUnit } from './units';

export interface ParsedLine {
  /** null when the line has no amount ("salt and pepper"). */
  amount: number | null;
  /** Normalised unit key (g, kg, ml, tbsp, count...) or null. */
  unit: string | null;
  /** The countable unit as written ("clove", "tin") when the unit is a count. */
  countWord: string | null;
  /** What it is ("Maris Pipers"), with sizes and preparation removed. */
  name: string;
  /** Preparation and extras ("peeled", "finely chopped"). */
  note: string | null;
  optional: boolean;
}

const FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅛': 0.125,
};

/** Words that measure in units we know (weights, volumes, spoons). */
const MEASURE_UNITS = new Set(['g', 'kg', 'oz', 'lb', 'ml', 'cl', 'l', 'tsp', 'tbsp', 'cup_metric', 'cup_us', 'fl_oz_uk', 'pint_uk', 'pinch']);

/** Words that count things ("2 cloves garlic", "1 tin tomatoes"). */
const COUNT_WORDS = new Set([
  'clove',
  'cloves',
  'tin',
  'tins',
  'can',
  'cans',
  'slice',
  'slices',
  'rasher',
  'rashers',
  'fillet',
  'fillets',
  'breast',
  'breasts',
  'thigh',
  'thighs',
  'sprig',
  'sprigs',
  'bunch',
  'bunches',
  'handful',
  'handfuls',
  'stick',
  'sticks',
  'head',
  'heads',
  'bulb',
  'bulbs',
  'pack',
  'packs',
  'packet',
  'packets',
  'jar',
  'jars',
  'piece',
  'pieces',
  'cube',
  'cubes',
  'sheet',
  'sheets',
  'knob',
  'stalk',
  'stalks',
  'leaf',
  'leaves',
  'egg',
  'eggs',
]);

const SIZE_WORDS = /\b(small|medium|large|big|extra[- ]large|heaped|level|rounded|generous|good|thick|thin|whole|fresh|ripe)\b/gi;

function singular(word: string): string {
  const w = word.toLowerCase();
  if (w === 'leaves') return 'leaf';
  if (w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** "1 1/2", "1½", "½", "1.5", "2-3" (takes the first), "2 x". */
function readAmount(s: string): { amount: number; rest: string } | null {
  let t = s.replace(/^about\s+|^approx\.?\s+|^roughly\s+/i, '');
  for (const [ch, v] of Object.entries(FRACTIONS)) t = t.replace(new RegExp(`(\\d)\\s*${ch}`), (_m, d: string) => String(Number(d) + v)).replace(ch, String(v));
  const m = t.match(/^(\d+(?:[.,]\d+)?)(?:\s+(\d+)\/(\d+)|\/(\d+))?(?:\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?)?\s*/);
  if (!m) return null;
  let amount = Number(m[1]!.replace(',', '.'));
  if (m[2] && m[3]) amount += Number(m[2]) / Number(m[3]);
  else if (m[4]) amount = amount / Number(m[4]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, rest: t.slice(m[0].length) };
}

/** Read one ingredient line from a recipe. */
export function parseIngredientLine(raw: string): ParsedLine {
  let text = raw.replace(/\s+/g, ' ').trim();
  let optional = false;
  if (/\(optional\)|,?\s*optional\s*$|^optional:?\s*/i.test(text)) {
    optional = true;
    text = text.replace(/\(optional\)|,?\s*optional\s*$|^optional:?\s*/gi, '').trim();
  }

  // Notes after a comma, or in brackets: "2 onions, finely chopped", "1 tin (400g) tomatoes".
  const notes: string[] = [];
  text = text.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    notes.push(inner.trim());
    return ' ';
  });
  const comma = text.indexOf(',');
  if (comma > 0) {
    notes.unshift(text.slice(comma + 1).trim());
    text = text.slice(0, comma);
  }
  text = text.replace(/\s+/g, ' ').trim();

  let amount: number | null = null;
  let unit: string | null = null;
  let countWord: string | null = null;
  const a = readAmount(text);
  if (a) {
    amount = a.amount;
    text = a.rest;
    // "2 x 400g tins" -> 800g
    const multi = text.match(/^[x×]\s*/i);
    if (multi) {
      const b = readAmount(text.slice(multi[0].length));
      if (b) {
        amount *= b.amount;
        text = b.rest;
      }
    }
    // Unit glued or spaced: "400g", "2 tbsp", "1 heaped tsp", "3 fl oz"
    text = text.replace(/^(heaped|level|rounded|large|small|medium)\s+(?=(tsp|tbsp|teaspoons?|tablespoons?|cups?|cloves?|tins?|cans?)\b)/i, '');
    const u = text.match(/^(fl\.?\s?oz|[a-zA-Z]+\.?)\b\s*/);
    if (u) {
      const word = u[1]!.replace(/\.$/, '');
      const norm = normaliseUnit(word);
      if (MEASURE_UNITS.has(norm)) {
        unit = norm;
        text = text.slice(u[0].length);
      } else if (COUNT_WORDS.has(word.toLowerCase())) {
        unit = 'count';
        countWord = singular(word);
        // "3 eggs": the counting word is also the thing itself.
        const after = text.slice(u[0].length).trim();
        if (after) text = after;
      }
    }
    if (!unit) unit = 'count';
    // "400g tin chopped tomatoes": the pack word after a weight is just description.
    text = text.replace(/^(tins?|cans?|packs?|packets?|jars?|bags?)\s+(of\s+)?/i, '');
    text = text.replace(/^of\s+/i, '');
  }

  const name = text.replace(SIZE_WORDS, ' ').replace(/\s+/g, ' ').trim() || raw.trim();
  const note = notes.filter(Boolean).join('; ') || null;
  return { amount, unit, countWord, name, note, optional };
}

export function scaleAmount(amount: number | null, fromServes: number, toServes: number): number | null {
  if (amount === null || fromServes <= 0) return amount;
  return (amount * toServes) / fromServes;
}

/** Nicely rounded amounts for display: 0.5 -> "½", 1.25 -> "1¼", 2.333 -> "2⅓", 137.4 -> "137". */
export function formatAmount(n: number): string {
  if (n >= 20) return String(Math.round(n));
  const whole = Math.floor(n);
  const frac = n - whole;
  const nice: [number, string][] = [
    [0, ''],
    [0.25, '¼'],
    [1 / 3, '⅓'],
    [0.5, '½'],
    [2 / 3, '⅔'],
    [0.75, '¾'],
    [1, ''],
  ];
  const [value, glyph] = nice.reduce((best, cur) => (Math.abs(cur[0] - frac) < Math.abs(best[0] - frac) ? cur : best));
  if (Math.abs(value - frac) < 0.04) {
    const w = value === 1 ? whole + 1 : whole;
    return w === 0 && glyph ? glyph : `${w || ''}${glyph}` || '0';
  }
  return String(Number(n.toFixed(1)));
}

export const NUTRIENTS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'saturates', 'fibre', 'salt'] as const;

export interface NutritionLine {
  grams: number | null;
  per100g: Nutrition | null;
}

export interface NutritionTotal {
  perServing: Nutrition;
  /** Share of lines (by count) whose calories are known, 0-1. */
  coverage: number;
}

const LEADING_AMOUNT =
  /^(about\s+)?(\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])(?:\s+\d+\/\d+|\/\d+)?(?:\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?/i;

/** Import noise some recipe sites add ("1 unit(s) Apple" becomes "1 Apple"). */
export function tidyLine(text: string): string {
  return text.replace(/\s*\bunits?\s*\(s\)/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * A recipe line with its amount scaled to the servings chosen, keeping the
 * recipe's own wording: "400g chopped tomatoes" for 4 becomes "200g chopped tomatoes" for 2.
 */
export function scaledLine(text: string, amount: number | null, from: number, to: number): string {
  const tidy = tidyLine(text);
  if (amount === null || from === to || from <= 0) return tidy;
  const scaled = formatAmount(scaleAmount(amount, from, to)!);
  const m = tidy.match(LEADING_AMOUNT);
  if (!m) return `${scaled} × ${tidy}`;
  return `${scaled}${tidy.slice(m[0].length)}`;
}

/** Nutrition per serving from each line's grams and per-100g values. Lines with no data are skipped and lower the coverage. */
export function recipeNutrition(lines: NutritionLine[], serves: number): NutritionTotal {
  const total: Record<string, number> = {};
  let known = 0;
  let counted = 0;
  for (const l of lines) {
    counted++;
    if (l.grams === null || !l.per100g || l.per100g.kcal === null || l.per100g.kcal === undefined) continue;
    known++;
    for (const k of NUTRIENTS) {
      const v = l.per100g[k];
      if (v !== null && v !== undefined) total[k] = (total[k] ?? 0) + (v * l.grams) / 100;
    }
  }
  const perServing: Nutrition = {};
  for (const [k, v] of Object.entries(total)) perServing[k as keyof Nutrition] = Math.round((v / Math.max(1, serves)) * 10) / 10;
  return { perServing, coverage: counted ? known / counted : 1 };
}

/** ISO 8601 durations from recipe sites ("PT1H15M") to minutes. */
export function isoDurationMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const minutes = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Math.round(Number(m[4] ?? 0) / 60);
  return minutes > 0 ? minutes : null;
}

export type MealFilter = 'breakfast' | 'lunch' | 'dinner';

const MEAL_TAGS: Record<MealFilter, string[]> = {
  breakfast: ['breakfast', 'brunch'],
  lunch: ['lunch', 'light meal', 'light lunch', 'sandwich', 'salad', 'soup'],
  dinner: ['dinner', 'supper', 'main', 'main course', 'mains', 'main dish', 'tea'],
};

/** Which meals a recipe suits, from its tags ("main course" counts as dinner). Untagged recipes suit none. */
export function recipeMeals(tags: string[]): MealFilter[] {
  const t = new Set(tags.map((x) => x.trim().toLowerCase()));
  return (Object.keys(MEAL_TAGS) as MealFilter[]).filter((m) => MEAL_TAGS[m].some((w) => t.has(w)));
}
