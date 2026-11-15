/**
 * Every stock action in one place, shared by Today, Stock, the item screen and
 * the scanner: Use (an amount from the row, then "Just use it" or "I ate it"), Open, Freeze,
 * Defrost, Move and Binned, with Undo on every change.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import {
  amountText,
  type EarmarkDto,
  formatQuantity,
  isStarted,
  itemOf,
  itemsText,
  MEAL_SLOTS,
  type MealSlot,
  orderForUse,
  quickAmounts,
  readyToEat,
  type StockChangeDto,
  type StockItemDto,
  type UseAmountInput,
  outcomeOfUse,
  stepForUse,
} from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { useEarmarks, useLocations, useStock, useUnits } from '../lib/queries';
import { longDate } from '../lib/format';
import { AmountSheet } from './AmountSheet';
import { Icon, locationIcon } from './Icon';
import { currentSlot, SLOT_LABEL } from './LogFood';
import { useToast } from './Toast';
import { Button, Select, Sheet, TextInput } from './ui';

/** What the Use sheet asks for. */
export interface UseRequest {
  amount: UseAmountInput;
  /** With "all": everything on the row, not just one pack. */
  wholeRow?: boolean;
  /** "That finished the pack": empty it, whatever the numbers say. */
  finishOpen?: boolean;
  /** Also add the food to the shopping list (a planned meal would go short). */
  addToList?: boolean;
}

interface StockActions {
  use(item: StockItemDto): void;
  /** Use food from a stock row; with `log`, it's also logged as eaten by you (one Undo for both). */
  useRow(item: StockItemDto, request: UseRequest, log?: { slot: MealSlot }): Promise<StockChangeDto | null>;
  open(item: StockItemDto): Promise<void>;
  freeze(item: StockItemDto): Promise<void>;
  defrost(item: StockItemDto): Promise<void>;
  move(item: StockItemDto): void;
  /** Change how much is left, for one pack or every pack on a stock row. */
  changeAmount(packs: StockItemDto[]): void;
  discard(item: StockItemDto): Promise<void>;
}

const Ctx = createContext<StockActions | null>(null);

export function useStockActions(): StockActions {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStockActions outside StockActionsProvider');
  return c;
}

interface PlanWarning {
  message: string;
  ingredientId: string;
  resolve: (choice: 'use' | 'cancel' | 'list') => void;
}

