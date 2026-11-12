import { formatAmount, scaleAmount } from '@snackoverflow/shared';

const LEADING_AMOUNT =
  /^(about\s+)?(\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])(?:\s+\d+\/\d+|\/\d+)?(?:\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?/i;

/**
 * A recipe line with its amount scaled to the servings chosen, keeping the
 * recipe's own wording: "400g chopped tomatoes" for 4 becomes "200g chopped tomatoes" for 2.
 */
export function scaledLine(text: string, amount: number | null, _unit: string | null, from: number, to: number): string {
  if (amount === null || from === to) return text;
  const scaled = formatAmount(scaleAmount(amount, from, to)!);
  const m = text.match(LEADING_AMOUNT);
  if (!m) return `${scaled} × ${text}`;
  return `${scaled}${text.slice(m[0].length)}`;
}
