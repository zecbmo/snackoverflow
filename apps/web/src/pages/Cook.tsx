/**
 * Cook a recipe (or batch cook it): check what comes out of stock, earliest
 * best-before first; keep leftovers (in halves, up to what was cooked, cut into smaller
 * portions if you like); when it wasn't planned, put what was eaten on the calendar;
 * then answer "Is it opened now?" for packs used in part. The whole cook can be undone.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { amountText, type CookPlanDto, type CookResultDto, formatAmount, MEAL_SLOTS, type MealSlot, type PlanEntryDto, slotForTime, type StockItemDto } from '@snackoverflow/shared';
import { BackButton, useMe } from '../components/Layout';
import { PortionPicker } from '../components/PortionIcons';
import { Segmented } from '../components/Toolbar';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, PageHeader, Pill, Select, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { dateLabel, toneClasses, toneFor } from '../lib/format';
import { useCookPlan, useLocations, useRecipe, useUsers } from '../lib/queries';

type Take = CookPlanDto['lines'][number]['takes'][number] & { use: boolean; edit: string };
type Line = Omit<CookPlanDto['lines'][number], 'takes'> & { takes: Take[]; skipped: boolean };

/** Liquids are entered in ml; everything else in grams. */
const isLiquid = (l: { unit: CookPlanDto['lines'][number]['unit'] }) => l.unit.displayUnit === 'ml';
const density = (l: { unit: CookPlanDto['lines'][number]['unit'] }) => l.unit.densityGPerMl ?? 1;

function fromPlan(plan: CookPlanDto): Line[] {
  return plan.lines.map((l) => ({
    ...l,
    skipped: false,
    takes: l.takes.map((t) => ({ ...t, use: true, edit: t.grams !== null ? String(Math.round(isLiquid(l) ? t.grams / density(l) : t.grams)) : '' })),
  }));
}

/** "Potatoes · 1.6kg in stock", "Prunes · none in stock". */
function stockLine(l: Line): string {
  const name = l.ingredientName ?? 'This';
  if (l.inStockGrams === null) return `${name} · some in stock`;
  if (l.inStockGrams <= 0) return `${name} · none in stock`;
  return `${name} · ${amountText(l.inStockGrams, l.unit)} in stock`;
}

const SLOT_LABEL: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const SPLITS = [
  { value: '1', label: 'No' },
  { value: '2', label: 'Halves' },
  { value: '3', label: 'Thirds' },
  { value: '4', label: 'Quarters' },
] as const;

/** "1 portion", "1½ portions". */
const portionWords = (n: number) => `${formatAmount(n)} ${n > 1 ? 'portions' : 'portion'}`;

