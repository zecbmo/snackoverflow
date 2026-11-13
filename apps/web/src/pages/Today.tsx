/**
 * Today: tonight's meal, the week's dinners, food to use soon (with the same row actions as
 * Stock), and a side column of figures: calories, waste, running low, the shopping list.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, formatPence, type PlanEntryDto, type StockItemDto } from '@snackoverflow/shared';
import { dayName } from '../components/AddToPlanSheet';
import { type Column, DataTable, StatusDot } from '../components/DataTable';
import { BellButton, MenuButton, useMe } from '../components/Layout';
import { StockRowActions } from '../components/StockRowActions';
import { useToast } from '../components/Toast';
import { PageTop } from '../components/Toolbar';
import { Button, Card, EmptyState, Pill, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { amountLabel, dateLabel, greeting, longToday, minutesLabel, stateLabel, toneClasses, toneFor, toneMeaning } from '../lib/format';
import { useCalories, usePlan, useProducts, useRecipes, useRunningLow, useShopping, useStock, useWasteReport } from '../lib/queries';
import { changeLine, weightLabel } from './Dashboard';
import { itemTitle } from './Shopping';

function SectionHead({ id, title, link }: { id: string; title: string; link?: { to: string; label: string } }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-lg font-bold lg:text-base">
        {title}
      </h2>
      {link && (
        <Link to={link.to} className="text-sm font-semibold text-accent-text hover:underline">
          {link.label}
        </Link>
      )}
    </div>
  );
}

/** A figure in the side column: label, big number, a line under it, a link. */
function Tile({ label, value, unit, children, className = '' }: { label: string; value: ReactNode; unit?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Card className={`p-4 ${className}`}>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">
        {value} {unit && <span className="text-sm font-normal text-muted">{unit}</span>}
      </p>
      {children}
    </Card>
  );
}

