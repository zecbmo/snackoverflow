/**
 * A small column chart in plain HTML: one series, columns at most 24px wide with rounded tops,
 * an optional reference line (a calorie target), a tooltip on hover or focus for each column,
 * and the numbers as a table for anyone who'd rather read them.
 */
import { type ReactNode, useId, useState } from 'react';

export interface Bar {
  key: string;
  /** Under the column: "Mon", "Nov". */
  label: string;
  value: number;
  /** On the cap when labelled: "2.4k". */
  short?: string;
  /** Tooltip and accessible name: "Monday 10 November: 2,400 kcal, over target". */
  detail: string;
  tone?: 'ink' | 'accent' | 'pending';
}

const TONE = { ink: 'bg-ink', accent: 'bg-accent', pending: 'bg-chart-pending' } as const;

export function BarChart({
  bars,
  label,
  reference,
  showValues = false,
  height = 180,
  tableHeadings = ['Day', 'Amount'],
  note,
}: {
  bars: Bar[];
  /** What the chart shows, for screen readers. */
  label: string;
  reference?: { value: number; label: string } | null;
  /** A value on every cap: only for a handful of columns. */
  showValues?: boolean;
  height?: number;
  tableHeadings?: [string, string];
  /** A line under the chart, before the table toggle: what the colours mean. */
  note?: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  const tableId = useId();
  const max = Math.max(1, ...bars.map((b) => b.value), reference?.value ?? 0) * (showValues ? 1.18 : 1.05);
  const pct = (v: number) => `${(v / max) * 100}%`;
  const dense = bars.length > 14;

  return (
    <figure className="m-0">
      <div role="group" aria-label={label} aria-describedby={tableId} className="relative" style={{ height }}>
        {/* Baseline and reference line: hairlines, behind the columns. */}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-line" />
        {reference && reference.value > 0 && (
          <div aria-hidden className="absolute inset-x-0 h-px bg-muted/60" style={{ bottom: pct(reference.value) }}>
            {/* Too crowded to label among 30 columns: the card's heading names the target instead. */}
            {!dense && <span className="absolute -top-5 right-0 rounded bg-card px-1 text-xs text-muted">{reference.label}</span>}
          </div>
        )}
        <div className={`absolute inset-0 flex items-end ${dense ? 'gap-px' : 'gap-0.5'}`}>
          {bars.map((b, i) => (
            <div
              key={b.key}
              tabIndex={0}
              aria-label={b.detail}
              onMouseEnter={() => setActive(b.key)}
              onMouseLeave={() => setActive((a) => (a === b.key ? null : a))}
              onFocus={() => setActive(b.key)}
              onBlur={() => setActive((a) => (a === b.key ? null : a))}
              className="group relative flex h-full flex-1 flex-col items-center justify-end rounded-md outline-offset-2"
            >
              {showValues && b.value > 0 && <span className="mb-1 text-xs font-medium tabular-nums text-muted">{b.short ?? b.value}</span>}
              <div
                className={`w-[min(24px,70%)] rounded-t-[4px] ${TONE[b.tone ?? 'ink']} ${active === b.key ? 'opacity-80' : ''}`}
                style={{ height: b.value > 0 ? pct(b.value) : 0, minHeight: b.value > 0 ? 2 : 0 }}
              />
              {active === b.key && (
                <div
                  role="tooltip"
                  className={`pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-48 rounded-lg bg-strong px-2.5 py-1.5 text-center text-xs font-medium text-strong-ink shadow-lg ${
                    // Keep it inside the card at either end.
                    i < bars.length / 4 ? 'left-0' : i >= (bars.length * 3) / 4 ? 'right-0' : ''
                  }`}
                >
                  {b.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden className={`mt-2 flex ${dense ? 'gap-px' : 'gap-0.5'}`}>
        {bars.map((b, i) => (
          <span key={b.key} className={`min-w-0 flex-1 text-center text-xs text-muted sm:text-sm ${dense ? 'flex justify-center overflow-visible whitespace-nowrap' : 'truncate'}`}>
            {/* 30 columns: a label every week, counting back from the last, spilling over the empty ones beside it. */}
            {!dense || (bars.length - 1 - i) % 7 === 0 ? b.label : ''}
          </span>
        ))}
      </div>
      {note}
      <details className="mt-3 text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-accent-text">Show the numbers</summary>
        <table id={tableId} className="mt-1 w-full text-left">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-medium">{tableHeadings[0]}</th>
              <th className="py-1 text-right font-medium">{tableHeadings[1]}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {bars.map((b) => (
              <tr key={b.key} className="border-t border-line">
                <td className="py-1">{b.detail.split(':')[0]}</td>
                <td className="py-1 text-right">{b.detail.split(': ').slice(1).join(': ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
