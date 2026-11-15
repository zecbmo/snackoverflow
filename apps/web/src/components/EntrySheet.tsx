/**
 * The sheet for one meal or food, opened from the Calendar or from a diary row on Today.
 *
 * A recipe has servings, a person icon per portion, and Cooked it. A food (a snack, leftovers,
 * something logged from stock) is simpler: how much, in the food's own unit, with its calories;
 * who it's for; and whether it came from stock. The line owns the food it took, so changing the
 * amount, unticking it or removing it moves the difference in stock, and the sheet says so.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, amountText, type CalendarDate, MEAL_SLOTS, type MealSlot, type PlanEntryDto, type UserDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { useStock } from '../lib/queries';
import { Icon } from './Icon';
import { useMe } from './Layout';
import { SLOT_LABEL, stockable, useLogFood } from './LogFood';
import { PortionPicker } from './PortionIcons';
import { useToast } from './Toast';
import { Segmented } from './Toolbar';
import { Button, Field, Select, Sheet, TextInput, Toggle } from './ui';

export function dayLabel(d: CalendarDate, today: CalendarDate, long = false): string {
  const date = new Date(`${d}T12:00:00Z`);
  const name = date.toLocaleDateString('en-GB', { weekday: long ? 'long' : 'short', timeZone: 'UTC' });
  const num = date.getUTCDate();
  if (d === today) return `Today · ${name.slice(0, 3)} ${num}`;
  if (d === addDays(today, 1)) return `Tomorrow · ${name.slice(0, 3)} ${num}`;
  return `${name} ${num}`;
}

const plural = (n: number, word: string) => `${trim(n)} ${word}${n === 1 ? '' : 's'}`;
const trim = (n: number) => String(Math.round(n * 100) / 100);

/** True when a food's amount isn't a whole number of items, so it reads better as a weight. */
const byWeight = (e: Pick<PlanEntryDto, 'servings' | 'unitGrams'>) => e.unitGrams !== null && Math.abs(e.servings - Math.round(e.servings)) > 0.001;

/** A generic food measured per 100g (rice, chicken): always a weight. */
const perHundred = (e: PlanEntryDto) => e.kind === 'ingredient' && e.displayUnit !== 'count' && e.unitGrams !== null;

/** How many slices or items a pack-measured food comes to ("2 slices"), when it has them. */
function pieces(e: PlanEntryDto): { n: number; unit: string } | null {
  if (!e.pieceGrams || !e.pieceUnit || !e.unitGrams) return null;
  return { n: Math.round(((e.servings * e.unitGrams) / e.pieceGrams) * 2) / 2, unit: e.pieceUnit };
}

/** "2 servings", "1 item", "2 slices", "150g": the amount in the food's own unit. */
export function amountWords(e: PlanEntryDto): string {
  if (e.kind === 'text') return '';
  if (e.kind === 'recipe') return plural(e.servings, 'serving');
  const p = pieces(e);
  if (p) return plural(p.n, p.unit);
  if (e.kind === 'ingredient' && e.displayUnit === 'count' && e.countUnit) return plural(e.servings, e.countUnit);
  if (byWeight(e) || perHundred(e)) return amountText(e.servings * e.unitGrams!, { displayUnit: e.displayUnit });
  return plural(e.servings, e.kind === 'stock' ? 'portion' : 'item');
}

/** A short amount for a calendar card: "×2", "150g", "2 slices", or nothing for one of something. */
export function shortAmount(e: PlanEntryDto): string {
  if (e.kind === 'text') return '';
  if (pieces(e) || byWeight(e) || perHundred(e) || (e.kind === 'ingredient' && e.countUnit && e.servings !== 1)) return amountWords(e);
  return e.servings === 1 ? '' : `×${trim(e.servings)}`;
}

/** What moved in stock between two versions of a line: "50g more taken from stock." */
function stockNote(before: PlanEntryDto, after: PlanEntryDto): string | null {
  const diff = after.stockGrams - before.stockGrams;
  if (Math.abs(diff) < 0.5) return null;
  const amount = amountText(Math.abs(diff), { displayUnit: after.displayUnit === 'ml' ? 'ml' : 'g' });
  return diff > 0 ? `${amount}${before.stockGrams > 0.5 ? ' more' : ''} taken from stock.` : `${amount} put back in stock.`;
}