export function TodayPage() {
  const me = useMe();
  const stock = useStock();
  const navigate = useNavigate();
  const waste = useWasteReport('month').data;
  const thisMonth = waste?.periods.at(-1);
  const calories = useCalories('me').data;
  const target = me.user.kcalTarget;
  const avg7 = calories?.avg7 ?? null;
  const unnamed = useProducts('', true).data ?? [];
  const soonLimit = addDays(me.today, 3);
  const soon = (stock.data ?? []).filter((i) => i.state !== 'frozen' && i.bestBefore !== null && i.bestBefore <= soonLimit);
  const shown = soon.slice(0, 8);
  const wasteChange = waste ? changeLine(waste.changePercent, waste.periods, 'month') : null;

  const day = usePlan(me.today, me.today, 'me').data?.days[0];
  const eatenKcal = (day?.entries ?? []).filter((e) => e.status === 'cooked').reduce((n, e) => n + (e.kcal ?? 0), 0);
  const plannedKcal = (day?.entries ?? []).filter((e) => e.status !== 'skipped').reduce((n, e) => n + (e.kcal ?? 0), 0);
  const tonight =
    (day?.entries ?? []).find((e) => e.kind === 'recipe' && e.status === 'planned' && e.slot === 'dinner') ?? (day?.entries ?? []).find((e) => e.kind === 'recipe' && e.status === 'planned');
  const low = (useRunningLow().data ?? []).filter((l) => !l.onList);
  const qc = useQueryClient();
  const toast = useToast();
  const open = (item: StockItemDto) => navigate(`/stock?open=${item.id}`);

  const columns: Column<StockItemDto>[] = [
    {
      key: 'status',
      header: <span className="sr-only">Freshness</span>,
      className: 'w-6 pr-0',
      cell: (i) => <StatusDot className={toneClasses[toneFor(i, me.today)].dot} meaning={toneMeaning[toneFor(i, me.today)]} />,
    },
    { key: 'name', header: 'Item', primary: true, cell: (i) => i.productName },
    { key: 'where', header: 'Where', className: 'whitespace-nowrap', cell: (i) => `${i.locationName}${i.state !== 'closed' ? ` · ${stateLabel[i.state].toLowerCase()}` : ''}` },
    { key: 'left', header: 'Left', className: 'whitespace-nowrap', cell: (i) => amountLabel(i) },
    { key: 'date', header: 'Best before', className: 'whitespace-nowrap', cell: (i) => <Pill className={toneClasses[toneFor(i, me.today)].pill}>{dateLabel(i.bestBefore, me.today)}</Pill> },
  ];

  return (
    <>
      <PageTop title={greeting()} subtitle={longToday(me.today)} left={<MenuButton />} actions={<BellButton />} />
      {tonight && <TonightCard entry={tonight} />}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <WeekDinners />
          <section aria-labelledby="use-soon" className="mb-6">
            <SectionHead id="use-soon" title="Use soon" link={soon.length > 0 ? { to: '/stock', label: 'All stock' } : undefined} />
            {stock.isPending ? (
              <Spinner />
            ) : (
              <DataTable
                label="Use soon"
                columns={columns}
                rows={shown}
                rowKey={(i) => i.id}
                onOpen={open}
                openLabel={(i) => `${i.productName}, details`}
                actions={(i) => <StockRowActions item={i} name={i.productName} onDetails={() => open(i)} />}
                phone={(i) => ({
                  lead: <span aria-hidden className={`h-10 w-1 shrink-0 rounded-full ${toneClasses[toneFor(i, me.today)].bar}`} />,
                  title: i.productName,
                  meta: `${i.locationName}${i.state === 'opened' ? ' · opened' : ''} · ${amountLabel(i)}`,
                  badge: <Pill className={toneClasses[toneFor(i, me.today)].pill}>{dateLabel(i.bestBefore, me.today)}</Pill>,
                  trailing: <StockRowActions item={i} name={i.productName} onDetails={() => open(i)} compact />,
                })}
                empty={
                  <EmptyState title="Nothing going off in the next 3 days">
                    <p>Nice. Scan your shopping in to keep it that way.</p>
                  </EmptyState>
                }
              />
            )}
            {soon.length > shown.length && (
              <Link to="/stock" className="mt-2 inline-flex min-h-10 items-center text-sm font-semibold text-accent-text hover:underline">
                {soon.length - shown.length} more going off soon
              </Link>
            )}
          </section>
        </div>

        <aside className="mb-6 grid grid-cols-2 gap-3 lg:flex lg:flex-col" aria-label="At a glance">
          <Tile label={target ? 'Calories today' : 'Eaten today'} value={eatenKcal.toLocaleString('en-GB')} unit={target ? `of ${target.toLocaleString('en-GB')} kcal` : 'kcal'}>
            {(target ?? plannedKcal) > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card-muted" role="img" aria-label={`${eatenKcal} of ${target ?? plannedKcal} ${target ? 'target' : 'planned'} calories`}>
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (eatenKcal / (target ?? plannedKcal)) * 100)}%` }} />
              </div>
            )}
            <p className="mt-2 text-sm text-muted">
              {avg7 !== null && <span className="hidden sm:inline">7-day average {avg7.toLocaleString('en-GB')} · </span>}
              <Link to="/dashboard" className="font-semibold text-accent-text hover:underline">
                Dashboard
              </Link>
            </p>
          </Tile>
          <Tile
            label="Binned this month"
            value={thisMonth ? weightLabel(thisMonth.grams).replace(/ (kg|g)$/, '') : '–'}
            unit={
              <>
                {thisMonth && thisMonth.grams >= 100 ? 'kg' : 'g'}
                {thisMonth?.pence ? ` · ${formatPence(thisMonth.pence)}` : ''}
              </>
            }
          >
            {wasteChange && <p className={`mt-1 text-sm font-semibold ${waste!.changePercent! <= 0 ? 'text-fresh-green-text' : 'text-muted'}`}>{wasteChange}</p>}
            <Link to="/waste" className="mt-1 inline-block text-sm font-semibold text-accent-text hover:underline">
              Waste report
            </Link>
          </Tile>

          {low.length > 0 && (
            <Card className="col-span-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold">Running low</p>
                <Button
                  size="xs"
                  variant="dark"
                  onClick={async () => {
                    for (const l of low) await api.post('/api/shopping', { ingredientId: l.ingredientId, reason: 'running-low' }).catch(() => {});
                    await qc.invalidateQueries({ queryKey: ['shopping'] });
                    toast.show('Added to the shopping list.');
                  }}
                >
                  Add all to list
                </Button>
              </div>
              <p className="mt-1 text-sm text-muted">{low.map((l) => (l.daysLeft ? `${l.name} (about ${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'})` : l.name)).join(' · ')}</p>
            </Card>
          )}

          {unnamed.length > 0 && (
            <Card className="col-span-2 flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{unnamed.length === 1 ? '1 product needs a name' : `${unnamed.length} products need a name`}</p>
                <p className="text-sm text-muted">Name it once and everyone's phone will know it.</p>
              </div>
              <Link to="/products?unnamed=1" className="inline-flex min-h-10 shrink-0 items-center rounded-lg bg-strong px-3 text-sm font-semibold text-strong-ink lg:min-h-7 lg:rounded-md">
                Name them
              </Link>
            </Card>
          )}
          <ShoppingSummary />
        </aside>
      </div>
    </>
  );
}

