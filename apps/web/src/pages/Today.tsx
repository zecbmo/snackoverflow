import { Link } from 'react-router';
import { addDays, formatQuantity } from '@snackoverflow/shared';
import { BellButton, MenuButton, useMe } from '../components/Layout';
import { useStockActions } from '../components/StockActions';
import { Button, Card, EmptyState, PageHeader, Pill, Spinner } from '../components/ui';
import { amountLabel, dateLabel, greeting, longToday, stateLabel, toneClasses, toneFor } from '../lib/format';
import { useProducts, useStock, useWaste } from '../lib/queries';

export function TodayPage() {
  const me = useMe();
  const stock = useStock();
  const waste = useWaste().data;
  const unnamed = useProducts('', true).data ?? [];
  const actions = useStockActions();
  const soonLimit = addDays(me.today, 3);
  const soon = (stock.data ?? []).filter((i) => i.state !== 'frozen' && i.bestBefore !== null && i.bestBefore <= soonLimit);
  const shown = soon.slice(0, 8);
  const wasteChange =
    waste && waste.lastMonthGrams > 0 ? Math.round(((waste.thisMonthGrams - waste.lastMonthGrams) / waste.lastMonthGrams) * 100) : null;

  return (
    <>
      <PageHeader title={greeting()} subtitle={longToday(me.today)} left={<MenuButton />} right={<BellButton />} />

      <section aria-labelledby="use-soon" className="mb-6">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="use-soon" className="text-2xl font-bold">
            Use soon
          </h2>
          {soon.length > 0 && (
            <Link to="/stock" className="font-semibold text-accent-text">
              See all {soon.length}
            </Link>
          )}
        </div>
        {stock.isPending ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <EmptyState title="Nothing going off in the next 3 days">
            <p>Nice. Scan your shopping in to keep it that way.</p>
          </EmptyState>
        ) : (
          <>
            {/* Phone: horizontal cards. Desktop: a table. */}
            <ul className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 lg:hidden">
              {shown.map((item) => {
                const t = toneClasses[toneFor(item, me.today)];
                const freezeOk = item.actions.freeze === null;
                return (
                  <li key={item.id} className="w-[46%] min-w-40 shrink-0 snap-start">
                    <Card className="flex h-full flex-col gap-2 p-4">
                      <Pill className={`self-start ${t.pill}`}>{dateLabel(item.bestBefore, me.today)}</Pill>
                      <Link to={`/stock/${item.id}`} className="text-lg font-semibold leading-snug">
                        {item.productName}
                      </Link>
                      <p className="text-muted">
                        {item.locationName}
                        {item.state === 'opened' ? ' · opened' : item.remainingGrams !== null ? ` · ${amountLabel(item)}` : ''}
                      </p>
                      <Button className="mt-auto bg-card-muted" variant="outline" onClick={() => (freezeOk && item.state === 'closed' ? void actions.freeze(item) : actions.use(item))}>
                        {freezeOk && item.state === 'closed' ? 'Freeze it' : 'Use'}
                      </Button>
                    </Card>
                  </li>
                );
              })}
            </ul>
            <Card className="hidden overflow-hidden lg:block">
              <table className="w-full text-left">
                <thead className="text-sm text-muted">
                  <tr className="border-b border-line">
                    <th className="px-5 py-3 font-medium">Item</th>
                    <th className="px-3 py-3 font-medium">Where</th>
                    <th className="px-3 py-3 font-medium">Left</th>
                    <th className="px-3 py-3 font-medium">Best before</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr key={item.id} className="border-b border-line last:border-b-0">
                      <td className="px-5 py-3 font-semibold">
                        <Link to={`/stock/${item.id}`}>{item.productName}</Link>
                      </td>
                      <td className="px-3 py-3 text-muted">
                        {item.locationName}
                        {item.state !== 'closed' ? ` · ${stateLabel[item.state]}` : ''}
                      </td>
                      <td className="px-3 py-3 text-muted">{amountLabel(item)}</td>
                      <td className="px-3 py-3">
                        <Pill className={toneClasses[toneFor(item, me.today)].pill}>{dateLabel(item.bestBefore, me.today)}</Pill>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="dark" onClick={() => actions.use(item)}>
                            Use
                          </Button>
                          <Button size="sm" variant="outline" disabled={item.actions.freeze !== null} onClick={() => void actions.freeze(item)}>
                            Freeze
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </section>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Card className="p-5">
          <p className="text-muted">In stock</p>
          <p className="mt-1 font-display text-4xl font-bold">
            {stock.data?.length ?? '–'} <span className="font-sans text-lg font-normal text-muted">packs</span>
          </p>
          <Link to="/stock" className="mt-2 inline-block font-semibold text-accent-text">
            Open stock
          </Link>
        </Card>
        <Card className="p-5">
          <p className="text-muted">Binned this month</p>
          <p className="mt-1 font-display text-4xl font-bold">
            {waste ? formatQuantity(waste.thisMonthGrams).replace(/(kg|g)$/, '') : '–'}{' '}
            <span className="font-sans text-lg font-normal text-muted">{waste && waste.thisMonthGrams >= 1000 ? 'kg' : 'g'}</span>
          </p>
          {wasteChange !== null && (
            <p className="mt-2 text-[15px] font-semibold text-muted">
              {wasteChange <= 0 ? `Down ${-wasteChange}%` : `Up ${wasteChange}%`} on last month
            </p>
          )}
        </Card>
      </div>

      {unnamed.length > 0 && (
        <Card className="mb-6 flex items-center gap-4 p-5">
          <div className="flex-1">
            <p className="text-lg font-semibold">
              {unnamed.length === 1 ? '1 product needs a name' : `${unnamed.length} products need a name`}
            </p>
            <p className="text-muted">Name it once and everyone's phone will know it.</p>
          </div>
          <Link to="/products?unnamed=1" className="inline-flex min-h-11 items-center rounded-xl bg-ink px-4 font-semibold text-bg">
            Name them
          </Link>
        </Card>
      )}
    </>
  );
}
