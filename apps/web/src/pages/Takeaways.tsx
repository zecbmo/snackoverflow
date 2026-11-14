/**
 * Settings → Fast food & takeaways: the chains whose menus the app knows, each chain's menu with
 * its published nutrition, and a search across every menu.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CHAIN_CATEGORIES, type ChainDto, type ChainMenuItemDto, formatShortDate } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { BackButton, MenuButton } from '../components/Layout';
import { type Column, ColumnsMenu, DataTable, useHiddenColumns } from '../components/DataTable';
import { PickerMenu } from '../components/Menu';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { PageTop, SearchBox, Segmented, Toolbar } from '../components/Toolbar';
import { EmptyState, ErrorNote, Spinner } from '../components/ui';
import { kcalRange, macroSummary, NUTRIENTS, type Nutrient, nutrientValue, per100g, servingLabel } from '../lib/chains';
import { useChainMenu, useChainSearch, useChains } from '../lib/queries';
import { groupRows, matchesSearch, sortRows } from '../lib/table';

/** Waits until typing pauses before searching the server. */
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const longDate = (d: string | null) => (d ? `${formatShortDate(d)} ${d.slice(0, 4)}` : '');

/** A calorie figure with a bar showing it against the biggest on the page. */
function KcalBar({ kcal, max }: { kcal: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (kcal / max) * 100)) : 0;
  return (
    <span className="flex items-center justify-end gap-2">
      <span aria-hidden className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-card-muted xl:block">
        <span className="block h-full rounded-full bg-muted/70" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-10 text-right font-semibold tabular-nums text-ink">{nutrientValue(kcal, 'kcal')}</span>
    </span>
  );
}

/** Where a chain's menu sits between the lowest and highest calories across every chain. */
function KcalRangeBar({ chain, max }: { chain: ChainDto; max: number }) {
  if (chain.kcalMin === null || chain.kcalMax === null) return <span className="text-muted">No menu yet</span>;
  const left = max > 0 ? (chain.kcalMin / max) * 100 : 0;
  const width = max > 0 ? Math.max(1.5, ((chain.kcalMax - chain.kcalMin) / max) * 100) : 0;
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="relative hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-card-muted xl:block">
        <span className="absolute inset-y-0 rounded-full bg-muted/70" style={{ left: `${left}%`, width: `${width}%` }} />
      </span>
      <span className="whitespace-nowrap tabular-nums">{kcalRange(chain)}</span>
    </span>
  );
}

function SourceLink({ chain }: { chain: ChainDto }) {
  if (!chain.sourceUrl) return <span className="text-muted">Not found yet</span>;
  return (
    <a href={chain.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">
      {new URL(chain.sourceUrl).hostname.replace(/^www\./, '')}
      <Icon name="external" className="size-3.5" />
      <span className="sr-only">(opens {chain.name}'s nutrition information in a new tab)</span>
    </a>
  );
}

type View = 'chains' | 'items';

export function TakeawaysPage() {
  const chains = useChains();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('chains');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'category' | 'none'>('category');
  const [filter, setFilter] = useState<'all' | 'menus' | 'none'>('all');
  const all = chains.data ?? [];
  const totalItems = all.reduce((n, c) => n + c.itemCount, 0);
  const withMenus = all.filter((c) => c.itemCount > 0).length;

  return (
    <>
      <PageTop
        title="Fast food & takeaways"
        subtitle={chains.data ? `${all.length} chains · ${withMenus} with menus · ${totalItems.toLocaleString('en-GB')} menu items` : undefined}
        left={<MenuButton />}
      />
      <p className="mb-3 max-w-[65ch] text-sm text-muted">
        Calories and nutrition that UK chains publish for their menus, per item as sold. They come with the app and update with it; each chain links to where its figures came from.
      </p>
      <Toolbar
        search={
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder={view === 'chains' ? 'Search chains' : 'Search every menu, e.g. "big mac"'}
            label={view === 'chains' ? 'Search chains' : 'Search every menu'}
          />
        }
      >
        <Segmented
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'chains', label: 'Chains' },
            { value: 'items', label: 'Menu items' },
          ]}
        />
        {view === 'chains' && (
          <>
            <PickerMenu
              label="Filter"
              icon="filter"
              value={filter}
              defaultValue="all"
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All chains' },
                { value: 'menus', label: 'With a menu' },
                { value: 'none', label: 'No menu yet' },
              ]}
            />
            <PickerMenu
              label="Group"
              icon="group"
              value={group}
              defaultValue="category"
              onChange={setGroup}
              options={[
                { value: 'category', label: 'Type of food' },
                { value: 'none', label: 'No grouping' },
              ]}
            />
          </>
        )}
      </Toolbar>
      <ErrorNote error={chains.error} />
      {chains.isPending ? (
        <Spinner />
      ) : view === 'chains' ? (
        <ChainsTable chains={all} q={q} filter={filter} group={group} onOpen={(c) => void navigate(`/takeaways/${c.key}`)} />
      ) : (
        <MenuSearch q={q} />
      )}
    </>
  );
}

