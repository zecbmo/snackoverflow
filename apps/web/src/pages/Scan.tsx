/**
 * The till experience: the camera stays open, every barcode gives a beep, a big
 * tick and a strip with the name and estimated best-before. Unknown barcodes get
 * an amber flash and a quick "what is it?" sheet. Undo on every scan.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { type EatResultDto, formatPackSize, MEAL_SLOTS, type MealSlot, type ProductDto, type ScanAddResult, type ScanUseResult, slotForTime, type StockItemDto } from '@snackoverflow/shared';
import { Icon, locationIcon } from '../components/Icon';
import { useMe } from '../components/Layout';
import { useStockActions } from '../components/StockActions';
import { useToast } from '../components/Toast';
import { Button, Field, Select, Sheet, TextInput } from '../components/ui';
import { api, errorMessage, isOffline } from '../lib/api';
import { enqueueScan, type QueuedScan, removeQueued } from '../lib/offlineQueue';
import { longDate } from '../lib/format';
import { useIngredients, useLocations } from '../lib/queries';
import { beep, useBarcodeScanner } from '../scanner/useBarcodeScanner';

type Mode = 'add' | 'use' | 'eat';

interface Entry {
  key: number;
  barcode: string;
  mode: Mode;
  add?: ScanAddResult;
  use?: ScanUseResult;
  eat?: EatResultDto;
  /** Saved on the phone with no signal; sent when back online. */
  queued?: QueuedScan;
  error?: string;
  undone?: boolean;
}

const LOCATION_KEY = 'so.scan.location';
const COOLDOWN_MS = 2000;

function packLabel(p: ProductDto): string {
  const size = formatPackSize(p.packAmount, p.packUnit);
  return size ? ` ${size}` : '';
}

function readStoredLocation(): string | null {
  try {
    return localStorage.getItem(LOCATION_KEY);
  } catch {
    return null;
  }
}

