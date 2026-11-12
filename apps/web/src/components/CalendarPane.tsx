/**
 * The Calendar's right-hand pane: stock, recipes and leftovers to drag onto a day and meal.
 * Collapses to a thin rail like the sidebar. Every item also has a "+" button, so planning
 * works without dragging (keyboard, touch).
 */
import { useMemo, useState } from 'react';
import { amountText, type RecipeSummaryDto, type StockItemDto } from '@snackoverflow/shared';
import { dateLabel, toneClasses, toneFor } from '../lib/format';
import { useRecipes, useStock } from '../lib/queries';
import { groupStock, type StockGroup } from '../lib/stockGroups';
import { matchesSearch } from '../lib/table';
import { AddToPlanSheet, type PlanTarget } from './AddToPlanSheet';
import { Icon } from './Icon';
import { useMe } from './Layout';
import { SearchBox, Segmented } from './Toolbar';
import { Pill } from './ui';

/** What's being dragged onto the calendar: something new to plan, or a planned meal being moved. */
export type CalendarDrag = { type: 'new'; kind: 'recipe' | 'product' | 'stock'; id: string; title: string } | { type: 'move'; entryId: string; title: string };

export const DRAG_TYPE = 'application/x-snack-overflow';

export function readDrag(e: React.DragEvent): CalendarDrag | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as CalendarDrag) : null;
  } catch {
    return null;
  }
}

export function startDrag(e: React.DragEvent, drag: CalendarDrag) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(drag));
  e.dataTransfer.setData('text/plain', drag.title);
  e.dataTransfer.effectAllowed = drag.type === 'move' ? 'move' : 'copy';
}

type Tab = 'stock' | 'recipes' | 'leftovers';
const KEY = 'so-calendar-pane';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function CalendarPane({ servings }: { servings: number }) {
  const me = useMe();
  const stock = useStock().data;
  const recipes = useRecipes().data;
  const [tab, setTab] = useState<Tab>('stock');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? 'open' : 'collapsed');
      } catch {
        // Not remembered.
      }
      return !c;
    });

  const food = useMemo(() => groupStock((stock ?? []).filter((s) => !s.isMeal)).filter((g) => !q || matchesSearch(`${g.name} ${g.locationName}`, q)), [stock, q]);
  const leftovers = useMemo(() => (stock ?? []).filter((s) => s.isMeal && (!q || matchesSearch(s.productName, q))), [stock, q]);
  const recipeList = useMemo(() => (recipes ?? []).filter((r) => !q || matchesSearch(`${r.title} ${r.tags.join(' ')}`, q)), [recipes, q]);

  if (collapsed) {
    return (
      <aside aria-label="Food to plan" className="sticky top-0 hidden h-screen w-11 shrink-0 flex-col items-center gap-2 border-l border-line bg-card pt-3 lg:flex">
        <button type="button" onClick={toggle} aria-label="Show stock, recipes and leftovers" title="Stock, recipes and leftovers" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-card-muted hover:text-ink">
          <Icon name="sidebar" className="size-[18px] -scale-x-100" />
        </button>
      </aside>
    );
  }

  const item = (key: string, drag: CalendarDrag & { type: 'new' }, title: string, meta: React.ReactNode, badge: React.ReactNode, plan: PlanTarget) => (
    <li key={key}>
      <div
        draggable
        onDragStart={(e) => startDrag(e, drag)}
        className="group flex cursor-grab items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 hover:border-accent/50 hover:bg-accent-soft/40 active:cursor-grabbing"
      >
        <span aria-hidden className="text-muted/60">
          <Icon name="more" className="size-4 rotate-90" strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          {meta && <span className="block truncate text-xs text-muted">{meta}</span>}
        </span>
        {badge}
        <button
          type="button"
          aria-label={`Plan ${title}`}
          onClick={() => setPlanning(plan)}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-card-muted hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          <Icon name="plus" className="size-4" />
        </button>
      </div>
    </li>
  );

  const stockMeta = (g: StockGroup) => {
    const total = g.packs.every((p) => p.remainingGrams !== null) ? g.packs.reduce((n, p) => n + p.remainingGrams!, 0) : null;
    return [g.locationName, total !== null ? amountText(total, g.first) : null].filter(Boolean).join(' · ');
  };
  const pill = (s: StockItemDto) => <Pill className={toneClasses[toneFor(s, me.today)].pill}>{dateLabel(s.bestBefore, me.today)}</Pill>;
  const recipeMeta = (r: RecipeSummaryDto) => [r.kcalPerServing ? `${r.kcalPerServing} kcal` : null, r.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · ');

  return (
    <aside aria-label="Food to plan" className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-l border-line bg-card lg:flex xl:w-80">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <p className="flex-1 text-sm font-semibold">Drag onto the calendar</p>
        <button type="button" onClick={toggle} aria-label="Hide stock, recipes and leftovers" title="Hide" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-card-muted hover:text-ink">
          <Icon name="sidebar" className="size-[18px] -scale-x-100" />
        </button>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2">
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'stock', label: 'Stock' },
            { value: 'recipes', label: 'Recipes' },
            { value: 'leftovers', label: 'Leftovers' },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${tab}`} label={`Search ${tab}`} />
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-4">
        {tab === 'stock' &&
          food.map((g) =>
            item(g.key, { type: 'new', kind: 'product', id: g.productId, title: g.name }, g.name, stockMeta(g), pill(g.first), { kind: 'product', id: g.productId, title: g.name, servings: 1 }),
          )}
        {tab === 'recipes' &&
          recipeList.map((r) => item(r.id, { type: 'new', kind: 'recipe', id: r.id, title: r.title }, r.title, recipeMeta(r), null, { kind: 'recipe', id: r.id, title: r.title, servings }))}
        {tab === 'leftovers' &&
          leftovers.map((s) =>
            item(s.id, { type: 'new', kind: 'stock', id: s.id, title: s.productName }, s.productName, s.locationName, pill(s), { kind: 'stock', id: s.id, title: s.productName, servings: 1 }),
          )}
        {((tab === 'stock' && food.length === 0) || (tab === 'recipes' && recipeList.length === 0) || (tab === 'leftovers' && leftovers.length === 0)) && (
          <li className="px-1 py-6 text-center text-sm text-muted">{q ? 'Nothing matches.' : tab === 'leftovers' ? 'No leftovers or batch-cook portions.' : `No ${tab} yet.`}</li>
        )}
      </ul>
      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
    </aside>
  );
}
