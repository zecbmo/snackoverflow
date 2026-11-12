/**
 * The waste-aware optimiser. It works out the surplus of every ingredient
 * (what you have, plus what the shopping list will bring in, minus what the plan
 * needs), scores surplus that will go off before it's used, and ranks recipes by
 * how much at-risk surplus they use, minus the cost of anything extra to buy.
 */
import { addDays, type CalendarDate, daysBetween } from './dates';

export interface Lot {
  ingredientId: string;
  grams: number;
  bestBefore: CalendarDate | null;
  frozen: boolean;
  /** On the shopping list, not bought yet. */
  coming: boolean;
}

export interface Need {
  ingredientId: string;
  grams: number;
  date: CalendarDate;
}

/**
 * Take planned needs out of the lots, earliest need from the earliest-expiring
 * lot (frozen and coming lots last), and return what's left: the surplus.
 */
export function surplusLots(lots: Lot[], needs: Need[]): Lot[] {
  const order = (a: Lot, b: Lot) =>
    Number(a.coming) - Number(b.coming) || Number(a.frozen) - Number(b.frozen) || (a.bestBefore ?? '9999').localeCompare(b.bestBefore ?? '9999');
  const left = lots.map((l) => ({ ...l })).sort(order);
  for (const need of [...needs].sort((a, b) => a.date.localeCompare(b.date))) {
    let want = need.grams;
    for (const lot of left) {
      if (want <= 0) break;
      if (lot.ingredientId !== need.ingredientId || lot.grams <= 0) continue;
      // Food that's gone off before the meal can't be used for it.
      if (!lot.frozen && !lot.coming && lot.bestBefore && lot.bestBefore < need.date) continue;
      const take = Math.min(lot.grams, want);
      lot.grams -= take;
      want -= take;
    }
  }
  return left.filter((l) => l.grams > 0.5);
}

/**
 * How urgently a lot needs using, 0-1, judged on `on` (today, or the day of a planned meal).
 * Frozen, already-expired and not-yet-bought food scores nothing.
 */
export function riskWeight(lot: Pick<Lot, 'bestBefore' | 'frozen' | 'coming'>, on: CalendarDate): number {
  if (lot.frozen || lot.coming || !lot.bestBefore) return 0;
  const days = daysBetween(on, lot.bestBefore);
  if (days < 0) return 0;
  return Math.round((1 / (1 + days / 2)) * 1000) / 1000;
}

export interface ScoringLine {
  ingredientId: string | null;
  name: string;
  grams: number | null;
  optional: boolean;
}

export interface ScoringRecipe {
  id: string;
  title: string;
  serves: number;
  tags: string[];
  lines: ScoringLine[];
}

export interface RecipeScore {
  recipeId: string;
  title: string;
  /** Everything needed is in stock now. */
  cookNow: boolean;
  /** Ingredients short (beyond what's in stock or coming). */
  missing: { ingredientId: string; name: string; grams: number }[];
  /** At-risk surplus this recipe would use. */
  uses: { ingredientId: string; name: string; grams: number; bestBefore: CalendarDate | null; weight: number }[];
  extraCostPence: number | null;
  score: number;
  reason: string;
}

export interface ScoreOptions {
  /** The day it would be cooked (today for "Cook now"). */
  on: CalendarDate;
  servings?: number;
  /** Price of buying the missing grams of an ingredient, when pricing is on. */
  priceOf?: (ingredientId: string, grams: number) => number | null;
  /** Says an amount the way the ingredient is measured ("400ml" for milk); grams otherwise. */
  amountText?: (ingredientId: string, grams: number) => string;
}

/** Points lost per extra item to buy when there are no prices: "fewest extra items". */
export const EXTRA_ITEM_PENALTY = 1;
/** Points lost per pound of extras when prices are known. */
export const EXTRA_POUND_PENALTY = 0.5;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function when(bestBefore: CalendarDate, on: CalendarDate): string {
  const d = daysBetween(on, bestBefore);
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 7) return WEEKDAYS[new Date(`${bestBefore}T12:00:00Z`).getUTCDay()]!;
  return `in ${d} days`;
}