export function ScanPage() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const actions = useStockActions();
  const locations = useLocations().data ?? [];
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>(() => (['add', 'use', 'eat'].includes(params.get('mode') ?? '') ? (params.get('mode') as Mode) : 'add'));
  const [slot, setSlot] = useState<MealSlot>(() =>
    MEAL_SLOTS.includes(params.get('slot') as MealSlot) ? (params.get('slot') as MealSlot) : slotForTime(new Date().getHours()),
  );
  const [addLocation, setAddLocation] = useState<string | null>(readStoredLocation);
  const [useLocation, setUseLocation] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'unknown' | 'miss'; n: number } | null>(null);
  const [sheet, setSheet] = useState<'location' | 'keyboard' | 'name' | 'date' | 'summary' | 'slot' | null>(null);
  const busy = useRef(false);
  const last = useRef<{ code: string; at: number } | null>(null);
  const nextKey = useRef(1);

  // Default to the remembered location, else the first fridge.
  const fallback = locations.find((l) => l.type === 'fridge') ?? locations[0];
  const addLocationId = locations.some((l) => l.id === addLocation) ? addLocation : (fallback?.id ?? null);
  const location = locations.find((l) => l.id === (mode === 'add' ? addLocationId : useLocation));
  const current = entries.find((e) => !e.undone);

  const update = (key: number, patch: Partial<Entry>) => setEntries((all) => all.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  const handleCode = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code || busy.current) return;
      const now = Date.now();
      if (last.current && last.current.code === code && now - last.current.at < COOLDOWN_MS) return;
      busy.current = true;
      last.current = { code, at: now };
      const key = nextKey.current++;
      try {
        if (mode === 'add') {
          const r = await api.post<ScanAddResult>('/api/scan/add', { barcode: code, locationId: addLocationId ?? undefined });
          setEntries((all) => [{ key, barcode: code, mode, add: r }, ...all]);
          beep(r.known ? 'ok' : 'warn');
          setFlash({ kind: r.known ? 'ok' : 'unknown', n: key });
          if (!r.known) setSheet('name');
        } else if (mode === 'eat') {
          const r = await api.post<EatResultDto>('/api/scan/eat', { barcode: code, slot });
          setEntries((all) => [{ key, barcode: code, mode, eat: r }, ...all]);
          beep('ok');
          setFlash({ kind: 'ok', n: key });
          void qc.invalidateQueries({ queryKey: ['plan'] });
        } else {
          const r = await api.post<ScanUseResult>('/api/scan/use', { barcode: code, locationId: useLocation ?? undefined });
          setEntries((all) => [{ key, barcode: code, mode, use: r }, ...all]);
          beep(r.status === 'used' ? 'ok' : 'warn');
          setFlash({ kind: r.status === 'used' ? 'ok' : 'miss', n: key });
        }
        void qc.invalidateQueries({ queryKey: ['stock'] });
      } catch (e) {
        if (isOffline(e)) {
          // No signal: keep the scan and send it later, like a till that keeps working offline.
          const queued = enqueueScan({ mode, barcode: code, locationId: (mode === 'add' ? addLocationId : useLocation) ?? undefined, slot: mode === 'eat' ? slot : undefined });
          beep('ok');
          setFlash({ kind: 'ok', n: key });
          setEntries((all) => [{ key, barcode: code, mode, queued }, ...all]);
        } else {
          beep('warn');
          setFlash({ kind: 'miss', n: key });
          setEntries((all) => [{ key, barcode: code, mode, error: errorMessage(e) }, ...all]);
        }
      } finally {
        busy.current = false;
        last.current = { code, at: Date.now() };
      }
    },
    [mode, addLocationId, useLocation, qc, slot],
  );

  const scanning = sheet === null;
  const { videoRef, status } = useBarcodeScanner((c) => void handleCode(c), scanning);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
  }, [flash]);

  const undo = async (entry: Entry) => {
    if (entry.eat) {
      try {
        if (entry.eat.change) await api.post(`/api/events/${entry.eat.change.eventId}/undo`);
        await api.del(`/api/plan/${entry.eat.entry.id}`);
        update(entry.key, { undone: true });
        void qc.invalidateQueries({ queryKey: ['stock'] });
        void qc.invalidateQueries({ queryKey: ['plan'] });
        toast.show('Undone.');
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
      }
      return;
    }
    if (entry.queued) {
      removeQueued(entry.queued.id);
      update(entry.key, { undone: true });
      toast.show('Removed.');
      return;
    }
    const eventId = entry.add?.change.eventId ?? (entry.use?.status === 'used' ? entry.use.change.eventId : null);
    if (!eventId) return;
    try {
      await api.post(`/api/events/${eventId}/undo`);
      update(entry.key, { undone: true });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show('Undone.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const onlySome = async (entry: Entry) => {
    if (entry.use?.status !== 'used') return;
    const item = entry.use.change.item;
    await undo(entry);
    actions.use({ ...item, fractionLeft: item.fractionLeft || 1 } as StockItemDto);
  };

  const live = entries.filter((e) => !e.undone && !e.error);
  const needsName = live.filter((e) => e.add && !e.add.known && !e.add.product.name).length;

  return (
    <div className="fixed inset-0 flex flex-col bg-scan text-white">
      <video ref={videoRef} muted playsInline className="absolute inset-0 size-full object-cover opacity-70" aria-hidden />
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70" aria-hidden />

      <div className="relative z-10 flex flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Close scanner"
            onClick={() => (live.length ? setSheet('summary') : navigate(-1))}
            className="inline-flex size-12 items-center justify-center rounded-full bg-white/10 backdrop-blur"
          >
            <Icon name="close" />
          </button>
          <button
            type="button"
            onClick={() => setSheet(mode === 'eat' ? 'slot' : 'location')}
            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-white/10 px-4 text-lg font-semibold backdrop-blur"
          >
            <Icon name={mode === 'eat' ? 'calendar' : location ? locationIcon(location.type) : 'box'} className="size-5" />
            {mode === 'eat' ? `Your ${slot}` : (location?.name ?? 'Any location')}
            <Icon name="chevronDown" className="size-4" />
          </button>
        </div>

        <div role="tablist" aria-label="Scan mode" className="mt-4 grid grid-cols-3 rounded-2xl bg-white/10 p-1 backdrop-blur">
          {(['add', 'use', 'eat'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-12 rounded-xl text-lg font-semibold ${mode === m ? 'bg-white text-[#1a1c1a]' : 'text-white'}`}
            >
              {m === 'add' ? 'Add' : m === 'use' ? 'Use' : 'Eat'}
            </button>
          ))}
        </div>

        <div className="relative mx-auto mt-10 aspect-[3/2] w-full max-w-sm">
          {(['left-0 top-0 border-l-4 border-t-4 rounded-tl-2xl', 'right-0 top-0 border-r-4 border-t-4 rounded-tr-2xl', 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-2xl', 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-2xl'] as const).map((c) => (
            <span key={c} aria-hidden className={`absolute size-10 border-white ${c}`} />
          ))}
          {flash && (
            <div key={flash.n} className="absolute inset-0 flex items-center justify-center" aria-hidden>
              <span
                className={`animate-pop inline-flex size-32 items-center justify-center rounded-full ring-[14px] ${
                  flash.kind === 'ok' ? 'bg-[#22a35a] ring-[#22a35a]/30' : flash.kind === 'unknown' ? 'bg-[#e0a020] ring-[#e0a020]/30' : 'bg-[#d0453a] ring-[#d0453a]/30'
                }`}
              >
                <Icon name={flash.kind === 'ok' ? 'check' : flash.kind === 'unknown' ? 'warning' : 'close'} className="size-16" strokeWidth={3} />
              </span>
            </div>
          )}
        </div>
        <p className="mt-6 text-center text-[17px] text-white/80" aria-live="polite">
          {status === 'denied'
            ? 'Camera blocked. Allow camera access in your browser, or type the barcode.'
            : status === 'unavailable' || status === 'error'
              ? 'No camera here. Type the barcode instead.'
              : mode === 'add'
                ? 'Keep scanning. Each beep adds one pack.'
                : mode === 'use'
                  ? 'Keep scanning. Each beep uses one pack.'
                  : `Each beep logs it to your ${slot} and takes it out of stock.`}
        </p>
      </div>

      <div className="relative z-10 flex flex-col gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {current && <ResultCard entry={current} onUndo={() => void undo(current)} onDate={() => setSheet('date')} onName={() => setSheet('name')} onSome={() => void onlySome(current)} />}
        <div className="flex items-stretch gap-3">
          <div className="flex flex-1 items-center gap-3 rounded-2xl bg-white/10 px-4 py-2 backdrop-blur">
            <span className="font-display text-4xl font-bold" aria-label={`${live.length} scanned`}>
              {live.length}
            </span>
            <span className="text-[15px] leading-tight text-white/80">
              scanned this session
              {needsName > 0 && (
                <>
                  <br />
                  {needsName} {needsName === 1 ? 'needs' : 'need'} a name
                </>
              )}
            </span>
          </div>
          <button type="button" aria-label="Type a barcode" onClick={() => setSheet('keyboard')} className="inline-flex w-16 items-center justify-center rounded-2xl border border-white/30">
            <Icon name="keyboard" className="size-7" />
          </button>
          <button type="button" onClick={() => (live.length ? setSheet('summary') : navigate('/stock'))} className="min-h-14 rounded-2xl bg-accent px-7 text-xl font-semibold text-accent-ink">
            Done
          </button>
        </div>
      </div>

      <LocationSheet
        open={sheet === 'location'}
        mode={mode}
        selected={mode === 'add' ? addLocationId : useLocation}
        onClose={() => setSheet(null)}
        onPick={(id) => {
          if (mode === 'add' && id) {
            setAddLocation(id);
            try {
              localStorage.setItem(LOCATION_KEY, id);
            } catch {
              // Remembering is a nicety.
            }
          } else setUseLocation(id);
          setSheet(null);
        }}
      />
      <Sheet open={sheet === 'slot'} onClose={() => setSheet(null)} title="Log it to…">
        <div className="flex flex-col gap-2">
          {MEAL_SLOTS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={slot === s}
              onClick={() => {
                setSlot(s);
                setSheet(null);
              }}
              className={`flex min-h-14 items-center rounded-xl border px-4 text-left font-medium capitalize ${slot === s ? 'border-accent bg-accent-soft' : 'border-line'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </Sheet>
      <KeyboardSheet open={sheet === 'keyboard'} onClose={() => setSheet(null)} onSubmit={(code) => void handleCode(code)} />
      {current?.add && (
        <NameSheet
          key={current.key}
          open={sheet === 'name'}
          product={current.add.product}
          onClose={() => setSheet(null)}
          onSaved={(p) => current.add && update(current.key, { add: { ...current.add, product: p, known: true } })}
        />
      )}
      {current?.add && (
        <ScanDateSheet
          key={`date-${current.key}`}
          open={sheet === 'date'}
          item={current.add.change.item}
          onClose={() => setSheet(null)}
          onSaved={(item) => current.add && update(current.key, { add: { ...current.add, change: { ...current.add.change, item }, estimated: false } })}
        />
      )}
      <Sheet open={sheet === 'summary'} onClose={() => setSheet(null)} title="This session">
        <ul className="mb-4 flex flex-col divide-y divide-line">
          {live.map((e) => {
            const item = e.add?.change.item ?? (e.use?.status === 'used' ? e.use.change.item : null) ?? e.eat?.change?.item ?? null;
            const name = e.add ? (e.add.product.name ?? 'Unnamed product') : e.eat ? (e.eat.product.name ?? 'Unnamed product') : (e.use?.product?.name ?? e.barcode);
            return (
              <li key={e.key}>
                {item ? (
                  <Link to={`/stock/${item.id}`} className="flex min-h-14 items-center gap-3 py-2">
                    <span className="flex-1">
                      <span className="block font-semibold">{name}</span>
                      <span className="block text-sm text-muted">
                        {e.mode === 'add' ? `Added to ${item.locationName} · best before ${longDate(item.bestBefore)}` : e.mode === 'eat' ? `Logged to your ${e.eat?.entry.slot ?? 'meal'}` : `Used from ${item.locationName}`}
                      </span>
                    </span>
                    <Icon name="chevronRight" className="size-5 text-muted" />
                  </Link>
                ) : e.queued ? (
                  <p className="py-3">
                    <span className="font-semibold">Barcode {e.barcode}</span> <span className="text-muted">will sync when you're online</span>
                  </p>
                ) : (
                  <p className="py-3">
                    <span className="font-semibold">{name}</span> <span className="text-muted">wasn't in stock</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mb-4 text-sm text-muted">Tap anything to fix its date or location. Changing a date teaches the app.</p>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" onClick={() => setSheet(null)}>
            Keep scanning
          </Button>
          <Button variant="primary" onClick={() => navigate('/stock')}>
            Finish
          </Button>
        </div>
      </Sheet>
      <span className="sr-only">Signed in as {me.user.name}</span>
    </div>
  );
}

function ResultCard({ entry, onUndo, onDate, onName, onSome }: { entry: Entry; onUndo: () => void; onDate: () => void; onName: () => void; onSome: () => void }) {
  let label: string;
  let labelClass = 'text-fresh-green-text';
  let title: string;
  let detail: string;
  let primary: { text: string; onClick: () => void } | null = null;
  let canUndo = true;
  if (entry.eat) {
    const e = entry.eat;
    label = `Logged to your ${e.entry.slot}`;
    labelClass = 'text-accent-text';
    title = `${e.product.name ?? 'Unnamed product'}${packLabel(e.product)}`;
    detail = [e.entry.kcal !== null ? `${e.entry.kcal} kcal` : 'Calories unknown', e.change ? `taken from ${e.change.item.locationName.toLowerCase()}` : 'not in stock'].join(' · ');
  } else if (entry.queued) {
    label = 'Saved offline';
    labelClass = 'text-accent-text';
    title = `Barcode ${entry.barcode}`;
    detail = `No signal. We'll ${entry.mode === 'add' ? 'add' : 'use'} it as soon as you're back online.`;
  } else if (entry.error) {
    label = "Couldn't save that";
    labelClass = 'text-danger';
    title = entry.barcode;
    detail = entry.error;
    canUndo = false;
  } else if (entry.add) {
    const { product, change, estimated, known } = entry.add;
    if (!known && !product.name) {
      label = 'New barcode';
      labelClass = 'text-fresh-amber-text';
      title = 'Needs a name';
      detail = `Added to ${change.item.locationName}. Name it now or later.`;
      primary = { text: 'Name it', onClick: onName };
    } else {
      label = `Added to ${change.item.locationName}`;
      title = `${product.name}${packLabel(product)}`;
      detail = change.item.bestBefore ? `Best before ${longDate(change.item.bestBefore)}${estimated ? ' (estimated)' : ''}` : 'No best-before date yet';
      primary = { text: 'Change date', onClick: onDate };
    }
  } else if (entry.use?.status === 'used') {
    label = `Used from ${entry.use.change.item.locationName}`;
    labelClass = 'text-accent-text';
    title = `${entry.use.product.name ?? 'Unnamed product'}${packLabel(entry.use.product)}`;
    detail = entry.use.packsLeft === 0 ? 'That was the last one' : `${entry.use.packsLeft} ${entry.use.packsLeft === 1 ? 'pack' : 'packs'} left`;
    primary = { text: 'Only used some', onClick: onSome };
  } else {
    label = 'Not in stock';
    labelClass = 'text-danger';
    title = entry.use?.product?.name ?? entry.barcode;
    detail = entry.use?.product ? "There's none of this in stock." : "We don't know this barcode yet. Scan it in Add mode first.";
    canUndo = false;
  }
  return (
    <div className="animate-slide-up rounded-3xl bg-card p-4 text-ink" role="status" aria-live="polite">
      <div className="mb-3 flex items-center gap-4">
        <span aria-hidden className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-card-muted">
          <Icon name="bottle" className="size-7" />
        </span>
        <div className="min-w-0">
          <p className={`font-semibold ${labelClass}`}>{label}</p>
          <p className="truncate text-xl font-semibold">{title}</p>
          <p className="text-muted">{detail}</p>
        </div>
      </div>
      {(primary || canUndo) && (
        <div className="grid grid-cols-2 gap-3">
          {primary ? (
            <Button variant="outline" size="lg" onClick={primary.onClick}>
              {primary.text}
            </Button>
          ) : (
            <span />
          )}
          {canUndo && (
            <Button variant="danger" size="lg" onClick={onUndo}>
              Undo
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function LocationSheet({ open, mode, selected, onClose, onPick }: { open: boolean; mode: Mode; selected: string | null; onClose: () => void; onPick: (id: string | null) => void }) {
  const locations = useLocations().data ?? [];
  const options = [...(mode === 'use' ? [{ id: null, name: 'Any location', type: '' }] : []), ...locations];
  return (
    <Sheet open={open} onClose={onClose} title={mode === 'add' ? 'Put it in…' : 'Take it from…'}>
      <div className="flex flex-col gap-2">
        {options.map((l) => (
          <button
            key={l.id ?? 'any'}
            type="button"
            onClick={() => onPick(l.id)}
            aria-pressed={selected === l.id}
            className={`flex min-h-14 items-center gap-3 rounded-xl border px-4 text-left font-medium ${selected === l.id ? 'border-accent bg-accent-soft' : 'border-line'}`}
          >
            <Icon name={l.type ? locationIcon(l.type) : 'box'} className="size-5" />
            {l.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function KeyboardSheet({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <Sheet open={open} onClose={onClose} title="Type a barcode">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!code.trim()) return;
          onClose();
          onSubmit(code.trim());
          setCode('');
        }}
      >
        <Field label="Barcode" hint="The numbers under the stripes.">
          {(id) => <TextInput id={id} inputMode="numeric" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" disabled={!code.trim()}>
          Scan it
        </Button>
      </form>
    </Sheet>
  );
}

function NameSheet({ open, product, onClose, onSaved }: { open: boolean; product: ProductDto; onClose: () => void; onSaved: (p: ProductDto) => void }) {
  const ingredients = useIngredients().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(product.name ?? '');
  const [amount, setAmount] = useState(product.packAmount ? String(product.packAmount) : '');
  const [unit, setUnit] = useState(product.packUnit ?? 'g');
  const [ingredientId, setIngredientId] = useState(product.ingredientId ?? '');
  const [saving, setSaving] = useState(false);
  // Suggest the ingredient from the name as it's typed.
  const suggestion = name.length >= 3 ? ingredients.find((i) => name.toLowerCase().includes(i.name.toLowerCase().replace(/s$/, ''))) : undefined;
  const save = async () => {
    setSaving(true);
    try {
      const p = await api.patch<ProductDto>(`/api/products/${product.id}`, {
        name,
        packAmount: amount ? Number(amount) : null,
        packUnit: amount ? unit : null,
        ingredientId: (ingredientId || suggestion?.id) ?? null,
      });
      onSaved(p);
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(`Saved. Everyone's phone will know ${p.name} now.`);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="What is it?">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <Field label="Name">{(id) => <TextInput id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Greek yogurt" />}</Field>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label="Pack size">{(id) => <TextInput id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Optional" />}</Field>
          <Field label="Unit">
            {(id) => (
              <Select id={id} value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="g">g</option>
                <option value="kg">kg</option>
                <option value="ml">ml</option>
                <option value="l">litres</option>
                <option value="count">items</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Which ingredient is it?" hint="Lets recipes find it. Leave blank for things like crisps or chocolate bars.">
          {(id) => (
            <Select id={id} value={ingredientId || suggestion?.id || ''} onChange={(e) => setIngredientId(e.target.value)}>
              <option value="">None</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" size="lg" onClick={onClose}>
            Later
          </Button>
          <Button type="submit" variant="primary" size="lg" disabled={!name.trim() || saving}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function ScanDateSheet({ open, item, onClose, onSaved }: { open: boolean; item: StockItemDto; onClose: () => void; onSaved: (i: StockItemDto) => void }) {
  const [value, setValue] = useState(item.bestBefore ?? '');
  const toast = useToast();
  return (
    <Sheet open={open} onClose={onClose} title="Best-before date">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const c = await api.patch<{ item: StockItemDto }>(`/api/stock/${item.id}`, { bestBefore: value || null });
            onSaved(c.item);
            toast.show("Saved. We'll use this date next time too.");
            onClose();
          } catch (err) {
            toast.show(errorMessage(err), { tone: 'error' });
          }
        }}
      >
        <Field label="Best before">{(id) => <TextInput id={id} type="date" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" size="lg">
          Save
        </Button>
      </form>
    </Sheet>
  );
}
