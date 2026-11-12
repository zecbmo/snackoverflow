import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { RecipeScore, RecipeSummaryDto } from '@snackoverflow/shared';
import { AddToPlanSheet, type PlanTarget } from '../components/AddToPlanSheet';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { minutesLabel } from '../lib/format';
import { useRecipes, useRecipeScores } from '../lib/queries';

/** Soft, food-neutral tints for recipes without a photo (not the freshness colours). */
const TINTS = ['bg-accent-soft', 'bg-card-muted'];

export function RecipeImage({ recipe, className = '' }: { recipe: Pick<RecipeSummaryDto, 'imageUrl' | 'title'>; className?: string }) {
  const [broken, setBroken] = useState(false);
  const tint = TINTS[recipe.title.length % TINTS.length];
  if (!recipe.imageUrl || broken) {
    return (
      <div aria-hidden className={`flex items-center justify-center ${tint} ${className}`}>
        <span className="font-display text-4xl font-bold text-muted/40">{recipe.title.charAt(0)}</span>
      </div>
    );
  }
  return <img src={recipe.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`object-cover ${className}`} />;
}

type Tab = 'all' | 'cook-now' | 'nearly' | 'use-it-up';

const TAB_HELP: Record<Tab, string> = {
  all: 'Every recipe, A to Z.',
  'cook-now': 'Everything they need is in stock.',
  nearly: 'Missing one to three things.',
  'use-it-up': 'Ranked by how much soon-to-expire food they use.',
};

