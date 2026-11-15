/**
 * The till experience: the camera stays open, every barcode gives a beep, a big
 * tick and a strip with the name and estimated best-before. Unknown barcodes get
 * an amber flash and a quick "what is it?" sheet. Undo on every scan. Where it goes is a row
 * of buttons at the bottom, in reach of a thumb. Scanning is for putting shopping away: food
 * you've used or eaten is taken out from the stock row or Log food (which has its own scanner).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatFullDate, formatPackSize, MEAL_SLOTS, type MealSlot, type ProductDto, type ProductPhotoReadDto, type ScanAddResult, type StockItemDto } from '@snackoverflow/shared';
import { Icon, locationIcon } from '../components/Icon';
import { useMe } from '../components/Layout';
import { useLogFood } from '../components/LogFood';
import { useToast } from '../components/Toast';
import { Button, Field, Select, Sheet, TextInput, Toggle } from '../components/ui';
import { api, errorMessage, isOffline } from '../lib/api';
import { enqueueScan, type QueuedScan, removeQueued } from '../lib/offlineQueue';
import { photoBody } from '../lib/images';
import { parsePounds } from '../lib/money';
import { canShareWithOff, rememberedShare, rememberShare, shareWithOff } from '../lib/off';
import { isNative } from '../lib/platform';
import { useIngredients, useLocations } from '../lib/queries';
import { beep, useBarcodeScanner } from '../scanner/useBarcodeScanner';

interface Entry {
  key: number;
  barcode: string;
  add?: ScanAddResult;
  /** Saved on the phone with no signal; sent when back online. */
  queued?: QueuedScan;
  error?: string;
  undone?: boolean;
  /** More packs of the same thing, added from the review card. */
  extra?: number;
  /** Reviewed and saved: its card is put away. */
  reviewed?: boolean;
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
  const locations = useLocations().data ?? [];
  const [params] = useSearchParams();
  // Eat mode moved to Log food: old links (and notifications) open its barcode scanner instead.
  const logFood = useLogFood();
  const eatLink = params.get('mode') === 'eat';
  const eatSlot = MEAL_SLOTS.includes(params.get('slot') as MealSlot) ? (params.get('slot') as MealSlot) : undefined;
  useEffect(() => {
    if (!eatLink) return;
    navigate('/', { replace: true });
    logFood.openLog({ slot: eatSlot, scan: true });
  }, [eatLink, eatSlot, navigate, logFood]);
  const [addLocation, setAddLocation] = useState<string | null>(readStoredLocation);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'unknown' | 'miss'; n: number } | null>(null);
  const [sheet, setSheet] = useState<'keyboard' | 'name' | 'date' | 'summary' | null>(null);
  const busy = useRef(false);
  const last = useRef<{ code: string; at: number } | null>(null);
  const nextKey = useRef(1);

  // Default to the remembered location, else the first fridge.
  const fallback = locations.find((l) => l.type === 'fridge') ?? locations[0];
  const addLocationId = locations.some((l) => l.id === addLocation) ? addLocation : (fallback?.id ?? null);
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
        const r = await api.post<ScanAddResult>('/api/scan/add', { barcode: code, locationId: addLocationId ?? undefined });
        setEntries((all) => [{ key, barcode: code, add: r }, ...all]);
        beep(r.known ? 'ok' : 'warn');
        setFlash({ kind: r.known ? 'ok' : 'unknown', n: key });
        if (!r.known) setSheet('name');
        void qc.invalidateQueries({ queryKey: ['stock'] });
      } catch (e) {
        if (isOffline(e)) {
          // No signal: keep the scan and send it later, like a till that keeps working offline.
          const queued = enqueueScan({ mode: 'add', barcode: code, locationId: addLocationId ?? undefined });
          beep('ok');
          setFlash({ kind: 'ok', n: key });
          setEntries((all) => [{ key, barcode: code, queued }, ...all]);
        } else {
          beep('warn');
          setFlash({ kind: 'miss', n: key });
          setEntries((all) => [{ key, barcode: code, error: errorMessage(e) }, ...all]);
        }
      } finally {
        busy.current = false;
        last.current = { code, at: Date.now() };
      }
    },
    [addLocationId, qc],
  );

  const scanning = sheet === null;
  const { videoRef, status } = useBarcodeScanner((c) => void handleCode(c), scanning);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
  }, [flash]);

  const undo = async (entry: Entry) => {
    if (entry.queued) {
      removeQueued(entry.queued.id);
      update(entry.key, { undone: true });
      toast.show('Removed.');
      return;
    }
    const eventId = entry.add?.change.eventId;
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

  /** Save what the review card changed: the name with or without its brand, and any more packs of it. */
  const saveReview = async (entry: Entry, r: { name?: string; packs: number }) => {
    if (!entry.add) return;
    try {
      let product = entry.add.product;
      if (r.name) product = await api.patch<ProductDto>(`/api/products/${product.id}`, { name: r.name });
      const item = entry.add.change.item;
      if (r.packs > 1) await api.post('/api/stock', { productId: product.id, locationId: item.locationId, count: r.packs - 1, bestBefore: item.bestBefore });
      update(entry.key, { add: { ...entry.add, product }, extra: r.packs - 1, reviewed: true });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
      toast.show(r.packs > 1 ? `Saved: ${r.packs} packs of ${product.name}.` : 'Saved.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const live = entries.filter((e) => !e.undone && !e.error);
  const packsScanned = live.reduce((n, e) => n + 1 + (e.extra ?? 0), 0);
  const needsName = live.filter((e) => e.add && !e.add.known && !e.add.product.name).length;
  const pickLocation = (id: string) => {
    setAddLocation(id);
    try {
      localStorage.setItem(LOCATION_KEY, id);
    } catch {
      // Remembering is a nicety.
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-scan text-white">
      {/* The Android app's camera is a native view behind the page; an empty <video> there shows the web view's play-button placeholder. */}
      {!isNative() && <video ref={videoRef} muted playsInline className="absolute inset-0 size-full object-cover opacity-70" aria-hidden />}
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
          <h1 className="text-lg font-semibold">Scan shopping</h1>
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
        <p className="mt-6 text-center text-[1.0625rem] text-white/80" aria-live="polite">
          {status === 'denied'
            ? 'Camera blocked. Allow camera access in your browser, or type the barcode.'
            : status === 'unavailable' || status === 'error'
              ? 'No camera here. Type the barcode instead.'
              : 'Keep scanning. Each beep adds one pack.'}
        </p>
      </div>

      <div className="relative z-10 flex flex-col gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {current && !current.reviewed && (
          <ResultCard key={current.key} entry={current} onUndo={() => void undo(current)} onDate={() => setSheet('date')} onName={() => setSheet('name')} onSave={(r) => saveReview(current, r)} />
        )}
        {/* Where the next scan goes: one tap, down here by the thumb, remembered for next time. */}
        <div role="radiogroup" aria-label="Put it in" className="flex gap-1 overflow-x-auto rounded-2xl bg-white/10 p-1 backdrop-blur">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={l.id === addLocationId}
              onClick={() => pickLocation(l.id)}
              className={`inline-flex min-h-12 min-w-fit flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 text-[0.9375rem] font-semibold ${l.id === addLocationId ? 'bg-white text-[#1a1c1a]' : 'text-white'}`}
            >
              <Icon name={locationIcon(l.type)} className="size-[18px] shrink-0" />
              {l.name}
            </button>
          ))}
        </div>
        <div className="flex items-stretch gap-3">
          <div className="flex flex-1 items-center gap-3 rounded-2xl bg-white/10 px-4 py-2 backdrop-blur">
            <span className="text-3xl font-bold tabular-nums sm:text-4xl" aria-label={`${packsScanned} scanned`}>
              {packsScanned}
            </span>
            <span className="text-[0.9375rem] leading-tight text-white/80">
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
            const item = e.add?.change.item ?? null;
            const name = e.add ? (e.add.product.name ?? 'Unnamed product') : e.barcode;
            return (
              <li key={e.key}>
                {item ? (
                  <Link to={`/stock/${item.id}`} className="flex min-h-14 items-center gap-3 py-2">
                    <span className="flex-1">
                      <span className="block font-semibold">
                        {name}
                        {e.extra ? ` × ${1 + e.extra}` : ''}
                      </span>
                      <span className="block text-sm text-muted">
                        Added to {item.locationName} · best before {item.bestBefore ? formatFullDate(item.bestBefore) : 'not set'}
                      </span>
                    </span>
                    <Icon name="chevronRight" className="size-5 text-muted" />
                  </Link>
                ) : (
                  <p className="py-3">
                    <span className="font-semibold">Barcode {e.barcode}</span> <span className="text-muted">will sync when you're online</span>
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

/** The brand as part of a scanned product's name: whether it's there now, and the name each way. */
function brandInName(product: ProductDto): { on: boolean; withBrand: string; bare: string } | null {
  const brand = product.brand?.trim();
  const name = product.name ?? '';
  if (!brand || !name || brand.length > 30) return null;
  const starts = name.toLowerCase().startsWith(`${brand.toLowerCase()} `);
  // The brand is in the name some other way ("Coca-Cola Zero"): nothing to switch.
  if (!starts && name.toLowerCase().includes(brand.toLowerCase())) return null;
  const bare = starts ? name.slice(brand.length + 1) : name;
  return { on: starts, withBrand: `${brand} ${bare}`, bare };
}

/** What a scan's review card can change before it's saved. */
interface Review {
  name?: string;
  packs: number;
}

/**
 * What the last scan did, with Undo, and a quick review: the brand in or out of the name, and
 * how many packs. Nothing here needs touching: if it scanned right, scan the next thing. Change
 * something and Save appears; saving puts the card away.
 */
function ResultCard({ entry, onUndo, onDate, onName, onSave }: { entry: Entry; onUndo: () => void; onDate: () => void; onName: () => void; onSave: (r: Review) => Promise<void> }) {
  const [brand, setBrand] = useState<boolean | null>(null);
  const [packs, setPacks] = useState(1);
  const [saving, setSaving] = useState(false);
  let label: string;
  let labelClass = 'text-fresh-green-text';
  let title: string;
  let detail: string;
  let primary: { text: string; onClick: () => void } | null = null;
  let canUndo = true;
  let naming: ReturnType<typeof brandInName> = null;
  let reviewable = false;
  let needsSize = false;
  if (entry.queued) {
    label = 'Saved offline';
    labelClass = 'text-accent-text';
    title = `Barcode ${entry.barcode}`;
    detail = "No signal. We'll add it as soon as you're back online.";
  } else if (entry.error) {
    label = "Couldn't save that";
    labelClass = 'text-danger';
    title = entry.barcode;
    detail = entry.error;
    canUndo = false;
  } else {
    const { product, change, estimated, known } = entry.add!;
    if (!known && !product.name) {
      label = 'New barcode';
      labelClass = 'text-fresh-amber-text';
      title = 'Needs a name';
      detail = `Added to ${change.item.locationName}. Name it now or later.`;
      primary = { text: 'Name it', onClick: onName };
    } else {
      naming = brandInName(product);
      reviewable = true;
      const name = naming && brand !== null ? (brand ? naming.withBrand : naming.bare) : product.name;
      label = `Added to ${change.item.locationName}`;
      title = `${name}${packLabel(product)}`;
      const serving = product.servingGrams ? ` · ${Math.round(product.servingGrams * 10) / 10}${product.displayUnit === 'ml' ? 'ml' : 'g'} a serving` : '';
      detail = `${change.item.bestBefore ? `Best before ${formatFullDate(change.item.bestBefore)}${estimated ? ' (estimated)' : ''}` : 'No best-before date yet'}${serving}`;
      primary = { text: 'Change date', onClick: onDate };
      // Nobody knows how big the pack is (Open Food Facts didn't say): the amount can't be shown until it's set.
      needsSize = !product.packAmount;
    }
  }
  const brandOn = naming ? (brand ?? naming.on) : false;
  const dirty = reviewable && ((naming !== null && brandOn !== naming.on) || packs !== 1);
  const save = async () => {
    setSaving(true);
    await onSave({ name: naming && brandOn !== naming.on ? (brandOn ? naming.withBrand : naming.bare) : undefined, packs });
    setSaving(false);
  };
  const step = 'inline-flex size-10 items-center justify-center rounded-full border border-line text-lg disabled:opacity-40';
  // Kept short: on a phone it sits above the location buttons and Done, which must stay on screen.
  return (
    <div className="animate-slide-up rounded-2xl bg-card p-3 text-ink" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${labelClass}`}>{label}</p>
          <p className="truncate text-lg font-semibold leading-tight">{title}</p>
          {primary && reviewable ? (
            // The date line is the way to change the date: one less button on a small screen.
            <button type="button" title={primary.text} onClick={primary.onClick} className="block max-w-full truncate text-left text-sm text-muted underline decoration-dotted underline-offset-2">
              {detail}
              <span className="sr-only">: {primary.text.toLowerCase()}</span>
            </button>
          ) : (
            <p className="truncate text-sm text-muted">{detail}</p>
          )}
        </div>
        {needsSize && !dirty && (
          <Button variant="primary" size="sm" title="The pack's size isn't known, so its amount can't be shown" onClick={onName}>
            Set size
          </Button>
        )}
        {primary && !reviewable && (
          <Button variant="primary" size="sm" onClick={primary.onClick}>
            {primary.text}
          </Button>
        )}
        {canUndo && !dirty && (
          <Button variant="danger" size="sm" onClick={onUndo}>
            Undo
          </Button>
        )}
      </div>
      {reviewable && (
        <div className="mt-2 flex items-center gap-3 border-t border-line pt-2">
          {naming && (
            <div className="flex min-w-0 items-center gap-2">
              <Toggle checked={brandOn} onChange={setBrand} label={`${entry.add!.product.brand} in the name`} />
              <span className="text-sm">Brand</span>
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5" role="group" aria-label="How many packs">
            <button type="button" aria-label="One fewer pack" disabled={packs <= 1} onClick={() => setPacks((n) => Math.max(1, n - 1))} className={step}>
              −
            </button>
            <span className="min-w-14 text-center text-sm font-semibold tabular-nums" aria-live="polite">
              {packs} {packs === 1 ? 'pack' : 'packs'}
            </span>
            <button type="button" aria-label="One more pack" disabled={packs >= 24} onClick={() => setPacks((n) => Math.min(24, n + 1))} className={step}>
              +
            </button>
          </div>
        </div>
      )}
      {dirty && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setBrand(null);
              setPacks(1);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
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
  const canShare = canShareWithOff(product, useMe().features);
  const [share, setShare] = useState(() => canShare && rememberedShare());
  const [brand, setBrand] = useState(product.brand ?? '');
  const shareId = useId();
  const me = useMe();
  // Read from photos of the pack (AI): fills the form in, and the label's nutrition is saved with it.
  const [nutrition, setNutrition] = useState<ProductPhotoReadDto['nutritionPer100g']>(null);
  const [reading, setReading] = useState(false);
  const [fromPhoto, setFromPhoto] = useState(false);
  const readPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setReading(true);
    try {
      const photos = await Promise.all([...files].slice(0, 4).map(photoBody));
      const r = await api.post<ProductPhotoReadDto>(`/api/products/${product.id}/read-photos`, { photos });
      setName(r.name);
      if (r.brand) setBrand(r.brand);
      if (r.packAmount) {
        setAmount(String(r.packAmount));
        setUnit(r.packUnit ?? 'g');
      }
      if (r.ingredientId) setIngredientId(r.ingredientId);
      setNutrition(r.nutritionPer100g);
      setFromPhoto(true);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setReading(false);
    }
  };
  // Suggest the ingredient from the name as it's typed.
  const suggestion = name.length >= 3 ? ingredients.find((i) => name.toLowerCase().includes(i.name.toLowerCase().replace(/s$/, ''))) : undefined;
  const save = async () => {
    setSaving(true);
    try {
      const p = await api.patch<ProductDto>(`/api/products/${product.id}`, {
        name,
        ...(share || fromPhoto ? { brand: brand.trim() || null } : {}),
        ...(nutrition ? { nutritionPer100g: nutrition } : {}),
        packAmount: amount ? Number(amount) : null,
        packUnit: amount ? unit : null,
        ingredientId: (ingredientId || suggestion?.id) ?? null,
      });
      onSaved(p);
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(`Saved. Everyone's phone will know ${p.name} now.`);
      onClose();
      if (canShare) rememberShare(share);
      // Carries on after the sheet closes, so scanning isn't held up.
      if (share)
        shareWithOff(p.id)
          .then((r) => {
            toast.show(r.message);
            void qc.invalidateQueries({ queryKey: ['products'] });
          })
          .catch((e: unknown) => toast.show(errorMessage(e), { tone: 'error' }));
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
        {me.features.ai && (
          <div className="flex flex-col gap-1">
            <label className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-card px-4 font-semibold hover:bg-card-muted ${reading ? 'opacity-60' : ''}`}>
              <Icon name="camera" className="size-5" />
              {reading ? 'Reading the pack…' : fromPhoto ? 'Take another photo' : 'Take a photo of the pack'}
              <input type="file" accept="image/*" capture="environment" multiple className="sr-only" disabled={reading} onChange={(e) => void readPhotos(e.target.files)} />
            </label>
            <p className="text-sm text-muted">
              {fromPhoto
                ? `Filled in from the photo${nutrition ? ', with the label’s nutrition' : ''}. Check it, then save.`
                : 'The front, and the label with the nutrition if you can. Or type it in.'}
            </p>
          </div>
        )}
        <Field label="Name">{(id) => <TextInput id={id} autoFocus={!me.features.ai} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Greek yogurt" />}</Field>
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
        {canShare && (
          <div className="flex min-h-11 items-start gap-3">
            <input
              id={`${shareId}-box`}
              type="checkbox"
              aria-describedby={`${shareId}-hint`}
              className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
            />
            <div>
              <label htmlFor={`${shareId}-box`} className="block font-medium">
                Add it to Open Food Facts too
              </label>
              <p id={`${shareId}-hint`} className="text-sm text-muted">
                Shares the name, brand and pack size, so the next person to scan it doesn't have to type them.
              </p>
            </div>
          </div>
        )}
        {(share || fromPhoto) && <Field label="Brand">{(id) => <TextInput id={id} value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Optional" />}</Field>}
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
  const [price, setPrice] = useState('');
  const toast = useToast();
  const pricing = useMe().household.settings.pricingEnabled;
  return (
    <Sheet open={open} onClose={onClose} title="Best-before date">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const c = await api.patch<{ item: StockItemDto }>(`/api/stock/${item.id}`, { bestBefore: value || null });
            const pence = pricing ? parsePounds(price) : null;
            if (pence) await api.post(`/api/products/${item.productId}/prices`, { pricePence: pence });
            onSaved(c.item);
            toast.show("Saved. We'll use this date next time too.");
            onClose();
          } catch (err) {
            toast.show(errorMessage(err), { tone: 'error' });
          }
        }}
      >
        <Field label="Best before">{(id) => <TextInput id={id} type="date" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        {pricing && (
          <Field label="Price paid (£)" hint="Optional.">
            {(id) => <TextInput id={id} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 1.55" />}
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg">
          Save
        </Button>
      </form>
    </Sheet>
  );
}
