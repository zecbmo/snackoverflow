/**
 * The one shared shopping list, grouped by aisle, rounded to real packs, with
 * what each thing is for. Tick things off in the shop, then put them away.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { addDays, formatPence, type ShoppingItemDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, EmptyState, ErrorNote, Field, PageHeader, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useIngredients, useRunningLow, useShopping, useSurplus, useUsers } from '../lib/queries';
import { AddToPlanSheet, type PlanTarget } from '../components/AddToPlanSheet';
import { SuggestSheet } from '../components/OptimiserSheets';

/** "Potatoes, 2.5kg bag", "Red peppers × 3", "Milk × 2". */
export function itemTitle(i: ShoppingItemDto): string {
  if (i.reason === 'plan' && i.packLabel) {
    return i.packs > 1 ? `${i.text}, ${i.packs} × ${i.packLabel}` : `${i.text}, ${i.packLabel}`;
  }
  return i.packs > 1 ? `${i.text} × ${i.packs}` : i.text;
}

function itemDetail(i: ShoppingItemDto): string {
  const parts: string[] = [];
  if (i.reason === 'plan' && i.forMeals) parts.push(i.forMeals);
  if (i.reason === 'running-low') parts.push('Running low');
  if (i.reason === 'manual' && i.addedByName) parts.push(`Added by ${i.addedByName}`);
  if (i.surplusGrams && i.surplusGrams >= 50 && i.surplusLabel) parts.push(`${i.surplusLabel} spare`);
  return parts.join(' · ');
}

