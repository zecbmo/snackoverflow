/** A recipe: ingredients (with what's in stock) next to the method, and Cook / Batch cook / Edit at the top. */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type RecipeDto, type RecipeIngredientDto, scaledLine, type SwapExclusionDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { AddToPlanSheet, type PlanTarget } from '../components/AddToPlanSheet';
import { BackButton } from '../components/Layout';
import { Menu } from '../components/Menu';
import { useToast } from '../components/Toast';
import { PageTop } from '../components/Toolbar';
import { Button, Card, ErrorNote, Sheet, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { minutesLabel } from '../lib/format';
import { useRecipe } from '../lib/queries';
import { useIsDesktop } from '../lib/useMedia';
import { RecipeImage } from './Recipes';

export function recipeMeta(r: RecipeDto): string {
  return [minutesLabel(r.prepMinutes) && `Prep ${minutesLabel(r.prepMinutes)}`, minutesLabel(r.cookMinutes) && `Cook ${minutesLabel(r.cookMinutes)}`, r.kcalPerServing && `${r.kcalPerServing} kcal a serving`]
    .filter(Boolean)
    .join(' · ');
}

/** Swaps chosen on a recipe: recipe line id -> the ingredient used instead. */
export type Swaps = Record<string, string>;

/** Set or clear one line's swap. */
export function withSwap(swaps: Swaps, lineId: string, ingredientId: string | null): Swaps {
  const next = { ...swaps };
  if (ingredientId) next[lineId] = ingredientId;
  else delete next[lineId];
  return next;
}

/** "lineId:ingredientId,..." for the cook page's address. */
export const swapsParam = (swaps: Swaps) =>
  Object.entries(swaps)
    .map(([l, i]) => `${l}:${i}`)
    .join(',');

/** "Chicken thighs for chicken breasts": what's swapped, in words. */
export function swapNote(r: RecipeDto, swaps: Swaps): string | null {
  const parts = Object.entries(swaps).flatMap(([lineId, ingId]) => {
    const l = r.ingredients.find((x) => x.id === lineId);
    const o = l && [...l.swaps.close, ...l.swaps.loose].find((x) => x.ingredientId === ingId);
    return l && o ? [`${o.name} for ${(l.ingredientName ?? l.text).toLowerCase()}`] : [];
  });
  return parts.length ? parts.join(', ') : null;
}

/**
 * The ingredient list with a servings stepper; a filled dot means there's enough in stock. A line
 * the house is short of shows a swap button when something else in stock could stand in: yellow
 * for a close swap (same swap group), orange for a loose one (same category).
 */
export function RecipeIngredients({
  recipe: r,
  servings: n,
  onServings,
  swaps = {},
  onSwap,
}: {
  recipe: RecipeDto;
  servings: number;
  onServings: (n: number) => void;
  swaps?: Swaps;
  onSwap?: (lineId: string, ingredientId: string | null) => void;
}) {
  const factor = n / r.serves;
  const step = 'inline-flex size-10 items-center justify-center rounded-lg border border-line text-lg disabled:opacity-40 lg:size-7 lg:rounded-md lg:text-base';
  // The line whose swaps are open (looked up fresh, so options taken away disappear).
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const choosing = choosingId ? (r.ingredients.find((l) => l.id === choosingId) ?? null) : null;
  const setChoosing = (l: RecipeIngredientDto | null) => setChoosingId(l?.id ?? null);
  const qc = useQueryClient();
  const toast = useToast();
  /** "Pesto isn't a swap for stock cubes": never offer either for the other again (Undo, or Settings → Swap groups). */
  const notASwap = async (line: RecipeIngredientDto, option: { ingredientId: string; name: string }) => {
    try {
      const list = await api.post<SwapExclusionDto[]>('/api/swap-exclusions', { ingredientId: line.ingredientId, otherIngredientId: option.ingredientId });
      if (swaps[line.id] === option.ingredientId) onSwap?.(line.id, null);
      // Close the sheet so the toast's Undo can be reached.
      setChoosingId(null);
      await qc.invalidateQueries({ queryKey: ['recipes'] });
      const made = list.find((x) => x.ingredients.some((i) => i.id === option.ingredientId) && x.ingredients.some((i) => i.id === line.ingredientId));
      const forWhat = (line.ingredientName ?? line.text).toLowerCase();
      toast.show(`${option.name} won't be offered for ${forWhat} again.`, {
        action: made
          ? {
              label: 'Undo',
              onClick: async () => {
                await api.del(`/api/swap-exclusions/${made.id}`);
                await qc.invalidateQueries({ queryKey: ['recipes'] });
              },
            }
          : undefined,
      });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const hasSwaps = r.ingredients.some((l) => l.swaps.close.length || l.swaps.loose.length);
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
          const swapped = swaps[l.id] ? [...l.swaps.close, ...l.swaps.loose].find((o) => o.ingredientId === swaps[l.id]) : undefined;
          const have = swapped ? swapped.inStockGrams : l.inStockGrams;
          const enough = needed !== null && have !== null && have >= needed;
          const close = l.swaps.close.length > 0;
          const canSwap = onSwap && (close || l.swaps.loose.length > 0);
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
                {swapped && <span className="block text-sm font-medium text-ink">Using {swapped.name.toLowerCase()} instead</span>}
              </span>
              {canSwap && (
                <button
                  type="button"
                  onClick={() => setChoosing(l)}
                  aria-label={`${close ? 'Close' : 'Loose'} swaps for ${l.ingredientName ?? l.text}`}
                  className={`-my-1 inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold lg:min-h-7 ${
                    close ? 'bg-swap-close-soft text-swap-close-text' : 'bg-swap-loose-soft text-swap-loose-text'
                  }`}
                >
                  <span aria-hidden className={`size-2 rounded-full ${close ? 'bg-swap-close' : 'bg-swap-loose'}`} />
                  {swapped ? 'Swapped' : 'Swap'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">
        Green dot: you have enough in stock.
        {hasSwaps && onSwap && ' Swap: something else you have could stand in (yellow is a close match, orange less so).'}
      </p>
      {choosing && onSwap && (
        <Sheet open onClose={() => setChoosing(null)} title={`Instead of ${(choosing.ingredientName ?? choosing.text).toLowerCase()}`}>
          <div className="flex flex-col gap-4">
            {!choosing.swaps.close.length && !choosing.swaps.loose.length && <p className="text-muted">Nothing else you have would do.</p>}
            {(
              [
                ['close', 'Close swaps', choosing.swaps.close],
                ['loose', 'Same kind of food', choosing.swaps.loose],
              ] as const
            ).map(
              ([kind, title, options]) =>
                options.length > 0 && (
                  <section key={kind}>
                    <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
                      <span aria-hidden className={`size-2 rounded-full ${kind === 'close' ? 'bg-swap-close' : 'bg-swap-loose'}`} />
                      {title}
                    </h3>
                    <ul className="flex flex-col gap-2">
                      {options.map((o) => (
                        <li key={o.ingredientId} className="flex gap-2">
                          <Button
                            className="min-w-0 flex-1 justify-between"
                            variant={swaps[choosing.id] === o.ingredientId ? 'primary' : 'outline'}
                            onClick={() => {
                              onSwap(choosing.id, o.ingredientId);
                              setChoosing(null);
                            }}
                          >
                            <span className="truncate">{o.name}</span>
                            <span className="font-normal">{o.amount} in</span>
                          </Button>
                          <button
                            type="button"
                            aria-label={`${o.name} isn't a swap for ${(choosing.ingredientName ?? choosing.text).toLowerCase()}`}
                            title="Not a good swap: don't offer it for this again"
                            onClick={() => void notASwap(choosing, o)}
                            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-line text-muted hover:bg-card-muted hover:text-ink lg:size-8 lg:rounded-md"
                          >
                            <Icon name="close" className="size-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ),
            )}
            <Button
              variant="ghost"
              onClick={() => {
                onSwap(choosing.id, null);
                setChoosing(null);
              }}
            >
              Use {(choosing.ingredientName ?? choosing.text).toLowerCase()} as the recipe says
            </Button>
            <p className="text-sm text-muted">
              Close swaps come from your{' '}
              <Link to="/swap-groups" className="font-semibold text-accent-text">
                swap groups
              </Link>
              . Tap ✕ on one that isn&apos;t a good fit and it won&apos;t be offered for this food again.
            </p>
          </div>
        </Sheet>
      )}
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
  const [fullTitle, setFullTitle] = useState(false);
  const [swaps, setSwaps] = useState<Swaps>({});
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const desktop = useIsDesktop();

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

  const cookLink = (
    <Link
      to={`/recipes/${r.id}/cook?servings=${n}${Object.keys(swaps).length ? `&swaps=${swapsParam(swaps)}` : ''}`}
      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-110 lg:min-h-8 lg:rounded-md lg:px-3"
    >
      Cook
    </Link>
  );
  const moreMenu = (
    <Menu
      label="More for this recipe"
      items={[
        { label: 'Add to calendar…', icon: 'calendar', onSelect: () => setPlanning({ kind: 'recipe', id: r.id, title: r.title, servings: n, swaps, swapNote: swapNote(r, swaps) }) },
        ...(desktop ? [{ label: 'Batch cook…', onSelect: () => setBatchOpen(true) }] : []),
        { label: 'Edit', icon: 'edit', onSelect: () => navigate(`/recipes/${r.id}/edit`) },
        ...(r.sourceUrl ? [{ label: 'Original recipe', icon: 'external' as const, onSelect: () => window.open(r.sourceUrl!, '_blank', 'noreferrer') }] : []),
        'divider',
        { label: 'Delete recipe', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(true) },
      ]}
    />
  );

  return (
    <>
      {desktop ? (
        <PageTop
          title={r.title}
          subtitle={recipeMeta(r) || undefined}
          left={<BackButton to="/recipes" />}
          actions={
            <>
              {cookLink}
              <Button onClick={() => setBatchOpen(true)}>Batch cook</Button>
              {moreMenu}
            </>
          }
        />
      ) : (
        // Phones: Cook and Batch cook stay in reach while scrolling; the title gets the full width
        // under them (two lines, tap for the rest).
        <header className="sticky top-0 z-20 -mx-4 mb-3 border-b border-line bg-bg/95 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex items-center gap-2">
            <BackButton to="/recipes" />
            <span className="flex-1" />
            {cookLink}
            <Button onClick={() => setBatchOpen(true)}>Batch cook</Button>
            {moreMenu}
          </div>
          <button type="button" onClick={() => setFullTitle((f) => !f)} aria-expanded={fullTitle} className="mt-2 block w-full text-left">
            <h1 className={`text-xl font-bold leading-tight ${fullTitle ? '' : 'line-clamp-2'}`}>{r.title}</h1>
            {recipeMeta(r) && <p className="mt-0.5 text-sm text-muted">{recipeMeta(r)}</p>}
          </button>
        </header>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <RecipeImage recipe={r} className="h-40 w-full rounded-xl lg:h-44 lg:rounded-lg" />
          <Card className="p-4 max-lg:order-2">
            <RecipeIngredients recipe={r} servings={n} onServings={setServings} swaps={swaps} onSwap={(line, ing) => setSwaps((s) => withSwap(s, line, ing))} />
          </Card>
          <Card className="p-4 max-lg:order-1">
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
            <p className="flex flex-wrap gap-1.5 max-lg:order-3">
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

      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
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
