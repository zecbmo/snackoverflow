/**
 * Shopping and planning maths: rounding what the plan needs up to whole packs,
 * estimating when staples run out, and meal slots.
 */
import { addDays, type CalendarDate, daysBetween } from './dates';

export interface PackChoice {
  /** Size of one pack in grams. */
  packGrams: number;
  packs: number;
  /** Grams bought beyond what's needed. */
  surplusGrams: number;
}

/**
 * Shops sell fixed packs: "buy a 2.5kg bag", not "buy 100g". Pick the pack size
 * and count that covers the shortfall with the least left over (fewer packs on a tie).
 * Without known pack sizes the shortfall itself is the "pack".
 */
export function choosePacks(shortGrams: number, packSizes: number[]): PackChoice | null {
  if (shortGrams <= 0) return null;
  const sizes = [...new Set(packSizes.filter((s) => s > 0))];
  if (sizes.length === 0) return { packGrams: Math.ceil(shortGrams), packs: 1, surplusGrams: 0 };
  let best: PackChoice | null = null;
  for (const size of sizes) {
    const packs = Math.ceil(shortGrams / size - 1e-9);
    const surplus = packs * size - shortGrams;
    if (!best || surplus < best.surplusGrams - 1e-9 || (Math.abs(surplus - best.surplusGrams) < 1e-9 && packs < best.packs)) {
      best = { packGrams: size, packs, surplusGrams: Math.round(surplus * 10) / 10 };
    }
  }
  return best;
}

export interface UsagePoint {
  /** Grams taken out on that day (uses and binned; not adds). */
  grams: number;
  day: CalendarDate;
}

/**
 * How fast a staple gets used, from the last `windowDays` of stock events, and
 * when it will run out at that rate. Needs at least two uses to say anything.
 */
export function estimateRunOut(input: {
  uses: UsagePoint[];
  onHandGrams: number;
  today: CalendarDate;
  windowDays?: number;
}): { gramsPerDay: number; daysLeft: number; runsOutOn: CalendarDate } | null {
  const window = input.windowDays ?? 60;
  const recent = input.uses.filter((u) => u.grams > 0 && daysBetween(u.day, input.today) <= window && daysBetween(u.day, input.today) >= 0);
  if (recent.length < 2) return null;
  const first = recent.reduce((a, u) => (u.day < a ? u.day : a), recent[0]!.day);
  const span = Math.max(7, daysBetween(first, input.today));
  const gramsPerDay = recent.reduce((s, u) => s + u.grams, 0) / span;
  if (gramsPerDay <= 0) return null;
  const daysLeft = Math.floor(input.onHandGrams / gramsPerDay);
  return { gramsPerDay: Math.round(gramsPerDay * 10) / 10, daysLeft, runsOutOn: addDays(input.today, daysLeft) };
}

/** Running low when it will be gone within this many days. */
export const RUNNING_LOW_DAYS = 3;

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

/** When each meal usually happens: used for "Did you cook it?" prompts and to pick the slot for Eat mode. */
export const SLOT_TIMES: Record<MealSlot, { hour: number; minute: number }> = {
  breakfast: { hour: 8, minute: 0 },
  lunch: { hour: 12, minute: 30 },
  dinner: { hour: 18, minute: 0 },
  snack: { hour: 15, minute: 30 },
};

/** The meal slot for something eaten now (Eat mode): by time of day. */
export function slotForTime(hour: number): MealSlot {
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 17) return 'snack';
  if (hour < 21) return 'dinner';
  return 'snack';
}

/**
 * Share of a planned meal each person eats. People listed with portions get
 * those; a meal with nobody listed is the household's, split evenly.
 */
export function portionShare(servings: number, people: { userId: string; portions: number }[], userId: string, householdSize: number): number {
  if (people.length === 0) return householdSize > 0 ? servings / householdSize : 0;
  return people.find((p) => p.userId === userId)?.portions ?? 0;
}
