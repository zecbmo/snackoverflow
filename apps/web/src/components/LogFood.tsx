/**
 * Log food: what you've eaten, on the go. One search across the kitchen, your recipes, foods
 * and takeaway menus (and Open Food Facts when asked), or scan a barcode; suggestions, favourites
 * and saved meals before you type; pick an amount; logged as eaten (it never plans). When the
 * food is in stock, the last step asks whether to take it from stock. Works without signal from
 * foods seen before, sending logs when back online. The "+" chooser (phone centre button, desktop
 * sidebar) opens it, alongside scanning shopping in and planning a meal.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  type BarcodeFoodDto,
  type CalendarDate,
  type FoodResultDto,
  type FoodSuggestionsDto,
  MEAL_SLOTS,
  type MealSlot,
  type OffSearchDto,
  type PlanEntryDto,
  type SavedMealDto,
  slotForTime,
} from '@snackoverflow/shared';
import { api, errorMessage, isOffline } from '../lib/api';
import { rememberFoods, searchRemembered } from '../lib/foodCache';
import { enqueueScan } from '../lib/offlineQueue';
import { usePlan, useUsers } from '../lib/queries';
import { beep, useBarcodeScanner } from '../scanner/useBarcodeScanner';
import { Icon, type IconName } from './Icon';
import { useMe } from './Layout';
import { useToast } from './Toast';
import { Button, Field, Select, Sheet, TextInput } from './ui';

export const SLOT_LABEL: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

interface LogOptions {
  date?: CalendarDate;
  slot?: MealSlot;
  /** Open straight on the barcode scanner. */
  scan?: boolean;
}

interface LogFood {
  /** Open Log food, for a meal (default: now). */
  openLog(opts?: LogOptions): void;
  /** Open the "+" chooser: Log food, Scan shopping, Add by hand, Plan a meal. */
  openChooser(): void;
  /**
   * Tick someone's portion of a meal as eaten (anyone can tick for anyone). When the meal's food
   * comes from stock, asks whether to take it first. Toast with Undo.
   */
  tickEaten(entry: PlanEntryDto, userId: string): Promise<void>;
  /** Untick: they haven't eaten it after all. */
  untickEaten(entry: PlanEntryDto, userId: string): Promise<void>;
}

/** Meals whose food can come out of stock when eaten (recipes go through Cooked it). */
export function stockable(entry: PlanEntryDto): boolean {
  return !entry.batch && (entry.kind === 'stock' || entry.kind === 'product' || entry.kind === 'ingredient');
}

const Ctx = createContext<LogFood | null>(null);

export function useLogFood(): LogFood {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLogFood outside LogFoodProvider');
  return c;
}

export function currentSlot(): MealSlot {
  return slotForTime(new Date().getHours());
}

export function LogFoodProvider({ children }: { children: ReactNode }) {
  const [log, setLog] = useState<Required<LogOptions> | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState<{ title: string; resolve: (answer: boolean | null) => void } | null>(null);
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const members = useUsers().data;
  const openLog = useCallback((opts: LogOptions = {}) => setLog({ date: opts.date ?? me.today, slot: opts.slot ?? currentSlot(), scan: opts.scan ?? false }), [me.today]);
  const refresh = useCallback(() => Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] })]), [qc]);
  const nameOf = useCallback(
    (userId: string) => (userId === me.user.id ? 'You' : (members?.find((m) => m.id === userId)?.name ?? 'They')),
    [me.user.id, members],
  );
  const tickEaten = useCallback(
    async (entry: PlanEntryDto, userId: string) => {
      let fromStock = false;
      if (stockable(entry)) {
        const answer = await new Promise<boolean | null>((resolve) => setAsking({ title: entry.title, resolve }));
        setAsking(null);
        if (answer === null) return;
        fromStock = answer;
      }
      try {
        const r = await api.post<{ entry: PlanEntryDto; stockEventIds: string[] }>(`/api/plan/${entry.id}/eat`, { fromStock, people: [userId] });
        await refresh();
        toast.show(`${nameOf(userId)} had ${userId === me.user.id ? 'the' : 'their'} ${entry.title.toLowerCase()}.`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                for (const e of [...r.stockEventIds].reverse()) await api.post(`/api/events/${e}/undo`);
                await api.post(`/api/plan/${entry.id}/uneat`, { people: [userId] });
              } catch (e) {
                toast.show(errorMessage(e), { tone: 'error' });
              }
              await refresh();
            },
          },
        });
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
      }
    },
    [me.user.id, nameOf, refresh, toast],
  );
  const untickEaten = useCallback(
    async (entry: PlanEntryDto, userId: string) => {
      try {
        await api.post(`/api/plan/${entry.id}/uneat`, { people: [userId] });
        await refresh();
        toast.show(`${entry.title}: not eaten yet.`);
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
      }
    },
    [refresh, toast],
  );
  const value = useMemo<LogFood>(() => ({ openLog, openChooser: () => setChoosing(true), tickEaten, untickEaten }), [openLog, tickEaten, untickEaten]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Chooser open={choosing} onClose={() => setChoosing(false)} onLog={() => openLog()} />
      <Sheet open={asking !== null} onClose={() => asking?.resolve(null)} title="Take it from stock?">
        {asking && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">If the {asking.title.toLowerCase()} came from your kitchen, we'll take it out of stock.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="primary" onClick={() => asking.resolve(true)}>
                Yes, take it
              </Button>
              <Button onClick={() => asking.resolve(false)}>No, ate it elsewhere</Button>
            </div>
          </div>
        )}
      </Sheet>
      {log && <LogFoodSheet key={`${log.date}-${log.slot}`} initial={log} onClose={() => setLog(null)} />}
    </Ctx.Provider>
  );
}