function gramsText(g: number): string {
  return g >= 1000 ? `${Number((g / 1000).toFixed(1))}kg` : `${Math.round(g)}g`;
}

/** "Uses your 400g spare potatoes and the spinach going off Thursday." */
export function reasonFor(uses: RecipeScore['uses'], missing: RecipeScore['missing'], on: CalendarDate, say?: ScoreOptions['amountText']): string {
  const top = [...uses].sort((a, b) => b.grams * b.weight - a.grams * a.weight).slice(0, 2);
  const parts = top.map((u) => {
    const name = u.name.toLowerCase();
    return u.bestBefore && daysBetween(on, u.bestBefore) <= 6 ? `the ${name} going off ${when(u.bestBefore, on)}` : `your ${say ? say(u.ingredientId, u.grams) : gramsText(u.grams)} spare ${name}`;
  });
  const uses_ = parts.length ? `Uses ${parts.join(' and ')}` : '';
  const miss = missing.length ? `needs ${missing.map((m) => m.name.toLowerCase()).join(', ')}` : '';
  const text = [uses_, miss].filter(Boolean).join('; ');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : 'Everything is in stock.';
}

/** Score one recipe against the surplus. */
export function scoreRecipe(recipe: ScoringRecipe, surplus: Lot[], opts: ScoreOptions): RecipeScore {
  const factor = (opts.servings ?? recipe.serves) / Math.max(1, recipe.serves);
  // Group the recipe's needs by ingredient (two lines of onions count together).
  const needs = new Map<string, { name: string; grams: number }>();
  for (const l of recipe.lines) {
    if (l.optional || !l.ingredientId || !l.grams) continue;
    const n = needs.get(l.ingredientId) ?? { name: l.name, grams: 0 };
    n.grams += l.grams * factor;
    needs.set(l.ingredientId, n);
  }
  const missing: RecipeScore['missing'] = [];
  const uses: RecipeScore['uses'] = [];
  let cookNow = true;
  let extraPence = 0;
  let priced = true;
  for (const [ingredientId, need] of needs) {
    const lots = surplus
      .filter((l) => l.ingredientId === ingredientId && (l.frozen || l.coming || !l.bestBefore || l.bestBefore >= opts.on))
      .sort((a, b) => Number(a.coming) - Number(b.coming) || (a.bestBefore ?? '9999').localeCompare(b.bestBefore ?? '9999'));
    let want = need.grams;
    let fromStock = 0;
    for (const lot of lots) {
      if (want <= 0) break;
      const take = Math.min(lot.grams, want);
      want -= take;
      if (!lot.coming) fromStock += take;
      const weight = riskWeight(lot, opts.on);
      if (weight > 0) uses.push({ ingredientId, name: need.name, grams: Math.round(take), bestBefore: lot.bestBefore, weight });
    }
    // A little short (within 10%) still counts as enough.
    if (fromStock < need.grams * 0.9) cookNow = false;
    if (want > need.grams * 0.1) {
      missing.push({ ingredientId, name: need.name, grams: Math.round(want) });
      const p = opts.priceOf?.(ingredientId, want) ?? null;
      if (p === null) priced = false;
      else extraPence += p;
    }
  }
  const useScore = uses.reduce((s, u) => s + (u.grams / 100) * u.weight, 0);
  const extraCostPence = missing.length === 0 ? 0 : opts.priceOf && priced ? extraPence : null;
  const cost = extraCostPence !== null && opts.priceOf ? (extraCostPence / 100) * EXTRA_POUND_PENALTY : missing.length * EXTRA_ITEM_PENALTY;
  return {
    recipeId: recipe.id,
    title: recipe.title,
    cookNow: cookNow && needs.size > 0,
    missing,
    uses,
    extraCostPence,
    score: Math.round((useScore - cost) * 100) / 100,
    reason: reasonFor(uses, missing, opts.on, opts.amountText),
  };
}

