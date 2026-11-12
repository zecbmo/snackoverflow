/** "Suggest meals" and "Plan my week": the optimiser's ideas, which the cook picks from before anything is planned. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { addDays, type CalendarDate, formatPence, MEAL_SLOTS, type MealSlot, type RecipeScore } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { dayName } from './AddToPlanSheet';
import { useMe } from './Layout';
import { useToast } from './Toast';
import { Button, Card, ErrorNote, Field, Select, Sheet, Spinner } from './ui';

interface MealOption {
  stockItemId: string;
  title: string;
  portions: number;
  reason: string;
}

interface Suggestions {
  date: CalendarDate;
  recipes: RecipeScore[];
  meals: MealOption[];
}

export function SuggestSheet({
  open,
  onClose,
  defaultDate,
  ingredient,
  servings,
}: {
  open: boolean;
  onClose: () => void;
  defaultDate: CalendarDate;
  ingredient?: { id: string; name: string } | null;
  servings: number;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(defaultDate);
  const [slot, setSlot] = useState<MealSlot>('dinner');
  const days = Array.from({ length: 10 }, (_, i) => addDays(me.today, i));
  const q = useQuery({
    queryKey: ['stock', 'suggest', date, ingredient?.id ?? ''],
    queryFn: () => api.get<Suggestions>(`/api/optimiser/suggest?date=${date}${ingredient ? `&ingredient=${ingredient.id}` : ''}&servings=${servings}`),
    enabled: open,
  });
  const add = async (body: Record<string, unknown>, title: string) => {
    try {
      await api.post('/api/plan', { date, slot, servings, ...body });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(`${title} is planned for ${dayName(date, me.today).toLowerCase()}.`);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const pricing = me.household.settings.pricingEnabled;
  return (
    <Sheet open={open} onClose={onClose} title={ingredient ? `Ideas for the ${ingredient.name.toLowerCase()}` : 'Suggest meals'}>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Field label="Day">
          {(id) => (
            <Select id={id} value={date} onChange={(e) => setDate(e.target.value)}>
              {days.map((d) => (
                <option key={d} value={d}>
                  {dayName(d, me.today)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Meal">
          {(id) => (
            <Select id={id} value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)}>
              {MEAL_SLOTS.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <ErrorNote error={q.error} />
      {q.isPending ? (
        <Spinner />
      ) : (
        <ul className="flex flex-col gap-3">
          {q.data?.meals.map((m) => (
            <li key={m.stockItemId}>
              <Card className="flex items-center gap-3 p-4">
                <div className="flex-1">
                  <p className="font-semibold">{m.title}</p>
                  <p className="text-sm text-muted">{m.reason}</p>
                </div>
                <Button variant="dark" onClick={() => void add({ kind: 'stock', stockItemId: m.stockItemId, servings: Math.min(servings, m.portions) }, m.title)}>
                  Add
                </Button>
              </Card>
            </li>
          ))}
          {q.data?.recipes.map((r) => (
            <li key={r.recipeId}>
              <Card className="flex items-center gap-3 p-4">
                <div className="flex-1">
                  <p className="font-semibold">{r.title}</p>
                  <p className="text-sm text-muted">
                    {r.reason}
                    {pricing && r.extraCostPence ? ` Extras about ${formatPence(r.extraCostPence)}.` : ''}
                  </p>
                </div>
                <Button variant="dark" onClick={() => void add({ kind: 'recipe', recipeId: r.recipeId }, r.title)}>
                  Add
                </Button>
              </Card>
            </li>
          ))}
          {!q.data?.recipes.length && !q.data?.meals.length && <p className="text-muted">No ideas right now. Add some recipes, or check the no-repeat and excluded tags in Settings.</p>}
        </ul>
      )}
    </Sheet>
  );
}

interface Pick {
  date: CalendarDate;
  slot: MealSlot;
  kind: 'recipe' | 'stock';
  recipeId: string | null;
  stockItemId: string | null;
  title: string;
  reason: string;
  missing: string[];
  alternatives: { recipeId: string; title: string; reason: string }[];
}

export function PlanWeekSheet({ open, onClose, from, to, defaultServings }: { open: boolean; onClose: () => void; from: CalendarDate; to: CalendarDate; defaultServings: number }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [slots, setSlots] = useState<Set<MealSlot>>(new Set(['dinner']));
  const [servings, setServings] = useState(defaultServings);
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [busy, setBusy] = useState(false);
  const start = from < me.today ? me.today : from;

  const propose = async () => {
    setBusy(true);
    try {
      setPicks(await api.post<Pick[]>('/api/optimiser/plan-week', { from: start, to, slots: [...slots], servings }));
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const swap = (i: number) =>
    setPicks((ps) =>
      ps!.map((p, j) => {
        if (j !== i || !p.alternatives.length) return p;
        const [next, ...rest] = p.alternatives;
        const current = p.recipeId ? [{ recipeId: p.recipeId, title: p.title, reason: p.reason }] : [];
        return { ...p, kind: 'recipe', recipeId: next!.recipeId, stockItemId: null, title: next!.title, reason: next!.reason, missing: [], alternatives: [...rest, ...current] };
      }),
    );
  const save = async () => {
    setBusy(true);
    try {
      for (const p of picks ?? []) {
        await api.post('/api/plan', {
          date: p.date,
          slot: p.slot,
          servings,
          kind: p.kind,
          ...(p.kind === 'recipe' ? { recipeId: p.recipeId } : { stockItemId: p.stockItemId }),
        });
      }
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(`Planned ${picks?.length ?? 0} meals. Build the shopping list when you're ready.`);
      setPicks(null);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Plan my week">
      {!picks ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted">We'll fill the empty slots from {dayName(start, me.today).toLowerCase()} on, using up what goes off first. You can swap or remove anything before it's planned.</p>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Which meals</legend>
            <div className="flex flex-wrap gap-2">
              {(['breakfast', 'lunch', 'dinner'] as const).map((s) => (
                <label key={s} className={`flex min-h-11 items-center rounded-full border px-4 capitalize ${slots.has(s) ? 'border-ink bg-ink text-bg' : 'border-line'}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={slots.has(s)}
                    onChange={(e) =>
                      setSlots((cur) => {
                        const n = new Set(cur);
                        if (e.target.checked) n.add(s);
                        else n.delete(s);
                        return n;
                      })
                    }
                  />
                  {s}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center justify-between" role="group" aria-label="Servings">
            <span className="font-medium">Servings each meal</span>
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Fewer servings" disabled={servings <= 1} onClick={() => setServings(servings - 1)} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40">
                −
              </button>
              <span className="min-w-8 text-center font-semibold">{servings}</span>
              <button type="button" aria-label="More servings" onClick={() => setServings(servings + 1)} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl">
                +
              </button>
            </div>
          </div>
          <Button variant="primary" size="lg" disabled={busy || slots.size === 0} onClick={() => void propose()}>
            {busy ? 'Thinking…' : 'Make a plan'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {picks.length === 0 && <p className="text-muted">Nothing to fill: those slots are planned already, or there are no recipes to suggest.</p>}
          {picks.map((p, i) => (
            <Card key={`${p.date}${p.slot}`} className="p-4">
              <p className="text-sm font-semibold uppercase tracking-wider text-muted">
                {dayName(p.date, me.today)} · {p.slot}
              </p>
              <p className="text-lg font-semibold">{p.title}</p>
              <p className="text-sm text-muted">{p.reason}</p>
              <div className="mt-2 flex gap-2">
                {p.alternatives.length > 0 && (
                  <Button size="sm" onClick={() => swap(i)}>
                    Swap
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setPicks((ps) => ps!.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            </Card>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={() => setPicks(null)}>Back</Button>
            <Button variant="primary" disabled={busy || picks.length === 0} onClick={() => void save()}>
              Add {picks.length} to plan
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
