/**
 * Everything in the house, one row per product and location, with the actions on every row.
 * Filter, sort and group from the toolbar; tick rows to bin, freeze or move several at once;
 * click a row for its details in a side panel.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, type StockChangeDto, type StockItemDto } from '@snackoverflow/shared';
import { type Column, DataTable } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { Menu, PickerMenu } from '../components/Menu';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { StockItemDetail } from '../components/StockItemDetail';
import { StockRowActions } from '../components/StockRowActions';
import { useToast } from '../components/Toast';
import { PageTop, SearchBox, Toolbar } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Pill, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { dateLabel, gramsLabel, stateLabel, type Tone, toneClasses, toneFor } from '../lib/format';
import { useEarmarks, useLocations, useStock, useStockItem } from '../lib/queries';
import { groupStock, groupSummary, type StockGroup } from '../lib/stockGroups';
import { groupRows, matchesSearch, sortRows } from '../lib/table';

/** Kept for pages not yet on the table (Batch cooks & leftovers). */
export function StockActionsRow({ item }: { item: StockItemDto }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StockRowActions item={item} name={item.productName} size="sm" />
    </div>
  );
}

type FilterId = string; // 'all' | 'opened' | 'frozen' | 'soon' | `loc:${id}`
type SortId = 'best-before' | 'name' | 'location' | 'added';
type GroupId = 'none' | 'location' | 'status';

const STATUS: Record<Tone, string> = { red: 'Use first', amber: 'This week', green: 'Fine', blue: 'Frozen', grey: 'No date' };
const STATUS_ORDER = [STATUS.red, STATUS.amber, STATUS.green, STATUS.blue, STATUS.grey];

/** "2 packs · 3.4L" without the location (which has its own column). */
function amountOnly(g: StockGroup): string {
  return groupSummary(g)
    .split(' · ')
    .slice(1)
    .filter((p) => p !== 'opened' && p !== 'defrosted')
    .join(' · ');
}

