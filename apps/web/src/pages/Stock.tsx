/**
 * Everything in the house, one row per product and location, with the actions on every row.
 * Filter, sort and group from the toolbar; tick rows to bin, freeze or move several at once;
 * click a row for its details in a side panel.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, amountText, type StockChangeDto, type StockItemDto } from '@snackoverflow/shared';
import { type Column, DataTable, StatusDot } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { Menu, PickerMenu } from '../components/Menu';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { StockItemDetail } from '../components/StockItemDetail';
import { StockRowActions } from '../components/StockRowActions';
import { useToast } from '../components/Toast';
import { PageTop, SearchBox, Segmented, Toolbar } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Pill, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { dateLabel, type Tone, toneClasses, toneFor, toneMeaning } from '../lib/format';
import { useEarmarks, useLocations, useShopping, useStock, useStockItem } from '../lib/queries';
import { groupStock, type StockGroup } from '../lib/stockGroups';
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

/** What's left across the row's packs, in the food's own unit: "3.4L", "about 400g", "2 portions". */
function leftLabel(g: StockGroup): string {
  const p = g.first;
  if (p.isMeal) {
    const portions = g.packs.reduce((n, x) => n + (x.remainingGrams !== null && x.gramsPerCount ? x.remainingGrams / x.gramsPerCount : 1), 0);
    const r = Math.round(portions * 2) / 2;
    return `${r} ${r === 1 ? 'portion' : 'portions'}`;
  }
  if (g.packs.some((x) => x.remainingGrams === null)) return '';
  const total = g.packs.reduce((sum, x) => sum + x.remainingGrams!, 0);
  const partial = g.packs.some((x) => x.fractionLeft < 1);
  return `${partial ? '~' : ''}${amountText(total, p)}`;
}

/** Opened, defrosted or frozen; blank for packs as bought. */
function stateText(g: StockGroup): string {
  if (g.packs.some((x) => x.state === 'opened')) return 'Opened';
  if (g.packs.some((x) => x.state === 'defrosted')) return 'Defrosted';
  if (g.first.state === 'frozen') return 'Frozen';
  return '';
}

/** The state as an icon with its name as a tooltip. */
function StateIcon({ g }: { g: StockGroup }) {
  const text = stateText(g);
  if (!text) return null;
  const icon = text === 'Opened' ? 'opened' : text === 'Defrosted' ? 'drop' : 'snowflake';
  return (
    <span role="img" aria-label={text} title={text} className={`inline-flex ${text === 'Frozen' ? 'text-frozen-text' : 'text-muted'}`}>
      <Icon name={icon} className="size-4" />
    </span>
  );
}

/** Planned meals against what's in the house: enough, short (and whether it's already on the list). */
interface PlanStatus {
  grams: number;
  short: number;
  onList: boolean;
}

