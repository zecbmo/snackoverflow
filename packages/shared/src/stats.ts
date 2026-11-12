/** Dashboard maths: weeks and months, calorie averages and "down 40% on October". Pure, so it's unit-tested. */
import { addDays, type CalendarDate, daysBetween } from './dates';

export type StatsPeriod = 'week' | 'month';

/** The Monday of the week a date falls in. */
export function weekStart(d: CalendarDate): CalendarDate {
  const dow = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(d, -dow);
}

export function monthStart(d: CalendarDate): CalendarDate {
  return `${d.slice(0, 8)}01` as CalendarDate;
}

/** The first day of the next week or month. */
export function nextPeriod(start: CalendarDate, period: StatsPeriod): CalendarDate {
  if (period === 'week') return addDays(start, 7);
  const [y, m] = start.split('-').map(Number) as [number, number];
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01` as CalendarDate;
}

export function previousPeriod(start: CalendarDate, period: StatsPeriod): CalendarDate {
  return period === 'week' ? addDays(start, -7) : monthStart(addDays(start, -1));
}

/** The last `count` weeks or months up to and including the one `today` is in, oldest first. */
export function periodStarts(today: CalendarDate, period: StatsPeriod, count: number): CalendarDate[] {
  let start = period === 'week' ? weekStart(today) : monthStart(today);
  const out = [start];
  while (out.length < count) {
    start = previousPeriod(start, period);
    out.unshift(start);
  }
  return out;
}

/** "w/c 3 Nov" or "Nov" (with the year when it isn't this year's). */
export function periodLabel(start: CalendarDate, period: StatsPeriod, today: CalendarDate): string {
  const d = new Date(`${start}T12:00:00Z`);
  if (period === 'week') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const sameYear = start.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString('en-GB', { month: 'short', ...(sameYear ? {} : { year: '2-digit' }), timeZone: 'UTC' });
}

/**
 * Average calories over the `days` complete days before today. Days with nothing logged are left out
 * (an empty day means nobody logged it, not that nobody ate). null when nothing was logged.
 */
export function averageKcal(byDate: Map<CalendarDate, number>, today: CalendarDate, days: number): number | null {
  let total = 0;
  let n = 0;
  for (let i = 1; i <= days; i++) {
    const k = byDate.get(addDays(today, -i)) ?? 0;
    if (k > 0) {
      total += k;
      n++;
    }
  }
  return n ? Math.round(total / n) : null;
}

/**
 * Change against the previous period at the same point: on 12 November, 1-12 November against
 * 1-12 October, so a month that has only just started isn't "down 90%". null when there's nothing to compare.
 */
export function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** The end (exclusive) of "the same point" in the previous period, for changePercent. */
export function samePointInPrevious(start: CalendarDate, period: StatsPeriod, today: CalendarDate): { from: CalendarDate; to: CalendarDate } {
  const prev = previousPeriod(start, period);
  const elapsed = daysBetween(start, today) + 1;
  const prevEnd = start; // exclusive
  const to = addDays(prev, elapsed);
  return { from: prev, to: to < prevEnd ? to : prevEnd };
}
