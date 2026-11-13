/**
 * The one shared shopping list in two parts: "For your plan", which keeps itself in step with the
 * plan and stock (whole packs, and what each thing is for), and things added by hand. Type at the
 * bottom to add, tick things off in the shop, then put them away.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { FOOD_GROUPS, type FoodGroup, formatPence, type ShoppingItemDto } from '@snackoverflow/shared';
import { AddToPlanSheet, type PlanTarget } from '../components/AddToPlanSheet';
import { type Column, ColumnsMenu, DataTable, useHiddenColumns } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { SuggestSheet } from '../components/OptimiserSheets';
import { useToast } from '../components/Toast';
import { PageTop, SearchBox, Segmented, Toolbar } from '../components/Toolbar';
import { Menu } from '../components/Menu';
import { Button, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useIngredients, useRunningLow, useShopping, useSurplus, useUsers } from '../lib/queries';
import { groupRows, matchesSearch } from '../lib/table';

/** "Potatoes, 2.5kg bag", "Red peppers × 3", "Milk × 2". */
export function itemTitle(i: ShoppingItemDto): string {
  if (i.reason === 'plan' && i.packLabel) {
    return i.packs > 1 ? `${i.text}, ${i.packs} × ${i.packLabel}` : `${i.text}, ${i.packLabel}`;
  }
  return i.packs > 1 ? `${i.text} × ${i.packs}` : i.text;
}