function ChainsTable({
  chains,
  q,
  filter,
  group,
  onOpen,
}: {
  chains: ChainDto[];
  q: string;
  filter: 'all' | 'menus' | 'none';
  group: 'category' | 'none';
  onOpen: (c: ChainDto) => void;
}) {
  const max = Math.max(0, ...chains.map((c) => c.kcalMax ?? 0));
  const list = chains
    .filter((c) => filter === 'all' || (filter === 'menus' ? c.itemCount > 0 : c.itemCount === 0))
    .filter((c) => !q.trim() || matchesSearch(`${c.name} ${c.aliases.join(' ')} ${c.category}`, q));
  const columns: Column<ChainDto>[] = [
    { key: 'name', header: 'Chain', primary: true, cell: (c) => c.name },
    ...(group === 'none' ? [{ key: 'category', header: 'Type of food', cell: (c: ChainDto) => c.category }] : []),
    { key: 'items', header: 'Menu items', align: 'right', className: 'tabular-nums', cell: (c) => (c.itemCount ? c.itemCount.toLocaleString('en-GB') : '') },
    { key: 'kcal', header: 'Calories per item', cell: (c) => <KcalRangeBar chain={c} max={max} /> },
    { key: 'source', header: 'Source', cell: (c) => <SourceLink chain={c} /> },
    { key: 'checked', header: 'Checked', className: 'whitespace-nowrap', cell: (c) => longDate(c.retrievedOn) },
    { key: 'notes', header: 'Notes', cell: (c) => c.notes ?? '' },
  ];
  const groups =
    group === 'category'
      ? groupRows(list, (c) => c.category, CHAIN_CATEGORIES).map((g) => ({ key: g.key, label: g.key, rows: g.rows }))
      : undefined;
  return (
    <DataTable
      label="Chains"
      columns={columns}
      rows={groups ? undefined : list}
      groups={groups}
      rowKey={(c) => c.key}
      onOpen={onOpen}
      openLabel={(c) => `${c.name} menu`}
      phone={(c) => ({
        title: c.name,
        meta: c.itemCount ? `${c.itemCount} items · ${kcalRange(c)}` : 'No menu yet',
        badge: <Icon name="chevronRight" className="size-4 text-muted" />,
      })}
      empty={<EmptyState title="No chains found" />}
    />
  );
}

function itemColumns(max: number, opts: { chain: boolean; section: boolean }): Column<ChainMenuItemDto>[] {
  const n = (key: Exclude<Nutrient, 'kcal'>, header: string, label: string): Column<ChainMenuItemDto> => ({
    key,
    header,
    label,
    align: 'right',
    className: 'tabular-nums',
    cell: (i) => nutrientValue(i[key], key),
  });
  return [
    { key: 'name', header: 'Item', primary: true, hideable: false, cell: (i) => i.name },
    ...(opts.chain ? [{ key: 'chain', header: 'Chain', cell: (i: ChainMenuItemDto) => i.chainName }] : []),
    ...(opts.section ? [{ key: 'section', header: 'Section', cell: (i: ChainMenuItemDto) => i.section ?? '' }] : []),
    { key: 'serving', header: 'Serving', className: 'whitespace-nowrap', cell: (i) => servingLabel(i) },
    { key: 'kcal', header: 'kcal', align: 'right', hideable: false, cell: (i) => <KcalBar kcal={i.kcal} max={max} /> },
    n('protein', 'Protein g', 'Protein'),
    n('carbs', 'Carbs g', 'Carbohydrate'),
    n('sugars', 'Sugars g', 'Sugars'),
    n('fat', 'Fat g', 'Fat'),
    n('saturates', 'Sat fat g', 'Saturates'),
    n('fibre', 'Fibre g', 'Fibre'),
    n('salt', 'Salt g', 'Salt'),
  ];
}

