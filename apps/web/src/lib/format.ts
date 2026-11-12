import {
  bestBeforeLabel,
  type CalendarDate,
  formatQuantity,
  formatShortDate,
  freshness,
  type StockItemDto,
} from '@snackoverflow/shared';

export type Tone = 'red' | 'amber' | 'green' | 'blue' | 'grey';

/** Colour for a pack: blue when frozen, otherwise by freshness. */
export function toneFor(item: Pick<StockItemDto, 'state' | 'bestBefore'>, today: CalendarDate): Tone {
  if (item.state === 'frozen') return 'blue';
  if (!item.bestBefore) return 'grey';
  const f = freshness(item.bestBefore, today);
  if (f === 'expired' || f === 'going-off') return 'red';
  if (f === 'this-week') return 'amber';
  return 'green';
}

export const toneClasses: Record<Tone, { bar: string; pill: string; dot: string }> = {
  red: { bar: 'bg-fresh-red', pill: 'bg-fresh-red-soft text-fresh-red-text', dot: 'bg-fresh-red' },
  amber: { bar: 'bg-fresh-amber', pill: 'bg-fresh-amber-soft text-fresh-amber-text', dot: 'bg-fresh-amber' },
  green: { bar: 'bg-fresh-green', pill: 'bg-fresh-green-soft text-fresh-green-text', dot: 'bg-fresh-green' },
  blue: { bar: 'bg-frozen', pill: 'bg-frozen-soft text-frozen-text', dot: 'bg-frozen' },
  grey: { bar: 'bg-line', pill: 'bg-card-muted text-muted', dot: 'bg-line' },
};

export function dateLabel(bestBefore: CalendarDate | null, today: CalendarDate): string {
  return bestBefore ? bestBeforeLabel(bestBefore, today) : 'No date';
}

export function longDate(d: CalendarDate | null): string {
  return d ? formatShortDate(d) : 'no date';
}

/** "about 120g left", "400g", "2.27L", or "¾ left" when the size isn't known. */
export function amountLabel(item: StockItemDto): string {
  const measures = { densityGPerMl: item.densityGPerMl, gramsPerCount: item.gramsPerCount };
  if (item.remainingGrams !== null) {
    const q = formatQuantity(item.remainingGrams, item.displayUnit, measures);
    return item.fractionLeft < 1 ? `about ${q} left` : q;
  }
  if (item.fractionLeft >= 1) return '1 pack';
  return `${fractionWord(item.fractionLeft)} left`;
}

export function fractionWord(f: number): string {
  if (f >= 0.7) return 'about ¾';
  if (f >= 0.45) return 'about half';
  if (f >= 0.2) return 'about ¼';
  return 'a little';
}

export const stateLabel: Record<StockItemDto['state'], string> = {
  closed: 'closed',
  opened: 'opened',
  frozen: 'frozen',
  defrosted: 'defrosted',
};

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function longToday(today: CalendarDate): string {
  const d = new Date(`${today}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
