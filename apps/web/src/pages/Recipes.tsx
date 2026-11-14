/**
 * The recipe library: All / Cook now / Nearly there / Use it up, as a gallery or a table.
 * Clicking a recipe previews it in a side panel: Cook and Batch cook at the top, Full recipe and Add to plan below.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type MealFilter, recipeMeals, type RecipeScore, type RecipeSummaryDto } from '@snackoverflow/shared';
import { AddToPlanSheet, type PlanTarget } from '../components/AddToPlanSheet';
import { type Column, DataTable } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { PickerMenu } from '../components/Menu';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { PageTop, SearchBox, Segmented, Toolbar } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { minutesLabel } from '../lib/format';
import { useRecipe, useRecipes, useRecipeScores } from '../lib/queries';
import { matchesSearch } from '../lib/table';
import { useIsDesktop } from '../lib/useMedia';
import { BatchSheet, RecipeIngredients, recipeMeta, type Swaps, swapNote, swapsParam, withSwap } from './RecipeDetail';
import { useRecipeScans } from './RecipePhotos';

/** Placeholder tints for recipes without a photo; follow the palette (not the freshness colours). */
const TINTS = ['bg-accent-soft', 'bg-card-muted'];

export function RecipeImage({ recipe, className = '' }: { recipe: Pick<RecipeSummaryDto, 'imageUrl' | 'title'>; className?: string }) {
  const [broken, setBroken] = useState(false);
  const tint = TINTS[recipe.title.length % TINTS.length];
  if (!recipe.imageUrl || broken) {
    return (
      <div aria-hidden className={`flex items-center justify-center ${tint} ${className}`}>
        <span className="text-3xl font-bold text-muted/40">{recipe.title.charAt(0)}</span>
      </div>
    );
  }
  return <img src={recipe.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`object-cover ${className}`} />;
}

export type RecipeTab = 'all' | 'cook-now' | 'nearly' | 'use-it-up';
type Tab = RecipeTab;
type View = 'gallery' | 'table';

/** The recipe views, used on the Recipes page and in the Calendar's pane. */
export const RECIPE_TABS: { id: RecipeTab; label: string; help: string }[] = [
  { id: 'all', label: 'All', help: 'Every recipe, A to Z.' },
  { id: 'cook-now', label: 'Ready to cook', help: 'Everything it needs is in stock.' },
  { id: 'nearly', label: 'Missing a few', help: 'In stock except for one to three things.' },
  { id: 'use-it-up', label: 'Use it up', help: "Uses food that's going off soon, best first." },
];
/** The meal filter beside the views: any meal, or recipes tagged for breakfast, lunch or dinner. */
export type MealChoice = 'any' | MealFilter;
export const MEAL_CHOICES: { value: MealChoice; label: string }[] = [
  { value: 'any', label: 'Any meal' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
];
export const inMeal = (r: Pick<RecipeSummaryDto, 'tags'>, m: MealChoice) => m === 'any' || recipeMeals(r.tags).includes(m);

const TAB_HELP = Object.fromEntries(RECIPE_TABS.map((t) => [t.id, t.help])) as Record<Tab, string>;

/** Whether a recipe belongs in a view, from its score. */
export function inRecipeTab(s: RecipeScore | undefined, t: RecipeTab): boolean {
  if (t === 'all') return true;
  if (!s) return false;
  if (t === 'cook-now') return s.cookNow;
  if (t === 'nearly') return !s.cookNow && s.missing.length >= 1 && s.missing.length <= 3;
  return s.uses.length > 0;
}

/** Recipes in a view, in that view's order (Use it up: most saved first; Missing a few: fewest missing first). */
export function sortForTab<T extends { id: string }>(list: T[], byId: Map<string, RecipeScore>, t: RecipeTab): T[] {
  if (t === 'use-it-up') return [...list].sort((a, b) => (byId.get(b.id)?.score ?? 0) - (byId.get(a.id)?.score ?? 0));
  if (t === 'nearly') return [...list].sort((a, b) => (byId.get(a.id)?.missing.length ?? 9) - (byId.get(b.id)?.missing.length ?? 9));
  return list;
}

function daysUntil(date: string, on: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / 86_400_000);
}