export function CookPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const batch = params.get('batch') === '1';
  const entryId = params.get('entry');
  const servings = Number(params.get('servings')) || 0;
  const swapsParam = params.get('swaps');
  const plan = useCookPlan(id, servings || 1, entryId ? `&entry=${entryId}` : swapsParam ? `&swaps=${encodeURIComponent(swapsParam)}` : '');
  const recipe = useRecipe(id).data;
  const members = useUsers().data ?? [];
  const me = useMe();
  const locationsQuery = useLocations();
  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [step, setStep] = useState<'take' | 'keep' | 'calendar' | 'after'>('take');
  // Servings kept per place (halves allowed); `split` cuts each serving into smaller portions.
  const [groups, setGroups] = useState<{ locationId: string; portions: number }[]>([]);
  const [split, setSplit] = useState(1);
  // Not from the calendar: who ate what wasn't kept, and when.
  const [eaters, setEaters] = useState<{ userId: string; portions: number }[]>([]);
  const [slot, setSlot] = useState<MealSlot>(() => slotForTime(new Date().getHours()));
  const [planned, setPlanned] = useState<string | null>(null);
  const [result, setResult] = useState<CookResultDto | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (plan.data && !lines) setLines(fromPlan(plan.data));
  }, [plan.data, lines]);

  useEffect(() => {
    if (!plan.data || groups.length || !locations.length) return;
    const fridge = locations.find((l) => l.type === 'fridge') ?? locations[0]!;
    const freezer = locations.find((l) => l.type === 'freezer');
    const total = Math.round(plan.data.servings);
    if (batch && freezer) {
      const inFridge = Math.min(2, total);
      setGroups([
        { locationId: fridge.id, portions: inFridge },
        ...(total - inFridge > 0 ? [{ locationId: freezer.id, portions: total - inFridge }] : []),
      ]);
    } else {
      setGroups([{ locationId: fridge.id, portions: 0 }]);
    }
  }, [plan.data, locations, batch, groups.length]);

  if (plan.isPending || !lines) return <Spinner />;
  if (plan.error || !plan.data) return <ErrorNote error={plan.error ?? 'Not found'} />;
  const p = plan.data;

  const setTake = (li: number, ti: number, patch: Partial<Take>) =>
    setLines((ls) => ls!.map((l, i) => (i === li ? { ...l, takes: l.takes.map((t, j) => (j === ti ? { ...t, ...patch } : t)) } : l)));

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post<CookResultDto>(`/api/recipes/${id}/cook`, {
        servings: p.servings,
        ...(entryId ? { mealPlanEntryId: entryId } : {}),
        lines: lines
          .filter((l) => !l.skipped)
          .map((l) => ({
            takes: l.takes
              .filter((t) => t.use)
              .map((t) =>
                t.grams !== null
                  ? { stockItemId: t.stockItemId, grams: Math.max(0.1, (Number(t.edit) || 0) * (isLiquid(l) ? density(l) : 1)) }
                  : { stockItemId: t.stockItemId, fraction: t.fraction ?? 0.5 },
              )
              .filter((t) => !('grams' in t) || (t.grams ?? 0) > 0),
          })),
        leftovers: groups.filter((g) => g.portions > 0),
        split,
      });
      setResult(r);
      setOpened(new Set(r.askOpened.map((i) => i.id)));
      await qc.invalidateQueries({ queryKey: ['stock'] });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      // Cooked without a plan and not all of it kept: offer to put what was eaten on the calendar.
      const eaten = p.servings - portions;
      if (!entryId && eaten > 0) {
        setEaters([{ userId: me.user.id, portions: Math.min(1, eaten) }]);
        setStep('calendar');
      } else setStep('after');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const addToCalendar = async () => {
    setBusy(true);
    try {
      const e = await api.post<PlanEntryDto>('/api/plan', { date: me.today, slot, kind: 'recipe', recipeId: id, servings: p.servings - portions, people: eaters, eaten: true });
      setPlanned(e.id);
      await qc.invalidateQueries({ queryKey: ['plan'] });
      setStep('after');
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      for (const sid of opened) await api.post(`/api/stock/${sid}/open`, {});
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(allKept ? 'Batch cooked. Portions are in stock.' : 'Enjoy!', {
        action: result
          ? {
              label: 'Undo',
              onClick: async () => {
                await api.post(`/api/cooks/${result.cookId}/undo`, {});
                if (planned) await api.del(`/api/plan/${planned}`).catch(() => {});
                await qc.invalidateQueries({ queryKey: ['stock'] });
                await qc.invalidateQueries({ queryKey: ['plan'] });
              },
            }
          : undefined,
      });
      // Back to wherever the cook started (Today, the calendar, the recipe).
      if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) navigate(-1);
      else navigate(`/recipes/${id}`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const short = lines.filter((l) => !l.skipped && (l.shortGrams ?? 0) > 0 && !l.optional);
  const portions = groups.reduce((n, g) => n + g.portions, 0);
  // Keeping every serving is a batch cook, whichever button started it.
  const allKept = portions > 0 && portions >= p.servings - 0.001;
  const room = p.servings - portions;
  const pieces = portions * split;
  const kcalEach = recipe?.kcalPerServing ? Math.round(recipe.kcalPerServing / split) : null;

  return (
    <>
      <PageHeader title={batch || (step !== 'take' && allKept) ? `Batch cook ${p.title}` : `Cook ${p.title}`} subtitle={`${p.servings} servings`} left={<BackButton to={`/recipes/${id}`} />} />
      <div className="flex max-w-3xl flex-col gap-4">
        {step === 'take' && (
          <>
            {short.length > 0 && (
              <p role="note" className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-[0.9375rem]">
                <strong className="font-semibold">Not all of this is in stock</strong> (short of {short.map((l) => (l.ingredientName ?? l.text).toLowerCase()).join(', ')}). We'll take what you have and
                assume you have the rest, so you can still cook it.
              </p>
            )}
            <p className="text-muted">This is what we'll take from stock, using what goes off first. Change any amount, or untick what you didn't use.</p>
            {lines.map((l, li) => (
              <Card key={l.recipeIngredientId} className={`p-4 ${l.skipped ? 'opacity-60' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <p className="font-semibold">{l.text}</p>
                    {l.swappedFrom && l.ingredientName && (
                      <p className="text-sm font-medium">
                        Using {l.ingredientName.toLowerCase()} instead of {l.swappedFrom.toLowerCase()}
                      </p>
                    )}
                    {p.servings !== p.serves && l.originalText !== l.text && (
                      <p className="text-sm text-muted">
                        Recipe for {p.serves} uses {l.originalText}
                      </p>
                    )}
                    <p className="text-sm text-muted">
                      {l.neededGrams === null ? (l.ingredientName ? 'Not tracked' : 'Not linked to stock') : stockLine(l)}
                      {!l.skipped && (l.shortGrams ?? 0) > 0 && <span className="text-fresh-red-text"> · short by {amountText(l.shortGrams ?? 0, l.unit)}</span>}
                    </p>
                  </div>
                  {l.takes.length > 0 && (
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={l.skipped} onChange={(e) => setLines((ls) => ls!.map((x, i) => (i === li ? { ...x, skipped: e.target.checked } : x)))} />
                      Didn't use
                    </label>
                  )}
                </div>
                {!l.skipped && l.takes.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {l.takes.map((t, ti) => (
                      <li key={t.stockItemId} className="flex flex-wrap items-center gap-2 rounded-xl bg-card-muted p-2">
                        <input
                          type="checkbox"
                          aria-label={`Take from ${t.productName}`}
                          className="size-5 accent-[var(--accent)]"
                          checked={t.use}
                          onChange={(e) => setTake(li, ti, { use: e.target.checked })}
                        />
                        <span className="min-w-0 flex-1 text-[0.9375rem]">
                          {t.productName} <span className="text-muted">· {t.locationName}</span>
                        </span>
                        <Pill className={toneClasses[toneFor(t, me.today)].pill}>{dateLabel(t.bestBefore, me.today)}</Pill>
                        {t.grams !== null ? (
                          <span className="flex items-center gap-1">
                            <span className="w-20">
                              <TextInput
                                aria-label={`${isLiquid(l) ? 'Millilitres' : 'Grams'} from ${t.productName}`}
                                inputMode="decimal"
                                value={t.edit}
                                onChange={(e) => setTake(li, ti, { edit: e.target.value })}
                              />
                            </span>
                            <span className="text-sm text-muted">{isLiquid(l) ? 'ml' : 'g'}</span>
                          </span>
                        ) : (
                          <span className="text-sm text-muted">about half</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
            <Button variant="primary" size="lg" className="lg:self-start lg:px-10" onClick={() => setStep('keep')}>
              Next
            </Button>
          </>
        )}

        {step === 'keep' && (
          <>
            <Card className="flex flex-col gap-3 p-5">
              <h2 className="text-xl font-bold">{batch || allKept ? 'Where are the portions going?' : 'Any leftovers?'}</h2>
              <p className="text-muted">
                {batch || allKept
                  ? 'Each place gets its own best-before.'
                  : 'Leftovers keep for 2 days in the fridge (rice dishes 1 day), or freeze them.'}{' '}
                You cooked {formatAmount(p.servings)}, so you can keep up to {formatAmount(p.servings)}.
              </p>
              {groups.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex items-center gap-2" role="group" aria-label="Portions">
                    <button
                      type="button"
                      aria-label="Fewer portions"
                      disabled={g.portions <= 0}
                      onClick={() => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, portions: Math.max(0, x.portions - 0.5) } : x)))}
                      className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="min-w-28 text-center font-semibold" aria-live="polite">
                      {portionWords(g.portions)}
                    </span>
                    <button
                      type="button"
                      aria-label="More portions"
                      disabled={room < 0.5}
                      onClick={() => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, portions: x.portions + 0.5 } : x)))}
                      className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                  <Select aria-label="Where" value={g.locationId} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, locationId: e.target.value } : x)))}>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
              {groups.length < 4 && room >= 0.5 && (
                <Button
                  className="self-start"
                  onClick={() => setGroups((gs) => [...gs, { locationId: (locations.find((l) => l.type === 'freezer') ?? locations[0]!).id, portions: Math.min(1, room) }])}
                >
                  Add another place
                </Button>
              )}
              {portions > 0 && (
                <div className="flex flex-col gap-2 border-t border-line pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">Split into smaller portions?</span>
                    <Segmented label="Split into smaller portions" value={String(split) as (typeof SPLITS)[number]['value']} onChange={(v) => setSplit(Number(v))} options={[...SPLITS]} />
                  </div>
                  <p className="text-sm text-muted">
                    {split === 1
                      ? `${portionWords(portions)} kept${kcalEach ? `, about ${kcalEach} kcal each` : ''}.`
                      : `${formatAmount(portions)} ${portions > 1 ? 'servings' : 'serving'} kept as ${portionWords(pieces)}${kcalEach ? ` of about ${kcalEach} kcal each` : ''}.`}
                  </p>
                </div>
              )}
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={() => setStep('take')}>
                Back
              </Button>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => void confirm()}>
                {busy ? 'Saving…' : allKept ? `Batch cooked, keep ${formatAmount(pieces)}` : portions ? `Cooked, keep ${formatAmount(pieces)}` : 'Cooked it'}
              </Button>
            </div>
          </>
        )}

        {step === 'calendar' && (
          <>
            <Card className="flex flex-col gap-3 p-5">
              <h2 className="text-xl font-bold">Add it to your calendar?</h2>
              <p className="text-muted">
                This wasn't planned. Put the {formatAmount(p.servings - portions)} {p.servings - portions > 1 ? 'servings' : 'serving'} you didn't keep on the calendar so they count
                towards calories. Tap a circle to say who had it.
              </p>
              <PortionPicker
                entry={{ servings: p.servings - portions, people: eaters.map((e) => ({ ...e, name: members.find((m) => m.id === e.userId)?.name ?? 'Someone' })), batch: false } as PlanEntryDto}
                viewerId={me.user.id}
                meId={me.user.id}
                isAdmin={me.user.role === 'admin'}
                members={members}
                onChange={setEaters}
              />
              <label className="flex items-center gap-2 text-sm">
                Meal
                <Select aria-label="Meal" value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)} className="max-w-40">
                  {MEAL_SLOTS.map((m) => (
                    <option key={m} value={m}>
                      {SLOT_LABEL[m]}
                    </option>
                  ))}
                </Select>
                <span className="text-muted">today</span>
              </label>
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={() => setStep('after')}>
                Skip
              </Button>
              <Button variant="primary" size="lg" disabled={busy || eaters.length === 0} onClick={() => void addToCalendar()}>
                Add to calendar
              </Button>
            </div>
          </>
        )}

        {step === 'after' && result && (
          <>
            {result.askOpened.length > 0 && (
              <Card className="flex flex-col gap-2 p-5">
                <h2 className="text-xl font-bold">Are these opened now?</h2>
                <p className="text-muted">Opened food goes off sooner, so we'll update the dates.</p>
                {result.askOpened.map((i: StockItemDto) => (
                  <label key={i.id} className="flex min-h-12 items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--accent)]"
                      checked={opened.has(i.id)}
                      onChange={(e) =>
                        setOpened((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(i.id);
                          else n.delete(i.id);
                          return n;
                        })
                      }
                    />
                    <span>
                      {i.productName} <span className="text-muted">· {i.locationName}</span>
                    </span>
                  </label>
                ))}
              </Card>
            )}
            {result.askStillSome.length > 0 && (
              <Card className="p-5">
                <p>
                  By our numbers {result.askStillSome.map((i) => i.productName).join(', ')} {result.askStillSome.length === 1 ? 'is' : 'are'} used up. If there's still some, fix the amount on the{' '}
                  <Link to={`/stock/${result.askStillSome[0]!.id}`} className="font-semibold text-accent-text">
                    item page
                  </Link>
                  .
                </p>
              </Card>
            )}
            {result.leftovers.length > 0 && (
              <Card className="p-5">
                <p>Kept: {result.leftovers.map((l) => `${l.locationName} (best before ${dateLabel(l.bestBefore, me.today).toLowerCase()})`).join(', ')}.</p>
              </Card>
            )}
            <Button variant="primary" size="lg" disabled={busy} onClick={() => void finish()}>
              Done
            </Button>
          </>
        )}
      </div>
    </>
  );
}