/** A − / + stepper: one at a time, or halves below one. */
const stepUp = (n: number) => n + (n >= 1 ? 1 : 0.5);
const stepDown = (n: number) => Math.max(0.5, n - (n > 1 ? 1 : 0.5));

/** − / + in grams or ml: an amount that suits the size of one item. */
function weightStep(unitGrams: number): number {
  return unitGrams > 1000 ? 100 : unitGrams > 300 ? 50 : unitGrams > 50 ? 10 : 5;
}

/**
 * How much of it, saved as you tap − or +: servings for a recipe, slices or items for food
 * eaten that way, portions for leftovers, else a weight (which can also be typed).
 */
function AmountEditor({ entry, onSaved }: { entry: PlanEntryDto; onSaved: (e: PlanEntryDto) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const piece = entry.pieceGrams && entry.unitGrams ? { grams: entry.pieceGrams, unit: entry.pieceUnit ?? 'item' } : null;
  const canWeigh = entry.kind !== 'recipe' && entry.unitGrams !== null;
  const unit = entry.displayUnit === 'ml' ? 'ml' : 'g';
  const [mode, setMode] = useState<'items' | 'weight'>(!piece && (byWeight(entry) || perHundred(entry)) ? 'weight' : 'items');
  // In "items", one step is a slice or item when the food has them, else one serving.
  const per = piece ? piece.grams / entry.unitGrams! : 1;
  const [count, setCount] = useState(Math.round((entry.servings / per) * 2) / 2);
  const [weight, setWeight] = useState(String(Math.round(entry.servings * (entry.unitGrams ?? 0))));
  const save = async (servings: number) => {
    try {
      const updated = await api.patch<PlanEntryDto>(`/api/plan/${entry.id}`, { servings: Math.round(servings * 10_000) / 10_000 });
      onSaved(updated);
      await Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
    } catch (e) {
      setCount(Math.round((entry.servings / per) * 2) / 2);
      setWeight(String(Math.round(entry.servings * (entry.unitGrams ?? 0))));
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const changeCount = (n: number) => {
    setCount(n);
    setWeight(String(Math.round(n * per * (entry.unitGrams ?? 0))));
    void save(n * per);
  };
  const grams = Number(weight);
  const weightValid = Number.isFinite(grams) && grams > 0 && entry.unitGrams !== null && grams / entry.unitGrams <= 100;
  const changeWeight = (g: number) => {
    if (!entry.unitGrams || g <= 0) return;
    setWeight(String(Math.round(g)));
    setCount(Math.round((g / entry.unitGrams / per) * 2) / 2);
    void save(g / entry.unitGrams);
  };
  const wStep = entry.unitGrams ? weightStep(entry.unitGrams) : 10;
  const noun = entry.kind === 'recipe' ? 'serving' : piece ? piece.unit : entry.kind === 'stock' ? 'portion' : entry.kind === 'ingredient' && entry.countUnit ? entry.countUnit : 'item';
  const step = 'inline-flex size-11 items-center justify-center rounded-full border border-line bg-card text-xl disabled:opacity-40 lg:size-8 lg:text-base';
  const kcal = entry.kcalPerServing !== null && !entry.batch ? Math.round(entry.kcalPerServing * entry.servings) : null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-card-muted p-3">
      {mode === 'items' ? (
        <div className="flex items-center gap-2" role="group" aria-label={entry.kind === 'recipe' ? 'Servings' : 'Amount'}>
          <button type="button" aria-label="Fewer" disabled={count <= 0.5} onClick={() => changeCount(stepDown(count))} className={step}>
            −
          </button>
          <span className="min-w-24 text-center font-semibold" aria-live="polite">
            {plural(count, noun)}
          </span>
          <button type="button" aria-label="More" disabled={count * per >= 100} onClick={() => changeCount(stepUp(count))} className={step}>
            +
          </button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (weightValid) changeWeight(grams);
          }}
        >
          <button type="button" aria-label="Less" disabled={!weightValid || grams <= wStep} onClick={() => changeWeight(Math.max(wStep, Math.ceil(grams / wStep - 1) * wStep))} className={step}>
            −
          </button>
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Amount ({unit})</span>
            <TextInput
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value.replace(/[^0-9.]/g, ''))}
              onBlur={() => weightValid && Math.abs(grams - entry.servings * entry.unitGrams!) > 0.5 && changeWeight(grams)}
              className="!w-24 text-right font-semibold"
            />
            <span className="text-muted">{unit}</span>
          </label>
          <button type="button" aria-label="More" disabled={!weightValid} onClick={() => changeWeight(Math.floor(grams / wStep + 1) * wStep)} className={step}>
            +
          </button>
        </form>
      )}
      {kcal !== null && entry.kind !== 'recipe' && (
        <span className="ml-auto font-semibold tabular-nums" aria-live="polite">
          {kcal} kcal
        </span>
      )}
      {canWeigh && !perHundred(entry) && (
        <span className={kcal !== null ? 'w-full' : 'ml-auto'}>
          <Segmented
            label="Measure by"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'items', label: piece ? `${piece.unit.charAt(0).toUpperCase()}${piece.unit.slice(1)}s` : entry.kind === 'stock' ? 'Portions' : 'Items' },
              { value: 'weight', label: unit === 'ml' ? 'Volume' : 'Weight' },
            ]}
          />
        </span>
      )}
      {canWeigh && mode === 'items' && !piece && entry.kind === 'product' && (
        <p className="w-full text-xs text-muted">One item is {amountText(entry.unitGrams!, { displayUnit: entry.displayUnit })}. For multipacks, set the size of one item on the product.</p>
      )}
    </div>
  );
}

