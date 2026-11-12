/** Calories per day with 7- and 30-day averages, what was binned this month, and spending from receipts. */
import { useState } from 'react';
import { Link } from 'react-router';
import { addDays, type CalendarDate, type CalorieStatsDto, formatPence, type WasteReportDto } from '@snackoverflow/shared';
import { type Bar, BarChart } from '../components/BarChart';
import { BackButton, useMe } from '../components/Layout';
import { Card, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { useCalories, useSpending, useUsers, useWasteReport } from '../lib/queries';

/** 800 → "0.8 kg", 60 → "60 g". */
export function weightLabel(grams: number): string {
  return grams >= 100 ? `${(grams / 1000).toFixed(1)} kg` : `${Math.round(grams)} g`;
}

/** 2400 → "2.4k". */
const shortKcal = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(1)}k` : String(k));
const n = (x: number) => x.toLocaleString('en-GB');

function dayLabel(d: CalendarDate, today: CalendarDate, style: 'short' | 'long'): string {
  if (d === today) return 'Today';
  const date = new Date(`${d}T12:00:00Z`);
  return style === 'short'
    ? date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
    : date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "Down 40% on October", from the change against the same point last month. */
export function changeLine(change: number | null, periods: { start: CalendarDate }[], period: 'week' | 'month'): string | null {
  if (change === null) return null;
  const prev = periods.at(-2)?.start;
  const against = period === 'week' ? 'last week' : prev ? new Date(`${prev}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }) : 'last month';
  if (change === 0) return `Same as ${against}`;
  return `${change < 0 ? 'Down' : 'Up'} ${Math.abs(change)}% on ${against}`;
}

