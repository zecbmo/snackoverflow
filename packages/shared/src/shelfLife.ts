/**
 * Best-before rules. The day counts come from docs/data/shelf-life-defaults.csv
 * (passed in as ShelfLife). The food-safety rules in docs/data/README.md are hard
 * rules and live here as code, not settings:
 *
 * - Opening never extends a date: new date = min(current, today + opened days).
 * - Food can be frozen up to midnight on its date, never after.
 * - Defrosted food is never refrozen.
 * - Perishable food with no storage instructions: refrigerate and eat within 2 days.
 * - Frozen food: eat within 3-6 months (we use the safer end, 3 months, when nothing else is known).
 * - Defrosted food with no specific guidance: use within 24 hours.
 */
import { addDays, type CalendarDate, daysBetween, minDate } from './dates';
import { parseCsv } from './csv';

export const STOCK_STATES = ['closed', 'opened', 'frozen', 'defrosted'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export const LOCATION_TYPES = ['cupboard', 'fridge', 'freezer'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

/** FSS: perishable food with no storage instructions, refrigerate and eat within 2 days. */
export const UNKNOWN_PERISHABLE_DAYS = 2;
/** FSA: eat frozen food within 3-6 months; 3 months when we know nothing else. */
export const UNKNOWN_FROZEN_DAYS = 90;
/** FSA: defrosted food must be used within 24 hours. */
export const DEFAULT_DEFROSTED_DAYS = 1;

export interface ShelfLife {
  closedDays: number | null;
  openedDays: number | null;
  frozenDays: number | null;
  defrostedDays: number | null;
  /** null = unknown (treated as freezable, the user knows best). */
  freezable: boolean | null;
}

export const EMPTY_SHELF_LIFE: ShelfLife = {
  closedDays: null,
  openedDays: null,
  frozenDays: null,
  defrostedDays: null,
  freezable: null,
};

export interface ShelfLifeCategorySeed extends ShelfLife {
  key: string;
  examples: string;
  defaultLocation: LocationType;
  source: string;
  notes: string;
}

function numOrNull(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseShelfLifeCsv(csv: string): ShelfLifeCategorySeed[] {
  return parseCsv(csv).map((row) => ({
    key: row.category ?? '',
    examples: row.examples ?? '',
    defaultLocation: (LOCATION_TYPES as readonly string[]).includes(row.default_location ?? '')
      ? (row.default_location as LocationType)
      : 'cupboard',
    closedDays: numOrNull(row.closed_days),
    openedDays: numOrNull(row.opened_days),
    frozenDays: numOrNull(row.frozen_days),
    defrostedDays: numOrNull(row.defrosted_days),
    freezable: row.freezable === 'yes' ? true : row.freezable === 'no' ? false : null,
    source: row.source ?? '',
    notes: row.notes ?? '',
  }));
}

/**
 * Merge shelf-life layers field by field; earlier layers win.
 * Order per the spec: the product's own category, then the ingredient's values.
 */
export function mergeShelfLife(...layers: (Partial<ShelfLife> | null | undefined)[]): ShelfLife {
  const out: ShelfLife = { ...EMPTY_SHELF_LIFE };
  for (const key of Object.keys(out) as (keyof ShelfLife)[]) {
    for (const layer of layers) {
      const v = layer?.[key];
      if (v !== null && v !== undefined) {
        (out as unknown as Record<string, unknown>)[key] = v;
        break;
      }
    }
  }
  return out;
}

function isKnown(s: ShelfLife): boolean {
  return s.closedDays !== null || s.openedDays !== null || s.frozenDays !== null;
}

export interface AddEstimate {
  state: StockState;
  /** null when there is nothing to base a date on (e.g. an unknown cupboard item). */
  bestBefore: CalendarDate | null;
  /** Where the estimate came from, for the "(estimated)" hint. */
  source: 'learned' | 'shelf-life' | 'safety-default' | 'none';
}

/**
 * Best-before for a newly scanned pack.
 * Order: what was learned for this product, then the shelf-life table, then the safety defaults.
 * Packs added to a freezer go in frozen.
 */
export function estimateOnAdd(input: {
  today: CalendarDate;
  locationType: LocationType;
  shelfLife: ShelfLife;
  learnedClosedDays?: number | null;
  learnedFrozenDays?: number | null;
}): AddEstimate {
  const { today, locationType, shelfLife } = input;
  if (locationType === 'freezer') {
    if (input.learnedFrozenDays != null) {
      return { state: 'frozen', bestBefore: addDays(today, input.learnedFrozenDays), source: 'learned' };
    }
    const days = shelfLife.frozenDays ?? shelfLife.closedDays;
    if (days !== null) return { state: 'frozen', bestBefore: addDays(today, days), source: 'shelf-life' };
    return { state: 'frozen', bestBefore: addDays(today, UNKNOWN_FROZEN_DAYS), source: 'safety-default' };
  }
  if (input.learnedClosedDays != null) {
    return { state: 'closed', bestBefore: addDays(today, input.learnedClosedDays), source: 'learned' };
  }
  if (shelfLife.closedDays !== null) {
    return { state: 'closed', bestBefore: addDays(today, shelfLife.closedDays), source: 'shelf-life' };
  }
  if (locationType === 'fridge') {
    return { state: 'closed', bestBefore: addDays(today, UNKNOWN_PERISHABLE_DAYS), source: 'safety-default' };
  }
  return { state: 'closed', bestBefore: null, source: 'none' };
}

export type ActionCheck = { ok: true } | { ok: false; reason: string };

/** Opening only makes sense for closed packs that have an opened shelf life (or unknown ones). */
export function canOpen(state: StockState, shelfLife: ShelfLife): ActionCheck {
  if (state !== 'closed' && state !== 'defrosted') return { ok: false, reason: 'Only closed packs can be opened.' };
  if (isKnown(shelfLife) && shelfLife.openedDays === null) {
    return { ok: false, reason: "This doesn't change once opened." };
  }
  return { ok: true };
}

/** Opening never extends a date: min(current date, today + opened days). */
export function bestBeforeOnOpen(input: {
  today: CalendarDate;
  current: CalendarDate | null;
  shelfLife: ShelfLife;
}): CalendarDate | null {
  const days = input.shelfLife.openedDays ?? (isKnown(input.shelfLife) ? null : UNKNOWN_PERISHABLE_DAYS);
  if (days === null) return input.current;
  const opened = addDays(input.today, days);
  return input.current ? minDate(input.current, opened) : opened;
}

/** Food can be frozen up to midnight on its date; defrosted food is never refrozen. */
export function canFreeze(input: {
  today: CalendarDate;
  state: StockState;
  bestBefore: CalendarDate | null;
  shelfLife: ShelfLife;
}): ActionCheck {
  if (input.state === 'frozen') return { ok: false, reason: "It's already frozen." };
  if (input.state === 'defrosted') return { ok: false, reason: 'Defrosted food must not be frozen again.' };
  if (input.shelfLife.freezable === false) return { ok: false, reason: "This doesn't freeze well." };
  if (input.bestBefore && input.bestBefore < input.today) {
    return { ok: false, reason: 'Too late to freeze: it is past its date.' };
  }
  return { ok: true };
}

export function bestBeforeOnFreeze(input: { today: CalendarDate; shelfLife: ShelfLife }): CalendarDate {
  return addDays(input.today, input.shelfLife.frozenDays ?? UNKNOWN_FROZEN_DAYS);
}

export function canDefrost(state: StockState): ActionCheck {
  return state === 'frozen' ? { ok: true } : { ok: false, reason: "It isn't frozen." };
}

export function bestBeforeOnDefrost(input: { today: CalendarDate; shelfLife: ShelfLife }): CalendarDate {
  return addDays(input.today, input.shelfLife.defrostedDays ?? DEFAULT_DEFROSTED_DAYS);
}

/**
 * When a user changes the date of a pack, the app learns it as the product's new default.
 * Only dates set while the pack is still in its as-bought state teach the app
 * (closed, or frozen when it went straight into the freezer).
 */
export function learnedDaysFromEdit(input: {
  state: StockState;
  addedOn: CalendarDate;
  frozenOn: CalendarDate | null;
  newBestBefore: CalendarDate;
}): { kind: 'closed' | 'frozen'; days: number } | null {
  const days = (from: CalendarDate) => daysBetween(from, input.newBestBefore);
  if (input.state === 'closed') {
    const d = days(input.addedOn);
    return d >= 0 ? { kind: 'closed', days: d } : null;
  }
  if (input.state === 'frozen' && input.frozenOn === input.addedOn) {
    const d = days(input.addedOn);
    return d >= 0 ? { kind: 'frozen', days: d } : null;
  }
  return null;
}