export function StockPage() {
  const me = useMe();
  const stock = useStock();
  const locationsQuery = useLocations().data;
  const locations = useMemo(() => locationsQuery ?? [], [locationsQuery]);
  const planned = new Map((useEarmarks().data ?? []).map((m) => [m.ingredientId, m.grams]));
  const [filter, setFilter] = useState<FilterId>('all');
  const [sort, setSort] = useState<SortId>('best-before');
  const [group, setGroup] = useState<GroupId>('none');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, openPanel, closePanel] = usePanelParam();
  const navigate = useNavigate();

  const rows = useMemo(() => {
    const soon = addDays(me.today, 3);
    const items = (stock.data ?? []).filter((i) => {
      if (filter.startsWith('loc:') && i.locationId !== filter.slice(4)) return false;
      if (filter === 'opened' && i.state !== 'opened') return false;
      if (filter === 'frozen' && i.state !== 'frozen') return false;
      if (filter === 'soon' && (i.state === 'frozen' || !i.bestBefore || i.bestBefore > soon)) return false;
      return !q || matchesSearch(`${i.productName} ${i.brand ?? ''} ${i.locationName}`, q);
    });
    const groups = groupStock(items);
    if (sort === 'name') return sortRows(groups, (g) => g.name);
    if (sort === 'location') return sortRows(groups, (g) => g.locationName);
    if (sort === 'added') return sortRows(groups, (g) => g.packs.reduce((m, p) => (p.addedAt > m ? p.addedAt : m), ''), 'desc');
    return groups; // The server sends stock in best-before order.
  }, [stock.data, filter, sort, q, me.today]);

  const tables = useMemo(() => {
    if (group === 'location') {
      const order = locations.map((l) => l.name);
      return groupRows(rows, (g) => g.locationName, order).map((x) => ({ key: x.key, label: x.key, rows: x.rows }));
    }
    if (group === 'status') return groupRows(rows, (g) => STATUS[toneFor(g.first, me.today)], STATUS_ORDER).map((x) => ({ key: x.key, label: x.key, rows: x.rows }));
    return undefined;
  }, [rows, group, locations, me.today]);

  const plannedFor = (g: StockGroup) => (g.first.ingredientId ? planned.get(g.first.ingredientId) : undefined);
  const datePill = (g: StockGroup) => (
    <Pill className={toneClasses[toneFor(g.first, me.today)].pill}>
      {g.first.state === 'frozen' && <Icon name="snowflake" className="size-3" strokeWidth={2.2} />}
      {g.first.state === 'frozen' && !g.first.bestBefore ? 'Frozen' : dateLabel(g.first.bestBefore, me.today)}
    </Pill>
  );

  const columns: Column<StockGroup>[] = [
    {
      key: 'status',
      header: <span className="sr-only">Freshness</span>,
      className: 'w-6 pr-0',
      cell: (g) => <span aria-hidden className={`inline-block size-2 rounded-full ${toneClasses[toneFor(g.first, me.today)].dot}`} />,
    },
    { key: 'name', header: 'Item', primary: true, cell: (g) => g.name, className: 'max-w-[18rem]' },
    {
      key: 'where',
      header: 'Where',
      className: 'whitespace-nowrap',
      cell: (g) => (
        <>
          {g.locationName}
          {g.first.state === 'opened' || g.first.state === 'defrosted' ? <span className="text-muted"> · {stateLabel[g.first.state].toLowerCase()}</span> : null}
        </>
      ),
    },
    {
      key: 'left',
      header: 'Left',
      className: 'whitespace-nowrap',
      cell: (g) => (
        <>
          {amountOnly(g) || '–'}
          {plannedFor(g) ? <span className="ml-1.5 text-xs text-accent-text">{gramsLabel(plannedFor(g)!)} planned</span> : null}
        </>
      ),
    },
    { key: 'date', header: 'Best before', className: 'whitespace-nowrap', cell: datePill },
  ];

  const openGroup = (g: StockGroup) => openPanel(g.first.id);
  const activeKey = rows.find((g) => g.packs.some((p) => p.id === openId))?.key ?? null;

  const chosen = rows.filter((g) => selected.has(g.key));
  const filterOptions = [
    { value: 'all', label: 'Everything' },
    { value: 'soon', label: 'Going off in 3 days' },
    { value: 'opened', label: 'Opened' },
    { value: 'frozen', label: 'Frozen' },
    ...locations.map((l) => ({ value: `loc:${l.id}`, label: l.name })),
  ];

  return (
    <>
      <PageTop
        title="Stock"
        subtitle={stock.data ? `${stock.data.length} ${stock.data.length === 1 ? 'pack' : 'packs'}` : undefined}
        left={<MenuButton />}
        actions={
          <Link
            to="/scan"
            className="hidden min-h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink hover:brightness-110 lg:inline-flex"
          >
            <Icon name="scan" className="size-4" /> Scan items
          </Link>
        }
      />
      <Toolbar search={<SearchBox value={q} onChange={setQ} placeholder="Search stock" label="Search stock" />}>
        <PickerMenu label="Filter" icon="filter" value={filter} defaultValue="all" options={filterOptions} onChange={setFilter} />
        <PickerMenu
          label="Sort"
          icon="sort"
          value={sort}
          defaultValue="best-before"
          onChange={setSort}
          options={[
            { value: 'best-before', label: 'Best before' },
            { value: 'name', label: 'Name' },
            { value: 'location', label: 'Location' },
            { value: 'added', label: 'Recently added' },
          ]}
        />
        <PickerMenu
          label="Group"
          icon="group"
          value={group}
          defaultValue="none"
          onChange={setGroup}
          options={[
            { value: 'none', label: 'No grouping' },
            { value: 'location', label: 'Location' },
            { value: 'status', label: 'Freshness' },
          ]}
        />
      </Toolbar>

      {chosen.length > 0 && <BulkBar groups={chosen} onDone={() => setSelected(new Set())} />}

      <ErrorNote error={stock.error} />
      {stock.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Stock"
          columns={columns}
          rows={tables ? undefined : rows}
          groups={tables}
          rowKey={(g) => g.key}
          onOpen={openGroup}
          openLabel={(g) => `${g.name}, ${g.locationName}`}
          activeKey={activeKey}
          selection={{ selected, onChange: setSelected }}
          actions={(g) => <StockRowActions item={g.first} name={g.name} onDetails={() => openGroup(g)} />}
          phone={(g) => ({
            lead: <span aria-hidden className={`h-10 w-1 shrink-0 rounded-full ${toneClasses[toneFor(g.first, me.today)].bar}`} />,
            title: g.name,
            meta: `${groupSummary(g)}${plannedFor(g) ? ` · ${gramsLabel(plannedFor(g)!)} planned` : ''}`,
            badge: datePill(g),
            actions: <StockRowActions item={g.first} name={g.name} onDetails={() => openGroup(g)} compact />,
          })}
          empty={
            <EmptyState title={q || filter !== 'all' ? 'Nothing matches' : 'Nothing in stock yet'}>
              {q || filter !== 'all' ? (
                <button
                  type="button"
                  className="font-semibold text-accent-text"
                  onClick={() => {
                    setQ('');
                    setFilter('all');
                  }}
                >
                  Clear the search and filter
                </button>
              ) : (
                <button type="button" className="font-semibold text-accent-text" onClick={() => navigate('/scan')}>
                  Scan your shopping in
                </button>
              )}
            </EmptyState>
          }
        />
      )}
      <StockPanel id={openId} onClose={closePanel} onOpenPack={openPanel} />
    </>
  );
}

