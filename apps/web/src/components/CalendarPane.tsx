/**
 * The Calendar's right-hand pane: stock, recipes and leftovers to drag onto a day and meal.
 * Collapses to a thin rail like the sidebar. Every item also has a "+" button, so planning
 * works without dragging (keyboard, touch). Its browsing part (tabs, filters, search, the list)
 * is `FoodBrowser`, which phones use in the "+ Add" sheet, picking with a tap instead of a drag.
 */
import { useEffect, useMemo, useState } from 'react';
import { amountText, type PlanEntryDto, type RecipeSummaryDto, type StockItemDto } from '@snackoverflow/shared';
import { dateLabel, toneClasses, toneFor } from '../lib/format';
import { useRecipes, useRecipeScores, useStock } from '../lib/queries';
import { inMeal, inRecipeTab, MEAL_CHOICES, type MealChoice, RECIPE_TABS, type RecipeTab, sortForTab } from '../pages/Recipes';
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

export type FoodTab = 'stock' | 'recipes' | 'leftovers';
type Tab = FoodTab;
const KEY = 'so-calendar-pane';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** The message on the pane while a planned meal is dragged over it. */
function removeMessage(e: PlanEntryDto): string {
  if (e.kind === 'recipe') return `Drop here to take ${e.title} off the calendar. Its ingredients come off the planned list.`;
  if (e.kind === 'product' || e.kind === 'stock') return `Drop here to take ${e.title} off the calendar. It goes back to being free stock.`;
  return `Drop here to take ${e.title} off the calendar.`;
}

