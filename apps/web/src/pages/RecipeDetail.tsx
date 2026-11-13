/** A recipe: ingredients (with what's in stock) next to the method, and Cook / Batch cook / Edit at the top. */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type RecipeDto, scaledLine } from '@snackoverflow/shared';
import { BackButton } from '../components/Layout';
import { Menu } from '../components/Menu';
import { useToast } from '../components/Toast';
import { PageTop } from '../components/Toolbar';
import { Button, Card, ErrorNote, Sheet, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { minutesLabel } from '../lib/format';
import { useRecipe } from '../lib/queries';
import { RecipeImage } from './Recipes';

export function recipeMeta(r: RecipeDto): string {
  return [minutesLabel(r.prepMinutes) && `Prep ${minutesLabel(r.prepMinutes)}`, minutesLabel(r.cookMinutes) && `Cook ${minutesLabel(r.cookMinutes)}`, r.kcalPerServing && `${r.kcalPerServing} kcal a serving`]
    .filter(Boolean)
    .join(' · ');
}

/** The ingredient list with a servings stepper; a filled dot means there's enough in stock. */
export function RecipeIngredients({ recipe: r, servings: n, onServings }: { recipe: RecipeDto; servings: number; onServings: (n: number) => void }) {
  const factor = n / r.serves;
  const step = 'inline-flex size-10 items-center justify-center rounded-lg border border-line text-lg disabled:opacity-40 lg:size-7 lg:rounded-md lg:text-base';
  return (
    <section aria-labelledby="ingredients-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="ingredients-heading" className="font-bold">
          Ingredients
        </h2>
        <div className="flex items-center gap-1.5" role="group" aria-label="Servings">
          <button type="button" aria-label="Fewer servings" disabled={n <= 1} onClick={() => onServings(n - 1)} className={step}>
            −
          </button>
          <span className="min-w-16 text-center text-sm font-semibold" aria-live="polite">
            Serves {n}
          </span>
          <button type="button" aria-label="More servings" onClick={() => onServings(n + 1)} className={step}>
            +
          </button>
        </div>
      </div>
      <ul className="divide-y divide-line text-[0.9375rem] lg:text-sm">
        {r.ingredients.map((l) => {
          const needed = l.grams === null ? null : l.grams * factor;
          const enough = needed !== null && l.inStockGrams !== null && l.inStockGrams >= needed;
          return (
            <li key={l.id} className="flex items-start gap-2.5 py-2">
              <span
                aria-hidden
                title={enough ? 'In stock' : 'Not enough in stock'}
                className={`mt-1.5 size-2 shrink-0 rounded-full ${l.ingredientId === null ? 'bg-transparent' : enough ? 'bg-fresh-green' : 'border border-muted bg-transparent'}`}
              />
              <span className="flex-1">
                {scaledLine(l.text, l.amount, r.serves, n)}
                {l.optional && <span className="text-muted"> (optional)</span>}
                {l.ingredientId && <span className="sr-only">{enough ? ' (in stock)' : ' (not enough in stock)'}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">Green dot: you have enough in stock.</p>
    </section>
  );
}

export function RecipeDetailPage() {
  const { id = '' } = useParams();
  const recipe = useRecipe(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [servings, setServings] = useState<number | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (recipe.isPending) return <Spinner />;
  if (recipe.error || !recipe.data) return <ErrorNote error={recipe.error ?? 'Not found'} />;
  const r = recipe.data;
  const n = servings ?? r.serves;
  const nutrition = r.nutritionPerServing;

  const remove = async () => {
    try {
      await api.del(`/api/recipes/${r.id}`);
      await qc.invalidateQueries({ queryKey: ['recipes'] });
      navigate('/recipes');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <>
      <PageTop
        title={r.title}
        subtitle={recipeMeta(r) || undefined}
        left={<BackButton to="/recipes" />}
        actions={
          <>
            <Link
              to={`/recipes/${r.id}/cook?servings=${n}`}
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-110 lg:min-h-8 lg:rounded-md lg:px-3"
            >
              Cook
            </Link>
            <span className="hidden sm:contents">
              <Button onClick={() => setBatchOpen(true)}>Batch cook</Button>
            </span>
            <Menu
              label="More for this recipe"
              items={[
                { label: 'Batch cook…', onSelect: () => setBatchOpen(true) },
                { label: 'Edit', icon: 'edit', onSelect: () => navigate(`/recipes/${r.id}/edit`) },
                ...(r.sourceUrl ? [{ label: 'Original recipe', icon: 'external' as const, onSelect: () => window.open(r.sourceUrl!, '_blank', 'noreferrer') }] : []),
                'divider',
                { label: 'Delete recipe', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(true) },
              ]}
            />
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <RecipeImage recipe={r} className="h-40 w-full rounded-xl lg:h-44 lg:rounded-lg" />
          <Card className="p-4">
            <RecipeIngredients recipe={r} servings={n} onServings={setServings} />
          </Card>
          <Card className="p-4">
            <h2 className="mb-2 font-bold">Per serving</h2>
            {nutrition.kcal != null ? (
              <dl className="grid grid-cols-4 gap-2 text-center">
                {(
                  [
                    ['kcal', 'kcal', ''],
                    ['protein', 'Protein', 'g'],
                    ['carbs', 'Carbs', 'g'],
                    ['fat', 'Fat', 'g'],
                  ] as const
                ).map(([k, label, unit]) => (
                  <div key={k} className="rounded-lg bg-card-muted px-1 py-2">
                    <dd className="font-bold tabular-nums">{nutrition[k] != null ? `${Math.round(nutrition[k]!)}${unit}` : '–'}</dd>
                    <dt className="text-xs text-muted">{label}</dt>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted">Not enough is known about these ingredients yet.</p>
            )}
            {r.nutritionCoverage < 1 && nutrition.kcal != null && <p className="mt-2 text-xs text-muted">Based on {Math.round(r.nutritionCoverage * 100)}% of the ingredients.</p>}
          </Card>
          {r.tags.length > 0 && (
            <p className="flex flex-wrap gap-1.5">
              {r.tags.map((t) => (
                <span key={t} className="rounded-full bg-card-muted px-2.5 py-0.5 text-xs font-medium">
                  {t}
                </span>
              ))}
            </p>
          )}
        </div>
        <Card className="self-start p-4 lg:p-6">
          <h2 className="mb-3 font-bold">Method</h2>
          {r.steps.length ? (
            <ol className="flex max-w-prose flex-col gap-4">
              {r.steps.map((s, i) => (
                <li key={i} className="flex gap-3 leading-relaxed">
                  <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-card-muted text-xs font-semibold">
                    {i + 1}
                  </span>
                  <span>
                    <span className="sr-only">Step {i + 1}: </span>
                    {s}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted">
              No method yet.{' '}
              <Link to={`/recipes/${r.id}/edit`} className="font-semibold text-accent-text">
                Add one
              </Link>
            </p>
          )}
        </Card>
      </div>

      <BatchSheet open={batchOpen} serves={r.serves} onClose={() => setBatchOpen(false)} onGo={(portions) => navigate(`/recipes/${r.id}/cook?servings=${portions}&batch=1`)} />
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this recipe?">
        <p className="mb-4 text-muted">{r.title} will be gone for everyone. Leftovers already in stock stay.</p>
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/** Batch cook: how many portions to make. The cook page then works exactly like a normal cook. */
export function BatchSheet({ open, serves, onClose, onGo }: { open: boolean; serves: number; onClose: () => void; onGo: (portions: number) => void }) {
  const [n, setN] = useState(serves * 3);
  const step = 'inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40';
  const times = n / serves;
  return (
    <Sheet open={open} onClose={onClose} title="Batch cook">
      <p className="mb-4 text-muted">Make lots in one go and keep the portions in the fridge and freezer.</p>
      <div className="mb-2 flex items-center justify-center gap-4" role="group" aria-label="Portions">
        <button type="button" aria-label="Fewer portions" disabled={n <= 1} onClick={() => setN(n - 1)} className={step}>
          −
        </button>
        <span className="min-w-28 text-center text-lg font-semibold" aria-live="polite">
          {n} {n === 1 ? 'portion' : 'portions'}
        </span>
        <button type="button" aria-label="More portions" onClick={() => setN(n + 1)} className={step}>
          +
        </button>
      </div>
      <p className="mb-4 text-center text-sm text-muted">
        The recipe serves {serves}
        {Number.isInteger(times) && times > 1 ? `, so that's ${times} times the recipe` : ''}.
      </p>
      <Button variant="primary" className="w-full" onClick={() => onGo(n)}>
        Continue
      </Button>
    </Sheet>
  );
}
