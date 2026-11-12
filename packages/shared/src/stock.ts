/**
 * Using up stock. A pack always tracks the fraction left (0-1); when its size in
 * grams is known it also tracks grams, and the two stay in step.
 */
import type { StockState } from './shelfLife';

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
export function shouldAskOpened(state: StockState, amount: UseAmount, after: PackAmount): boolean {
  return state === 'closed' && amount.kind !== 'all' && after.fractionLeft > 0;
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