export function ShoppingPage() {
  const me = useMe();
  const list = useShopping();
  const low = (useRunningLow().data ?? []).filter((l) => !l.onList);
  const qc = useQueryClient();
  const toast = useToast();
  const [putting, setPutting] = useState<{ added: number; needsScan: ShoppingItemDto[] } | null>(null);
  // Ticks not saved yet win over whatever the server last said, so a refresh can't flip them back.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'to-get' | 'got' | 'all'>('all');
  const [group, setGroup] = useState<'none' | 'category'>('none');
  const [hiddenColumns, toggleColumn] = useHiddenColumns('shopping-list');
  const items = useMemo(() => (list.data ?? []).map((i) => (i.id in pending ? { ...i, checked: pending[i.id]! } : i)), [list.data, pending]);
  const toGet = items.filter((i) => !i.checked);
  const pricing = me.household.settings.pricingEnabled;
  const pricedToGet = toGet.filter((i) => i.pricePence !== null);
  const estimate = pricedToGet.length ? pricedToGet.reduce((sum, i) => sum + i.pricePence!, 0) : null;
  const ticked = items.filter((i) => i.checked);
  const surplus = useSurplus().data ?? [];
  const people = Math.max(1, useUsers().data?.length ?? 2);
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const [ideasFor, setIdeasFor] = useState<{ id: string; name: string } | null>(null);
  const biggestSpare = items.filter((i) => !i.checked && (i.surplusGrams ?? 0) >= 200).sort((a, b) => (b.surplusGrams ?? 0) - (a.surplusGrams ?? 0))[0];
  const spareHint = biggestSpare ? surplus.find((h) => h.ingredientId === biggestSpare.ingredientId) : undefined;
  const spareIdea = spareHint?.topIdea;

  const refresh = () => qc.invalidateQueries({ queryKey: ['shopping'] });
  const tick = async (i: ShoppingItemDto) => {
    const checked = !i.checked;
    setPending((p) => ({ ...p, [i.id]: checked }));
    try {
      await api.patch(`/api/shopping/${i.id}`, { checked });
      await refresh();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
    setPending(({ [i.id]: _done, ...rest }) => rest);
  };
  const remove = async (i: ShoppingItemDto) => {
    await api.del(`/api/shopping/${i.id}`).catch(() => {});
    await refresh();
  };
  const setCategory = async (i: ShoppingItemDto, foodGroup: FoodGroup | null) => {
    try {
      await api.patch(`/api/shopping/${i.id}`, { foodGroup });
      await refresh();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const addLow = async () => {
    for (const l of low) await api.post('/api/shopping', { ingredientId: l.ingredientId, reason: 'running-low' }).catch(() => {});
    await refresh();
    await qc.invalidateQueries({ queryKey: ['shopping', 'running-low'] });
  };
  const putAway = async () => {
    try {
      const r = await api.post<{ added: number; needsScan: ShoppingItemDto[] }>('/api/shopping/put-away', {});
      await refresh();
      await qc.invalidateQueries({ queryKey: ['stock'] });
      setPutting(r);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const columns: Column<ShoppingItemDto>[] = [
    { key: 'got', header: <span className="sr-only">Got it</span>, hideable: false, className: 'w-8 pr-0', cell: (i) => <GotBox item={i} onTick={tick} /> },
    { key: 'item', header: 'Item', hideable: false, className: 'min-w-[12rem]', cell: (i) => <span className={`font-semibold ${i.checked ? 'text-muted line-through' : 'text-ink'}`}>{i.text}</span> },
    {
      key: 'for',
      label: 'For',
      header: <Explained help="The planned meals that need it">For</Explained>,
      className: 'max-w-[16rem] truncate',
      cell: (i) => i.forMeals ?? (i.reason === 'running-low' ? 'Running low' : ''),
    },
    { key: 'category', header: <Explained help="Its food group. Change it from the row's menu">Category</Explained>, label: 'Category', className: 'w-44 whitespace-nowrap', cell: (i) => i.foodGroup ?? '' },
    {
      key: 'need',
      label: 'Needed',
      header: <Explained help="How much the planned meals are short by, after what's in stock">Needed</Explained>,
      align: 'right',
      className: 'w-28 whitespace-nowrap tabular-nums',
      cell: (i) => (i.needLabel ? <span className="text-ink">{i.needLabel}</span> : ''),
    },
    {
      key: 'buy',
      label: 'To buy',
      header: <Explained help="Whole packs, as the shops sell them">To buy</Explained>,
      align: 'right',
      className: 'w-32 whitespace-nowrap tabular-nums',
      cell: (i) => (i.packLabel ? `${i.packs} × ${i.packLabel}` : i.packs > 1 ? `× ${i.packs}` : '1'),
    },
  ];
  if (pricing) {
    columns.push({
      key: 'price',
      label: 'Price',
      header: <Explained help="Estimated from your receipts and Open Prices">Price</Explained>,
      align: 'right',
      className: 'w-24 whitespace-nowrap tabular-nums',
      cell: (i) => (i.pricePence !== null ? formatPence(i.pricePence) : ''),
    });
  }
  const shown = items.filter((i) => (show === 'all' || (show === 'got' ? i.checked : !i.checked)) && (!q || matchesSearch(`${i.text} ${i.forMeals ?? ''} ${i.aisle}`, q)));
  // Two parts: what the plan needs (kept up to date for you), then what's been added by hand.
  const sections = [
    { key: 'plan', label: 'For your plan', rows: shown.filter((i) => i.reason === 'plan') },
    { key: 'added', label: 'Added by hand', rows: shown.filter((i) => i.reason !== 'plan') },
  ];
  const groups = sections.flatMap((sec) =>
    group === 'category'
      ? groupRows(sec.rows, (i) => i.foodGroup ?? 'Other', [...FOOD_GROUPS, 'Other']).map((g) => ({ key: `${sec.key}:${g.key}`, label: `${sec.label} · ${g.key}`, rows: g.rows }))
      : sec.rows.length || sec.key === 'added'
        ? [{ key: sec.key, label: sec.label, rows: sec.rows }]
        : [],
  );
  const putAwayButton =
    ticked.length > 0 ? (
      <Button variant="primary" onClick={() => void putAway()}>
        Put away {ticked.length} ticked item{ticked.length === 1 ? '' : 's'}
      </Button>
    ) : null;
  /** The row's menu (category) and, for things added by hand, remove. Plan items come off by themselves. */
  const rowActions = (i: ShoppingItemDto) => (
    <>
      <Menu
        label={`Options for ${i.text}`}
        items={[
          {
            label: 'Category',
            icon: 'tag',
            hint: i.foodGroup ?? 'None',
            onSelect: () => {},
            submenu: [
              ...FOOD_GROUPS.map((g) => ({ label: g, checked: i.foodGroup === g, onSelect: () => void setCategory(i, g) })),
              'divider' as const,
              { label: "The food's own", onSelect: () => void setCategory(i, null) },
            ],
          },
          ...(i.reason === 'plan' ? [{ heading: 'Comes off by itself once the plan is covered' }] : []),
        ]}
      />
      {i.reason !== 'plan' ? (
        <button
          type="button"
          aria-label={`Remove ${i.text}`}
          onClick={() => void remove(i)}
          className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink lg:size-7 lg:rounded-md"
        >
          <Icon name="close" className="size-4" />
        </button>
      ) : (
        <span aria-hidden className="inline-block size-10 lg:size-7" />
      )}
    </>
  );

  return (
    <>
      <PageTop
        title="Shopping list"
        subtitle={`${toGet.length} to get${pricing && estimate !== null ? ` · about ${formatPence(estimate)}` : ''}`}
        left={<MenuButton />}
        actions={putAwayButton && <div className="hidden lg:block">{putAwayButton}</div>}
      />
      <Toolbar
        search={
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <SearchBox value={q} onChange={setQ} placeholder="Search the list" label="Search the list" />
            </div>
            <ColumnsMenu columns={columns} hidden={hiddenColumns} onToggle={toggleColumn} />
          </div>
        }
      >
        <Segmented
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: 'to-get', label: 'To get' },
            { value: 'got', label: 'Got' },
            { value: 'all', label: 'All' },
          ]}
        />
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line lg:block" />
        <span className="hidden text-sm text-muted lg:inline">Group</span>
        <Segmented
          label="Group by"
          value={group}
          onChange={setGroup}
          options={[
            { value: 'none', label: 'None' },
            { value: 'category', label: 'Category' },
          ]}
        />
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line lg:block" />
        <Link to="/receipts" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-semibold hover:bg-card-muted lg:min-h-8 lg:rounded-md lg:px-2.5">
          <Icon name="receipt" className="size-4" /> Add from receipt
        </Link>
      </Toolbar>

      {biggestSpare && (
        <Notice>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">
              The {biggestSpare.packLabel ? `${biggestSpare.packLabel} ` : ''}
              {biggestSpare.text.toLowerCase()} leave {biggestSpare.surplusLabel} spare.
            </strong>{' '}
            {spareIdea
              ? `${spareIdea.title} would use it${spareIdea.missing.length ? ` (you'd also need ${spareIdea.missing.join(', ').toLowerCase()})` : ''}.`
              : `Plan something else with ${biggestSpare.text.toLowerCase()} this week so it gets used.`}
          </span>
          <span className="flex shrink-0 gap-2">
            {spareIdea && (
              <Button size="xs" variant="dark" onClick={() => setPlanning({ kind: 'recipe', id: spareIdea.recipeId, title: spareIdea.title, servings: people })}>
                Add to plan
              </Button>
            )}
            {spareHint && spareHint.ideas > (spareIdea ? 1 : 0) ? (
              <Button size="xs" onClick={() => setIdeasFor({ id: spareHint.ingredientId, name: spareHint.name })}>
                More ideas
              </Button>
            ) : (
              !spareIdea && (
                <Link to="/recipes" className="inline-flex min-h-10 items-center rounded-lg border border-line bg-card px-2.5 text-sm font-semibold lg:min-h-7 lg:rounded-md">
                  Find a recipe
                </Link>
              )
            )}
          </span>
        </Notice>
      )}
      {low.length > 0 && (
        <Notice>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">Running low:</strong> {low.map((l) => l.name).join(', ')}
          </span>
          <Button size="xs" variant="dark" onClick={() => void addLow()}>
            Add to list
          </Button>
        </Notice>
      )}
      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
      {ideasFor && <SuggestSheet open onClose={() => setIdeasFor(null)} defaultDate={me.today} ingredient={ideasFor} servings={people} />}

      <ErrorNote error={list.error} />
      {list.isPending ? (
        <Spinner />
      ) : (
        <div className="pb-24 lg:pb-0">
          <DataTable
            label="Shopping list"
            columns={columns}
            groups={groups}
            hidden={hiddenColumns}
            rowKey={(i) => i.id}
            actions={rowActions}
            phone={(i) => ({
              lead: <GotBox item={i} onTick={tick} />,
              title: <span className={i.checked ? 'text-muted line-through' : ''}>{itemTitle(i)}</span>,
              meta: [i.needLabel ? `Need ${i.needLabel}` : null, i.packLabel ? `${i.packs} × ${i.packLabel}` : null, i.foodGroup].filter(Boolean).join(' · ') || undefined,
              badge: (
                <span className="flex shrink-0 items-center gap-1">
                  {pricing && i.pricePence !== null && <span className="text-sm font-semibold tabular-nums text-muted">{formatPence(i.pricePence)}</span>}
                  {rowActions(i)}
                </span>
              ),
            })}
            empty={
              <EmptyState title="The list is empty">
                <p>Plan some meals and what they need shows up here by itself, or type something below.</p>
              </EmptyState>
            }
          />
          <QuickAdd />
        </div>
      )}
      {putAwayButton && <div className="fixed inset-x-4 bottom-24 z-20 mx-auto max-w-xl lg:hidden [&>button]:w-full [&>button]:shadow-lg">{putAwayButton}</div>}
      <Sheet open={putting !== null} onClose={() => setPutting(null)} title="Put away">
        {putting && (
          <div className="flex flex-col gap-3">
            <p>{putting.added ? `Added ${putting.added} to stock with estimated best-before dates.` : 'Nothing could be added in one tap.'}</p>
            {putting.needsScan.length > 0 && (
              <>
                <p className="text-muted">These need scanning so we know exactly what they are: {putting.needsScan.map((i) => i.text).join(', ')}.</p>
                <Link to="/scan" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent font-semibold text-accent-ink lg:min-h-8 lg:rounded-md">
                  Scan them
                </Link>
              </>
            )}
            <Button onClick={() => setPutting(null)}>Done</Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

/** A column header with a short explanation on hover (and for screen readers). */
function Explained({ help, children }: { help: string; children: ReactNode }) {
  return (
    <span title={help} className="cursor-help underline decoration-muted/60 decoration-dotted underline-offset-4">
      {children}
      <span className="sr-only">: {help}</span>
    </span>
  );
}

/** A slim highlighted line above the list: spare packs, things running low. */
function Notice({ children }: { children: ReactNode }) {
  return <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-sm">{children}</div>;
}

function GotBox({ item, onTick }: { item: ShoppingItemDto; onTick: (i: ShoppingItemDto) => Promise<void> }) {
  return (
    <input
      type="checkbox"
      aria-label={`Got ${itemTitle(item)}`}
      checked={item.checked}
      onChange={() => void onTick(item)}
      className="size-6 shrink-0 cursor-pointer accent-[var(--accent)] lg:size-4"
    />
  );
}

/** Type a thing and press Enter. An exact ingredient name links it; anything else is free text. */
function QuickAdd() {
  const ingredients = useIngredients().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const t = text.trim().toLowerCase();
  const match = t.length >= 3 ? ingredients.find((i) => i.name.toLowerCase() === t) : undefined;
  const suggestions = t.length >= 2 && !match ? ingredients.filter((i) => i.name.toLowerCase().includes(t)).slice(0, 6) : [];
  const add = async (body: Record<string, unknown>) => {
    try {
      await api.post('/api/shopping', { packs: 1, ...body });
      await qc.invalidateQueries({ queryKey: ['shopping'] });
      setText('');
      toast.show('Added to the list.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  return (
    <form
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void add(match ? { ingredientId: match.id } : { text: text.trim() });
      }}
    >
      <div className="flex gap-2">
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-dashed border-line bg-card px-3 focus-within:border-solid focus-within:border-accent lg:min-h-9 lg:rounded-md lg:px-2.5">
          <Icon name="plus" className="size-4 shrink-0 text-muted" />
          <span className="sr-only">Add to the list</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add an item and press Enter"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted lg:text-sm"
          />
        </label>
        {text.trim() && (
          <Button type="submit" variant="primary">
            Add
          </Button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button key={s.id} type="button" onClick={() => void add({ ingredientId: s.id })} className="min-h-10 rounded-full border border-line bg-card px-3 text-sm hover:bg-card-muted lg:min-h-7">
              {s.name}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
