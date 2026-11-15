/**
 * Every stock action in one place, shared by Today, Stock, the item screen and
 * the scanner: Use (all / some / exact), Open, Freeze, Defrost, Move and Binned,
 * with the follow-up questions ("Is it opened now?", "Is there still some left?")
 * and Undo on every change.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { amountText, type EarmarkDto, formatQuantity, itemsText, MEAL_SLOTS, type MealSlot, oneItem, quickAmounts, type StockChangeDto, type StockItemDto, type UseAmountInput } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { useLocations, useStock, useUnits } from '../lib/queries';
import { amountLabel, longDate } from '../lib/format';
import { AmountSheet } from './AmountSheet';
import { Icon, locationIcon } from './Icon';
import { currentSlot, SLOT_LABEL } from './LogFood';
import { useToast } from './Toast';
import { Button, Field, Sheet, TextInput, Toggle } from './ui';

interface StockActions {
  use(item: StockItemDto): void;
  /** Use some of a pack; with `log`, it's also logged as eaten by you (one Undo for both). */
  useAmount(item: StockItemDto, amount: UseAmountInput, log?: { slot: MealSlot }): Promise<StockChangeDto | null>;
  open(item: StockItemDto): Promise<void>;
  freeze(item: StockItemDto): Promise<void>;
  defrost(item: StockItemDto): Promise<void>;
  move(item: StockItemDto): void;
  /** Change how much is left, for one pack or every pack on a stock row. */
  changeAmount(packs: StockItemDto[]): void;
  discard(item: StockItemDto): Promise<void>;
  /** Handle the follow-up questions after any use. */
  followUp(change: StockChangeDto): void;
}

const Ctx = createContext<StockActions | null>(null);

export function useStockActions(): StockActions {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStockActions outside StockActionsProvider');
  return c;
}

type Prompt = { kind: 'opened'; change: StockChangeDto } | { kind: 'still-some'; change: StockChangeDto };

interface PlanWarning {
  message: string;
  ingredientId: string;
  resolve: (choice: 'use' | 'cancel' | 'list') => void;
}

