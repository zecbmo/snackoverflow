import { describe, expect, it } from 'vitest';
import type { CalendarDate } from './dates';
import { averageKcal, changePercent, monthStart, nextPeriod, periodLabel, periodStarts, samePointInPrevious, weekStart } from './stats';

const d = (s: string) => s as CalendarDate;

describe('stats periods', () => {
  it('finds the Monday of the week', () => {
    expect(weekStart(d('2026-11-12'))).toBe('2026-11-09'); // Thursday
    expect(weekStart(d('2026-11-09'))).toBe('2026-11-09'); // Monday
    expect(weekStart(d('2026-11-15'))).toBe('2026-11-09'); // Sunday
  });

  it('steps months across the year end', () => {
    expect(monthStart(d('2026-11-12'))).toBe('2026-11-01');
    expect(nextPeriod(d('2026-12-01'), 'month')).toBe('2027-01-01');
    expect(periodStarts(d('2027-01-20'), 'month', 3)).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
    expect(periodStarts(d('2026-11-12'), 'week', 3)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
  });

  it('labels periods', () => {
    expect(periodLabel(d('2026-11-09'), 'week', d('2026-11-12'))).toBe('9 Nov');
    expect(periodLabel(d('2026-11-01'), 'month', d('2026-11-12'))).toBe('Nov');
    expect(periodLabel(d('2025-12-01'), 'month', d('2026-01-12'))).toBe('Dec 25');
  });

  it('compares with the same point in the previous period', () => {
    expect(samePointInPrevious(d('2026-11-01'), 'month', d('2026-11-12'))).toEqual({ from: '2026-10-01', to: '2026-10-13' });
    // 31 March: the whole of February.
    expect(samePointInPrevious(d('2026-03-01'), 'month', d('2026-03-31'))).toEqual({ from: '2026-02-01', to: '2026-03-01' });
    expect(samePointInPrevious(d('2026-11-09'), 'week', d('2026-11-10'))).toEqual({ from: '2026-11-02', to: '2026-11-04' });
  });

  it('works out change', () => {
    expect(changePercent(0.6, 1)).toBe(-40);
    expect(changePercent(5, 0)).toBeNull();
  });
});

describe('averageKcal', () => {
  it('averages the complete days with something logged', () => {
    const byDate = new Map<CalendarDate, number>([
      [d('2026-11-12'), 900], // today: still being logged, left out
      [d('2026-11-11'), 2000],
      [d('2026-11-10'), 2400],
      [d('2026-11-01'), 1000], // outside the 7 days
    ]);
    expect(averageKcal(byDate, d('2026-11-12'), 7)).toBe(2200);
    expect(averageKcal(byDate, d('2026-11-12'), 30)).toBe(1800);
    expect(averageKcal(new Map(), d('2026-11-12'), 7)).toBeNull();
  });
});