export function DashboardPage() {
  const me = useMe();
  const users = useUsers().data ?? [];
  const isAdmin = me.user.role === 'admin';
  const [person, setPerson] = useState('me');
  const people = [
    { id: 'me', label: 'You' },
    ...(isAdmin ? users.filter((u) => u.id !== me.user.id).map((u) => ({ id: u.id, label: u.name })) : []),
    ...(users.length > 1 ? [{ id: 'household', label: 'Household' }] : []),
  ];
  return (
    <>
      <PageHeader title="Dashboard" left={<BackButton to="/" />} />
      {people.length > 1 && (
        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4" role="group" aria-label="Whose calories">
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={person === p.id}
              onClick={() => setPerson(p.id)}
              className={`min-h-12 shrink-0 rounded-full border px-5 text-[1.0625rem] font-semibold ${person === p.id ? 'border-strong bg-strong text-strong-ink' : 'border-line bg-card'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <CaloriesCard person={person} />
        <div className="flex flex-col gap-4">
          <WasteCard />
          <SpendingCard />
        </div>
      </div>
    </>
  );
}

function CaloriesCard({ person }: { person: string }) {
  const me = useMe();
  const q = useCalories(person);
  const [range, setRange] = useState<7 | 30>(7);
  const s = q.data;
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-2xl font-bold">Calories, last {range} days</h2>
        {s?.target ? (
          <span className="pt-1 text-muted">Target {n(s.target)}</span>
        ) : (
          s?.personId &&
          (s.personId === me.user.id ? (
            <Link to="/profile" className="pt-1 font-semibold text-accent-text">
              Set a target
            </Link>
          ) : (
            <Link to="/people" className="pt-1 font-semibold text-accent-text">
              Set a target
            </Link>
          ))
        )}
      </div>
      <ErrorNote error={q.error} />
      {!s ? (
        <Spinner />
      ) : (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-muted">7-day average</dt>
              <dd className="font-display text-4xl font-bold">{s.avg7 !== null ? n(s.avg7) : '–'}</dd>
            </div>
            <div>
              <dt className="text-muted">30-day average</dt>
              <dd className="font-display text-4xl font-bold">{s.avg30 !== null ? n(s.avg30) : '–'}</dd>
            </div>
          </dl>
          <div className="mb-4 flex justify-end">
            <div className="flex shrink-0 rounded-xl bg-card-muted p-1" role="group" aria-label="How many days">
              {([7, 30] as const).map((r) => (
                <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={`min-h-11 rounded-lg px-3 font-semibold ${range === r ? 'bg-card shadow-sm' : ''}`}>
                  {r} days
                </button>
              ))}
            </div>
          </div>
          <BarChart
            label={`Calories per day for ${s.personId === me.user.id ? 'you' : s.name}, last ${range} days`}
            bars={caloriesBars(s, range)}
            reference={s.target ? { value: s.target, label: 'Target' } : null}
            showValues={range === 7}
            tableHeadings={['Day', 'Calories']}
            note={
              <p className="mt-3 text-[0.9375rem] text-muted">
                {s.target ? 'Purple days went over target. ' : ''}Today is still being logged. Only meals marked eaten count.
              </p>
            }
          />
        </>
      )}
    </Card>
  );
}

function caloriesBars(s: CalorieStatsDto, range: 7 | 30): Bar[] {
  const from = addDays(s.today, -(range - 1));
  return s.days
    .filter((d) => d.date >= from)
    .map((d) => {
      const isToday = d.date === s.today;
      const over = !isToday && s.target !== null && d.kcal > s.target;
      return {
        key: d.date,
        label: range === 7 ? dayLabel(d.date, s.today, 'short') : d.date === s.today ? 'Today' : new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
        value: d.kcal,
        short: shortKcal(d.kcal),
        tone: isToday ? 'pending' : over ? 'accent' : 'ink',
        detail: `${dayLabel(d.date, s.today, 'long')}: ${d.kcal ? `${n(d.kcal)} kcal` : 'nothing logged'}${isToday && d.kcal ? ' so far' : ''}${over ? ', over target' : ''}`,
      };
    });
}

function WasteCard() {
  const q = useWasteReport('month');
  const r = q.data;
  const now = r?.periods.at(-1);
  const change = r ? changeLine(r.changePercent, r.periods, 'month') : null;
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold">Binned this month</h2>
        {change && <span className={`font-semibold ${r!.changePercent! <= 0 ? 'text-fresh-green-text' : 'text-muted'}`}>{change}</span>}
      </div>
      <ErrorNote error={q.error} />
      {!r || !now ? (
        <Spinner />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-muted">Weight</dt>
              <dd className="font-display text-4xl font-bold">{weightLabel(now.grams)}</dd>
            </div>
            {r.pricing && (
              <div>
                <dt className="text-muted">Value</dt>
                <dd className="font-display text-4xl font-bold">{now.pence !== null ? formatPence(now.pence) : '–'}</dd>
              </div>
            )}
          </dl>
          <WasteItems report={r} limit={4} />
          <Link to="/waste" className="mt-3 inline-flex min-h-11 items-center font-semibold text-accent-text">
            Waste report
          </Link>
        </>
      )}
    </Card>
  );
}

export function WasteItems({ report, limit }: { report: WasteReportDto; limit?: number }) {
  const items = limit ? report.byItem.slice(0, limit) : report.byItem;
  if (!items.length) return <p className="mt-3 text-muted">Nothing binned{report.period === 'week' ? ' this week' : ' this month'}. Lovely.</p>;
  return (
    <ul className="mt-3">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-3 border-t border-line py-3">
          <div className="flex-1">
            <p className="font-semibold">{i.name}</p>
            <p className="text-[0.9375rem] text-muted">
              {i.items === 1 ? 'Binned once' : `Binned ${i.items} times`}
              {report.pricing && i.pence !== null ? ` · ${formatPence(i.pence)}` : ''}
            </p>
          </div>
          <span className="font-semibold tabular-nums">{weightLabel(i.grams)}</span>
        </li>
      ))}
    </ul>
  );
}

function SpendingCard() {
  const q = useSpending('month');
  const s = q.data;
  if (!s) return null;
  const now = s.periods.at(-1)!;
  const change = changeLine(s.changePercent, s.periods, 'month');
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold">Spent this month</h2>
        {change && <span className="font-semibold text-muted">{change}</span>}
      </div>
      <p className="font-display text-4xl font-bold">{formatPence(now.pence)}</p>
      <p className="mb-4 text-muted">
        From {now.receipts === 1 ? '1 receipt' : `${now.receipts} receipts`}. Shops without a receipt aren't counted.
      </p>
      <BarChart
        label="Spending from receipts, last 6 months"
        height={110}
        tableHeadings={['Month', 'Spent']}
        bars={s.periods.map((p, i) => ({
          key: p.start,
          label: p.label,
          value: p.pence,
          tone: i === s.periods.length - 1 ? 'pending' : 'ink',
          detail: `${p.label}${i === s.periods.length - 1 ? ' (so far)' : ''}: ${formatPence(p.pence)}`,
        }))}
      />
    </Card>
  );
}