function weekday(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

/** Grams a use would take out of a pack. */
function gramsUsed(item: StockItemDto, amount: UseAmountInput): number {
  const left = item.remainingGrams ?? 0;
  if (amount.kind === 'all') return left;
  if (amount.kind === 'fraction') return left * amount.fraction;
  return Math.min(left, amount.grams);
}

export function StockActionsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [useFor, setUseFor] = useState<StockItemDto | null>(null);
  const [moveFor, setMoveFor] = useState<StockItemDto | null>(null);
  const [amountFor, setAmountFor] = useState<StockItemDto[] | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [warning, setWarning] = useState<PlanWarning | null>(null);
  const [freezeCheck, setFreezeCheck] = useState<{ item: StockItemDto; resolve: (go: boolean) => void } | null>(null);

  /** Planned meals don't lock stock, but using something they need gets a warning first. */
  const checkPlan = useCallback(
    async (item: StockItemDto, amount: UseAmountInput): Promise<boolean> => {
      if (!item.ingredientId || item.isMeal) return true;
      let marks: EarmarkDto[];
      try {
        marks = await qc.fetchQuery({ queryKey: ['plan', 'earmarks'], queryFn: () => api.get<EarmarkDto[]>('/api/plan/earmarks'), staleTime: 30_000 });
      } catch {
        return true;
      }
      const mark = marks.find((m) => m.ingredientId === item.ingredientId);
      if (!mark) return true;
      const stock = qc.getQueryData<StockItemDto[]>(['stock']) ?? [item];
      const have = stock.filter((s) => s.ingredientId === item.ingredientId && !s.isMeal).reduce((g, s) => g + (s.remainingGrams ?? 0), 0);
      const after = have - gramsUsed(item, amount);
      if (after >= mark.grams) return true;
      // The first planned meal that would go short.
      let running = after;
      const meal = mark.meals.find((m) => (running -= m.grams) < 0) ?? mark.meals[0]!;
      const leftFor = Math.max(0, running + meal.grams);
      const choice = await new Promise<'use' | 'cancel' | 'list'>((resolve) =>
        setWarning({
          ingredientId: item.ingredientId!,
          message: `This leaves ${amountText(leftFor, item)} for ${meal.title} on ${weekday(meal.date)}, which needs ${amountText(meal.grams, item)}.`,
          resolve,
        }),
      );
      setWarning(null);
      if (choice === 'cancel') return false;
      if (choice === 'list') {
        try {
          await api.post('/api/shopping', { ingredientId: item.ingredientId });
          await qc.invalidateQueries({ queryKey: ['shopping'] });
          toast.show('Added to the shopping list.');
        } catch (e) {
          toast.show(errorMessage(e), { tone: 'error' });
        }
      }
      return true;
    },
    [qc, toast],
  );

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['stock'] }), [qc]);

  const undo = useCallback(
    async (eventId: string) => {
      try {
        await api.post(`/api/events/${eventId}/undo`);
        toast.show('Undone.');
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
      }
      await refresh();
    },
    [refresh, toast],
  );

  const run = useCallback(
    async (fn: () => Promise<StockChangeDto>, message: (c: StockChangeDto) => string): Promise<StockChangeDto | null> => {
      try {
        const change = await fn();
        await refresh();
        // Used and logged: Undo removes the meal, which puts the food back too.
        const undoIt = change.entryId
          ? async () => {
              try {
                await api.del(`/api/plan/${change.entryId}?restoreStock=1`);
                toast.show('Undone.');
              } catch (e) {
                toast.show(errorMessage(e), { tone: 'error' });
              }
              await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['plan'] })]);
            }
          : change.eventIds && change.eventIds.length > 1
            ? async () => {
                // Took from more than one pack: put them all back, newest first.
                try {
                  for (const e of [...change.eventIds!].reverse()) await api.post(`/api/events/${e}/undo`);
                  toast.show('Undone.');
                } catch (e) {
                  toast.show(errorMessage(e), { tone: 'error' });
                }
                await refresh();
              }
            : () => undo(change.eventId);
        if (change.entryId) await qc.invalidateQueries({ queryKey: ['plan'] });
        toast.show(change.message ?? message(change), change.eventId ? { action: { label: 'Undo', onClick: undoIt } } : undefined);
        return change;
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
        return null;
      }
    },
    [refresh, toast, undo, qc],
  );

  const followUp = useCallback((change: StockChangeDto) => {
    const next: Prompt[] = [];
    if (change.askOpened) next.push({ kind: 'opened', change });
    if (change.askStillSome) next.push({ kind: 'still-some', change });
    if (next.length) setPrompts(next);
  }, []);

  const actions = useMemo<StockActions>(
    () => ({
      use: (item) => setUseFor(item),
      async useAmount(item, amount, log) {
        if (!(await checkPlan(item, amount))) return null;
        const change = await run(
          () => api.post<StockChangeDto>(`/api/stock/${item.id}/use`, { amount, ...(log ? { log } : {}) }),
          (c) =>
            `${c.item.fractionLeft <= 0 ? `Used up the ${item.productName}` : `Used some ${item.productName}`}${c.entryId && log ? ` and logged it to your ${SLOT_LABEL[log.slot].toLowerCase()}` : ''}.`,
        );
        if (change) followUp(change);
        return change;
      },
      async open(item) {
        await run(() => api.post<StockChangeDto>(`/api/stock/${item.id}/open`), (c) => `Opened. Best before is now ${longDate(c.item.bestBefore)}.`);
      },
      async freeze(item) {
        // Past its date or not great frozen: the household's call, after a word of warning.
        if (item.actions.freezeWarning) {
          const go = await new Promise<boolean>((resolve) => setFreezeCheck({ item, resolve }));
          setFreezeCheck(null);
          if (!go) return;
        }
        await run(() => api.post<StockChangeDto>(`/api/stock/${item.id}/freeze`), () => `${item.productName} is in the freezer.`);
      },
      async defrost(item) {
        await run(() => api.post<StockChangeDto>(`/api/stock/${item.id}/defrost`), (c) => `Defrosting in the ${c.item.locationName.toLowerCase()}. Use within a day or so.`);
      },
      move: (item) => setMoveFor(item),
      changeAmount: (packs) => setAmountFor(packs.length ? packs : null),
      async discard(item) {
        if (!(await checkPlan(item, { kind: 'all' }))) return;
        await run(() => api.post<StockChangeDto>(`/api/stock/${item.id}/discard`, {}), () => `Binned the ${item.productName}.`);
      },
      followUp,
    }),
    [run, followUp, checkPlan],
  );

  const prompt = prompts[0];
  const nextPrompt = () => setPrompts((p) => p.slice(1));

  return (
    <Ctx.Provider value={actions}>
      {children}
      <UseSheet item={useFor} onClose={() => setUseFor(null)} onUse={(item, amount, log) => void actions.useAmount(item, amount, log)} />
      <AmountSheet packs={amountFor} onClose={() => setAmountFor(null)} onReplace={setAmountFor} />
      <MoveSheet
        item={moveFor}
        onClose={() => setMoveFor(null)}
        onMove={(item, locationId) =>
          void run(() => api.post<StockChangeDto>(`/api/stock/${item.id}/move`, { locationId }), (c) => `Moved to the ${c.item.locationName}.`)
        }
      />
      <Sheet open={freezeCheck !== null} onClose={() => freezeCheck?.resolve(false)} title={`Freeze the ${freezeCheck?.item.productName ?? ''}?`}>
        {freezeCheck && (
          <div className="flex flex-col gap-3">
            <p>{freezeCheck.item.actions.freezeWarning}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => freezeCheck.resolve(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => freezeCheck.resolve(true)}>
                Freeze anyway
              </Button>
            </div>
          </div>
        )}
      </Sheet>
      <Sheet open={warning !== null} onClose={() => warning?.resolve('cancel')} title="Planned for a meal">
        {warning && (
          <div className="flex flex-col gap-3">
            <p>{warning.message}</p>
            <Button variant="dark" size="lg" onClick={() => warning.resolve('use')}>
              Use anyway
            </Button>
            <Button size="lg" onClick={() => warning.resolve('list')}>
              Use it and add to shopping list
            </Button>
            <Button variant="ghost" size="lg" onClick={() => warning.resolve('cancel')}>
              Cancel
            </Button>
          </div>
        )}
      </Sheet>
      <Sheet open={prompt?.kind === 'opened'} onClose={nextPrompt} title="Is it opened now?">
        {prompt?.kind === 'opened' && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">Opened food goes off sooner, so we'll update its date.</p>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" size="lg" onClick={nextPrompt}>
                No
              </Button>
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  void actions.open(prompt.change.item);
                  nextPrompt();
                }}
              >
                Yes, it's open
              </Button>
            </div>
          </div>
        )}
      </Sheet>
      <Sheet open={prompt?.kind === 'still-some'} onClose={nextPrompt} title="Is there still some left?">
        {prompt?.kind === 'still-some' && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">By our numbers the {prompt.change.item.productName} is about gone.</p>
            {(
              [
                ['yes', 'Yes, still some'],
                ['nearly-gone', 'Nearly gone'],
                ['none', 'None left'],
              ] as const
            ).map(([answer, label]) => (
              <Button
                key={answer}
                variant={answer === 'none' ? 'dark' : 'outline'}
                size="lg"
                onClick={() => {
                  void run(
                    () => api.post<StockChangeDto>(`/api/stock/${prompt.change.item.id}/still-some`, { answer }),
                    () => (answer === 'none' ? 'All gone.' : 'Thanks, updated.'),
                  );
                  nextPrompt();
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
      </Sheet>
    </Ctx.Provider>
  );
}

const LOG_KEY = 'so.use.log';

function rememberedLog(): boolean {
  try {
    return localStorage.getItem(LOG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Use: one at a time for counted food (an apple, an egg, a bar, a portion), else the whole pack,
 * part of it, or an exact amount. "Log it as eaten" also adds it to your diary (remembered on this
 * device), so eating something from the fridge is one step.
 */
function UseSheet({ item, onClose, onUse }: { item: StockItemDto | null; onClose: () => void; onUse: (item: StockItemDto, amount: UseAmountInput, log?: { slot: MealSlot }) => void }) {
  const [exact, setExact] = useState('');
  const [count, setCount] = useState(1);
  const [logIt, setLogIt] = useState(rememberedLog);
  const [slot, setSlot] = useState<MealSlot>(currentSlot);
  // The whole stock row: this pack (used first) and the others of the same food in the same place.
  const stock = useStock().data;
  const cupMl = useUnits().data?.cupMl ?? null;
  const row = item ? (stock ?? [item]).filter((s) => s.productId === item.productId && s.locationId === item.locationId && (s.state === 'frozen') === (item.state === 'frozen')) : [];
  const packs = row.length || 1;
  const total = row.some((s) => s.remainingGrams === null) ? null : row.reduce((n, s) => n + s.remainingGrams!, 0);
  const one = item ? oneItem(item, total) : null;
  const unit = item?.displayUnit === 'ml' ? 'ml' : one ? 'count' : 'g';
  const quick = item ? quickAmounts(item, total, cupMl) : [];
  const n = one ? Math.min(count, one.left) : 1;
  const thisPack = item?.remainingGrams ?? null;
  const choose = (amount: UseAmountInput) => {
    if (!item) return;
    onUse(item, amount, logIt ? { slot } : undefined);
    setExact('');
    setCount(1);
    onClose();
  };
  const setLog = (on: boolean) => {
    setLogIt(on);
    try {
      localStorage.setItem(LOG_KEY, on ? '1' : '0');
    } catch {
      // Remembering is a nicety.
    }
  };
  const exactGrams = () => {
    const v = Number(exact);
    if (!item || !Number.isFinite(v) || v <= 0) return null;
    if (unit === 'ml') return v * (item.densityGPerMl ?? 1);
    if (unit === 'count') return one ? v * one.grams : null;
    return v;
  };
  // Whole items from the row: all of this pack when that's exactly it, else by weight (spilling into the next pack).
  const itemsAmount = (k: number) => (thisPack !== null && Math.abs(k * one!.grams - thisPack) < 1 ? { kind: 'all' as const } : { kind: 'grams' as const, grams: k * one!.grams });
  const words = (k: number) => `${k} ${one!.name}${k === 1 ? '' : 's'}`;
  return (
    <Sheet open={item !== null} onClose={onClose} title={item ? `Use ${item.productName}` : 'Use'}>
      {item && (
        <div className="flex flex-col gap-4">
          <p className="text-muted">
            {[
              item.locationName,
              packs > 1 ? `${packs} packs` : null,
              total !== null ? itemsText(item, total) : null,
              total !== null ? formatQuantity(total, item.displayUnit === 'ml' ? 'ml' : 'g', { densityGPerMl: item.densityGPerMl }) : amountLabel(item),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="flex flex-col gap-2 rounded-lg bg-card-muted p-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">Log it as eaten</p>
                <p className="text-sm text-muted">{logIt ? `Adds it to your ${SLOT_LABEL[slot].toLowerCase()} today, with its calories.` : "Just using it, say in cooking: it isn't logged."}</p>
              </div>
              <Toggle checked={logIt} onChange={setLog} label="Log it as eaten" />
            </div>
            {logIt && (
              <div role="radiogroup" aria-label="Meal" className="flex self-start rounded-lg bg-card p-0.5">
                {MEAL_SLOTS.map((x) => (
                  <button
                    key={x}
                    type="button"
                    role="radio"
                    aria-checked={x === slot}
                    onClick={() => setSlot(x)}
                    className={`min-h-10 rounded-md px-2.5 text-sm font-medium lg:min-h-7 lg:px-2 ${x === slot ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted'}`}
                  >
                    {SLOT_LABEL[x]}
                  </button>
                ))}
              </div>
            )}
          </div>
          {one ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Button aria-label={`One fewer ${one.name}`} className="min-w-11 lg:min-w-8" disabled={n <= 1} onClick={() => setCount(Math.max(1, n - 1))}>
                  <Icon name="minus" className="size-4" />
                </Button>
                <Button variant="dark" size="lg" className="flex-1" onClick={() => choose(itemsAmount(n))}>
                  Use {words(n)}
                </Button>
                <Button aria-label={`One more ${one.name}`} className="min-w-11 lg:min-w-8" disabled={n >= one.left} onClick={() => setCount(Math.min(one.left, n + 1))}>
                  <Icon name="plus" className="size-4" />
                </Button>
              </div>
              <Button size="lg" onClick={() => choose({ kind: 'all' })}>
                {packs > 1 ? 'Used up this pack' : 'Used it all'}
              </Button>
            </div>
          ) : (
            <>
              {quick.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium">Used</p>
                  <div className="grid grid-cols-3 gap-2" role="group" aria-label="Quick amounts">
                    {quick.map((x) => (
                      <Button key={x.label} variant="outline" size="lg" className="px-2" aria-label={`Used ${x.label}`} onClick={() => choose({ kind: 'grams', grams: x.grams })}>
                        {x.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <Button variant="dark" size="lg" onClick={() => choose({ kind: 'all' })}>
                {packs > 1 ? 'Used up this pack' : 'Used it all'}
              </Button>
            </>
          )}
          <div>
            <p className="mb-2 text-sm font-medium">{packs > 1 ? 'Used some of this pack' : "Used some of what's left"}</p>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  [0.25, '¼'],
                  [0.5, '½'],
                  [0.75, '¾'],
                ] as const
              ).map(([f, label]) => (
                <Button key={f} variant="outline" size="lg" aria-label={`Used ${label}`} onClick={() => choose({ kind: 'fraction', fraction: f })}>
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {item.initialGrams !== null && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const g = exactGrams();
                if (g) choose({ kind: 'grams', grams: g });
              }}
            >
              <div className="flex-1">
                <Field label={`Exact amount (${unit === 'count' ? `${one!.name}s` : unit})${packs > 1 ? ', from any pack' : ''}`}>
                  {(id) => <TextInput id={id} inputMode="decimal" value={exact} onChange={(e) => setExact(e.target.value)} placeholder="Optional" />}
                </Field>
              </div>
              <Button type="submit" variant="outline" disabled={!exactGrams()}>
                Use
              </Button>
            </form>
          )}
        </div>
      )}
    </Sheet>
  );
}

function MoveSheet({ item, onClose, onMove }: { item: StockItemDto | null; onClose: () => void; onMove: (item: StockItemDto, locationId: string) => void }) {
  const locations = useLocations().data ?? [];
  return (
    <Sheet open={item !== null} onClose={onClose} title="Move to…">
      {item && (
        <div className="flex flex-col gap-2">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              disabled={l.id === item.locationId}
              onClick={() => {
                onMove(item, l.id);
                onClose();
              }}
              className="flex min-h-14 items-center gap-3 rounded-xl border border-line px-4 text-left disabled:opacity-50"
            >
              <Icon name={locationIcon(l.type)} className="size-5" />
              <span className="flex-1 font-medium">{l.name}</span>
              {l.type === 'freezer' && item.locationType !== 'freezer' && <span className="text-sm text-muted">freezes it</span>}
              {l.type !== 'freezer' && item.state === 'frozen' && <span className="text-sm text-muted">defrosts it</span>}
              {l.id === item.locationId && <span className="text-sm text-muted">here now</span>}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