const phoneRow = (showChain: boolean) => (i: ChainMenuItemDto) => ({
  title: i.name,
  meta: [showChain ? i.chainName : null, servingLabel(i), macroSummary(i)].filter(Boolean).join(' · '),
  badge: <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{nutrientValue(i.kcal, 'kcal')} kcal</span>,
});

function MenuSearch({ q }: { q: string }) {
  const query = useDebounced(q.trim());
  const results = useChainSearch(query);
  const [openId, openPanel, closePanel] = usePanelParam();
  const [hidden, toggle] = useHiddenColumns('chain-search', ['sugars', 'saturates', 'fibre', 'salt']);
  if (!query) return <EmptyState title="Search every menu">Type a dish or a chain, e.g. "nandos chips" or "latte".</EmptyState>;
  const items = results.data ?? [];
  const max = Math.max(0, ...items.map((i) => i.kcal));
  const columns = itemColumns(max, { chain: true, section: false });
  const open = items.find((i) => i.id === openId) ?? null;
  return (
    <>
      <ErrorNote error={results.error} />
      <div className="mb-2 flex items-center justify-between gap-2 text-sm text-muted">
        <span aria-live="polite">{results.isFetching && !results.data ? 'Searching…' : `${items.length === 200 ? 'First 200' : items.length} ${items.length === 1 ? 'item' : 'items'}`}</span>
        <ColumnsMenu columns={columns} hidden={hidden} onToggle={toggle} />
      </div>
      {results.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Menu items"
          columns={columns}
          hidden={hidden}
          rows={items}
          rowKey={(i) => i.id}
          onOpen={(i) => openPanel(i.id)}
          openLabel={(i) => `${i.name}, ${i.chainName}, nutrition`}
          activeKey={openId}
          phone={phoneRow(true)}
          empty={<EmptyState title="Nothing on the menus matches">Try fewer words, or the chain's name.</EmptyState>}
        />
      )}
      <ItemPanel item={open} onClose={closePanel} showChain />
    </>
  );
}

type SortKey = 'menu' | 'kcal-desc' | 'kcal-asc' | 'protein-desc' | 'name';

