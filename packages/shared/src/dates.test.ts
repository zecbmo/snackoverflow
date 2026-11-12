import { describe, expect, it } from 'vitest';
import {
  addDays,
  bestBeforeLabel,
  daysBetween,
  formatShortDate,
  freshness,
  isCalendarDate,
  minDate,
  todayIn,
  wallClockIn,
} from './dates';

describe('todayIn', () => {
  it('uses the household time zone, not UTC', () => {
    // 23:30 UTC on 30 June is already 1 July in London (BST).
    const now = new Date('2026-06-30T23:30:00Z');
    expect(todayIn('Europe/London', now)).toBe('2026-07-01');
    expect(todayIn('UTC', now)).toBe('2026-06-30');
  });

  it('matches UTC in winter for London', () => {
    expect(todayIn('Europe/London', new Date('2026-12-31T23:59:00Z'))).toBe('2026-12-31');
  });
});

describe('wallClockIn', () => {
  it('gives hour and weekday in the time zone', () => {
    // Sunday 8 Nov 2026, 10:05 in London (GMT).
    const c = wallClockIn('Europe/London', new Date('2026-11-08T10:05:00Z'));
    expect(c).toEqual({ date: '2026-11-08', hour: 10, minute: 5, weekday: 0 });
  });

  it('handles midnight as hour 0', () => {
    expect(wallClockIn('UTC', new Date('2026-11-09T00:00:00Z')).hour).toBe(0);
  });
});

describe('calendar arithmetic', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-11-28', 3)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is not affected by clock changes', () => {
    // UK clocks go back on 25 Oct 2026.
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-11-12', '2026-11-12')).toBe(0);
    expect(daysBetween('2026-11-12', '2026-11-20')).toBe(8);
    expect(daysBetween('2026-11-20', '2026-11-12')).toBe(-8);
  });

  it('picks the earlier date', () => {
    expect(minDate('2026-11-12', '2026-11-03')).toBe('2026-11-03');
  });

  it('validates calendar dates', () => {
    expect(isCalendarDate('2026-11-12')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('12/11/2026')).toBe(false);
  });
});

describe('freshness', () => {
  const today = '2026-11-12';
  it('bands dates for the colour coding', () => {
    expect(freshness('2026-11-11', today)).toBe('expired');
    expect(freshness('2026-11-12', today)).toBe('going-off');
    expect(freshness('2026-11-13', today)).toBe('going-off');
    expect(freshness('2026-11-14', today)).toBe('this-week');
    expect(freshness('2026-11-19', today)).toBe('this-week');
    expect(freshness('2026-11-20', today)).toBe('fine');
  });
});

describe('labels', () => {
  const today = '2026-11-12';
  it('reads naturally', () => {
    expect(bestBeforeLabel('2026-11-10', today)).toBe('2 days ago');
    expect(bestBeforeLabel('2026-11-11', today)).toBe('Yesterday');
    expect(bestBeforeLabel('2026-11-12', today)).toBe('Today');
    expect(bestBeforeLabel('2026-11-13', today)).toBe('Tomorrow');
    expect(bestBeforeLabel('2026-11-18', today)).toBe('6 days');
    expect(bestBeforeLabel('2026-12-03', today)).toBe('3 weeks');
    expect(bestBeforeLabel('2027-02-10', today)).toBe('Feb');
    expect(bestBeforeLabel('2028-11-12', today)).toBe('Nov 2028');
  });

  it('formats short dates', () => {
    expect(formatShortDate('2026-11-04')).toBe('4 Nov');
  });
});
