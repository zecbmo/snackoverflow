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

type Portion = { userId: string; portions: number };

/**
 * How much of a planned meal a person eats: the portions assigned to them. Portions nobody has
 * been given (and batch cooks) count for no one, so they never add to anyone's calories.
 */
export function portionShare(people: Portion[], userId: string): number {
  return people.find((p) => p.userId === userId)?.portions ?? 0;
}

/** Servings of a planned meal not assigned to anyone yet. */
export function freePortions(servings: number, people: Portion[]): number {
  const taken = people.reduce((n, p) => n + p.portions, 0);
  return Math.max(0, Math.round((servings - taken) * 1000) / 1000);
}

/**
 * Whether a planned meal shows on a person's calendar: theirs, or with portions still free
 * (so others can see something is being cooked). A meal fully given to other people doesn't.
 */
export function onCalendarOf(servings: number, people: Portion[], userId: string): boolean {
  return portionShare(people, userId) > 0 || freePortions(servings, people) > 0;
}

/**
 * One slot per serving for the person icons under a meal: whose it is, or null when it's free.
 * Part portions round to the nearest whole one (at least one each), and the list stops at `max`.
 */
export function portionSlots(servings: number, people: Portion[], max = 8): (string | null)[] {
  const slots: (string | null)[] = [];
  for (const p of people) for (let i = 0; i < Math.max(1, Math.round(p.portions)); i++) slots.push(p.userId);
  while (slots.length < Math.ceil(servings - 0.001)) slots.push(null);
  return slots.slice(0, max);
}

/**
 * Give one icon's portion to someone (or free it, with null): the people list after the change.
 * `slot` indexes `portionSlots`. Portions stay whole where they were whole.
 */
export function assignSlot(servings: number, people: Portion[], slot: number, to: string | null): Portion[] {
  const slots = portionSlots(servings, people, 1000);
  if (slot < 0 || slot >= slots.length) return people;
  const from = slots[slot]!;
  if (from === to) return people;
  const next = new Map(people.map((p) => [p.userId, p.portions]));
  if (from !== null) {
    const left = (next.get(from) ?? 0) - 1;
    if (left > 0.001) next.set(from, left);
    else next.delete(from);
  }
  if (to !== null) next.set(to, (next.get(to) ?? 0) + 1);
  return [...next.entries()].map(([userId, portions]) => ({ userId, portions: Math.round(portions * 1000) / 1000 }));
}