export function CalendarPane({ servings, removing, onRemove }: { servings: number; removing: PlanEntryDto | null; onRemove: (entryId: string) => void }) {
  const [tab, setTab] = useState<Tab>('stock');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const [over, setOver] = useState(false);
  // While a planned meal is dragged, show the tab it came from.
  useEffect(() => {
    if (!removing) return setOver(false);
    setTab(removing.kind === 'recipe' ? 'recipes' : removing.kind === 'stock' ? 'leftovers' : 'stock');
  }, [removing]);
  const dropZone = removing && (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const d = readDrag(e);
        if (d?.type === 'move') onRemove(d.entryId);
      }}
      className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 border-2 border-dashed p-6 text-center text-sm backdrop-blur-[1px] ${
        over ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-card/90 text-muted'
      }`}
    >
      <Icon name="undo" className="size-6" />
      <p className="font-medium">{removeMessage(removing)}</p>
    </div>
  );
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? 'open' : 'collapsed');
      } catch {
        // Not remembered.
      }
      return !c;
    });

  if (collapsed) {
    return (
      <aside aria-label="Food to plan" className="sticky top-0 hidden h-screen w-11 shrink-0 flex-col items-center gap-2 border-l border-line bg-card pt-3 lg:flex">
        {removing && <div className="absolute inset-0 [&>div]:p-1 [&>div>p]:hidden">{dropZone}</div>}
        <button type="button" onClick={toggle} aria-label="Show stock, recipes and leftovers" title="Stock, recipes and leftovers" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-card-muted hover:text-ink">
          <Icon name="sidebar" className="size-[18px] -scale-x-100" />
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label="Food to plan" className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-l border-line bg-card lg:flex xl:w-80">
      {dropZone}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <p className="flex-1 text-sm font-semibold">Drag onto the calendar</p>
        <button type="button" onClick={toggle} aria-label="Hide stock, recipes and leftovers" title="Hide" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-card-muted hover:text-ink">
          <Icon name="sidebar" className="size-[18px] -scale-x-100" />
        </button>
      </div>
      <FoodBrowser tab={tab} onTab={setTab} servings={servings} onPick={setPlanning} />
      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
    </aside>
  );
}

/**
 * Stock, recipes (with the recipe views and the meal filter) and leftovers, searchable. In the
 * desktop pane items are dragged (or planned with their "+"); with `pick` (phones) tapping an item
 * picks it. `onTab` left out hides the tab switch (the caller shows its own).
 */
export function FoodBrowser({
  tab,
  onTab,
  servings,
  onPick,
  pick = false,
}: {
  tab: FoodTab;
  onTab?: (t: FoodTab) => void;
  servings: number;
  onPick: (target: PlanTarget) => void;
  pick?: boolean;
}) {
  const me = useMe();
  const stock = useStock().data;
  const recipes = useRecipes().data;
  const [q, setQ] = useState('');
  const [place, setPlace] = useState('all');
  const [recipeTab, setRecipeTab] = useState<RecipeTab>('all');
  const [meal, setMeal] = useState<MealChoice>('any');
  const scores = useRecipeScores().data;
  const byId = useMemo(() => new Map((scores?.scores ?? []).map((s) => [s.recipeId, s])), [scores]);

  const food = useMemo(
    () => groupStock((stock ?? []).filter((s) => !s.isMeal && (place === 'all' || s.locationType === place))).filter((g) => !q || matchesSearch(`${g.name} ${g.locationName}`, q)),
    [stock, q, place],
  );
  const leftovers = useMemo(() => (stock ?? []).filter((s) => s.isMeal && (!q || matchesSearch(s.productName, q))), [stock, q]);
  const recipeList = useMemo(
    () => sortForTab((recipes ?? []).filter((r) => inRecipeTab(byId.get(r.id), recipeTab) && inMeal(r, meal) && (!q || matchesSearch(`${r.title} ${r.tags.join(' ')}`, q))), byId, recipeTab),
    [recipes, q, recipeTab, meal, byId],
  );

  const item = (key: string, drag: CalendarDrag & { type: 'new' }, title: string, meta: React.ReactNode, badge: React.ReactNode, plan: PlanTarget) =>
    pick ? (
      <li key={key}>
        <button
          type="button"
          onClick={() => onPick(plan)}
          aria-label={`Add ${title}`}
          className="flex min-h-12 w-full items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-left hover:border-accent/50 hover:bg-accent-soft/40"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{title}</span>
            {meta && <span className="block truncate text-sm text-muted">{meta}</span>}
          </span>
          {badge}
          <Icon name="plus" className="size-5 shrink-0 text-accent-text" />
        </button>
      </li>
    ) : (
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
            onClick={() => onPick(plan)}
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
    <>
      <div className={`flex flex-col gap-2 pb-2 ${pick ? '' : 'px-3'}`}>
        {onTab && (
          <Segmented
            label="Show"
            value={tab}
            onChange={onTab}
            options={[
              { value: 'stock', label: 'Stock' },
              { value: 'recipes', label: 'Recipes' },
              { value: 'leftovers', label: 'Leftovers' },
            ]}
          />
        )}
        {tab === 'stock' && (
          <Segmented
            stretch={pick}
            label="Where"
            value={place}
            onChange={setPlace}
            options={[
              { value: 'all', label: 'All' },
              { value: 'fridge', label: 'Fridge' },
              { value: 'freezer', label: 'Freezer' },
              { value: 'cupboard', label: 'Cupboard' },
            ]}
          />
        )}
        {tab === 'recipes' && (
          <div>
            <div role="group" aria-label="Which recipes" className="grid grid-cols-2 gap-1">
              {RECIPE_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={recipeTab === t.id}
                  onClick={() => setRecipeTab(t.id)}
                  className={`rounded-md border px-2 text-xs font-semibold ${pick ? 'min-h-10' : 'min-h-7'} ${recipeTab === t.id ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted hover:text-ink'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted">{RECIPE_TABS.find((t) => t.id === recipeTab)?.help}</p>
            <div className="mt-2">
              <Segmented stretch label="Meal" value={meal} onChange={setMeal} options={MEAL_CHOICES.map((m) => ({ ...m, label: m.value === 'any' ? 'Any' : m.label }))} />
            </div>
          </div>
        )}
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${tab}`} label={`Search ${tab}`} />
      </div>
      <ul className={pick ? 'flex flex-col gap-1.5' : 'flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-4'}>
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
    </>
  );
}
