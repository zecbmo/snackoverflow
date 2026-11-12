/**
 * Cook a recipe (or batch cook it): check what comes out of stock, earliest
 * best-before first; keep leftovers or portions; then answer "Is it opened now?"
 * for packs used in part. The whole cook can be undone.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { CookPlanDto, CookResultDto, StockItemDto } from '@snackoverflow/shared';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, PageHeader, Pill, Select, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { dateLabel, gramsLabel, toneClasses, toneFor } from '../lib/format';
import { useCookPlan, useLocations } from '../lib/queries';

type Take = CookPlanDto['lines'][number]['takes'][number] & { use: boolean; edit: string };
type Line = Omit<CookPlanDto['lines'][number], 'takes'> & { takes: Take[]; skipped: boolean };

function fromPlan(plan: CookPlanDto): Line[] {
  return plan.lines.map((l) => ({
    ...l,
    skipped: false,
    takes: l.takes.map((t) => ({ ...t, use: true, edit: t.grams !== null ? String(Math.round(t.grams)) : '' })),
  }));
}

export function CookPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const batch = params.get('batch') === '1';
  const servings = Number(params.get('servings')) || 0;
  const plan = useCookPlan(id, servings || 1);
  const me = useMe();
  const locationsQuery = useLocations();
  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [step, setStep] = useState<'take' | 'keep' | 'after'>('take');
  const [groups, setGroups] = useState<{ locationId: string; portions: number }[]>([]);
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
        lines: lines
          .filter((l) => !l.skipped)
          .map((l) => ({
            takes: l.takes
              .filter((t) => t.use)
              .map((t) => (t.grams !== null ? { stockItemId: t.stockItemId, grams: Math.max(0.1, Number(t.edit) || 0) } : { stockItemId: t.stockItemId, fraction: t.fraction ?? 0.5 }))
              .filter((t) => !('grams' in t) || (t.grams ?? 0) > 0),
          })),
        leftovers: groups.filter((g) => g.portions > 0),
      });
      setResult(r);
      setOpened(new Set(r.askOpened.map((i) => i.id)));
      await qc.invalidateQueries({ queryKey: ['stock'] });
      setStep('after');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      for (const sid of opened) await api.post(`/api/stock/${sid}/open`, {});
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(batch ? 'Batch cooked. Portions are in stock.' : 'Enjoy!', {
        action: result
          ? {
              label: 'Undo',
              onClick: async () => {
                await api.post(`/api/cooks/${result.cookId}/undo`, {});
                await qc.invalidateQueries({ queryKey: ['stock'] });
              },
            }
          : undefined,
      });
      navigate(`/recipes/${id}`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const short = lines.filter((l) => !l.skipped && (l.shortGrams ?? 0) > 0 && !l.optional);
  const portions = groups.reduce((n, g) => n + g.portions, 0);

  return (
    <>
      <PageHeader title={batch ? `Batch cook ${p.title}` : `Cook ${p.title}`} subtitle={`${p.servings} servings`} left={<BackButton to={`/recipes/${id}`} />} />
      <div className="flex max-w-3xl flex-col gap-4">
        {step === 'take' && (
          <>
            <p className="text-muted">This is what we'll take from stock, using what goes off first. Change any amount, or untick what you didn't use.</p>
            {lines.map((l, li) => (
              <Card key={l.recipeIngredientId} className={`p-4 ${l.skipped ? 'opacity-60' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <p className="font-semibold">{l.text}</p>
                    <p className="text-sm text-muted">
                      {l.neededGrams !== null ? `Needs ${gramsLabel(l.neededGrams)}` : 'Not tracked'}
                      {l.ingredientName ? ` · ${l.ingredientName}` : ''}
                      {!l.skipped && (l.shortGrams ?? 0) > 0 && ` · short by ${gramsLabel(l.shortGrams)}`}
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
                        <span className="min-w-0 flex-1 text-[15px]">
                          {t.productName} <span className="text-muted">· {t.locationName}</span>
                        </span>
                        <Pill className={toneClasses[toneFor(t, me.today)].pill}>{dateLabel(t.bestBefore, me.today)}</Pill>
                        {t.grams !== null ? (
                          <span className="flex items-center gap-1">
                            <span className="w-20">
                              <TextInput aria-label={`Grams from ${t.productName}`} inputMode="decimal" value={t.edit} onChange={(e) => setTake(li, ti, { edit: e.target.value })} />
                            </span>
                            <span className="text-sm text-muted">g</span>
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
            {short.length > 0 && <p className="text-[15px] text-muted">Short of {short.map((l) => l.ingredientName ?? l.text).join(', ')}. You can still cook; we'll take what's there.</p>}
            <Button variant="primary" size="lg" onClick={() => setStep('keep')}>
              Next
            </Button>
          </>
        )}

        {step === 'keep' && (
          <>
            <Card className="flex flex-col gap-3 p-5">
              <h2 className="text-xl font-bold">{batch ? 'Where are the portions going?' : 'Any leftovers?'}</h2>
              <p className="text-muted">{batch ? 'Each place gets its own best-before.' : 'Leftovers keep for 2 days in the fridge (rice dishes 1 day), or freeze them.'}</p>
              {groups.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex items-center gap-2" role="group" aria-label="Portions">
                    <button
                      type="button"
                      aria-label="Fewer portions"
                      disabled={g.portions <= 0}
                      onClick={() => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, portions: x.portions - 1 } : x)))}
                      className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="min-w-24 text-center font-semibold" aria-live="polite">
                      {g.portions} {g.portions === 1 ? 'portion' : 'portions'}
                    </span>
                    <button
                      type="button"
                      aria-label="More portions"
                      onClick={() => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, portions: x.portions + 1 } : x)))}
                      className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl"
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
              {groups.length < 4 && (
                <Button className="self-start" onClick={() => setGroups((gs) => [...gs, { locationId: (locations.find((l) => l.type === 'freezer') ?? locations[0]!).id, portions: 1 }])}>
                  Add another place
                </Button>
              )}
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={() => setStep('take')}>
                Back
              </Button>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => void confirm()}>
                {busy ? 'Saving…' : portions ? `Cooked, keep ${portions}` : 'Cooked it'}
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
