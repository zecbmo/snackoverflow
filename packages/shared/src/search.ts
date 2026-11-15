/** Text search shared by the server's food search and the web's tables. */

function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Every word of the query appears somewhere in the text (case and accents ignored). */
export function matchesSearch(text: string, query: string): boolean {
  const hay = norm(text);
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * How well a name matches, lower is better: 0 starts with the query, 1 a word starts with it,
 * 2 contains it, 3 only has all the words. Null when it doesn't match at all.
 */
export function searchRank(name: string, query: string): number | null {
  if (!matchesSearch(name, query)) return null;
  const n = norm(name);
  const q = norm(query).trim();
  if (n.startsWith(q)) return 0;
  if (n.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 1;
  if (n.includes(q)) return 2;
  return 3;
}
