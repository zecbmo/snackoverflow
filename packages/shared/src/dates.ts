/**
 * Calendar-date helpers. Best-before dates are calendar dates with no time,
 * stored and passed around as ISO strings ("2026-11-12"). "Today" is always
 * worked out in the household's time zone.
 */

export type CalendarDate = string;

export const DEFAULT_TIME_ZONE = 'Europe/London';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): value is CalendarDate {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The calendar date it is right now in the given time zone. */
export function todayIn(timeZone: string = DEFAULT_TIME_ZONE, now: Date = new Date()): CalendarDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Wall-clock hour (0-23), minute and weekday (0 = Sunday) in the given time zone. */
export function wallClockIn(
  timeZone: string = DEFAULT_TIME_ZONE,
  now: Date = new Date(),
): { date: CalendarDate; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: todayIn(timeZone, now),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekdays.indexOf(get('weekday')),
  };
}

function toUtc(date: CalendarDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

export function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a <= b ? a : b;
}

export function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a >= b ? a : b;
}

/**
 * Freshness band used for the colour coding.
 * - expired: past its date
 * - going-off: today or tomorrow (red)
 * - this-week: 2 to 7 days (amber)
 * - fine: more than a week (green)
 * Frozen items are shown in blue whatever their band; callers handle that.
 */
export type Freshness = 'expired' | 'going-off' | 'this-week' | 'fine';

export function freshness(bestBefore: CalendarDate, today: CalendarDate): Freshness {
  const days = daysBetween(today, bestBefore);
  if (days < 0) return 'expired';
  if (days <= 1) return 'going-off';
  if (days <= 7) return 'this-week';
  return 'fine';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Nov" */
export function formatShortDate(date: CalendarDate): string {
  const [, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** Short, friendly label for how long something has left: "Today", "Tomorrow", "3 days", "2 weeks", "Feb". */
export function bestBeforeLabel(bestBefore: CalendarDate, today: CalendarDate): string {
  const days = daysBetween(today, bestBefore);
  if (days < -1) return `${-days} days ago`;
  if (days === -1) return 'Yesterday';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `${days} days`;
  if (days < 56) return `${Math.floor(days / 7)} weeks`;
  const [y, m] = bestBefore.split('-');
  const month = MONTHS[Number(m) - 1] ?? '';
  return y === today.slice(0, 4) || days < 300 ? month : `${month} ${y}`;
}
