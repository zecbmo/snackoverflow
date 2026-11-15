/**
 * Using up stock. A pack always tracks the fraction left (0-1); when its size in
 * grams is known it also tracks grams, and the two stay in step.
 */
import type { StockState } from './shelfLife';
import type { CalendarDate } from './dates';

export type UseAmount = { kind: 'all' } | { kind: 'fraction'; fraction: number } | { kind: 'grams'; grams: number };

/** Below this fraction we ask "Is there still some left?". */
export const STILL_SOME_THRESHOLD = 0.1;
/** What "Yes, there's still some" and "Nearly gone" set the pack to when our numbers say it's empty. */
export const STILL_SOME_YES_FRACTION = 0.25;
export const STILL_SOME_NEARLY_GONE_FRACTION = 0.1;

export interface PackAmount {
  fractionLeft: number;
  initialGrams: number | null;
  remainingGrams: number | null;
}

export interface UseResult {
  after: PackAmount;
  /** Grams used, when known. */
  usedGrams: number | null;
  /** Fraction of the whole pack used. */
  usedFraction: number;
  /** The app's numbers might be off: ask "Is there still some left?". */
  askStillSome: boolean;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function withFraction(pack: PackAmount, fraction: number): PackAmount {
  const f = Math.max(0, Math.min(1, round(fraction)));
  return {
    fractionLeft: f,
    initialGrams: pack.initialGrams,
    remainingGrams: pack.initialGrams === null ? null : round(pack.initialGrams * f),
  };
}

/**
 * Apply a use to a pack. "Some" fractions are a share of what is left
 * (½ of a half-used jar leaves a quarter).
 */
export function applyUse(pack: PackAmount, amount: UseAmount): UseResult {
  let afterFraction: number;
  if (amount.kind === 'all') {
    afterFraction = 0;
  } else if (amount.kind === 'fraction') {
    const share = Math.max(0, Math.min(1, amount.fraction));
    afterFraction = pack.fractionLeft * (1 - share);
  } else {
    if (pack.initialGrams === null || pack.initialGrams <= 0) {
      throw new Error("This pack's size isn't known, so an exact amount can't be used.");
    }
    afterFraction = pack.fractionLeft - amount.grams / pack.initialGrams;
  }
  let after = withFraction(pack, afterFraction);
  // An amount in grams comes off in grams, exactly: the fraction is rounded, so it follows.
  if (amount.kind === 'grams' && pack.remainingGrams !== null && after.fractionLeft > 0) {
    after = { ...after, remainingGrams: round(Math.max(0, pack.remainingGrams - amount.grams)) };
  }
  const usedFraction = round(pack.fractionLeft - after.fractionLeft);
  const usedGrams =
    pack.initialGrams === null ? null : pack.remainingGrams !== null && after.remainingGrams !== null ? round(pack.remainingGrams - after.remainingGrams) : round(pack.initialGrams * usedFraction);
  const askStillSome = amount.kind !== 'all' && after.fractionLeft <= STILL_SOME_THRESHOLD;
  return { after, usedGrams, usedFraction, askStillSome };
}

export type StillSomeAnswer = 'yes' | 'nearly-gone' | 'none';

/** Correct a pack after the user answers "Is there still some left?". */
export function applyStillSome(pack: PackAmount, answer: StillSomeAnswer): PackAmount {
  if (answer === 'none') return withFraction(pack, 0);
  if (answer === 'nearly-gone') return withFraction(pack, Math.min(pack.fractionLeft || 1, STILL_SOME_NEARLY_GONE_FRACTION));
  return withFraction(pack, Math.max(pack.fractionLeft, STILL_SOME_YES_FRACTION));
}

/** A closed pack used in part for the first time prompts "Is it opened now?". */
/**
 * Ask "Is it opened now?" after using part of a closed pack, but only for food whose date
 * changes once opened (`openable`): potatoes or onions have no opened shelf life, so there's
 * nothing to ask (and marking them opened would be refused).
 */
export function shouldAskOpened(state: StockState, amount: UseAmount, after: PackAmount, openable = true): boolean {
  return openable && state === 'closed' && amount.kind !== 'all' && after.fractionLeft > 0;
}

export interface PackForOrdering {
  id: string;
  bestBefore: string | null;
  addedAt: string | Date;
  /** With these, a pack that's already started is used before a full one. */
  state?: StockState;
  fractionLeft?: number;
}

/** A pack that's been started: opened or defrosted, or part used (a frozen pack isn't "open"). */
export function isStarted(p: Pick<PackForOrdering, 'state' | 'fractionLeft'>): boolean {
  if (p.state === 'opened' || p.state === 'defrosted') return true;
  return p.state !== 'frozen' && p.fractionLeft !== undefined && p.fractionLeft < 1;
}

/**
 * Packs to use first: the one that's already open, then earliest best-before, undated last,
 * then oldest first. People finish the open bag before starting another.
 */
export function orderForUse<T extends PackForOrdering>(packs: T[]): T[] {
  return [...packs].sort((a, b) => {
    const started = Number(isStarted(b)) - Number(isStarted(a));
    if (started) return started;
    if (a.bestBefore !== b.bestBefore) {
      if (a.bestBefore === null) return 1;
      if (b.bestBefore === null) return -1;
      return a.bestBefore < b.bestBefore ? -1 : 1;
    }
    return new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime();
  });
}

/** What using an amount from a stock row will do, said before it's done. */
export interface UseOutcome {
  /**
   * `within`: some is left in the pack being used. `finishes`: it empties that pack exactly.
   * `spills`: it empties that pack and takes from the next. `last`: nothing is left in the row.
   */
  kind: 'within' | 'finishes' | 'spills' | 'last';
  /** The pack being used was already started (else this opens a new one). */
  started: boolean;
  /** Left in the pack being used (`within`). */
  packLeft: number;
  /** Taken from the following packs (`spills`). */
  fromNext: number;
  /** Left in the whole row afterwards. */
  left: number;
  /** Packs left in the row afterwards (counting a part-used one). */
  packsLeft: number;
}

/**
 * Work out what using `grams` does to a row's packs, given in the order they're used. Null when
 * there's nothing to say: no amount, or a pack whose size isn't known.
 */
export function outcomeOfUse(packs: Pick<StockPackLike, 'remainingGrams' | 'state' | 'fractionLeft'>[], grams: number): UseOutcome | null {
  const first = packs[0];
  if (!first || !(grams > 0) || packs.some((p) => p.remainingGrams === null)) return null;
  const total = packs.reduce((n, p) => n + p.remainingGrams!, 0);
  const open = first.remainingGrams!;
  const started = isStarted(first);
  if (grams >= total - 0.5) return { kind: 'last', started, packLeft: 0, fromNext: 0, left: 0, packsLeft: 0 };
  const left = total - grams;
  if (grams < open - 0.5) return { kind: 'within', started, packLeft: open - grams, fromNext: 0, left, packsLeft: packs.length };
  let rest = grams - open;
  let packsLeft = packs.length - 1;
  for (const p of packs.slice(1)) {
    if (rest < p.remainingGrams! - 0.5) break;
    rest -= p.remainingGrams!;
    packsLeft--;
  }
  if (grams <= open + 0.5) return { kind: 'finishes', started, packLeft: 0, fromNext: 0, left, packsLeft };
  return { kind: 'spills', started, packLeft: 0, fromNext: grams - open, left, packsLeft };
}

/** A pack as far as using it cares. */
export interface StockPackLike {
  remainingGrams: number | null;
  state: StockState;
  fractionLeft: number;
}

/** Food groups people eat as they are, so the Use sheet offers "I ate it" first. */
const READY_TO_EAT_GROUPS = new Set(['Fruit', 'Snacks', 'Sweets & Confectionery', 'Chilled & Prepared Food', 'Drinks', 'Bread & Bakery']);

/**
 * Whether something is usually eaten as it is (leftovers, a snack, fruit) rather than cooked with
 * (raw meat, flour). Only decides which button comes first; both are always there.
 */
export function readyToEat(p: { isMeal: boolean; ingredientId: string | null; foodGroup: string | null }): boolean {
  if (p.isMeal || p.ingredientId === null) return true;
  return p.foodGroup !== null && READY_TO_EAT_GROUPS.has(p.foodGroup);
}

/** What the amount stepper needs to know about a pack. */
export interface StepperPack {
  initialGrams: number | null;
  remainingGrams: number | null;
  displayUnit: 'g' | 'ml' | 'count';
  densityGPerMl: number | null;
  gramsPerCount: number | null;
  isMeal: boolean;
}

/** How a pack's amount is edited: in its own unit ("g", "ml", eggs, portions), with − / + steps. */
export interface AmountStepper {
  unit: 'g' | 'ml' | 'count' | 'portion';
  /** Short suffix shown next to the number: "g", "ml", "" for counts and portions. */
  suffix: string;
  /** Grams in one unit (1 for g, the density for ml, the item or portion weight for counts). */
  gramsPerUnit: number;
  /** Step sizes in the unit, small then large (one or two). */
  steps: number[];
  /** Amount left in the unit, rounded to what the stepper shows; null when not known. */
  value: number | null;
  /** The whole pack in the unit, when known. */
  packSize: number | null;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/**
 * Pick the unit and step sizes for changing a pack's amount. Steps scale with the pack:
 * a 150g pot moves in 10g and 50g, a 2.27L bottle in 100ml and 500ml, eggs one at a time,
 * portions in halves and wholes.
 */
export function amountStepper(pack: StepperPack): AmountStepper {
  const size = pack.initialGrams;
  if (pack.isMeal && pack.gramsPerCount) {
    return finish(pack, { unit: 'portion', suffix: '', gramsPerUnit: pack.gramsPerCount, steps: [0.5, 1] });
  }
  if (pack.displayUnit === 'count' && pack.gramsPerCount) {
    return finish(pack, { unit: 'count', suffix: '', gramsPerUnit: pack.gramsPerCount, steps: [1] });
  }
  const ml = pack.displayUnit === 'ml';
  const gramsPerUnit = ml ? (pack.densityGPerMl ?? 1) : 1;
  const inUnit = size === null ? null : size / gramsPerUnit;
  const steps = inUnit === null || inUnit > 1000 ? [100, 500] : inUnit > 300 ? [10, 100] : inUnit > 50 ? [10, 50] : [1, 10];
  return finish(pack, { unit: ml ? 'ml' : 'g', suffix: ml ? 'ml' : 'g', gramsPerUnit, steps });
}

function finish(pack: StepperPack, s: Omit<AmountStepper, 'value' | 'packSize'>): AmountStepper {
  // Grams, ml and counted food show whole numbers (nobody has half an egg); portions show halves.
  const precision = s.unit === 'portion' ? 0.5 : 1;
  const toUnit = (grams: number) => roundTo(grams / s.gramsPerUnit, precision);
  return {
    ...s,
    value: pack.remainingGrams === null ? null : toUnit(pack.remainingGrams),
    packSize: pack.initialGrams === null ? null : toUnit(pack.initialGrams),
  };
}

/**
 * Step an amount up or down, never below nothing. An amount between steps moves to the next
 * one in that direction: 437g + 10 gives 440g, 437g − 100 gives 400g.
 */
export function stepAmount(value: number, delta: number): number {
  const step = Math.abs(delta);
  const n = value / step;
  const next = delta > 0 ? Math.floor(n + 1e-9) + 1 : Math.ceil(n - 1e-9) - 1;
  return Math.max(0, Math.round(next * step * 1000) / 1000);
}

/** Grams for an amount typed or stepped in the stepper's unit. */
export function stepperGrams(stepper: Pick<AmountStepper, 'gramsPerUnit'>, value: number): number {
  return Math.round(Math.max(0, value) * stepper.gramsPerUnit * 1000) / 1000;
}

/** A pack as far as merging cares: its amount, state and dates. */
export interface MergeablePack extends PackAmount {
  state: StockState;
  bestBefore: CalendarDate | null;
  openedOn: CalendarDate | null;
  frozenOn: CalendarDate | null;
  defrostedOn: CalendarDate | null;
}

function earliest(dates: (CalendarDate | null)[]): CalendarDate | null {
  return dates.filter((d): d is CalendarDate => d !== null).sort()[0] ?? null;
}

/**
 * Merge packs of the same food in the same place into one. Food safety first: the merged pack
 * keeps the earliest best-before, and takes the shortest-lived state (defrosted, then opened)
 * with its earliest date. Frozen and unfrozen packs can't be merged. Amounts add up; when any
 * pack's size isn't known the fractions add up instead (at most one whole pack).
 */
export function mergePacks(packs: MergeablePack[]): MergeablePack {
  if (packs.length < 2) throw new Error('Pick at least two packs to merge.');
  const frozen = packs.filter((p) => p.state === 'frozen').length;
  if (frozen > 0 && frozen < packs.length) throw new Error("Frozen and unfrozen packs can't be merged.");
  const state: StockState = packs.some((p) => p.state === 'defrosted')
    ? 'defrosted'
    : packs.some((p) => p.state === 'opened')
      ? 'opened'
      : frozen
        ? 'frozen'
        : 'closed';
  const known = packs.every((p) => p.initialGrams !== null && p.remainingGrams !== null);
  let amount: PackAmount;
  if (known) {
    const initialGrams = round(packs.reduce((n, p) => n + p.initialGrams!, 0));
    const remainingGrams = round(packs.reduce((n, p) => n + p.remainingGrams!, 0));
    amount = { initialGrams, remainingGrams, fractionLeft: initialGrams > 0 ? Math.min(1, round(remainingGrams / initialGrams)) : 0 };
  } else {
    amount = { initialGrams: null, remainingGrams: null, fractionLeft: Math.min(1, round(packs.reduce((n, p) => n + p.fractionLeft, 0))) };
  }
  return {
    ...amount,
    state,
    bestBefore: earliest(packs.map((p) => p.bestBefore)),
    openedOn: state === 'opened' || state === 'defrosted' ? earliest(packs.map((p) => p.openedOn)) : null,
    frozenOn: earliest(packs.map((p) => p.frozenOn)),
    defrostedOn: state === 'defrosted' ? earliest(packs.map((p) => p.defrostedOn)) : null,
  };
}

/** What the Use sheet and the stock table need to know about how a food is measured. */
export interface MeasuredPack {
  displayUnit: 'g' | 'ml' | 'count';
  gramsPerCount: number | null;
  countUnit?: string | null;
  densityGPerMl?: number | null;
  isMeal: boolean;
  /** One item of a multipack (a bar of four), in grams. */
  itemGrams?: number | null;
  remainingGrams: number | null;
}

/**
 * What one item is, for food that's counted: by the item (apples, eggs), portions of a cooked meal,
 * or items of a multipack. Null for food measured by weight or volume (chicken thighs, milk), even
 * when it has a typical item weight, so it's never shown in units it isn't measured in.
 */
export function itemOf(p: MeasuredPack): { grams: number; name: string } | null {
  if (p.isMeal && p.gramsPerCount) return { grams: p.gramsPerCount, name: 'portion' };
  if (p.itemGrams) return { grams: p.itemGrams, name: 'item' };
  if (p.displayUnit === 'count' && p.gramsPerCount) return { grams: p.gramsPerCount, name: p.countUnit ?? 'item' };
  // A loaf is bought by weight but used by the slice.
  if (p.displayUnit === 'g' && p.countUnit && PIECE_UNITS.has(p.countUnit) && p.gramsPerCount) return { grams: p.gramsPerCount, name: p.countUnit };
  return null;
}

/** Count units that are pieces of a pack bought by weight (a slice of a loaf), so the pack is used a piece at a time. */
const PIECE_UNITS = new Set(['slice']);

export function isPieceUnit(unit: string | null | undefined): boolean {
  return Boolean(unit) && PIECE_UNITS.has(unit!);
}

/**
 * The − / + step on the Use sheet, in the food's own unit: one item, half a portion, or a round
 * amount that suits the size of the pack (10g for a small jar, 50g for a kilo of chicken).
 */
export function stepForUse(p: MeasuredPack & { initialGrams: number | null }): number {
  const it = itemOf(p);
  if (it) return it.name === 'portion' ? 0.5 : 1;
  const size = p.initialGrams === null ? null : p.displayUnit === 'ml' ? p.initialGrams / (p.densityGPerMl ?? 1) : p.initialGrams;
  if (size === null || size > 1000) return 100;
  if (size > 300) return 50;
  if (size > 50) return 10;
  return 5;
}

/** One item, and how many whole ones are left (across a stock row's packs when given its total). */
export interface OneItem {
  grams: number;
  /** "apple", "portion", "item". */
  name: string;
  /** Whole items left (rounded down), so − / + stay within what's there. */
  left: number;
}

/**
 * Counted food used an item at a time, when there's more than one left. Null otherwise: food
 * measured by weight or volume, or the last one (where "Used it all" is the one).
 */
export function oneItem(p: MeasuredPack, totalGrams: number | null = p.remainingGrams): OneItem | null {
  const it = itemOf(p);
  if (!it || totalGrams === null) return null;
  const left = Math.floor(totalGrams / it.grams + 0.05);
  if (left < 2) return null;
  return { ...it, left };
}

/** "6 apples", "~12 bananas", "2.5 portions", "1 item": counted food only (else null). Portions in halves; items whole. */
export function itemsText(p: MeasuredPack, grams: number | null): string | null {
  const it = itemOf(p);
  if (!it || grams === null) return null;
  const exact = grams / it.grams;
  if (it.name === 'portion') {
    const n = Math.round(exact * 2) / 2;
    return `${n} ${it.name}${n === 1 ? '' : 's'}`;
  }
  // Whole items: a bag bought by weight holds "~12 bananas", not 12.5.
  const n = grams > 0 ? Math.max(1, Math.round(exact)) : 0;
  return `${Math.abs(exact - n) > 0.15 ? '~' : ''}${n} ${it.name}${n === 1 ? '' : 's'}`;
}

/** Quick amounts for food measured by weight or volume: 100 / 250 / 500 (g or ml), and a cup when it can be weighed. */
export function quickAmounts(p: MeasuredPack, totalGrams: number | null, cupMl: number | null): { label: string; grams: number }[] {
  if (itemOf(p)) return [];
  const out: { label: string; grams: number }[] = [];
  if (p.displayUnit === 'ml') {
    const density = p.densityGPerMl ?? 1;
    for (const ml of [100, 250, 500]) out.push({ label: ml === cupMl ? `${ml}ml (a cup)` : `${ml}ml`, grams: ml * density });
    if (cupMl && ![100, 250, 500].includes(cupMl)) out.push({ label: `1 cup (${cupMl}ml)`, grams: cupMl * density });
  } else {
    for (const g of [100, 250, 500]) out.push({ label: `${g}g`, grams: g });
    // A cup of flour, rice or oats: only when the food has a density to weigh it.
    if (cupMl && p.densityGPerMl) out.push({ label: `1 cup (${Math.round(cupMl * p.densityGPerMl)}g)`, grams: cupMl * p.densityGPerMl });
  }
  return out.filter((x) => totalGrams === null || x.grams < totalGrams - 0.5);
}
