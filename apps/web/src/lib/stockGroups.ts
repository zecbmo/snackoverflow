/**
 * Batches stay hidden: the stock screen shows one row per product and location
 * ("Potatoes · 2 packs · 2.9kg"), and tapping it shows the individual packs.
 */
import { formatQuantity, type StockItemDto } from '@snackoverflow/shared';

export interface StockGroup {
  key: string;
  productId: string;
  name: string;
  locationName: string;
  locationType: StockItemDto['locationType'];
  /** Packs in the order they'll be used (earliest best-before first). */
  packs: StockItemDto[];
  first: StockItemDto;
}

export function groupStock(items: StockItemDto[]): StockGroup[] {
  const groups = new Map<string, StockGroup>();
  for (const item of items) {
    const key = `${item.productId}|${item.locationId}|${item.state === 'frozen' ? 'f' : ''}`;
    const g = groups.get(key);
    if (g) g.packs.push(item);
    else
      groups.set(key, {
        key,
        productId: item.productId,
        name: item.productName,
        locationName: item.locationName,
        locationType: item.locationType,
        packs: [item],
        first: item,
      });
  }
  // Items arrive sorted by best-before, so groups keep that order.
  return [...groups.values()];
}

/** "Fridge · opened · about 120g left", "Cupboard · 2 packs · 2.9kg", "Fridge · 2 × 2.27L". */
export function groupSummary(g: StockGroup): string {
  const parts: string[] = [g.locationName];
  const p = g.first;
  if (g.packs.some((x) => x.state === 'opened')) parts.push('opened');
  else if (g.packs.some((x) => x.state === 'defrosted')) parts.push('defrosted');
  const measures = { densityGPerMl: p.densityGPerMl, gramsPerCount: p.gramsPerCount };
  if (p.isMeal) {
    const portions = g.packs.reduce((n, x) => n + (x.remainingGrams !== null && x.gramsPerCount ? x.remainingGrams / x.gramsPerCount : 1), 0);
    const r = Math.round(portions * 2) / 2;
    parts.push(`${r} ${r === 1 ? 'portion' : 'portions'}`);
    return parts.join(' · ');
  }
  if (g.packs.length === 1) {
    if (p.remainingGrams !== null) {
      const q = formatQuantity(p.remainingGrams, p.displayUnit, measures);
      parts.push(p.fractionLeft < 1 ? `about ${q} left` : q);
    }
    return parts.join(' · ');
  }
  const allFull = g.packs.every((x) => x.fractionLeft >= 1 && x.initialGrams === p.initialGrams);
  if (allFull && p.initialGrams !== null) {
    parts.push(`${g.packs.length} × ${formatQuantity(p.initialGrams, p.displayUnit, measures)}`);
  } else {
    parts.push(`${g.packs.length} packs`);
    const total = g.packs.reduce((sum, x) => (sum === null || x.remainingGrams === null ? null : sum + x.remainingGrams), 0 as number | null);
    if (total !== null) parts.push(formatQuantity(total, p.displayUnit, measures));
  }
  return parts.join(' · ');
}
