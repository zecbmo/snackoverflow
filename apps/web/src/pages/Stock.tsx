import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { StockItemDto } from '@snackoverflow/shared';
import { MenuButton, useMe } from '../components/Layout';
import { useStockActions } from '../components/StockActions';
import { Button, EmptyState, ErrorNote, PageHeader, Pill, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { dateLabel, toneClasses, toneFor } from '../lib/format';
import { useEarmarks, useLocations, useStock } from '../lib/queries';
import { gramsLabel } from '../lib/format';
import { groupStock, groupSummary, type StockGroup } from '../lib/stockGroups';

type Filter = { kind: 'all' } | { kind: 'location'; id: string } | { kind: 'opened' } | { kind: 'frozen' };

export function StockActionsRow({ item, onDone }: { item: StockItemDto; onDone?: () => void }) {
  const actions = useStockActions();
  const frozen = item.state === 'frozen';
  const after = (fn: () => void) => () => {
    fn();
    onDone?.();
  };
  return (
    <div className="grid grid-cols-4 gap-2">
      <Button variant="dark" onClick={after(() => actions.use(item))}>
        Use
      </Button>
      {frozen ? (
        <Button variant="outline" onClick={after(() => void actions.defrost(item))}>
          Defrost
        </Button>
      ) : (
        <Button variant="outline" disabled={item.actions.freeze !== null} title={item.actions.freeze ?? undefined} onClick={after(() => void actions.freeze(item))}>
          Freeze
        </Button>
      )}
      <Button variant="outline" onClick={after(() => actions.move(item))}>
        Move
      </Button>
      <Button variant="danger" onClick={after(() => void actions.discard(item))}>
        Binned
      </Button>
    </div>
  );
}

function StockRow({ group, today, expanded, onToggle, plannedGrams }: { group: StockGroup; today: string; expanded: boolean; onToggle: () => void; plannedGrams?: number }) {
  const tone = toneFor(group.first, today);
  const t = toneClasses[tone];
  return (
    <li className={`border-b border-line last:border-b-0 ${expanded ? 'bg-accent-soft/60' : ''}`}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span aria-hidden className={`h-11 w-1.5 shrink-0 rounded-full ${t.bar}`} />
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[1.0625rem] font-semibold">{group.name}</span>
          <span className="block truncate text-[0.9375rem] text-muted">
            {groupSummary(group)}
            {plannedGrams ? ` · ${gramsLabel(plannedGrams)} planned` : ''}
          </span>
        </button>
        <Pill className={t.pill}>{group.first.state === 'frozen' && !group.first.bestBefore ? 'Frozen' : dateLabel(group.first.bestBefore, today)}</Pill>
      </div>
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4">
          <StockActionsRow item={group.first} />
          <Link to={`/stock/${group.first.id}`} className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-accent-text">
            {group.packs.length > 1 ? `See all ${group.packs.length} packs` : 'Details and history'}
            <Icon name="chevronRight" className="size-4" />
          </Link>
        </div>
      )}
    </li>
  );
}

export function StockPage() {
  const me = useMe();
  const stock = useStock();
  const locations = useLocations().data ?? [];
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const planned = new Map((useEarmarks().data ?? []).map((m) => [m.ingredientId, m.grams]));

  const groups = useMemo(() => {
    const items = (stock.data ?? []).filter((i) => {
      if (filter.kind === 'location' && i.locationId !== filter.id) return false;
      if (filter.kind === 'opened' && i.state !== 'opened') return false;
      if (filter.kind === 'frozen' && i.state !== 'frozen') return false;
      if (q && !`${i.productName} ${i.brand ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    return groupStock(items);
  }, [stock.data, filter, q]);

  const chips: { label: string; f: Filter }[] = [
    { label: 'All', f: { kind: 'all' } },
    ...locations.map((l) => ({ label: l.name, f: { kind: 'location', id: l.id } as Filter })),
    { label: 'Opened', f: { kind: 'opened' } },
  ];
  const same = (a: Filter, b: Filter) => a.kind === b.kind && (a.kind !== 'location' || (b.kind === 'location' && a.id === b.id));

  return (
    <>
      <PageHeader title="Stock" left={<MenuButton />} right={<span className="text-muted">{stock.data?.length ?? 0} items</span>} />
      <label className="mb-4 flex min-h-13 items-center gap-3 rounded-2xl border border-line bg-card px-4">
        <Icon name="search" className="size-5 text-muted" />
        <span className="sr-only">Search stock</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stock" className="min-h-12 flex-1 bg-transparent text-[1.0625rem] outline-none placeholder:text-muted" />
      </label>
      <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4" role="group" aria-label="Filter">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            aria-pressed={same(c.f, filter)}
            onClick={() => setFilter(c.f)}
            className={`min-h-11 shrink-0 rounded-full border px-5 text-[0.9375rem] font-semibold ${same(c.f, filter) ? 'border-strong bg-strong text-strong-ink' : 'border-line bg-card'}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[0.9375rem] text-muted">
        <span>Sorted by best-before</span>
        <span className="flex gap-3">
          {(['red', 'amber', 'green'] as const).map((tone) => (
            <span key={tone} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`size-2.5 rounded-full ${toneClasses[tone].dot}`} />
              {tone === 'red' ? 'Go off' : tone === 'amber' ? 'This week' : 'Fine'}
            </span>
          ))}
        </span>
      </div>
      <ErrorNote error={stock.error} />
      {stock.isPending ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <EmptyState title={q || filter.kind !== 'all' ? 'Nothing matches' : 'Nothing in stock yet'}>
          {!q && filter.kind === 'all' && (
            <p>
              Tap <strong>Scan</strong> and scan your shopping in, one beep per pack.
            </p>
          )}
        </EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-[18px] border border-line bg-card">
          {groups.map((g) => (
            <StockRow
              key={g.key}
              group={g}
              today={me.today}
              expanded={expanded === g.key}
              onToggle={() => setExpanded(expanded === g.key ? null : g.key)}
              plannedGrams={g.first.ingredientId ? planned.get(g.first.ingredientId) : undefined}
            />
          ))}
        </ul>
      )}
    </>
  );
}