export function StockPage() {
  const me = useMe();
  const stock = useStock();
  const locationsQuery = useLocations().data;
  const locations = useMemo(() => locationsQuery ?? [], [locationsQuery]);
  const earmarks = useEarmarks().data;
  const shopping = useShopping().data;
  const [place, setPlace] = useState('all');
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
      if (place !== 'all' && i.locationType !== place) return false;
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
  }, [stock.data, place, filter, sort, q, me.today]);

  const tables = useMemo(() => {
    if (group === 'location') {
      const order = locations.map((l) => l.name);
      return groupRows(rows, (g) => g.locationName, order).map((x) => ({ key: x.key, label: x.key, rows: x.rows }));
    }
    if (group === 'status') return groupRows(rows, (g) => STATUS[toneFor(g.first, me.today)], STATUS_ORDER).map((x) => ({ key: x.key, label: x.key, rows: x.rows }));
    return undefined;
  }, [rows, group, locations, me.today]);

  // Planned grams per ingredient against everything in stock for it (all locations), and what's on the list.
  const planStatus = useMemo(() => {
    const have = new Map<string, number>();
    for (const s of stock.data ?? []) if (s.ingredientId && !s.isMeal) have.set(s.ingredientId, (have.get(s.ingredientId) ?? 0) + (s.remainingGrams ?? 0));
    const listed = new Set((shopping ?? []).filter((i) => !i.checked && i.ingredientId).map((i) => i.ingredientId!));
    return new Map<string, PlanStatus>(
      (earmarks ?? []).map((m) => [m.ingredientId, { grams: m.grams, short: Math.max(0, m.grams - (have.get(m.ingredientId) ?? 0)), onList: listed.has(m.ingredientId) }]),
    );
  }, [earmarks, shopping, stock.data]);
  const plannedFor = (g: StockGroup) => (g.first.ingredientId && !g.first.isMeal ? planStatus.get(g.first.ingredientId) : undefined);
  const plannedCell = (g: StockGroup) => {
    const p = plannedFor(g);
    if (!p) return null;
    const amount = amountText(p.grams, g.first);
    if (p.short <= 0) return <span className="text-ink">{amount}</span>;
    if (p.onList)
      return (
        <span className="inline-flex items-center gap-1 text-accent-text" title="Not enough in stock, but it's on the shopping list">
          {amount} <Icon name="cart" className="size-3.5" /> <span className="text-xs">on list</span>
        </span>
      );
    return (
      <span className="text-danger" title="Not enough in stock for the planned meals">
        {amount} <span className="text-xs">· short {amountText(p.short, g.first)}</span>
      </span>
    );
  };
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
      cell: (g) => <StatusDot className={toneClasses[toneFor(g.first, me.today)].dot} meaning={toneMeaning[toneFor(g.first, me.today)]} />,
    },
    { key: 'name', header: 'Item', primary: true, cell: (g) => g.name, className: 'max-w-[18rem]' },
    { key: 'where', header: 'Where', className: 'whitespace-nowrap', cell: (g) => g.locationName },
    { key: 'state', header: <span title="Opened, frozen or defrosted">State</span>, className: 'w-14', cell: (g) => <StateIcon g={g} /> },
    { key: 'packs', header: 'Packs', align: 'right', className: 'w-16 tabular-nums', cell: (g) => (g.first.isMeal ? '' : g.packs.length) },
    { key: 'left', header: <span title="What's left. ~ means an estimate, for opened packs">Amount</span>, align: 'right', className: 'whitespace-nowrap tabular-nums', cell: (g) => leftLabel(g) || '–' },
    { key: 'planned', header: 'Planned', align: 'right', className: 'whitespace-nowrap tabular-nums', cell: plannedCell },
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
  ];
  const places = [
    { value: 'all', label: 'All' },
    ...(['fridge', 'freezer', 'cupboard'] as const).filter((t) => locations.some((l) => l.type === t)).map((t) => ({ value: t, label: t === 'fridge' ? 'Fridge' : t === 'freezer' ? 'Freezer' : 'Cupboard' })),
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
        <Segmented label="Where" value={place} onChange={setPlace} options={places} />
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line lg:block" />
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
            lead: <span role="img" aria-label={toneMeaning[toneFor(g.first, me.today)]} title={toneMeaning[toneFor(g.first, me.today)]} className={`h-10 w-1 shrink-0 rounded-full ${toneClasses[toneFor(g.first, me.today)].bar}`} />,
            title: g.name,
            meta: (
              <>
                {[g.locationName, stateText(g).toLowerCase(), g.first.isMeal ? '' : `${g.packs.length} ${g.packs.length === 1 ? 'pack' : 'packs'}`, leftLabel(g)].filter(Boolean).join(' · ')}
                {plannedFor(g) && <> · {plannedCell(g)} planned</>}
              </>
            ),
            badge: datePill(g),
            actions: <StockRowActions item={g.first} name={g.name} onDetails={() => openGroup(g)} compact />,
          })}
          empty={
            <EmptyState title={q || filter !== 'all' || place !== 'all' ? 'Nothing matches' : 'Nothing in stock yet'}>
              {q || filter !== 'all' || place !== 'all' ? (
                <button
                  type="button"
                  className="font-semibold text-accent-text"
                  onClick={() => {
                    setQ('');
                    setFilter('all');
                    setPlace('all');
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