/** This week's dinners, today first: what's planned, or a way to add one. */
function WeekDinners() {
  const me = useMe();
  const to = addDays(me.today, 6);
  const plan = usePlan(me.today, to, 'me').data;
  if (!plan) return null;
  return (
    <section aria-labelledby="week-dinners" className="mb-6">
      <SectionHead id="week-dinners" title="This week's dinners" link={{ to: '/calendar', label: 'Open calendar' }} />
      <ul className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-7 lg:px-0">
        {plan.days.map((d) => {
          const dinner = d.entries.find((e) => e.slot === 'dinner' && e.status !== 'skipped');
          const day = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
          const isToday = d.date === me.today;
          return (
            <li key={d.date} className="w-28 shrink-0 lg:w-auto">
              <Link
                to={dinner ? `/calendar?date=${d.date}` : `/calendar?date=${d.date}&add=dinner`}
                aria-label={`${dayName(d.date, me.today)}: ${dinner ? dinner.title : 'nothing planned, add a dinner'}`}
                className={`flex h-full min-h-20 flex-col gap-0.5 rounded-lg border bg-card p-2.5 hover:bg-card-muted ${isToday ? 'border-accent ring-1 ring-accent' : 'border-line'}`}
              >
                <span className={`text-xs font-semibold ${isToday ? 'text-accent-text' : 'text-muted'}`}>{isToday ? 'Today' : day}</span>
                {dinner ? (
                  <>
                    <span className="line-clamp-2 break-words text-sm font-semibold leading-snug">{dinner.title}</span>
                    <span className="text-xs text-muted">{dinner.status === 'cooked' ? 'Eaten' : (dinner.detail ?? '')}</span>
                  </>
                ) : (
                  <span className="text-sm font-medium text-muted">+ Add</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The shopping list at a glance: how many things, roughly what it'll cost, and the first few. */
function ShoppingSummary() {
  const me = useMe();
  const items = (useShopping().data ?? []).filter((i) => !i.checked);
  if (!items.length) return null;
  const pricing = me.household.settings.pricingEnabled;
  const priced = items.filter((i) => i.pricePence !== null);
  const total = priced.reduce((s, i) => s + i.pricePence!, 0);
  return (
    <Card className="col-span-2 hidden p-4 lg:block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Shopping list</h2>
        <span className="text-sm text-muted">
          {items.length} {items.length === 1 ? 'thing' : 'things'}
          {pricing && priced.length ? ` · about ${formatPence(total)}` : ''}
        </span>
      </div>
      <ul className="text-sm">
        {items.slice(0, 5).map((i) => (
          <li key={i.id} className="flex justify-between gap-3 border-b border-line py-2 last:border-b-0">
            <span className="min-w-0 truncate">{itemTitle(i)}</span>
            {pricing && i.pricePence !== null && <span className="tabular-nums text-muted">{formatPence(i.pricePence)}</span>}
          </li>
        ))}
      </ul>
      <Link to="/shop" className="mt-1 inline-flex min-h-8 items-center text-sm font-semibold text-accent-text hover:underline">
        Open list
      </Link>
    </Card>
  );
}

/** Tonight's meal: "Tonight · Chicken curry" with Cooked it / Skip; the rest of the card opens that day in the calendar. */
function TonightCard({ entry }: { entry: PlanEntryDto }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const recipe = useRecipes().data?.find((r) => r.id === entry.recipeId);
  const label = entry.slot === 'dinner' ? 'Tonight' : entry.slot === 'lunch' ? 'Lunch' : entry.slot === 'breakfast' ? 'Breakfast' : 'Today';
  const skip = async () => {
    await api.patch(`/api/plan/${entry.id}`, { status: 'skipped' });
    await qc.invalidateQueries({ queryKey: ['plan'] });
    toast.show('Skipped.', {
      action: {
        label: 'Undo',
        onClick: async () => void (await api.patch(`/api/plan/${entry.id}`, { status: 'planned' }), await qc.invalidateQueries({ queryKey: ['plan'] })),
      },
    });
  };
  const meta = [entry.people.length ? entry.people.map((p) => p.name).join(' + ') : null, `serves ${entry.servings}`, minutesLabel(recipe?.totalMinutes ?? null), entry.kcalPerServing ? `${entry.kcalPerServing} kcal each` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <section
      aria-label="Today's meal"
      className="relative mb-5 flex flex-col gap-3 rounded-xl border border-line bg-card p-4 hover:bg-card-muted/50 lg:flex-row lg:items-center lg:rounded-lg lg:py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-accent-text">{label}</p>
        <h2 className="truncate text-lg font-bold">
          {/* The whole card opens that day in the calendar, like the week's dinners below. */}
          <Link to={`/calendar?date=${entry.date}`} className="after:absolute after:inset-0 after:rounded-xl after:content-[''] lg:after:rounded-lg">
            {entry.title}
          </Link>
        </h2>
        <p className="text-sm text-muted">{meta}</p>
      </div>
      <div className="relative z-10 flex gap-2">
        <Button variant="primary" className="flex-1 lg:flex-none" onClick={() => navigate(`/recipes/${entry.recipeId}/cook?servings=${entry.servings}&entry=${entry.id}`)}>
          Cooked it
        </Button>
        <Button onClick={() => void skip()}>Skip</Button>
      </div>
    </section>
  );
}