function usesLine(s: RecipeScore, on: string): string | null {
  const soon = [...s.uses].filter((u) => u.bestBefore).sort((a, b) => (a.bestBefore ?? '').localeCompare(b.bestBefore ?? ''));
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const u of soon) {
    if (seen.has(u.ingredientId) || parts.length >= 3) continue;
    seen.add(u.ingredientId);
    const days = Math.round((Date.parse(`${u.bestBefore}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / 86_400_000);
    parts.push(`${u.name.toLowerCase()} (${days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `${days} days`})`);
  }
  return parts.length ? `Uses ${parts.join(', ')}` : null;
}

export function RecipesPage() {
  const recipes = useRecipes();
  const scores = useRecipeScores();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const tags = useMemo(() => [...new Set((recipes.data ?? []).flatMap((r) => r.tags))].sort().slice(0, 20), [recipes.data]);
  const byId = useMemo(() => new Map((scores.data?.scores ?? []).map((s) => [s.recipeId, s])), [scores.data]);
  const on = scores.data?.on ?? '';

  const inTab = (r: RecipeSummaryDto) => {
    const s = byId.get(r.id);
    if (tab === 'all') return true;
    if (!s) return false;
    if (tab === 'cook-now') return s.cookNow;
    if (tab === 'nearly') return !s.cookNow && s.missing.length >= 1 && s.missing.length <= 3;
    return s.uses.length > 0;
  };
  const counts: Record<Tab, number> = {
    all: recipes.data?.length ?? 0,
    'cook-now': (scores.data?.scores ?? []).filter((s) => s.cookNow).length,
    nearly: (scores.data?.scores ?? []).filter((s) => !s.cookNow && s.missing.length >= 1 && s.missing.length <= 3).length,
    'use-it-up': (scores.data?.scores ?? []).filter((s) => s.uses.length > 0).length,
  };
  let shown = (recipes.data ?? []).filter((r) => (!q || r.title.toLowerCase().includes(q.toLowerCase())) && (!tag || r.tags.includes(tag)) && inTab(r));
  if (tab === 'use-it-up') shown = shown.sort((a, b) => (byId.get(b.id)?.score ?? 0) - (byId.get(a.id)?.score ?? 0));
  if (tab === 'nearly') shown = shown.sort((a, b) => (byId.get(a.id)?.missing.length ?? 9) - (byId.get(b.id)?.missing.length ?? 9));

  return (
    <>
      <PageHeader
        title="Recipes"
        left={<MenuButton />}
        right={
          <div className="flex gap-2">
            <Link to="/recipes/import" className="inline-flex min-h-12 items-center gap-2 rounded-full bg-strong px-4 font-semibold text-strong-ink">
              <Icon name="download" className="size-5" />
              <span className="hidden sm:inline">Import URL</span>
              <span className="sm:hidden">Import</span>
            </Link>
            <Link to="/recipes/new" aria-label="New recipe" className="inline-flex size-12 items-center justify-center rounded-full border border-line bg-card">
              <Icon name="plus" />
            </Link>
          </div>
        }
      />
      <div role="tablist" aria-label="Which recipes" className="no-scrollbar -mx-4 mb-2 flex gap-1 overflow-x-auto px-4">
        <div className="flex min-w-full gap-1 rounded-2xl bg-card-muted p-1 sm:min-w-0">
          {(
            [
              ['all', 'All'],
              ['cook-now', 'Cook now'],
              ['nearly', 'Nearly there'],
              ['use-it-up', 'Use it up'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`min-h-11 flex-1 whitespace-nowrap rounded-xl px-3 text-[0.9375rem] font-semibold ${tab === t ? 'bg-card shadow-sm' : ''}`}
            >
              {label} <span className="text-muted">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-muted">{TAB_HELP[tab]}</p>
      <label className="mb-3 flex min-h-13 items-center gap-3 rounded-2xl border border-line bg-card px-4">
        <Icon name="search" className="size-5 text-muted" />
        <span className="sr-only">Search recipes</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes" className="min-h-12 flex-1 bg-transparent text-[1.0625rem] outline-none placeholder:text-muted" />
      </label>
      {tags.length > 0 && (
        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4" role="group" aria-label="Filter by tag">
          {[null, ...tags].map((t) => (
            <button
              key={t ?? 'all'}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(t)}
              className={`min-h-11 shrink-0 rounded-full border px-4 text-[0.9375rem] font-semibold ${tag === t ? 'border-strong bg-strong text-strong-ink' : 'border-line bg-card'}`}
            >
              {t ?? 'All tags'}
            </button>
          ))}
        </div>
      )}
      <ErrorNote error={recipes.error} />
      {recipes.isPending ? (
        <Spinner />
      ) : shown.length === 0 ? (
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
            <p>{tab === 'use-it-up' ? 'Nothing in stock is about to go off. Nice.' : 'Try another tab, or scan your shopping in.'}</p>
          )}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => {
            const s = byId.get(r.id);
            const uses = s && on ? usesLine(s, on) : null;
            return (
              <li key={r.id} className="flex flex-col overflow-hidden rounded-[18px] border border-line bg-card">
                <Link to={`/recipes/${r.id}`} className="block">
                  <RecipeImage recipe={r} className="h-32 w-full" />
                  <div className="flex items-start gap-3 px-4 pt-4">
                    <span className="flex-1 font-display text-xl font-semibold leading-snug">{r.title}</span>
                    <span className="whitespace-nowrap pt-1 text-[0.9375rem] text-muted">
                      {[minutesLabel(r.totalMinutes), r.kcalPerServing ? `${r.kcalPerServing} kcal` : null].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                </Link>
                <div className="flex flex-1 flex-col gap-1 px-4 pb-4 pt-1">
                  {uses && <p className="font-semibold text-fresh-green-text">{uses}</p>}
                  {s && (
                    <p className="text-muted">
                      {s.missing.length === 0 ? (s.cookNow ? 'Nothing missing' : 'Some of it is on the shopping list') : `Missing: ${s.missing.map((m) => m.name.toLowerCase()).join(', ')}`}
                    </p>
                  )}
                  <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
                    <button type="button" onClick={() => setPlanning({ kind: 'recipe', id: r.id, title: r.title, servings: r.serves })} className="min-h-12 rounded-xl bg-strong font-semibold text-strong-ink">
                      Add to plan
                    </button>
                    <button type="button" onClick={() => navigate(`/recipes/${r.id}/cook?servings=${r.serves}`)} className="min-h-12 rounded-xl border border-line font-semibold">
                      Cook now
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
    </>
  );
}