export function ShoppingPage() {
  const me = useMe();
  const list = useShopping();
  const low = (useRunningLow().data ?? []).filter((l) => !l.onList);
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [putting, setPutting] = useState<{ added: number; needsScan: ShoppingItemDto[] } | null>(null);
  // Ticks not saved yet win over whatever the server last said, so a refresh can't flip them back.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const items = useMemo(() => (list.data ?? []).map((i) => (i.id in pending ? { ...i, checked: pending[i.id]! } : i)), [list.data, pending]);
  const toGet = items.filter((i) => !i.checked);
  const pricing = me.household.settings.pricingEnabled;
  const pricedToGet = toGet.filter((i) => i.pricePence !== null);
  const estimate = pricedToGet.length ? pricedToGet.reduce((sum, i) => sum + i.pricePence!, 0) : null;
  const ticked = items.filter((i) => i.checked);
  const aisles = useMemo(() => [...new Set(items.map((i) => i.aisle))], [items]);
  const surplus = useSurplus().data ?? [];
  const people = Math.max(1, useUsers().data?.length ?? 2);
  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const [ideasFor, setIdeasFor] = useState<{ id: string; name: string } | null>(null);
  const biggestSpare = items.filter((i) => !i.checked && (i.surplusGrams ?? 0) >= 200).sort((a, b) => (b.surplusGrams ?? 0) - (a.surplusGrams ?? 0))[0];

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
  const build = async () => {
    try {
      const r = await api.post<{ added: number; updated: number; covered: number }>('/api/shopping/build', { from: me.today, to: addDays(me.today, 6) });
      await refresh();
      toast.show(r.added + r.updated ? `Updated from the next 7 days of the plan.` : 'Nothing to add: stock covers the plan.');
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

  return (
    <>
      <PageHeader
        title="Shopping"
        subtitle={`${toGet.length} to get${pricing && estimate !== null ? ` · about ${formatPence(estimate)}` : ''}`}
        left={<MenuButton />}
        right={
          <button type="button" aria-label="Add to the list" onClick={() => setAdding(true)} className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
            <Icon name="plus" />
          </button>
        }
      />
      {biggestSpare && (
        <Card className="mb-4 border-accent/40 bg-accent-soft p-5">
          <p className="text-lg font-semibold">
            The {biggestSpare.packLabel ? `${biggestSpare.packLabel} ` : ''}
            {biggestSpare.text.toLowerCase()} leave {biggestSpare.surplusLabel} spare
          </p>
          {(() => {
            const hint = surplus.find((h) => h.ingredientId === biggestSpare.ingredientId);
            const idea = hint?.topIdea;
            return (
              <>
                <p className="text-muted">
                  {idea
                    ? `${idea.title} would use it${idea.missing.length ? ` (you'd also need ${idea.missing.join(', ').toLowerCase()})` : ''}.`
                    : `Shops sell whole packs. Plan something else with ${biggestSpare.text.toLowerCase()} this week so it gets used.`}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {idea && (
                    <Button variant="dark" onClick={() => setPlanning({ kind: 'recipe', id: idea.recipeId, title: idea.title, servings: people })}>
                      Add to plan
                    </Button>
                  )}
                  {hint && hint.ideas > (idea ? 1 : 0) ? (
                    <Button onClick={() => setIdeasFor({ id: hint.ingredientId, name: hint.name })}>More ideas</Button>
                  ) : (
                    !idea && (
                      <Link to="/recipes" className="inline-flex min-h-11 items-center rounded-xl bg-strong px-4 font-semibold text-strong-ink">
                        Find a recipe
                      </Link>
                    )
                  )}
                </div>
              </>
            );
          })()}
        </Card>
      )}
      <AddToPlanSheet target={planning} onClose={() => setPlanning(null)} />
      {ideasFor && <SuggestSheet open onClose={() => setIdeasFor(null)} defaultDate={me.today} ingredient={ideasFor} servings={people} />}
      {low.length > 0 && (
        <Card className="mb-4 flex items-center gap-3 p-4">
          <p className="flex-1">
            <span className="font-semibold">Running low:</span> {low.map((l) => l.name).join(', ')}
          </p>
          <Button variant="dark" onClick={() => void addLow()}>
            Add
          </Button>
        </Card>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:flex">
        <Button className="whitespace-nowrap px-2 sm:px-4" onClick={() => void build()}>
          Update from plan
        </Button>
        <Link to="/receipts" className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl border border-line bg-card px-2 text-[0.9375rem] font-semibold sm:px-4">
          Add from receipt
        </Link>
      </div>
      <ErrorNote error={list.error} />
      {list.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="The list is empty">
          <p>Plan some meals and tap “Update from plan”, or add things with +.</p>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-5 pb-24">
          {aisles.map((aisle) => (
            <section key={aisle}>
              <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wider text-muted">{aisle}</h2>
              <ul className="overflow-hidden rounded-[18px] border border-line bg-card">
                {items
                  .filter((i) => i.aisle === aisle)
                  .map((i) => (
                    <li key={i.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
                      <input
                        type="checkbox"
                        aria-label={`Got ${itemTitle(i)}`}
                        checked={i.checked}
                        onChange={() => void tick(i)}
                        className="size-7 shrink-0 rounded-lg accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[1.0625rem] font-semibold ${i.checked ? 'text-muted line-through' : ''}`}>{itemTitle(i)}</span>
                        {itemDetail(i) && <span className="block text-[0.9375rem] text-muted">{itemDetail(i)}</span>}
                      </span>
                      {pricing && i.pricePence !== null && <span className="whitespace-nowrap text-[1.0625rem] font-semibold text-muted">{formatPence(i.pricePence)}</span>}
                      <button type="button" aria-label={`Remove ${i.text}`} onClick={() => void remove(i)} className="inline-flex size-11 items-center justify-center rounded-full text-muted hover:bg-card-muted">
                        <Icon name="close" className="size-5" />
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {ticked.length > 0 && (
        <div className="fixed inset-x-4 bottom-24 z-20 mx-auto max-w-xl lg:bottom-6">
          <Button variant="primary" size="lg" className="w-full shadow-lg" onClick={() => void putAway()}>
            Put away {ticked.length} ticked item{ticked.length === 1 ? '' : 's'}
          </Button>
        </div>
      )}
      {adding && <AddItemSheet onClose={() => setAdding(false)} />}
      <Sheet open={putting !== null} onClose={() => setPutting(null)} title="Put away">
        {putting && (
          <div className="flex flex-col gap-3">
            <p>{putting.added ? `Added ${putting.added} to stock with estimated best-before dates.` : 'Nothing could be added in one tap.'}</p>
            {putting.needsScan.length > 0 && (
              <>
                <p className="text-muted">These need scanning so we know exactly what they are: {putting.needsScan.map((i) => i.text).join(', ')}.</p>
                <Link to="/scan" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-accent font-semibold text-accent-ink">
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

function AddItemSheet({ onClose }: { onClose: () => void }) {
  const ingredients = useIngredients().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [packs, setPacks] = useState(1);
  const match = text.trim().length >= 3 ? ingredients.find((i) => i.name.toLowerCase() === text.trim().toLowerCase()) : undefined;
  const suggestions = text.trim().length >= 2 ? ingredients.filter((i) => i.name.toLowerCase().includes(text.trim().toLowerCase())).slice(0, 5) : [];
  const add = async (body: Record<string, unknown>) => {
    try {
      await api.post('/api/shopping', { packs, ...body });
      await qc.invalidateQueries({ queryKey: ['shopping'] });
      toast.show('Added to the list.');
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  return (
    <Sheet open onClose={onClose} title="Add to the list">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void add(match ? { ingredientId: match.id } : { text: text.trim() });
        }}
      >
        <Field label="What" hint="Anything: an ingredient, or free text like “birthday candles”.">
          {(id) => <TextInput id={id} autoFocus value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        {suggestions.length > 0 && !match && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s.id} type="button" onClick={() => void add({ ingredientId: s.id })} className="min-h-11 rounded-full border border-line px-4 text-[0.9375rem]">
                {s.name}
              </button>
            ))}
          </div>
        )}
        <Field label="How many">
          {(id) => (
            <Select id={id} value={packs} onChange={(e) => setPacks(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" disabled={!text.trim()}>
          Add
        </Button>
      </form>
    </Sheet>
  );
}