export function EntrySheet({ entry: initial, viewerId, members, onClose }: { entry: PlanEntryDto; viewerId: string; members: Pick<UserDto, 'id' | 'name'>[]; onClose: () => void }) {
  const me = useMe();
  const logFood = useLogFood();
  const stock = useStock().data;
  const [entry, setEntry] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const isAdmin = me.user.role === 'admin';
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(entry.date);
  const [slot, setSlot] = useState<MealSlot>(entry.slot);
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(me.today, i - 1)), [me.today]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);

  // A food that's all one person's (or nobody's yet) is a simple line: one amount, one person.
  const food = entry.kind !== 'recipe' && entry.kind !== 'text';
  const owner = entry.people[0];
  const single = food && !entry.batch && (entry.people.length === 0 || (entry.people.length === 1 && Math.abs(owner!.portions - entry.servings) < 0.001));
  const eatenLine = single && Boolean(owner?.eaten);
  const anyEaten = entry.people.some((p) => p.eaten);
  const inStock =
    entry.kind === 'stock' ||
    (stock ?? []).some((s) => (entry.kind === 'product' ? s.productId === entry.productId : entry.kind === 'ingredient' ? s.ingredientId === entry.ingredientId && !s.isMeal : false));

  const saved = (updated: PlanEntryDto) => {
    setNote(stockNote(entry, updated));
    setEntry(updated);
  };

  const run = async (fn: () => Promise<unknown>, message: string, undo?: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
      toast.show(
        message,
        undo
          ? {
              action: {
                label: 'Undo',
                onClick: async () => {
                  try {
                    await undo();
                  } catch (e) {
                    toast.show(errorMessage(e), { tone: 'error' });
                  }
                  await refresh();
                },
              },
            }
          : undefined,
      );
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  /** Change who has it, where it came from, or make it a batch cook; stays open. */
  const patch = async (body: { people?: { userId: string; portions: number }[]; batch?: boolean; fromStock?: boolean }) => {
    const before = entry;
    // Show the change straight away; the server's answer (names, calories) follows.
    if (body.batch !== undefined) setEntry({ ...entry, batch: body.batch, people: body.batch ? [] : entry.people });
    if (body.fromStock !== undefined) setEntry({ ...entry, fromStock: body.fromStock });
    try {
      const updated = await api.patch<PlanEntryDto>(`/api/plan/${entry.id}`, body);
      setNote(body.fromStock && updated.fromStock === false ? "There's none in stock to take." : stockNote(before, updated));
      setEntry(updated);
      await refresh();
    } catch (e) {
      setEntry(before);
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  /** Removing a food puts back what it took; Undo logs it again. */
  const remove = () => {
    const back = entry.stockGrams > 0.5 ? ` ${amountText(entry.stockGrams, { displayUnit: entry.displayUnit === 'ml' ? 'ml' : 'g' })} put back in stock.` : '';
    const again =
      single || entry.kind === 'text'
        ? () =>
            api.post('/api/plan', {
              date: entry.date,
              slot: entry.slot,
              kind: entry.kind,
              productId: entry.productId,
              stockItemId: entry.stockItemId,
              ingredientId: entry.ingredientId,
              chainItemId: entry.chainItemId,
              ...(entry.kind === 'text' ? { text: entry.title, kcalPerServing: entry.kcalPerServing } : {}),
              servings: entry.servings,
              people: entry.people.map((p) => ({ userId: p.userId, portions: p.portions })),
              eaten: anyEaten,
              fromStock: entry.fromStock ?? false,
            })
        : undefined;
    void run(() => api.del(`/api/plan/${entry.id}`), `Removed.${back}`, again);
  };

  const ownerChoices = isAdmin ? members : members.filter((m) => m.id === me.user.id);
  const canPickOwner = isAdmin || !owner || owner.userId === me.user.id;
  const kcalLine = entry.kcalPerServing !== null && !entry.batch ? `${entry.kcalPerServing} kcal a serving` : null;

  return (
    <Sheet open onClose={onClose} title={entry.title}>
      <p className="mb-4 text-muted">
        {/* A food's amount and calories are in the stepper just below; a recipe's are here. */}
        {(food ? [SLOT_LABEL[entry.slot], dayLabel(entry.date, me.today), entry.detail] : [SLOT_LABEL[entry.slot], amountWords(entry), kcalLine]).filter(Boolean).join(' · ')}
      </p>
      {!moving && entry.kind !== 'text' && <AmountEditor key={entry.id} entry={entry} onSaved={saved} />}
      {!moving && single && (
        <div className="mb-4 flex flex-col divide-y divide-line rounded-lg bg-card-muted px-3">
          <label className="flex min-h-12 items-center justify-between gap-3 py-1.5 lg:min-h-10">
            <span className="text-sm font-medium">{eatenLine ? 'Who ate it' : "Who it's for"}</span>
            {canPickOwner ? (
              <Select
                className="!w-40"
                value={owner?.userId ?? ''}
                onChange={(e) => void patch({ people: e.target.value ? [{ userId: e.target.value, portions: entry.servings }] : [] })}
              >
                {ownerChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === me.user.id ? 'You' : m.name}
                  </option>
                ))}
                {!eatenLine && <option value="">Nobody yet</option>}
              </Select>
            ) : (
              <span className="text-sm">{owner!.name}</span>
            )}
          </label>
          {eatenLine && stockable(entry) && (entry.fromStock || inStock) && (
            <div className="flex min-h-12 items-center justify-between gap-3 py-1.5 lg:min-h-10">
              <span>
                <span className="block text-sm font-medium">From stock</span>
                <span className="block text-xs text-muted">{entry.fromStock ? 'What you ate is out of stock.' : "Ate it elsewhere: stock isn't touched."}</span>
              </span>
              <Toggle checked={entry.fromStock === true} onChange={(on) => void patch({ fromStock: on })} label="From stock" />
            </div>
          )}
        </div>
      )}
      {!moving && !single && entry.kind !== 'text' && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg bg-card-muted p-3">
          <p className="text-sm font-medium">Who's eating?</p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Giving someone a portion of a batch cook makes it an ordinary meal again. */}
            <PortionPicker entry={entry} viewerId={viewerId} meId={me.user.id} isAdmin={isAdmin} members={members} onChange={(people) => void patch(entry.batch ? { batch: false, people } : { people })} />
            {entry.kind === 'recipe' && entry.status === 'planned' && (
              <Button
                size="sm"
                variant={entry.batch ? 'dark' : 'outline'}
                aria-pressed={entry.batch}
                title="Frees every portion: made for the freezer, so it counts towards nobody's calories"
                className="ml-auto"
                onClick={() => void patch({ batch: !entry.batch })}
              >
                Batch cook
              </Button>
            )}
          </div>
        </div>
      )}
      {note && !moving && (
        <p role="status" className="mb-4 flex items-center gap-1.5 text-sm text-muted">
          <Icon name="box" className="size-4 shrink-0" /> {note}
        </p>
      )}
      {moving ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day">
              {(id) => (
                <Select id={id} value={date} onChange={(e) => setDate(e.target.value)}>
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {dayLabel(d, me.today, true)}
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
                      {SLOT_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {/* Something already eaten stays eaten; a planned meal goes back on the plan. */}
          <Button variant="primary" onClick={() => void run(() => api.patch(`/api/plan/${entry.id}`, anyEaten ? { date, slot } : { date, slot, status: 'planned' }), 'Moved.')}>
            Move it
          </Button>
        </div>
      ) : (
        <>
          {entry.swaps.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Icon name="move" className="size-4 text-muted" />
              <span className="flex-1">Swapped: {entry.swaps.map((x) => `${x.to} for ${x.from.toLowerCase()}`).join(', ')}.</span>
              {entry.status !== 'cooked' && (
                <Button size="sm" variant="ghost" onClick={() => void run(() => api.patch(`/api/plan/${entry.id}`, { swaps: null }), 'Back to the recipe as written.')}>
                  Undo swaps
                </Button>
              )}
            </div>
          )}
          {!single && !entry.batch && entry.people.length > 0 && (
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-medium">Who's eaten?</p>
              <div className="flex flex-wrap gap-1.5">
                {entry.people.map((p) => (
                  <button
                    key={p.userId}
                    type="button"
                    aria-pressed={p.eaten}
                    onClick={() => {
                      onClose();
                      void (p.eaten ? logFood.untickEaten(entry, p.userId) : logFood.tickEaten(entry, p.userId));
                    }}
                    className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 text-sm font-medium lg:min-h-7 ${p.eaten ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-ink hover:bg-card-muted'}`}
                  >
                    <Icon name={p.eaten ? 'check' : 'plus'} className="size-3.5" />
                    {p.userId === me.user.id ? 'You' : p.name}
                    <span className="sr-only">{p.eaten ? ': eaten (tap to untick)' : ': not yet (tap to tick)'}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">Tick anyone who's had theirs. Calories count once they're ticked.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {entry.kind === 'recipe' && entry.recipeId && entry.status !== 'cooked' && (
              <Button variant="primary" size="lg" onClick={() => navigate(`/recipes/${entry.recipeId}/cook?servings=${entry.servings}&entry=${entry.id}${entry.batch ? '&batch=1' : ''}`)}>
                Cooked it
              </Button>
            )}
            {single && !eatenLine && (
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  onClose();
                  void logFood.tickEaten(entry, owner?.userId ?? me.user.id);
                }}
              >
                Ate it
              </Button>
            )}
            {entry.kind !== 'recipe' && !single && !entry.batch && !entry.people.find((p) => p.userId === me.user.id)?.eaten && (
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  onClose();
                  void logFood.tickEaten(entry, me.user.id);
                }}
              >
                I've eaten mine
              </Button>
            )}
            {eatenLine ? (
              <Button
                size="lg"
                onClick={() => {
                  onClose();
                  void logFood.untickEaten(entry, owner!.userId);
                }}
              >
                Not eaten after all
              </Button>
            ) : entry.status === 'planned' ? (
              <Button size="lg" onClick={() => void run(() => api.patch(`/api/plan/${entry.id}`, { status: 'skipped' }), 'Skipped.')}>
                Skip
              </Button>
            ) : (
              <Button size="lg" onClick={() => void run(() => api.patch(`/api/plan/${entry.id}`, { status: 'planned' }), 'Back on the plan.')}>
                Not done yet
              </Button>
            )}
            <Button size="lg" onClick={() => setMoving(true)}>
              Move
            </Button>
            <Button size="lg" variant="danger" onClick={remove}>
              Remove
            </Button>
            {entry.recipeId && (
              <Link to={`/recipes/${entry.recipeId}`} className="col-span-2 inline-flex min-h-11 items-center justify-center font-semibold text-accent-text">
                Open the recipe
              </Link>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
