/** "1.55", "£1.55", "1,55", "155p" -> 155 pence; null when it isn't a price. */
export function parsePounds(input: string): number | null {
  const s = input.trim().replace(/^£/, '').replace(',', '.');
  if (!s) return null;
  const pence = s.match(/^(\d{1,4})\s*p$/i);
  if (pence) return Number(pence[1]) || null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(Number(s) * 100);
  return v > 0 ? v : null;
}