function weekday(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

/**
 * Planned meals don't lock stock, but using food they need is worth a word first. Says which
 * planned meal would go short if `usedGrams` of this food went; null when there's enough.
 */
export function planShortfall(item: StockItemDto, usedGrams: number, marks: EarmarkDto[] | undefined, stock: StockItemDto[]): string | null {
  if (!item.ingredientId || item.isMeal || !marks) return null;
  const mark = marks.find((m) => m.ingredientId === item.ingredientId);
  if (!mark) return null;
  const have = stock.filter((s) => s.ingredientId === item.ingredientId && !s.isMeal).reduce((g, s) => g + (s.remainingGrams ?? 0), 0);
  const after = have - usedGrams;
  if (after >= mark.grams) return null;
  let running = after;
  const meal = mark.meals.find((m) => (running -= m.grams) < 0) ?? mark.meals[0]!;
  const leftFor = Math.max(0, running + meal.grams);
  return `This leaves ${amountText(leftFor, item)} for ${meal.title} on ${weekday(meal.date)}, which needs ${amountText(meal.grams, item)}.`;
}

/** An amount in the unit the food is used in: "2 slices", "250ml", "1.3kg". */
export function inUnits(item: StockItemDto, grams: number): string {
  return itemsText(item, grams) ?? formatQuantity(grams, item.displayUnit === 'ml' ? 'ml' : 'g', { densityGPerMl: item.densityGPerMl });
}

/** "Used 250g of Chicken Thighs. 2.3kg left." Always about the food, never one pack. */
function usedMessage(item: StockItemDto, c: StockChangeDto, slot?: MealSlot): string {
  const amount = c.usedGrams != null ? inUnits(item, c.usedGrams) : null;
  const left = c.rowLeft;
  const gone = left ? left.packs === 0 : c.item.fractionLeft <= 0;
  const what = amount ? `${amount} of ${item.productName}` : `some ${item.productName}`;
  const head = slot ? `Logged ${what} to your ${SLOT_LABEL[slot].toLowerCase()}.` : gone ? `Used the last of the ${item.productName}.` : `Used ${what}.`;
  const tail = gone ? (slot ? " That's the last of it." : '') : left?.grams != null ? ` ${inUnits(item, left.grams)} left.` : '';
  const opened = c.opened && !gone ? ` It's open now: best before ${longDate(c.item.bestBefore)}.` : '';
  return `${head}${tail}${opened}${c.message ? ` ${c.message}` : ''}`;
}

export function StockActionsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [useFor, setUseFor] = useState<StockItemDto | null>(null);
  const [moveFor, setMoveFor] = useState<StockItemDto | null>(null);
  const [amountFor, setAmountFor] = useState<StockItemDto[] | null>(null);
  const [warning, setWarning] = useState<PlanWarning | null>(null);
  const [freezeCheck, setFreezeCheck] = useState<{ item: StockItemDto; resolve: (go: boolean) => void } | null>(null);

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
                // Added to a line already in the diary: back to what it was. Else the line goes. Either way the food goes back.
                if (change.entryWas !== undefined) await api.patch(`/api/plan/${change.entryId}`, { servings: change.entryWas });
                else await api.del(`/api/plan/${change.entryId}`);
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

  const addToList = useCallback(
    async (ingredientId: string) => {
      try {
        await api.post('/api/shopping', { ingredientId });
        await qc.invalidateQueries({ queryKey: ['shopping'] });
        toast.show('Added to the shopping list.');
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
      }
    },
    [qc, toast],
  );

  /** Binning something a planned meal needs gets a warning first. */
  const checkPlan = useCallback(
    async (item: StockItemDto): Promise<boolean> => {
      if (!item.ingredientId || item.isMeal) return true;
      let marks: EarmarkDto[];
      try {
        marks = await qc.fetchQuery({ queryKey: ['plan', 'earmarks'], queryFn: () => api.get<EarmarkDto[]>('/api/plan/earmarks'), staleTime: 30_000 });
      } catch {
        return true;
      }
      const message = planShortfall(item, item.remainingGrams ?? 0, marks, qc.getQueryData<StockItemDto[]>(['stock']) ?? [item]);
      if (!message) return true;
      const choice = await new Promise<'use' | 'cancel' | 'list'>((resolve) => setWarning({ ingredientId: item.ingredientId!, message, resolve }));
      setWarning(null);
      if (choice === 'cancel') return false;
      if (choice === 'list') await addToList(item.ingredientId);
      return true;
    },
    [qc, addToList],
  );

  const actions = useMemo<StockActions>(
    () => ({
      use: (item) => setUseFor(item),
      async useRow(item, request, log) {
        const { addToList: list, ...body } = request;
        const change = await run(
          () => api.post<StockChangeDto>(`/api/stock/${item.id}/use`, { ...body, ...(log ? { log } : {}) }),
          (c) => usedMessage(item, c, c.entryId && log ? log.slot : undefined),
        );
        if (change && list && item.ingredientId) await addToList(item.ingredientId);
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
        if (!(await checkPlan(item))) return;
        await run(() => api.post<StockChangeDto>(`/api/stock/${item.id}/discard`, {}), () => `Binned the ${item.productName}.`);
      },
    }),
    [run, checkPlan, addToList],
  );

  return (
    <Ctx.Provider value={actions}>
      {children}
      <UseSheet item={useFor} onClose={() => setUseFor(null)} onUse={(item, request, log) => void actions.useRow(item, request, log)} />
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
              Bin it anyway
            </Button>
            <Button size="lg" onClick={() => warning.resolve('list')}>
              Bin it and add to shopping list
            </Button>
            <Button variant="ghost" size="lg" onClick={() => warning.resolve('cancel')}>
              Cancel
            </Button>
          </div>
        )}
      </Sheet>
    </Ctx.Provider>
  );
}

/**
 * Use: how much, then what for. The amount is the main thing, in the food's own unit (g, ml,
 * slices, eggs, portions); the quick amounts only fill it in. One line says what that will do
 * to the row before anything happens, and two buttons commit it: "Just use it" (out of stock
 * only) or "I ate it" (out of stock and into your diary). Packs stay out of it: food comes from
 * the pack that's open, then the next.
 */
function UseSheet({ item, onClose, onUse }: { item: StockItemDto | null; onClose: () => void; onUse: (item: StockItemDto, request: UseRequest, log?: { slot: MealSlot }) => void }) {
  return (
    <Sheet open={item !== null} onClose={onClose} title={item ? `Use ${item.productName}` : 'Use'}>
      {item && <UseForm key={item.id} item={item} onClose={onClose} onUse={onUse} />}
    </Sheet>
  );
}

const FRACTIONS = [
  [0.25, '¼'],
  [0.5, '½'],
  [0.75, '¾'],
] as const;

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const PRESSED = 'aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-text';