function StockPanel({ id, onClose, onOpenPack }: { id: string | null; onClose: () => void; onOpenPack: (id: string) => void }) {
  const item = useStockItem(id ?? '').data?.item;
  return (
    <SidePanel open={Boolean(id)} onClose={onClose} title={item?.productName ?? 'Loading…'} subtitle={item?.brand ?? undefined}>
      {id && <StockItemDetail id={id} onOpenPack={onOpenPack} />}
    </SidePanel>
  );
}

/** Ticked rows: bin, freeze or move them all at once, with one Undo. */
function BulkBar({ groups, onDone }: { groups: StockGroup[]; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const locations = useLocations().data ?? [];
  const [busy, setBusy] = useState(false);
  const packs = groups.flatMap((g) => g.packs);
  const run = async (verb: string, path: (p: StockItemDto) => string | null, body: object = {}) => {
    setBusy(true);
    const events: string[] = [];
    let skipped = 0;
    try {
      for (const p of packs) {
        const url = path(p);
        if (!url) {
          skipped++;
          continue;
        }
        const c = await api.post<StockChangeDto>(url, body);
        events.push(c.eventId);
      }
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(`${verb} ${events.length} ${events.length === 1 ? 'pack' : 'packs'}.${skipped ? ` ${skipped} couldn't be.` : ''}`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            for (const e of [...events].reverse()) await api.post(`/api/events/${e}/undo`);
            await qc.invalidateQueries({ queryKey: ['stock'] });
          },
        },
      });
      onDone();
    } catch (e) {
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="region" aria-label="Selected rows" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
      <span className="mr-auto font-semibold text-accent-text">
        {groups.length} selected · {packs.length} {packs.length === 1 ? 'pack' : 'packs'}
      </span>
      <Button size="xs" disabled={busy} onClick={() => void run('Froze', (p) => (p.actions.freeze === null ? `/api/stock/${p.id}/freeze` : null))}>
        Freeze
      </Button>
      <Menu
        label="Move selected to"
        align="end"
        triggerClassName="inline-flex min-h-10 items-center rounded-lg border border-line bg-card px-2.5 text-sm font-semibold lg:min-h-7 lg:rounded-md lg:px-2 lg:text-[0.8125rem]"
        trigger={<>Move to…</>}
        items={locations.map((l) => ({ label: l.name, onSelect: () => void run(`Moved to ${l.name}:`, (p) => (p.locationId === l.id ? null : `/api/stock/${p.id}/move`), { locationId: l.id }) }))}
      />
      <Button size="xs" variant="danger" disabled={busy} onClick={() => void run('Binned', (p) => `/api/stock/${p.id}/discard`)}>
        Bin
      </Button>
      <Button size="xs" variant="ghost" onClick={onDone}>
        Clear
      </Button>
    </div>
  );
}