function Chooser({ open, onClose, onLog }: { open: boolean; onClose: () => void; onLog: () => void }) {
  const navigate = useNavigate();
  const me = useMe();
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const choices: { label: string; hint: string; icon: IconName; onClick: () => void }[] = [
    { label: 'Log food', hint: "Something you've eaten", icon: 'spoon', onClick: go(onLog) },
    { label: 'Scan shopping', hint: 'Put food into stock with the camera', icon: 'scan', onClick: go(() => navigate('/scan')) },
    { label: 'Add shopping by hand', hint: 'No barcode? Type it in', icon: 'box', onClick: go(() => navigate('/stock?add=1')) },
    { label: 'Plan a meal', hint: 'For later, on the calendar', icon: 'calendar', onClick: go(() => navigate(`/calendar?date=${me.today}&add=${currentSlot()}`)) },
  ];
  return (
    <Sheet open={open} onClose={onClose} title="What would you like to do?">
      <div className="flex flex-col gap-2">
        {choices.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={c.onClick}
            className="flex min-h-16 items-center gap-3 rounded-xl border border-line px-4 text-left hover:bg-card-muted lg:min-h-12 lg:rounded-lg lg:px-3"
          >
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text lg:size-8">
              <Icon name={c.icon} className="size-5 lg:size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{c.label}</span>
              <span className="block text-sm text-muted">{c.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** What to log: a food (search, suggestion, barcode), a meal already planned, or just calories. */
type Picked = { kind: 'food'; food: FoodResultDto } | { kind: 'planned'; entry: PlanEntryDto } | { kind: 'quick' };

type Stage =
  | { kind: 'search' }
  | { kind: 'scan' }
  | { kind: 'name'; productId: string }
  | { kind: 'amount'; picked: Picked }
  | { kind: 'meal'; meal: SavedMealDto };

const GROUPS: { title: string; sources: FoodResultDto['source'][] }[] = [
  { title: 'In your kitchen', sources: ['leftovers', 'stock'] },
  { title: 'Your recipes', sources: ['recipe'] },
  { title: 'Foods', sources: ['product', 'ingredient'] },
  { title: 'Takeaways and eating out', sources: ['chain'] },
  { title: 'Had before', sources: ['quick'] },
  { title: 'Open Food Facts', sources: ['off'] },
];

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function dayWord(date: CalendarDate, today: CalendarDate): string {
  if (date === today) return 'today';
  const d = new Date(`${date}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diff === -1) return 'yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const STAGE_TITLE: Record<Stage['kind'], string> = { search: 'Log food', scan: 'Scan a barcode', name: 'What is it?', amount: 'How much?', meal: 'Log a meal' };

function LogFoodSheet({ initial, onClose }: { initial: Required<LogOptions>; onClose: () => void }) {
  const [date, setDate] = useState(initial.date);
  const [slot, setSlot] = useState(initial.slot);
  const [stage, setStage] = useState<Stage>(initial.scan ? { kind: 'scan' } : { kind: 'search' });
  const toSearch = () => setStage({ kind: 'search' });
  const pick = (food: FoodResultDto) => setStage({ kind: 'amount', picked: { kind: 'food', food } });
  return (
    <Sheet open onClose={onClose} title={STAGE_TITLE[stage.kind]}>
      {stage.kind === 'search' && <SearchStage date={date} setDate={setDate} slot={slot} setSlot={setSlot} onPick={(p) => setStage({ kind: 'amount', picked: p })} onScan={() => setStage({ kind: 'scan' })} onMeal={(meal) => setStage({ kind: 'meal', meal })} />}
      {stage.kind === 'scan' && <ScanStage onBack={toSearch} onFood={pick} onUnknown={(productId) => setStage({ kind: 'name', productId })} />}
      {stage.kind === 'name' && <NameStage productId={stage.productId} onBack={toSearch} onNamed={pick} />}
      {stage.kind === 'amount' && <AmountStep picked={stage.picked} date={date} slot={slot} onBack={toSearch} onLogged={toSearch} />}
      {stage.kind === 'meal' && <MealStage meal={stage.meal} date={date} slot={slot} onBack={toSearch} onLogged={toSearch} />}
    </Sheet>
  );
}

function BackLink({ onClick, label = 'Back to search' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className="-mt-2 inline-flex min-h-10 items-center gap-1 self-start text-sm font-semibold text-accent-text lg:min-h-7">
      <Icon name="chevronLeft" className="size-4" /> {label}
    </button>
  );
}

function SearchStage({
  date,
  setDate,
  slot,
  setSlot,
  onPick,
  onScan,
  onMeal,
}: {
  date: CalendarDate;
  setDate: (d: CalendarDate) => void;
  slot: MealSlot;
  setSlot: (s: MealSlot) => void;
  onPick: (p: Picked) => void;
  onScan: () => void;
  onMeal: (m: SavedMealDto) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [offFor, setOffFor] = useState<string | null>(null);
  const query = useDebounced(q.trim());
  const results = useQuery({
    queryKey: ['foods', 'search', query],
    queryFn: () => api.get<FoodResultDto[]>(`/api/foods/search?q=${encodeURIComponent(query)}`),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: (n, e) => !isOffline(e) && n < 2,
  });
  const suggestions = useQuery({
    queryKey: ['foods', 'suggestions', slot],
    queryFn: () => api.get<FoodSuggestionsDto>(`/api/foods/suggestions?slot=${slot}`),
    staleTime: 30_000,
    retry: (n, e) => !isOffline(e) && n < 2,
  });
  const off = useQuery({
    queryKey: ['foods', 'off', offFor],
    queryFn: () => api.get<OffSearchDto>(`/api/foods/off?q=${encodeURIComponent(offFor!)}`),
    enabled: offFor !== null,
    staleTime: 10 * 60_000,
    retry: false,
  });
  // Keep what we've seen for searching without signal.
  useEffect(() => {
    if (results.data) rememberFoods(results.data);
  }, [results.data]);
  useEffect(() => {
    const s = suggestions.data;
    if (s) rememberFoods([...s.favourites, ...s.usual, ...s.recent]);
  }, [suggestions.data]);
  const offline = isOffline(results.error) || (!navigator.onLine && !results.data);
  const shown = offline ? searchRemembered(query) : (results.data ?? []);

  const plan = usePlan(date, date);
  const planned = (plan.data?.days[0]?.entries ?? []).filter((e) => e.slot === slot && !e.eaten && !e.batch && e.status !== 'skipped' && e.people.some((p) => p.userId === me.user.id));
  const s = suggestions.data;
  const removeMeal = async (m: SavedMealDto) => {
    try {
      await api.del(`/api/foods/meals/${m.id}`);
      await qc.invalidateQueries({ queryKey: ['foods', 'suggestions'] });
      toast.show(`Removed ${m.name}.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const [opening, setOpening] = useState<string | null>(null);
  // Open Food Facts results become your product (with their nutrition) when picked.
  const choose = async (r: FoodResultDto) => {
    if (r.source !== 'off') return onPick({ kind: 'food', food: r });
    setOpening(r.id);
    try {
      onPick({ kind: 'food', food: (await api.get<BarcodeFoodDto>(`/api/foods/barcode/${encodeURIComponent(r.id)}`)).food });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
      setOpening(null);
    }
  };
  const row = (r: FoodResultDto) => <ResultRow key={`${r.source}-${r.id}-${r.title}`} food={r} busy={opening === r.id} onClick={() => void choose(r)} />;
  const localOff = shown.some((r) => r.source === 'off');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Meal" className="flex rounded-lg bg-card-muted p-0.5">
          {MEAL_SLOTS.map((x) => (
            <button
              key={x}
              type="button"
              role="radio"
              aria-checked={x === slot}
              onClick={() => setSlot(x)}
              className={`min-h-10 rounded-md px-2.5 text-sm font-medium lg:min-h-7 lg:px-2 ${x === slot ? 'bg-card font-semibold text-ink shadow-sm' : 'text-muted'}`}
            >
              {SLOT_LABEL[x]}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-muted">
          <span className="sr-only">Day</span>
          <input
            type="date"
            value={date}
            max={me.today}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="min-h-10 rounded-md border border-line bg-card px-2 text-sm text-ink lg:min-h-7"
          />
        </label>
      </div>
      <div className="relative">
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted lg:size-4" />
        <TextInput
          aria-label="Search food"
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffFor(null);
          }}
          placeholder="Search food, recipes or takeaways"
          className="pl-10 pr-12 lg:pl-8 lg:pr-10"
        />
        <button
          type="button"
          onClick={onScan}
          aria-label="Scan a barcode"
          title="Scan a barcode"
          className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-accent-text hover:bg-card-muted lg:size-7"
        >
          <Icon name="scan" className="size-5 lg:size-[18px]" />
        </button>
      </div>
      {offline && <p className="rounded-md bg-card-muted px-3 py-2 text-sm">No signal. Showing foods you've had before; anything you log goes when you're back online.</p>}

      <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto" aria-busy={results.isFetching}>
        {!q && planned.length > 0 && (
          <ResultGroup title={`Planned for your ${SLOT_LABEL[slot].toLowerCase()}`}>
            {planned.map((e) => (
              <li key={e.id} className="border-b border-line last:border-b-0">
                <button type="button" onClick={() => onPick({ kind: 'planned', entry: e })} className="flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-card-muted lg:min-h-10">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{e.title}</span>
                    <span className="block truncate text-sm text-muted lg:text-xs">{e.detail ?? 'Planned'}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{e.kcal === null ? '–' : `${e.kcal} kcal`}</span>
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {!q && !offline && s && s.meals.length > 0 && (
          <ResultGroup title="Your meals">
            {s.meals.map((m) => (
              <li key={m.id} className="flex items-center border-b border-line last:border-b-0">
                <button type="button" onClick={() => onMeal(m)} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-1.5 text-left hover:bg-card-muted lg:min-h-10">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block truncate text-sm text-muted lg:text-xs">{m.items.map((i) => i.title).join(', ')}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{m.kcal === null ? '–' : `${m.kcal} kcal`}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${m.name}`}
                  onClick={() => void removeMeal(m)}
                  className="inline-flex size-11 shrink-0 items-center justify-center text-muted hover:text-danger lg:size-8"
                >
                  <Icon name="close" className="size-4" />
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {!q && s && s.favourites.length > 0 && <ResultGroup title="Favourites">{s.favourites.map(row)}</ResultGroup>}
        {!q && s && s.usual.length > 0 && <ResultGroup title={`Usually at ${SLOT_LABEL[slot].toLowerCase()}`}>{s.usual.map(row)}</ResultGroup>}
        {!q && s && s.recent.length > 0 && <ResultGroup title="Recently">{s.recent.map(row)}</ResultGroup>}
        {offline && shown.length > 0 && <ResultGroup title={q ? 'Had before' : 'Foods you have had'}>{shown.map(row)}</ResultGroup>}
        {!offline &&
          GROUPS.map((g) => {
            const rows = shown.filter((r) => g.sources.includes(r.source));
            if (!rows.length) return null;
            return (
              <ResultGroup
                key={g.title}
                title={!q && g.sources.includes('stock') ? 'In your kitchen, use these first' : g.title}
                note={g.sources.includes('off') ? 'From Open Food Facts, under the Open Database Licence.' : undefined}
              >
                {rows.map(row)}
              </ResultGroup>
            );
          })}
        {q && !offline && query === q.trim() && !results.isFetching && !shown.length && <p className="text-sm text-muted">Nothing of yours matches "{q}".</p>}
        {q.trim() && !offline && !localOff && (
          <OffResults
            q={q.trim()}
            asked={offFor === q.trim()}
            onAsk={() => setOffFor(q.trim())}
            state={off}
            onPick={(food) => onPick({ kind: 'food', food })}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-x-4">
        <button type="button" onClick={() => onPick({ kind: 'quick' })} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent-text lg:min-h-8">
          <Icon name="plus" className="size-4" /> Just add calories
        </button>
        <button type="button" onClick={onScan} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent-text lg:min-h-8">
          <Icon name="scan" className="size-4" /> Scan a barcode
        </button>
      </div>
      <p className="text-xs text-muted">
        Logging to {SLOT_LABEL[slot].toLowerCase()}, {dayWord(date, me.today)}. To plan something for later, use the Calendar.
      </p>
    </div>
  );
}

/** Open Food Facts by name, only when asked: it allows about 10 searches a minute. */
function OffResults({
  q,
  asked,
  onAsk,
  state,
  onPick,
}: {
  q: string;
  asked: boolean;
  onAsk: () => void;
  state: { data?: OffSearchDto; isFetching: boolean; error: unknown };
  onPick: (food: FoodResultDto) => void;
}) {
  const toast = useToast();
  const [opening, setOpening] = useState<string | null>(null);
  if (!asked) {
    return (
      <button type="button" onClick={onAsk} className="flex min-h-12 items-center gap-2 rounded-lg border border-dashed border-line px-3 text-left text-sm font-semibold text-accent-text hover:bg-card-muted lg:min-h-10">
        <Icon name="search" className="size-4" /> Search Open Food Facts for "{q}"
      </button>
    );
  }
  if (state.isFetching) return <p className="text-sm text-muted">Asking Open Food Facts…</p>;
  const d = state.data;
  if (state.error || !d || d.status === 'unavailable') return <p className="text-sm text-muted">Couldn't reach Open Food Facts. Your own foods still work.</p>;
  if (d.status === 'busy') return <p className="text-sm text-muted">Open Food Facts is busy. Try again in a minute.</p>;
  if (!d.results.length) return <p className="text-sm text-muted">Open Food Facts doesn't know "{q}" either. Try "Just add calories".</p>;
  // Picking one makes it one of your products (with its nutrition), then asks how much.
  const open = async (r: FoodResultDto) => {
    setOpening(r.id);
    try {
      onPick((await api.get<BarcodeFoodDto>(`/api/foods/barcode/${encodeURIComponent(r.id)}`)).food);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setOpening(null);
    }
  };
  return (
    <ResultGroup title="Open Food Facts" note="From Open Food Facts, under the Open Database Licence.">
      {d.results.map((r) => (
        <ResultRow key={r.id} food={r} busy={opening === r.id} onClick={() => void open(r)} />
      ))}
    </ResultGroup>
  );
}

function ResultGroup({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <ul className="overflow-hidden rounded-lg border border-line">{children}</ul>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </section>
  );
}

function ResultRow({ food, onClick, busy = false }: { food: FoodResultDto; onClick: () => void; busy?: boolean }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" onClick={onClick} disabled={busy} className="flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-card-muted disabled:opacity-60 lg:min-h-10">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 truncate font-medium">
            {food.favourite && <Icon name="starFilled" className="size-3.5 shrink-0 text-accent-text" label="Favourite" />}
            <span className="truncate">{food.title}</span>
          </span>
          {food.subtitle && <span className="block truncate text-sm text-muted lg:text-xs">{food.subtitle}</span>}
        </span>
        <span className="shrink-0 text-right text-sm tabular-nums">
          <span className="block font-semibold">{food.kcalPerServing === null ? '–' : `${food.kcalPerServing} kcal`}</span>
          <span className="block max-w-[9rem] truncate text-xs text-muted">{food.servingLabel}</span>
        </span>
      </button>
    </li>
  );
}

/** The camera (or a typed barcode). Known barcodes go straight to "How much?"; new ones ask what they are. */
function ScanStage({ onBack, onFood, onUnknown }: { onBack: () => void; onFood: (f: FoodResultDto) => void; onUnknown: (productId: string) => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const look = useCallback(
    async (code: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const r = await api.get<BarcodeFoodDto>(`/api/foods/barcode/${encodeURIComponent(code)}`);
        if (r.named) onFood(r.food);
        else onUnknown(r.productId);
      } catch (e) {
        toast.show(isOffline(e) ? 'No signal. Search for it instead: foods you have had before still show.' : errorMessage(e), { tone: 'error' });
        setBusy(false);
      }
    },
    [busy, onFood, onUnknown, toast],
  );
  const { videoRef, status } = useBarcodeScanner((code) => {
    beep();
    void look(code);
  }, !busy);
  return (
    <div className="flex flex-col gap-3">
      <BackLink onClick={onBack} />
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} muted playsInline className="size-full object-cover" />
        <p className="absolute inset-x-0 bottom-0 bg-black/50 px-3 py-2 text-center text-sm text-white">
          {busy
            ? 'Looking it up…'
            : status === 'denied'
              ? 'The camera is blocked. Type the barcode below.'
              : status === 'unavailable' || status === 'error'
                ? "There's no camera here. Type the barcode below."
                : 'Point the camera at the barcode.'}
        </p>
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) void look(typed.trim());
        }}
      >
        <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
          Or type the barcode
          <TextInput inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value.replace(/[^0-9A-Za-z-]/g, ''))} placeholder="e.g. 5000159407236" />
        </label>
        <Button type="submit" variant="primary" disabled={busy || typed.trim().length < 4}>
          Find it
        </Button>
      </form>
    </div>
  );
}

/** A barcode nobody knows: name it (with its calories if you can) so everyone's phone knows it next time. */
function NameStage({ productId, onBack, onNamed }: { productId: string; onBack: () => void; onNamed: (f: FoodResultDto) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [size, setSize] = useState('');
  const [unit, setUnit] = useState<'g' | 'ml'>('g');
  const [kcal, setKcal] = useState('');
  const [busy, setBusy] = useState(false);
  const sizeNum = Number(size);
  const kcalNum = Number(kcal);
  const needsSize = kcal.trim() !== '' && !(sizeNum > 0);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/products/${productId}`, {
        name: name.trim(),
        ...(sizeNum > 0 ? { packAmount: sizeNum, packUnit: unit } : {}),
        // Calories for the whole pack, stored per 100g (or ml) like everything else.
        ...(sizeNum > 0 && kcal.trim() !== '' ? { nutritionPer100g: { kcal: Math.round((kcalNum * 100) / sizeNum) } } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['products'] });
      onNamed(await api.get<FoodResultDto>(`/api/foods/product/${productId}`));
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !needsSize && !busy) void save();
      }}
    >
      <BackLink onClick={onBack} />
      <p className="text-sm text-muted">Nobody knows this barcode yet, not even Open Food Facts. Name it once and everyone's phone will know it.</p>
      <Field label="Name">{(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Corner shop samosa" autoFocus />}</Field>
      <div className="grid grid-cols-[1fr_5.5rem] items-end gap-2">
        <Field label="Pack size (optional)">{(id) => <TextInput id={id} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 120" />}</Field>
        <Select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as 'g' | 'ml')}>
          <option value="g">g</option>
          <option value="ml">ml</option>
        </Select>
      </div>
      <Field label="Calories in the whole pack (optional)" error={needsSize ? 'Add the pack size too, so we can work out a portion.' : null}>
        {(id) => <TextInput id={id} inputMode="numeric" value={kcal} onChange={(e) => setKcal(e.target.value.replace(/[^0-9]/g, ''))} placeholder="kcal" />}
      </Field>
      <Button type="submit" variant="primary" size="lg" disabled={!name.trim() || needsSize || busy}>
        Save and continue
      </Button>
    </form>
  );
}

/** Plan-entry fields for a food. */
function entryFor(food: FoodResultDto): Record<string, unknown> {
  switch (food.source) {
    case 'leftovers':
      return { kind: 'stock', stockItemId: food.id };
    case 'stock':
    case 'product':
      return { kind: 'product', productId: food.id };
    case 'recipe':
      return { kind: 'recipe', recipeId: food.id };
    case 'ingredient':
      return { kind: 'ingredient', ingredientId: food.id };
    case 'chain':
      return { kind: 'chain', chainItemId: food.id };
    default:
      return { kind: 'text', text: food.title, kcalPerServing: food.kcalPerServing };
  }
}

const FAVOURITE_KIND: Partial<Record<FoodResultDto['source'], string>> = { stock: 'product', product: 'product', recipe: 'recipe', ingredient: 'ingredient', chain: 'chain' };

function show(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function macroLine(n: FoodResultDto['nutritionPerServing'], times: number): string | null {
  if (!n || n.protein == null || n.carbs == null || n.fat == null) return null;
  const g = (x: number) => `${Math.round(x * times)}g`;
  return `Protein ${g(n.protein)} · Carbs ${g(n.carbs)} · Fat ${g(n.fat)}`;
}

function AmountStep({ picked, date, slot, onBack, onLogged }: { picked: Picked; date: CalendarDate; slot: MealSlot; onBack: () => void; onLogged: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const members = useUsers().data ?? [];
  const food = picked.kind === 'food' ? picked.food : null;
  const entry = picked.kind === 'planned' ? picked.entry : null;
  const [servings, setServings] = useState(food?.usualServings ?? 1);
  const [byWeight, setByWeight] = useState(false);
  const [grams, setGrams] = useState('');
  const [who, setWho] = useState<string[]>([me.user.id]);
  const [name, setName] = useState('');
  const [kcalText, setKcalText] = useState('');
  const [busy, setBusy] = useState(false);
  const [favourite, setFavourite] = useState(food?.favourite ?? false);

  const title = food?.title ?? entry?.title ?? 'Something else';
  const kcalPer = food?.kcalPerServing ?? entry?.kcalPerServing ?? null;
  const unitGrams = food?.unitGrams ?? null;
  const weightUnit = food?.displayUnit === 'ml' ? 'ml' : 'g';
  const gramsNum = Number(grams);
  const amount = byWeight && unitGrams ? (gramsNum > 0 ? gramsNum / unitGrams : 0) : servings;
  const quickKcal = Number(kcalText);
  const total = picked.kind === 'quick' ? (kcalText && quickKcal >= 0 ? Math.round(quickKcal) : null) : kcalPer === null ? null : Math.round(kcalPer * amount);
  const macros = macroLine(food?.nutritionPerServing ?? entry?.nutritionPerServing ?? null, entry ? (entry.people.find((p) => p.userId === me.user.id)?.portions ?? 1) : amount);
  // In stock: the final step asks whether to take it. A planned meal asks if its food can come from stock.
  const stockQuestion = food ? food.inStock : entry && stockable(entry) ? { packs: 0, locationName: '' } : null;
  // Halves for recipes and leftovers (and below one of anything), whole items otherwise.
  const step = food?.source === 'recipe' || food?.source === 'leftovers' ? 0.5 : 1;
  // "1 pack (125g)", "1 banana (120g)", "1 burger": count in that, else servings.
  const unitWord = `${food?.servingLabel.match(/^1 ([a-z]+)/i)?.[1]?.toLowerCase() ?? 'serving'}s`;
  const canLog = picked.kind === 'quick' ? kcalText.trim() !== '' && quickKcal >= 0 : amount > 0 && who.length > 0;
  const favKind = food ? FAVOURITE_KIND[food.source] : undefined;

  const toggleFavourite = async () => {
    const on = !favourite;
    setFavourite(on);
    try {
      await api.post('/api/foods/favourites', { kind: favKind, id: food!.id, on });
      await qc.invalidateQueries({ queryKey: ['foods'] });
    } catch (e) {
      setFavourite(!on);
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const log = async (fromStock: boolean) => {
    setBusy(true);
    const each = picked.kind === 'quick' ? 1 : Math.round(amount * 1000) / 1000;
    const body = entry
      ? null
      : {
          ...(picked.kind === 'quick' ? { kind: 'text', text: name.trim() || 'Something else', kcalPerServing: quickKcal } : entryFor(food!)),
          date,
          slot,
          servings: Math.round(each * who.length * 1000) / 1000,
          people: who.map((userId) => ({ userId, portions: each })),
          eaten: true,
          fromStock,
        };
    try {
      let created: PlanEntryDto | null = null;
      let ticked: { id: string; events: string[] } | null = null;
      if (entry) {
        const r = await api.post<{ entry: PlanEntryDto; stockEventIds: string[] }>(`/api/plan/${entry.id}/eat`, { fromStock, people: [me.user.id] });
        ticked = { id: entry.id, events: r.stockEventIds };
      } else {
        created = await api.post<PlanEntryDto>('/api/plan', body);
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] }), qc.invalidateQueries({ queryKey: ['foods'] })]);
      const others = who.filter((u) => u !== me.user.id).map((u) => members.find((m) => m.id === u)?.name ?? 'someone');
      const forWhom = others.length ? ` for ${who.includes(me.user.id) ? 'you and ' : ''}${others.join(' and ')}` : '';
      toast.show(`Logged ${title}${forWhom} to ${SLOT_LABEL[slot].toLowerCase()}.`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              if (created) await api.del(`/api/plan/${created.id}?restoreStock=1`);
              if (ticked) {
                for (const e of [...ticked.events].reverse()) await api.post(`/api/events/${e}/undo`);
                await api.post(`/api/plan/${ticked.id}/uneat`, { people: [me.user.id] });
              }
            } catch (e) {
              toast.show(errorMessage(e), { tone: 'error' });
            }
            await Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
          },
        },
      });
      onLogged();
    } catch (e) {
      if (isOffline(e) && body) {
        // No signal: it goes when the phone's back online.
        enqueueScan({ mode: 'log', barcode: '', body });
        toast.show(`No signal. ${title} will be logged when you're back online.`);
        onLogged();
      } else {
        toast.show(errorMessage(e), { tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canLog && !busy) void log(Boolean(stockQuestion));
      }}
    >
      <BackLink onClick={onBack} />

      {picked.kind === 'quick' ? (
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            What was it? <span className="font-normal text-muted">(optional)</span>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Something else" autoFocus />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Calories
            <TextInput inputMode="numeric" value={kcalText} onChange={(e) => setKcalText(e.target.value.replace(/[^0-9]/g, ''))} placeholder="kcal" />
          </label>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{title}</p>
              <p className="text-sm text-muted">{[food?.subtitle ?? entry?.detail, food ? `${food.servingLabel}${kcalPer !== null ? `: ${kcalPer} kcal` : ''}` : null].filter(Boolean).join(' · ')}</p>
            </div>
            {favKind && (
              <button
                type="button"
                aria-pressed={favourite}
                aria-label={favourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
                title={favourite ? 'In your favourites' : 'Add to favourites'}
                onClick={() => void toggleFavourite()}
                className={`inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-card-muted lg:size-8 ${favourite ? 'text-accent-text' : 'text-muted'}`}
              >
                <Icon name={favourite ? 'starFilled' : 'star'} className="size-5" />
              </button>
            )}
          </div>
          {entry ? (
            <p className="text-sm">Your portion from the plan.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {byWeight && unitGrams ? (
                <label className="flex items-center gap-2">
                  <span className="sr-only">Amount in {weightUnit === 'ml' ? 'millilitres' : 'grams'}</span>
                  <TextInput inputMode="decimal" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder={show(unitGrams)} autoFocus className="max-w-[10rem] text-right" />
                  <span className="text-muted">{weightUnit}</span>
                </label>
              ) : (
                <div className="flex items-center gap-2">
                  <Button aria-label="Less" className="min-w-11 lg:min-w-8" onClick={() => setServings((n) => Math.max(0.5, Math.round((n - (n <= 1 ? 0.5 : step)) * 10) / 10))}>
                    <Icon name="minus" className="size-4" />
                  </Button>
                  <span className="min-w-[6rem] text-center text-lg font-semibold tabular-nums lg:text-base" aria-live="polite">
                    {show(servings)} {servings === 1 ? unitWord.replace(/s$/, '') : unitWord}
                  </span>
                  <Button aria-label="More" className="min-w-11 lg:min-w-8" onClick={() => setServings((n) => Math.round((n + (n < 1 ? 0.5 : step)) * 10) / 10)}>
                    <Icon name="plus" className="size-4" />
                  </Button>
                  {food?.usualServings !== null && food?.usualServings !== undefined && <span className="text-xs text-muted">your usual</span>}
                </div>
              )}
              {unitGrams && (
                <button
                  type="button"
                  onClick={() => {
                    setByWeight((b) => !b);
                    setGrams(show(unitGrams * servings));
                  }}
                  className="inline-flex min-h-10 items-center self-start text-sm font-semibold text-accent-text lg:min-h-7"
                >
                  {byWeight ? `By the ${food?.countUnit ?? 'serving'} instead` : `By weight (${weightUnit}) instead`}
                </button>
              )}
              {members.length > 1 && (
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium">Who ate it?</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => {
                      const on = who.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setWho((w) => (on ? w.filter((x) => x !== m.id) : [...w, m.id]))}
                          className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 text-sm font-medium lg:min-h-7 ${on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-ink'}`}
                        >
                          {on && <Icon name="check" className="size-3.5" />}
                          {m.id === me.user.id ? 'You' : m.name}
                        </button>
                      );
                    })}
                  </div>
                  {who.length > 1 && <p className="mt-1 text-xs text-muted">That amount each.</p>}
                </fieldset>
              )}
            </div>
          )}
        </>
      )}

      <div>
        <p className="text-sm">
          {total === null ? 'Calories unknown' : <span className="text-lg font-bold tabular-nums lg:text-base">{total} kcal</span>}
          {total !== null && who.length > 1 && picked.kind === 'food' && <span className="text-muted"> each</span>}
        </p>
        {macros && <p className="text-sm text-muted tabular-nums">{macros}</p>}
      </div>

      {stockQuestion && picked.kind !== 'quick' ? (
        <div className="flex flex-col gap-2 rounded-lg bg-card-muted p-3">
          <p className="text-sm font-medium">
            {food?.inStock ? `Take it from stock? ${food.inStock.packs > 1 ? `${food.inStock.packs} packs` : 'There is some'} in the ${food.inStock.locationName.toLowerCase()}.` : 'Take it from stock?'}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="submit" variant="primary" disabled={!canLog || busy}>
              Log and take it
            </Button>
            <Button disabled={!canLog || busy} onClick={() => void log(false)}>
              Log only, ate it elsewhere
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" variant="primary" size="lg" disabled={!canLog || busy}>
          Log it
        </Button>
      )}
    </form>
  );
}

/** A saved meal: everything in it logged as eaten by you, in one go. */
function MealStage({ meal, date, slot, onBack, onLogged }: { meal: SavedMealDto; date: CalendarDate; slot: MealSlot; onBack: () => void; onLogged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const log = async (fromStock: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{ entries: PlanEntryDto[] }>(`/api/foods/meals/${meal.id}/log`, { date, slot, fromStock });
      await Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] }), qc.invalidateQueries({ queryKey: ['foods'] })]);
      toast.show(`Logged ${meal.name} to ${SLOT_LABEL[slot].toLowerCase()}.`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              for (const e of [...r.entries].reverse()) await api.del(`/api/plan/${e.id}?restoreStock=1`);
            } catch (e) {
              toast.show(errorMessage(e), { tone: 'error' });
            }
            await Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
          },
        },
      });
      onLogged();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <BackLink onClick={onBack} />
      <p className="font-semibold">{meal.name}</p>
      <ul className="overflow-hidden rounded-lg border border-line text-sm">
        {meal.items.map((i, n) => (
          <li key={n} className="flex justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0">
            <span className="min-w-0 truncate">
              {i.title}
              {i.servings !== 1 ? ` × ${show(i.servings)}` : ''}
            </span>
            <span className="shrink-0 tabular-nums text-muted">{i.kcal === null ? '–' : `${i.kcal} kcal`}</span>
          </li>
        ))}
      </ul>
      <p className="text-lg font-bold tabular-nums lg:text-base">{meal.kcal === null ? 'Calories partly unknown' : `${meal.kcal} kcal`}</p>
      <div className="flex flex-col gap-2 rounded-lg bg-card-muted p-3">
        <p className="text-sm font-medium">Take what's in stock out of stock?</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="primary" disabled={busy} onClick={() => void log(true)}>
            Log and take it
          </Button>
          <Button disabled={busy} onClick={() => void log(false)}>
            Log only, ate it elsewhere
          </Button>
        </div>
      </div>
    </div>
  );
}