export interface RankRules {
  /** Recipe ids cooked or planned recently (no repeats). */
  recent: Set<string>;
  excludedTags: string[];
  maxExtraIngredients: number;
}

/** Recipes worth suggesting, best first. */
export function rankRecipes(recipes: ScoringRecipe[], surplus: Lot[], opts: ScoreOptions, rules: RankRules): RecipeScore[] {
  const excluded = new Set(rules.excludedTags.map((t) => t.toLowerCase()));
  return recipes
    .filter((r) => !rules.recent.has(r.id) && !r.tags.some((t) => excluded.has(t.toLowerCase())))
    .map((r) => scoreRecipe(r, surplus, opts))
    .filter((s) => s.missing.length <= rules.maxExtraIngredients)
    .sort((a, b) => b.score - a.score || a.missing.length - b.missing.length || a.title.localeCompare(b.title));
}

export interface WeekSlot {
  date: CalendarDate;
  slot: string;
}

export interface WeekPick {
  date: CalendarDate;
  slot: string;
  choice: RecipeScore;
  /** Next-best options, for "swap". */
  alternatives: RecipeScore[];
}

/**
 * "Plan my week": fill the empty slots one day at a time, each time picking the
 * recipe that best uses what will be at risk by then, then treating its
 * ingredients as used so later days don't count on the same food.
 */
export function planWeek(
  recipes: ScoringRecipe[],
  lots: Lot[],
  needs: Need[],
  slots: WeekSlot[],
  opts: Omit<ScoreOptions, 'on'>,
  rules: RankRules,
): WeekPick[] {
  const picks: WeekPick[] = [];
  const planned = [...needs];
  const used = new Set(rules.recent);
  for (const s of [...slots].sort((a, b) => a.date.localeCompare(b.date))) {
    const surplus = surplusLots(lots, planned);
    const ranked = rankRecipes(recipes, surplus, { ...opts, on: s.date }, { ...rules, recent: used });
    const choice = ranked[0];
    if (!choice) continue;
    picks.push({ date: s.date, slot: s.slot, choice, alternatives: ranked.slice(1, 4) });
    used.add(choice.recipeId);
    const recipe = recipes.find((r) => r.id === choice.recipeId)!;
    const factor = (opts.servings ?? recipe.serves) / Math.max(1, recipe.serves);
    for (const l of recipe.lines) {
      if (!l.optional && l.ingredientId && l.grams) planned.push({ ingredientId: l.ingredientId, grams: l.grams * factor, date: s.date });
    }
  }
  return picks;
}

/** Surplus that will go off unused, grouped by ingredient: "2.1kg potatoes spare after this plan". */
export function surplusSummary(surplus: Lot[], on: CalendarDate, horizonDays = 14): { ingredientId: string; grams: number; goesOffBy: CalendarDate | null }[] {
  const until = addDays(on, horizonDays);
  const map = new Map<string, { ingredientId: string; grams: number; goesOffBy: CalendarDate | null }>();
  for (const l of surplus) {
    if (l.frozen) continue;
    // Bought (or to be bought) food that keeps for weeks isn't "at risk".
    if (!l.coming && (!l.bestBefore || l.bestBefore > until)) continue;
    const e = map.get(l.ingredientId) ?? { ingredientId: l.ingredientId, grams: 0, goesOffBy: null };
    e.grams += l.grams;
    if (l.bestBefore && (!e.goesOffBy || l.bestBefore < e.goesOffBy)) e.goesOffBy = l.bestBefore;
    map.set(l.ingredientId, e);
  }
  return [...map.values()].map((e) => ({ ...e, grams: Math.round(e.grams) })).sort((a, b) => b.grams - a.grams);
}