function UseForm({ item, onClose, onUse }: { item: StockItemDto; onClose: () => void; onUse: (item: StockItemDto, request: UseRequest, log?: { slot: MealSlot }) => void }) {
  const actions = useStockActions();
  const stock = useStock().data;
  const marks = useEarmarks().data;
  const cupMl = useUnits().data?.cupMl ?? null;
  const [text, setText] = useState('');
  const [part, setPart] = useState<number | 'all' | null>(null);
  const [finish, setFinish] = useState(false);
  const [list, setList] = useState(false);
  const [slot, setSlot] = useState<MealSlot>(currentSlot);

  // The whole stock row, in the order it's used: the open pack, then the others of this food in this place.
  const row = useMemo(
    () => orderForUse((stock ?? [item]).filter((s) => s.productId === item.productId && s.locationId === item.locationId && (s.state === 'frozen') === (item.state === 'frozen'))),
    [stock, item],
  );
  const packs = row.length ? row : [item];
  const total = packs.some((s) => s.remainingGrams === null) ? null : packs.reduce((n, s) => n + s.remainingGrams!, 0);
  const one = itemOf(item);
  const unit = one ? 'count' : item.displayUnit === 'ml' ? 'ml' : 'g';
  const perUnit = one ? one.grams : unit === 'ml' ? (item.densityGPerMl ?? 1) : 1;
  const suffix = one ? `${one.name}s` : unit;
  const step = stepForUse(item);
  const said = (grams: number) => inUnits(item, grams);

  // Sizes known: an amount. Not known: all of the pack, or a rough share of it.
  const value = Number(text);
  const grams = total === null ? null : Number.isFinite(value) && value > 0 ? Math.min(total, value * perUnit) : 0;
  const outcome = grams ? outcomeOfUse(packs, grams) : null;
  const ready = total === null ? part !== null : Boolean(grams);
  const everything = total !== null && grams !== null && grams >= total - 0.5;
  const type = (t: string) => {
    setText(t);
    setFinish(false);
  };
  const nudge = (by: number) => {
    const next = Math.max(0, Math.round(((Number.isFinite(value) ? value : 0) + by) / step) * step);
    type(next ? trim(total === null ? next : Math.min(next, total / perUnit)) : '');
  };

  const chips: { label: string; grams: number }[] = [];
  if (total !== null) {
    if (one) for (const n of [1, 2, 4]) if (n * one.grams < total - 0.5) chips.push({ label: `${n} ${one.name}${n === 1 ? '' : 's'}`, grams: n * one.grams });
    chips.push(...quickAmounts(item, total, cupMl));
    const open = packs[0]!;
    if (packs.length > 1 && isStarted(open) && open.remainingGrams! < total - 0.5) chips.push({ label: `The open pack (${said(open.remainingGrams!)})`, grams: open.remainingGrams! });
    chips.push({ label: `All ${said(total)}`, grams: total });
  }

  const several = packs.length > 1;
  const pack = (o: { started: boolean }) => (o.started ? 'the open pack' : 'a pack');
  const happens = !outcome
    ? null
    : outcome.kind === 'last'
      ? "That's the last of it."
      : outcome.kind === 'within'
        ? finish
          ? several
            ? `Finishes ${pack(outcome)}. ${said(outcome.left - outcome.packLeft)} left.`
            : "That's the last of it."
          : several
            ? `${outcome.started ? `Leaves about ${said(outcome.packLeft)} in the open pack` : `Opens a pack and leaves about ${said(outcome.packLeft)} in it`}. ${said(outcome.left)} left in all.`
            : `Leaves about ${said(outcome.left)}.`
        : outcome.kind === 'finishes'
          ? `Finishes ${pack(outcome)}. ${said(outcome.left)} left.`
          : `Finishes ${pack(outcome)} and takes ${said(outcome.fromNext)} from the next. ${said(outcome.left)} left.`;
  const finishing = finish && outcome?.kind === 'within';
  const usedForPlan = grams ? (finishing ? grams + outcome.packLeft : grams) : total === null && part !== null ? (item.remainingGrams ?? 0) : 0;
  const short = usedForPlan && stock ? planShortfall(item, usedForPlan, marks, stock) : null;

  const kcal = grams && item.kcalPer100g !== null ? Math.round((item.kcalPer100g * grams) / 100) : null;
  const amountWords = total === null ? (part === 'all' ? 'it all' : part ? `${FRACTIONS.find(([f]) => f === part)![1]} of it` : 'it') : grams ? said(grams) : 'it';
  const commit = (ate: boolean) => {
    if (!ready) return;
    const request: UseRequest =
      total === null
        ? { amount: part === 'all' ? { kind: 'all' } : { kind: 'fraction', fraction: part as number } }
        : everything
          ? { amount: { kind: 'all' }, wholeRow: true }
          : { amount: { kind: 'grams', grams: Math.round(grams! * 1000) / 1000 }, ...(finishing ? { finishOpen: true } : {}) };
    onUse(item, short && list ? { ...request, addToList: true } : request, ate ? { slot } : undefined);
    onClose();
  };

  const choice = 'flex min-h-14 w-full flex-col items-start justify-center rounded-lg px-4 py-2 text-left transition disabled:opacity-50 lg:min-h-12 lg:rounded-md lg:px-3';
  const first = 'bg-strong text-strong-ink hover:opacity-90';
  const second = 'border border-line bg-card text-ink hover:bg-card-muted';
  const ateFirst = readyToEat(item);
  const useButton = (
    <button key="use" type="button" disabled={!ready} onClick={() => commit(false)} className={`${choice} ${ateFirst ? second : first}`}>
      <span className="font-semibold">Just use {amountWords}</span>
      <span className="text-sm opacity-80 lg:text-xs">Out of stock only, for cooking say. Not in your diary.</span>
    </button>
  );
  const ateButton = (
    <div key="ate" className="flex items-stretch gap-2">
      <button type="button" disabled={!ready} onClick={() => commit(true)} className={`${choice} min-w-0 flex-1 ${ateFirst ? first : second}`}>
        <span className="font-semibold">I ate {amountWords}</span>
        <span className="text-sm opacity-80 lg:text-xs">Out of stock and into your diary{kcal !== null ? `: ${kcal} kcal` : ''}.</span>
      </button>
      <Select aria-label="Meal to log it to" value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)} className="!h-auto !w-28 shrink-0">
        {MEAL_SLOTS.map((x) => (
          <option key={x} value={x}>
            {SLOT_LABEL[x]}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="-mt-2 flex flex-wrap items-center gap-x-1.5 text-muted">
        <span>
          {item.locationName}
          {total !== null ? ` · ${said(total)} left` : ''}
        </span>
        {several && (
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-0.5 font-semibold text-accent-text hover:underline lg:min-h-7"
            onClick={() => {
              onClose();
              actions.changeAmount(packs);
            }}
          >
            {packs.length} packs <Icon name="chevronRight" className="size-4" />
          </button>
        )}
      </p>

      {total !== null ? (
        <>
          <div className="flex items-center justify-center gap-2">
            <Button aria-label="Less" className="min-w-11 lg:min-w-9" disabled={!grams} onClick={() => nudge(-step)}>
              <Icon name="minus" className="size-4" />
            </Button>
            <label className="flex items-center gap-2">
              <span className="sr-only">How much ({suffix})</span>
              <TextInput inputMode="decimal" autoFocus value={text} onChange={(e) => type(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" className="!w-28 text-right !text-xl font-semibold lg:!text-lg" />
              <span className="min-w-10 text-muted">{suffix}</span>
            </label>
            <Button aria-label="More" className="min-w-11 lg:min-w-9" disabled={everything} onClick={() => nudge(step)}>
              <Icon name="plus" className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Quick amounts">
            {chips.map((c) => (
              <Button key={c.label} size="sm" aria-pressed={grams !== null && Math.abs(grams - c.grams) < 0.5} className={PRESSED} onClick={() => type(trim(c.grams / perUnit))}>
                {c.label}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <div>
          <p className="mb-2 text-sm text-muted">We don't know this pack's size, so say roughly how much.</p>
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="How much">
            {FRACTIONS.map(([f, label]) => (
              <Button key={f} size="lg" aria-pressed={part === f} aria-label={`${label} of it`} className={PRESSED} onClick={() => setPart(f)}>
                {label}
              </Button>
            ))}
            <Button size="lg" aria-pressed={part === 'all'} className={PRESSED} onClick={() => setPart('all')}>
              All
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-11 flex-col justify-center gap-1.5 rounded-lg bg-card-muted px-3 py-2 text-sm" aria-live="polite">
        <p>{happens ?? (total === null ? 'Pick how much, then say what it was for.' : 'How much? Type it, or pick an amount.')}</p>
        {outcome?.kind === 'within' && (
          <label className="flex min-h-10 items-center gap-2 font-medium lg:min-h-7">
            <input type="checkbox" className="size-4" checked={finish} onChange={(e) => setFinish(e.target.checked)} />
            {several ? 'That finished the open pack' : "That's the last of it"}
          </label>
        )}
        {short && (
          <>
            <p className="text-danger">{short}</p>
            <label className="flex min-h-10 items-center gap-2 font-medium lg:min-h-7">
              <input type="checkbox" className="size-4" checked={list} onChange={(e) => setList(e.target.checked)} />
              Add it to the shopping list
            </label>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">{ateFirst ? [ateButton, useButton] : [useButton, ateButton]}</div>
    </div>
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
