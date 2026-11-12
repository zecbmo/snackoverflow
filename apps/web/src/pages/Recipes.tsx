import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { RecipeSummaryDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { minutesLabel } from '../lib/format';
import { useRecipes } from '../lib/queries';

/** Soft, food-neutral tints for recipes without a photo (not the freshness colours). */
const TINTS = ['#EEEAFB', '#F1EFEA', '#E9EEF4', '#F4ECE6', '#ECF0EA'];

export function RecipeImage({ recipe, className = '' }: { recipe: Pick<RecipeSummaryDto, 'imageUrl' | 'title'>; className?: string }) {
  const [broken, setBroken] = useState(false);
  const tint = TINTS[recipe.title.length % TINTS.length];
  if (!recipe.imageUrl || broken) {
    return (
      <div aria-hidden className={`flex items-center justify-center ${className}`} style={{ background: tint }}>
        <span className="font-display text-4xl font-bold text-[#1a1c1a]/25">{recipe.title.charAt(0)}</span>
      </div>
    );
  }
  return <img src={recipe.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`object-cover ${className}`} />;
}

export function RecipesPage() {
  const recipes = useRecipes();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set((recipes.data ?? []).flatMap((r) => r.tags))].sort().slice(0, 20), [recipes.data]);
  const shown = (recipes.data ?? []).filter((r) => (!q || r.title.toLowerCase().includes(q.toLowerCase())) && (!tag || r.tags.includes(tag)));

  return (
    <>
      <PageHeader
        title="Recipes"
        left={<MenuButton />}
        right={
          <div className="flex gap-2">
            <Link to="/recipes/import" className="inline-flex min-h-12 items-center gap-2 rounded-full bg-ink px-4 font-semibold text-bg">
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
      <label className="mb-3 flex min-h-13 items-center gap-3 rounded-2xl border border-line bg-card px-4">
        <Icon name="search" className="size-5 text-muted" />
        <span className="sr-only">Search recipes</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes" className="min-h-12 flex-1 bg-transparent text-[17px] outline-none placeholder:text-muted" />
      </label>
      {tags.length > 0 && (
        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4" role="group" aria-label="Filter by tag">
          {[null, ...tags].map((t) => (
            <button
              key={t ?? 'all'}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(t)}
              className={`min-h-11 shrink-0 rounded-full border px-4 text-[15px] font-semibold ${tag === t ? 'border-ink bg-ink text-bg' : 'border-line bg-card'}`}
            >
              {t ?? 'All'}
            </button>
          ))}
        </div>
      )}
      <ErrorNote error={recipes.error} />
      {recipes.isPending ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <EmptyState title={recipes.data?.length ? 'Nothing matches' : 'No recipes yet'}>
          {!recipes.data?.length && (
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
          )}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <li key={r.id}>
              <Link to={`/recipes/${r.id}`} className="block overflow-hidden rounded-[18px] border border-line bg-card">
                <RecipeImage recipe={r} className="h-36 w-full" />
                <div className="flex items-start gap-3 p-4">
                  <span className="flex-1 font-display text-xl font-semibold leading-snug">{r.title}</span>
                  <span className="whitespace-nowrap pt-1 text-[15px] text-muted">
                    {[minutesLabel(r.totalMinutes), r.kcalPerServing ? `${r.kcalPerServing} kcal` : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
