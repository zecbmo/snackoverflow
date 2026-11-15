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
  const after = withFraction(pack, afterFraction);
  const usedFraction = round(pack.fractionLeft - after.fractionLeft);
  const usedGrams = pack.initialGrams === null ? null : round(pack.initialGrams * usedFraction);
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
}

/** Packs to use first: earliest best-before first, undated last, then oldest first. */
export function orderForUse<T extends PackForOrdering>(packs: T[]): T[] {
  return [...packs].sort((a, b) => {
    if (a.bestBefore !== b.bestBefore) {
      if (a.bestBefore === null) return 1;
      if (b.bestBefore === null) return -1;
      return a.bestBefore < b.bestBefore ? -1 : 1;
    }
    return new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime();
  });
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
  // Grams and ml show whole numbers; counts and portions show halves.
  const precision = s.unit === 'g' || s.unit === 'ml' ? 1 : 0.5;
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