export function ChainMenuPage() {
  const { key = '' } = useParams();
  const menu = useChainMenu(key);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'section' | 'none'>('section');
  const [sort, setSort] = useState<SortKey>('menu');
  const [openId, openPanel, closePanel] = usePanelParam();
  const [hidden, toggle] = useHiddenColumns('chain-menu', ['saturates', 'fibre']);
  const chain = menu.data?.chain;
  const items = menu.data?.items ?? [];
  const max = Math.max(0, ...items.map((i) => i.kcal));
  const columns = itemColumns(max, { chain: false, section: group === 'none' });
  const filtered = items.filter((i) => !q.trim() || matchesSearch(`${i.name} ${i.section ?? ''} ${i.serving ?? ''}`, q));
  const sorted =
    sort === 'menu'
      ? filtered
      : sort === 'name'
        ? sortRows(filtered, (i) => i.name)
        : sort === 'protein-desc'
          ? sortRows(filtered, (i) => i.protein, 'desc')
          : sortRows(filtered, (i) => i.kcal, sort === 'kcal-desc' ? 'desc' : 'asc');
  const groups = group === 'section' ? groupRows(sorted, (i) => i.section ?? 'Other').map((g) => ({ key: g.key, label: g.key, rows: g.rows })) : undefined;
  const open = items.find((i) => i.id === openId) ?? null;

  return (
    <>
      <PageTop
        title={chain?.name ?? 'Menu'}
        subtitle={chain ? `${chain.category} · ${chain.itemCount} items` : undefined}
        left={<BackButton to="/takeaways" />}
      />
      <ErrorNote error={menu.error} />
      {chain && (
        <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span className="inline-flex items-center gap-1">
            Source: <SourceLink chain={chain} />
          </span>
          {chain.retrievedOn && <span>Checked {longDate(chain.retrievedOn)}</span>}
          {chain.aliases.length > 0 && <span>Also called {chain.aliases.join(', ')}</span>}
          {chain.notes && <span>{chain.notes}</span>}
        </p>
      )}
      {menu.isPending ? (
        <Spinner />
      ) : chain && items.length === 0 ? (
        <EmptyState title="No menu for this chain yet">We couldn't find nutrition figures {chain.name} publishes. It will appear here when the app's data includes it.</EmptyState>
      ) : (
        <>
          <Toolbar search={<SearchBox value={q} onChange={setQ} placeholder={`Search ${chain?.name ?? 'the'} menu`} label="Search the menu" />}>
            <PickerMenu
              label="Sort"
              icon="sort"
              value={sort}
              defaultValue="menu"
              onChange={setSort}
              options={[
                { value: 'menu', label: 'Menu order' },
                { value: 'kcal-desc', label: 'Most calories' },
                { value: 'kcal-asc', label: 'Fewest calories' },
                { value: 'protein-desc', label: 'Most protein' },
                { value: 'name', label: 'Name' },
              ]}
            />
            <PickerMenu
              label="Group"
              icon="group"
              value={group}
              defaultValue="section"
              onChange={setGroup}
              options={[
                { value: 'section', label: 'Menu section' },
                { value: 'none', label: 'No grouping' },
              ]}
            />
            <ColumnsMenu columns={columns} hidden={hidden} onToggle={toggle} />
          </Toolbar>
          <DataTable
            label={`${chain?.name ?? ''} menu`}
            columns={columns}
            hidden={hidden}
            rows={groups ? undefined : sorted}
            groups={groups}
            rowKey={(i) => i.id}
            onOpen={(i) => openPanel(i.id)}
            openLabel={(i) => `${i.name}, nutrition`}
            activeKey={openId}
            phone={phoneRow(false)}
            empty={<EmptyState title="Nothing on the menu matches" />}
          />
        </>
      )}
      <ItemPanel item={open} onClose={closePanel} />
    </>
  );
}

/** One menu item's full nutrition, per serving and (when the weight is published) per 100g. */
function ItemPanel({ item, onClose, showChain = false }: { item: ChainMenuItemDto | null; onClose: () => void; showChain?: boolean }) {
  return (
    <SidePanel
      open={Boolean(item)}
      onClose={onClose}
      title={item?.name ?? 'Menu item'}
      subtitle={item ? [showChain ? item.chainName : null, item.section, servingLabel(item)].filter(Boolean).join(' · ') : undefined}
    >
      {item && (
        <div className="flex flex-col gap-4">
          <p className="text-4xl font-bold tabular-nums lg:text-3xl">
            {nutrientValue(item.kcal, 'kcal')} <span className="text-lg font-semibold text-muted lg:text-base">kcal</span>
          </p>
          <table className="w-full text-sm">
            <caption className="sr-only">Nutrition for {item.name}</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th scope="col" className="py-1.5 font-medium">
                  Nutrient
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  Per serving
                </th>
                {item.servingG ? (
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Per 100g
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {NUTRIENTS.map((nu) => {
                const v = item[nu.key];
                const unit = nu.unit === 'kcal' ? ' kcal' : 'g';
                return (
                  <tr key={nu.key} className="border-b border-line last:border-b-0">
                    <th scope="row" className={`py-2 text-left font-medium ${nu.key === 'saturates' || nu.key === 'sugars' ? 'pl-4 font-normal text-muted' : ''}`}>
                      {nu.key === 'saturates' ? 'of which saturates' : nu.key === 'sugars' ? 'of which sugars' : nu.label}
                    </th>
                    <td className="py-2 text-right tabular-nums">{v === null ? <span className="text-muted">Not published</span> : `${nutrientValue(v, nu.key)}${unit}`}</td>
                    {item.servingG ? <td className="py-2 text-right tabular-nums text-muted">{v === null ? '' : `${nutrientValue(per100g(item, v), nu.key)}${unit}`}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {showChain && (
            <Link to={`/takeaways/${item.chainKey}`} className="text-sm font-semibold text-accent-text hover:underline">
              See {item.chainName}'s full menu
            </Link>
          )}
        </div>
      )}
    </SidePanel>
  );
}