/** "Uses spinach (tomorrow), chicken thighs (2 days)". */
function usesLine(s: RecipeScore, on: string): string | null {
  const soon = [...s.uses].filter((u) => u.bestBefore).sort((a, b) => (a.bestBefore ?? '').localeCompare(b.bestBefore ?? ''));
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const u of soon) {
    if (seen.has(u.ingredientId) || parts.length >= 3) continue;
    seen.add(u.ingredientId);
    const days = daysUntil(u.bestBefore!, on);
    parts.push(`${u.name.toLowerCase()} (${days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `${days} days`})`);
  }
  return parts.length ? `Uses ${parts.join(', ')}` : null;
}

function missingLine(s: RecipeScore | undefined): string | null {
  if (!s) return null;
  if (s.missing.length === 0) return s.cookNow ? 'Nothing missing' : 'Some of it is on the shopping list';
  return `Missing: ${s.missing.map((m) => m.name.toLowerCase()).join(', ')}`;
}

function readView(): View {
  try {
    return localStorage.getItem('so-recipes-view') === 'table' ? 'table' : 'gallery';
  } catch {
    return 'gallery';
  }
}

export function RecipesPage() {
  const me = useMe();
  const recipes = useRecipes();
  const waitingPhotos = (useRecipeScans().data ?? []).filter((x) => x.status !== 'done').length;
  const scores = useRecipeScores();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [meal, setMeal] = useState<MealChoice>('any');
  const [view, setView] = useState<View>(readView);
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const [openId, openPanelParam, closePanel] = usePanelParam();
  const desktop = useIsDesktop();
  // Phones skip the side panel and open the full recipe, which reads better on a small screen.
  const openPanel = (id: string) => (desktop ? openPanelParam(id) : navigate(`/recipes/${id}`));
  const tags = useMemo(() => [...new Set((recipes.data ?? []).flatMap((r) => r.tags))].sort(), [recipes.data]);
  const byId = useMemo(() => new Map((scores.data?.scores ?? []).map((s) => [s.recipeId, s])), [scores.data]);
  const on = scores.data?.on ?? '';

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('so-recipes-view', v);
    } catch {
      // Not remembered.
    }
  };
  const inTab = (r: RecipeSummaryDto, t: Tab) => inRecipeTab(byId.get(r.id), t);
  const count = (t: Tab) => (recipes.data ?? []).filter((r) => inTab(r, t) && inMeal(r, meal)).length;
  let shown = (recipes.data ?? []).filter((r) => (!q || matchesSearch(`${r.title} ${r.tags.join(' ')}`, q)) && (!tag || r.tags.includes(tag)) && inTab(r, tab) && inMeal(r, meal));
  shown = sortForTab(shown, byId, tab);

  const plan = (r: RecipeSummaryDto, swaps?: Swaps, note?: string | null) => setPlanning({ kind: 'recipe', id: r.id, title: r.title, servings: r.serves, swaps, swapNote: note });
  const cook = (r: RecipeSummaryDto) => navigate(`/recipes/${r.id}/cook?servings=${r.serves}`);
  const actions = (r: RecipeSummaryDto) => (
    <>
      <Button size="xs" variant="dark" aria-label={`Add ${r.title} to the plan`} onClick={() => plan(r)}>
        Add to plan
      </Button>
      <Button size="xs" aria-label={`Cook ${r.title} now`} onClick={() => cook(r)}>
        Cook now
      </Button>
    </>
  );
  const facts = (r: RecipeSummaryDto) => [minutesLabel(r.totalMinutes), r.kcalPerServing ? `${r.kcalPerServing} kcal` : null].filter(Boolean).join(' · ');

  const columns: Column<RecipeSummaryDto>[] = [
    { key: 'title', header: 'Recipe', primary: true, className: 'max-w-[18rem]', cell: (r) => r.title },
    {
      key: 'uses',
      header: 'Uses soon',
      className: 'max-w-[16rem] truncate',
      cell: (r) => {
        const s = byId.get(r.id);
        const u = s && on ? usesLine(s, on) : null;
        return u ? <span className="text-fresh-green-text">{u.replace(/^Uses /, '')}</span> : '';
      },
    },
    { key: 'missing', header: 'Missing', className: 'max-w-[14rem] truncate', cell: (r) => byId.get(r.id)?.missing.map((m) => m.name.toLowerCase()).join(', ') ?? '' },
    { key: 'time', header: 'Time', className: 'whitespace-nowrap', cell: (r) => minutesLabel(r.totalMinutes) ?? '' },
    { key: 'kcal', header: 'kcal', align: 'right', className: 'tabular-nums', cell: (r) => r.kcalPerServing ?? '' },
    { key: 'tags', header: 'Tags', className: 'max-w-[10rem] truncate', cell: (r) => r.tags.join(', ') },
  ];

  const empty = (
    <EmptyState title={recipes.data?.length ? 'Nothing here right now' : 'No recipes yet'}>
      {!recipes.data?.length ? (
        <p>
          <Link to="/recipes/import" className="font-semibold text-accent-text">
            Import one from a link
          </Link>{' '}
          (BBC Good Food, Hello Fresh, most blogs) or{' '}
          <Link to="/recipes/new" className="font-semibold text-accent-text">
            type one in
          </Link>
          .
        </p>
      ) : (
        <p>{meal !== 'any' ? `No ${meal} recipes in this view. Tag a recipe "${meal}" to see it here.` : tab === 'use-it-up' ? 'Nothing in stock is about to go off. Nice.' : 'Try another view, or scan your shopping in.'}</p>
      )}
    </EmptyState>
  );

  return (
    <>
      <PageTop
        title="Recipes"
        subtitle={recipes.data ? `${recipes.data.length}` : undefined}
        left={<MenuButton />}
        actions={
          <>
            <Link
              to="/recipes/import"
              aria-label="Import a recipe from a link"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-ink hover:brightness-110 lg:min-h-8 lg:rounded-md"
            >
              <Icon name="download" className="size-4" />
              <span className="hidden sm:inline">Import from a link</span>
            </Link>
            <Link
              to="/recipes/photos"
              aria-label={`Recipe photos${waitingPhotos ? `, ${waitingPhotos} to read` : ''}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-sm font-semibold hover:bg-card-muted lg:min-h-8 lg:rounded-md"
            >
              <Icon name="camera" className="size-4" />
              <span className="hidden sm:inline">Photos</span>
              {waitingPhotos > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-xs text-accent-text">{waitingPhotos}</span>}
            </Link>
            <Link
              to="/recipes/new"
              aria-label="New recipe"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-sm font-semibold hover:bg-card-muted lg:min-h-8 lg:rounded-md"
            >
              <Icon name="plus" className="size-4" />
              <span className="hidden sm:inline">New</span>
            </Link>
          </>
        }
      />
      <div role="tablist" aria-label="Which recipes" className="no-scrollbar -mx-4 mb-2 flex gap-1 overflow-x-auto border-b border-line px-4 lg:mx-0 lg:px-0">
        {RECIPE_TABS.map(({ id: t, label }) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-semibold lg:min-h-9 ${tab === t ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {label} <span className="font-normal text-muted">{count(t)}</span>
          </button>
        ))}
      </div>
      <Toolbar search={<SearchBox value={q} onChange={setQ} placeholder="Search recipes" label="Search recipes" />}>
        <Segmented label="Meal" value={meal} onChange={setMeal} options={MEAL_CHOICES} />
        {tags.length > 0 && (
          <PickerMenu label="Tag" icon="tag" value={tag} defaultValue="" onChange={setTag} options={[{ value: '', label: 'All tags' }, ...tags.map((t) => ({ value: t, label: t }))]} />
        )}
        <span className="hidden text-sm text-muted lg:inline lg:px-2">{TAB_HELP[tab]}</span>
        <span className="ml-auto lg:ml-0">
          <Segmented
            label="View"
            value={view}
            onChange={changeView}
            options={[
              { value: 'gallery', label: <Icon name="grid" className="size-4" label="Gallery" /> },
              { value: 'table', label: <Icon name="rows" className="size-4" label="Table" /> },
            ]}
          />
        </span>
      </Toolbar>
      {tab === 'use-it-up' && me.features.ai && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm">
          <span className="flex-1">Nothing here that fits? Have a recipe made up around what’s going off.</span>
          <Link to="/recipes/use-it-up" className="font-semibold text-accent-text">
            Make one up with AI
          </Link>
        </div>
      )}
      <ErrorNote error={recipes.error} />
      {recipes.isPending ? (
        <Spinner />
      ) : view === 'table' ? (
        <DataTable
          label="Recipes"
          columns={columns}
          rows={shown}
          rowKey={(r) => r.id}
          onOpen={(r) => openPanel(r.id)}
          openLabel={(r) => r.title}
          activeKey={openId}
          actions={actions}
          phone={(r) => ({ title: r.title, meta: [facts(r), missingLine(byId.get(r.id))].filter(Boolean).join(' · '), actions: actions(r) })}
          empty={empty}
        />
      ) : shown.length === 0 ? (
        empty
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {shown.map((r) => {
            const s = byId.get(r.id);
            const uses = s && on ? usesLine(s, on) : null;
            return (
              <li key={r.id} className={`flex flex-col overflow-hidden rounded-xl border bg-card lg:rounded-lg ${openId === r.id ? 'border-accent ring-1 ring-accent' : 'border-line'}`}>
                <button type="button" onClick={() => openPanel(r.id)} className="block text-left">
                  <RecipeImage recipe={r} className="h-28 w-full" />
                  <span className="flex items-start gap-2 px-3 pt-2.5">
                    <span className="flex-1 font-semibold leading-snug">{r.title}</span>
                    <span className="whitespace-nowrap pt-0.5 text-xs text-muted">{facts(r)}</span>
                  </span>
                </button>
                <div className="flex flex-1 flex-col gap-0.5 px-3 pb-3 pt-1 text-sm">
                  {uses && <p className="font-medium text-fresh-green-text">{uses}</p>}
                  {missingLine(s) && <p className="text-muted">{missingLine(s)}</p>}
                  <div className="mt-auto flex gap-2 pt-2.5">{actions(r)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <RecipePanel key={openId ?? ''} id={openId} onClose={closePanel} onPlan={plan} score={openId ? byId.get(openId) : undefined} on={on} />
      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
    </>
  );
}

function RecipePanel({
  id,
  onClose,
  onPlan,
  score,
  on,
}: {
  id: string | null;
  onClose: () => void;
  onPlan: (r: RecipeSummaryDto, swaps?: Swaps, note?: string | null) => void;
  score?: RecipeScore;
  on: string;
}) {
  const r = useRecipe(id ?? '').data;
  const navigate = useNavigate();
  const [servings, setServings] = useState<number | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [swaps, setSwaps] = useState<Swaps>({});
  const uses = score && on ? usesLine(score, on) : null;
  const n = r ? (servings ?? r.serves) : 1;
  return (
    <SidePanel
      open={Boolean(id)}
      onClose={onClose}
      title={r?.title ?? 'Loading…'}
      subtitle={r ? recipeMeta(r) || undefined : undefined}
      headerActions={
        r && (
          <>
            <Button size="sm" variant="primary" onClick={() => navigate(`/recipes/${r.id}/cook?servings=${n}${Object.keys(swaps).length ? `&swaps=${swapsParam(swaps)}` : ''}`)}>
              Cook
            </Button>
            <Button size="sm" onClick={() => setBatchOpen(true)}>
              Batch cook
            </Button>
          </>
        )
      }
      footer={
        r && (
          <>
            <Link
              to={`/recipes/${r.id}`}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-110 lg:min-h-8 lg:rounded-md lg:px-3"
            >
              Full recipe <Icon name="chevronRight" className="size-4" />
            </Link>
            <Button onClick={() => onPlan(r, swaps, swapNote(r, swaps))}>Add to plan</Button>
          </>
        )
      }
    >
      {r ? (
        <div className="flex flex-col gap-4">
          <RecipeImage recipe={r} className="h-36 w-full rounded-lg" />
          {(uses || missingLine(score)) && (
            <div className="text-sm">
              {uses && <p className="font-medium text-fresh-green-text">{uses}</p>}
              {missingLine(score) && <p className="text-muted">{missingLine(score)}</p>}
            </div>
          )}
          <RecipeIngredients recipe={r} servings={n} onServings={setServings} swaps={swaps} onSwap={(line, ing) => setSwaps((s) => withSwap(s, line, ing))} />
          {r.steps.length > 0 && (
            <section>
              <h2 className="mb-2 font-bold">Method</h2>
              <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed">
                {r.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </section>
          )}
          <BatchSheet open={batchOpen} serves={r.serves} onClose={() => setBatchOpen(false)} onGo={(portions) => navigate(`/recipes/${r.id}/cook?servings=${portions}&batch=1`)} />
        </div>
      ) : (
        <Spinner />
      )}
    </SidePanel>
  );
}
