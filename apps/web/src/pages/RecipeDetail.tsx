import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BackButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, PageHeader, Sheet, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { minutesLabel } from '../lib/format';
import { scaledLine } from '../lib/recipeText';
import { useRecipe } from '../lib/queries';
import { RecipeImage } from './Recipes';

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
  const factor = n / r.serves;
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
      <PageHeader title={r.title} left={<BackButton to="/recipes" />} />
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          <RecipeImage recipe={r} className="h-52 w-full rounded-[18px] sm:h-72" />
          <p className="text-muted">
            {[minutesLabel(r.prepMinutes) && `Prep ${minutesLabel(r.prepMinutes)}`, minutesLabel(r.cookMinutes) && `Cook ${minutesLabel(r.cookMinutes)}`, r.kcalPerServing && `${r.kcalPerServing} kcal a serving`]
              .filter(Boolean)
              .join(' · ')}
            {r.sourceUrl && (
              <>
                {' · '}
                <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent-text">
                  Original recipe
                </a>
              </>
            )}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Link to={`/recipes/${r.id}/cook?servings=${n}`} className="inline-flex min-h-14 items-center justify-center rounded-xl bg-accent text-lg font-semibold text-accent-ink">
              Cook
            </Link>
            <Button size="lg" variant="outline" onClick={() => setBatchOpen(true)}>
              Batch cook
            </Button>
          </div>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-xl font-bold">Ingredients</h2>
              <div className="flex items-center gap-2" role="group" aria-label="Servings">
                <button type="button" aria-label="Fewer servings" disabled={n <= 1} onClick={() => setServings(n - 1)} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40">
                  −
                </button>
                <span className="min-w-20 text-center font-semibold" aria-live="polite">
                  Serves {n}
                </span>
                <button type="button" aria-label="More servings" onClick={() => setServings(n + 1)} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl">
                  +
                </button>
              </div>
            </div>
            <ul className="flex flex-col divide-y divide-line">
              {r.ingredients.map((l) => {
                const needed = l.grams === null ? null : l.grams * factor;
                const have = l.inStockGrams;
                const enough = needed !== null && have !== null && have >= needed;
                return (
                  <li key={l.id} className="flex items-start gap-3 py-2.5">
                    <span
                      aria-hidden
                      title={enough ? 'In stock' : 'Not enough in stock'}
                      className={`mt-2 size-2.5 shrink-0 rounded-full ${l.ingredientId === null ? 'bg-transparent' : enough ? 'bg-ink' : 'border border-muted bg-transparent'}`}
                    />
                    <span className="flex-1">
                      {scaledLine(l.text, l.amount, l.unit, r.serves, n)}
                      {l.optional && <span className="text-muted"> (optional)</span>}
                      {l.ingredientId && <span className="sr-only">{enough ? ' (in stock)' : ' (not enough in stock)'}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-sm text-muted">Filled dot: you have enough in stock.</p>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-xl font-bold">Method</h2>
            {r.steps.length ? (
              <ol className="flex list-decimal flex-col gap-3 pl-5">
                {r.steps.map((s, i) => (
                  <li key={i} className="pl-1 leading-relaxed">
                    {s}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted">No method yet.</p>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="mb-3 text-lg font-bold">Per serving</h2>
            {nutrition.kcal != null ? (
              <dl className="grid grid-cols-2 gap-y-2 text-[15px]">
                {(
                  [
                    ['kcal', 'Calories', ''],
                    ['protein', 'Protein', 'g'],
                    ['carbs', 'Carbs', 'g'],
                    ['fat', 'Fat', 'g'],
                  ] as const
                ).map(([k, label, unit]) =>
                  nutrition[k] != null ? (
                    <div key={k} className="contents">
                      <dt className="text-muted">{label}</dt>
                      <dd className="text-right font-semibold">
                        {Math.round(nutrition[k]!)}
                        {unit}
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            ) : (
              <p className="text-muted">Not enough is known about these ingredients yet.</p>
            )}
            {r.nutritionCoverage < 1 && nutrition.kcal != null && <p className="mt-3 text-sm text-muted">Based on {Math.round(r.nutritionCoverage * 100)}% of the ingredients.</p>}
          </Card>
          {r.tags.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {r.tags.map((t) => (
                <span key={t} className="rounded-full bg-card-muted px-3 py-1 text-sm">
                  {t}
                </span>
              ))}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Link to={`/recipes/${r.id}/edit`} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-card font-semibold">
              Edit
            </Link>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        </div>
      </div>

      <BatchSheet open={batchOpen} serves={r.serves} onClose={() => setBatchOpen(false)} onGo={(x) => navigate(`/recipes/${r.id}/cook?servings=${r.serves * x}&batch=1`)} />
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this recipe?">
        <p className="mb-4 text-muted">{r.title} will be gone for everyone. Leftovers already in stock stay.</p>
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <Button variant="dark" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function BatchSheet({ open, serves, onClose, onGo }: { open: boolean; serves: number; onClose: () => void; onGo: (multiplier: number) => void }) {
  const [x, setX] = useState(3);
  return (
    <Sheet open={open} onClose={onClose} title="Batch cook">
      <p className="mb-4 text-muted">Make several times the recipe in one go and keep the portions in the fridge and freezer.</p>
      <div className="mb-4 grid grid-cols-4 gap-2" role="group" aria-label="How many times the recipe">
        {[2, 3, 4, 6].map((m) => (
          <Button key={m} size="lg" variant={x === m ? 'dark' : 'outline'} aria-pressed={x === m} onClick={() => setX(m)}>
            ×{m}
          </Button>
        ))}
      </div>
      <p className="mb-4 font-semibold">{serves * x} portions</p>
      <Button variant="primary" size="lg" className="w-full" onClick={() => onGo(x)}>
        Continue
      </Button>
    </Sheet>
  );
}
