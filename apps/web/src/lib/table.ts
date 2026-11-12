/** Search, sort and group helpers for the data tables. Pure, so they're unit-tested. */

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;

/** Every word of the query appears somewhere in the text (case and accents ignored). */
export function matchesSearch(text: string, query: string): boolean {
  const norm = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const hay = norm(text);
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** A stable sort by one key. Empty values always go last, whichever way it's sorted. */
export function sortRows<T>(rows: readonly T[], key: (row: T) => SortValue, dir: SortDir = 'asc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: key(row) }))
    .sort((a, b) => {
      const ae = a.v === null || a.v === undefined || a.v === '';
      const be = b.v === null || b.v === undefined || b.v === '';
      if (ae || be) return ae && be ? a.i - b.i : ae ? 1 : -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'en-GB', { numeric: true, sensitivity: 'base' });
      return c === 0 ? a.i - b.i : c * sign;
    })
    .map((x) => x.row);
}

export interface Group<T> {
  key: string;
  rows: T[];
}

/**
 * Groups rows by a key, keeping row order inside each group. Groups follow `order` when given
 * (unknown keys after, A to Z), otherwise the order they first appear.
 */
export function groupRows<T>(rows: readonly T[], key: (row: T) => string, order?: readonly string[]): Group<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  const groups = [...map.entries()].map(([k, rs]) => ({ key: k, rows: rs }));
  if (!order) return groups;
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return groups.sort((a, b) => rank(a.key) - rank(b.key) || (rank(a.key) === order.length ? a.key.localeCompare(b.key) : 0));
}
