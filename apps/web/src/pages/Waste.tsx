/** What was binned by week or month, by item and by category, with its value when pricing is on. */
import { useState } from 'react';
import { formatPence, type StatsPeriod } from '@snackoverflow/shared';
import { BarChart } from '../components/BarChart';
import { MenuButton } from '../components/Layout';
import { Card, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { useWasteReport } from '../lib/queries';
import { changeLine, WasteItems, weightLabel } from './Dashboard';

export function WastePage() {
  const [period, setPeriod] = useState<StatsPeriod>('month');
  const q = useWasteReport(period);
  const r = q.data;
  const now = r?.periods.at(-1);
  const change = r ? changeLine(r.changePercent, r.periods, period) : null;
  const totalCat = r ? r.byCategory.reduce((s, c) => s + c.grams, 0) : 0;
  const thisLabel = period === 'week' ? 'this week' : 'this month';

  return (
    <>
      <PageHeader title="Waste report" left={<MenuButton />} />
      <div className="mb-4 flex rounded-2xl bg-card-muted p-1 sm:max-w-xs" role="group" aria-label="Group by">
        {(['week', 'month'] as const).map((p) => (
          <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} className={`min-h-11 flex-1 rounded-xl font-semibold ${period === p ? 'bg-card shadow-sm' : ''}`}>
            By {p}
          </button>
        ))}
      </div>
      <ErrorNote error={q.error} />
      {!r || !now ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-2xl font-bold">Binned {thisLabel}</h2>
              {change && <span className={`font-semibold ${r.changePercent! <= 0 ? 'text-fresh-green-text' : 'text-muted'}`}>{change}</span>}
            </div>
            <dl className="mb-5 grid grid-cols-3 gap-3">
              <div>
                <dt className="text-muted">Weight</dt>
                <dd className="font-display text-3xl font-bold">{weightLabel(now.grams)}</dd>
              </div>
              {r.pricing && (
                <div>
                  <dt className="text-muted">Value</dt>
                  <dd className="font-display text-3xl font-bold">{now.pence !== null ? formatPence(now.pence) : '–'}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted">Things</dt>
                <dd className="font-display text-3xl font-bold">{now.items}</dd>
              </div>
            </dl>
            <BarChart
              label={`Food binned per ${period}, last ${r.periods.length} ${period}s`}
              tableHeadings={[period === 'week' ? 'Week starting' : 'Month', 'Binned']}
              bars={r.periods.map((p, i) => {
                const current = i === r.periods.length - 1;
                return {
                  key: p.start,
                  label: p.label,
                  value: p.grams,
                  tone: current ? 'pending' : 'ink',
                  detail: `${period === 'week' ? `Week of ${p.label}` : p.label}${current ? ' (so far)' : ''}: ${weightLabel(p.grams)}${r.pricing && p.pence !== null ? `, ${formatPence(p.pence)}` : ''}, ${p.items} ${p.items === 1 ? 'thing' : 'things'}`,
                };
              })}
            />
          </Card>
          <div className="flex flex-col gap-4">
            <Card className="p-5">
              <h2 className="text-xl font-bold">By item, {thisLabel}</h2>
              <WasteItems report={r} />
            </Card>
            {r.byCategory.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-2 text-xl font-bold">By category, {thisLabel}</h2>
                <ul>
                  {r.byCategory.map((c) => (
                    <li key={c.name} className="border-t border-line py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{c.name}</span>
                        <span className="tabular-nums">
                          {weightLabel(c.grams)}
                          {r.pricing && c.pence !== null ? <span className="text-muted"> · {formatPence(c.pence)}</span> : null}
                        </span>
                      </div>
                      <div className="mt-2 h-2 rounded-full bg-card-muted" role="img" aria-label={`${Math.round((c.grams / Math.max(1, totalCat)) * 100)}% of the total`}>
                        <div className="h-full rounded-full bg-ink" style={{ width: `${(c.grams / Math.max(1, totalCat)) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
