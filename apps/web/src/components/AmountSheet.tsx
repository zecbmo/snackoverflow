/**
 * Change how much is left: a number in the food's own unit (g, ml, apples, portions) with
 * − and + buttons, plus quick "None / ¼ / ½ / ¾ / Full" for a single pack. A row with several
 * packs lists each one, and they can be merged into one. Packs can be removed (a correction,
 * not waste: Bin is for that). Saving writes one adjust event per changed pack, with one Undo.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type AmountStepper,
  amountStepper,
  amountText,
  type StockChangeDto,
  type StockItemDto,
  type StockMergeDto,
  stepAmount,
  stepperGrams,
} from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { longDate, stateLabel } from '../lib/format';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { Button, Sheet } from './ui';

/** What the user has set for one pack: an amount in the stepper's unit, or (size unknown) a fraction. */
type Draft = { text: string } | { fraction: number };

const FRACTIONS = [
  [0, 'None'],
  [0.25, '¼'],
  [0.5, '½'],
  [0.75, '¾'],
  [1, 'Full'],
] as const;

function show(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function stepLabel(step: number): string {
  return step === 0.5 ? '½' : show(step);
}

/** "g", "ml", "apples", "portion"… */
function unitWord(s: AmountStepper, pack: StockItemDto, n = 2): string {
  if (s.unit === 'portion') return n === 1 ? 'portion' : 'portions';
  if (s.unit === 'count') return pack.countUnit ? `${pack.countUnit}${n === 1 ? '' : 's'}` : n === 1 ? 'item' : 'items';
  return s.suffix;
}

/** "400g", "6 apples", "3 portions". */
function withUnit(n: number, s: AmountStepper, pack: StockItemDto): string {
  return s.suffix ? `${show(n)}${s.suffix}` : `${stepLabel(n)} ${unitWord(s, pack, n)}`;
}

function parse(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

function initialDraft(pack: StockItemDto): Draft {
  const v = amountStepper(pack).value;
  return { text: v === null ? '' : show(v) };
}

/** The PATCH body for a draft, or null when it doesn't change anything. */
function patchFor(pack: StockItemDto, draft: Draft): { remainingGrams: number } | { fractionLeft: number } | null {
  if ('fraction' in draft) return Math.abs(draft.fraction - pack.fractionLeft) < 0.001 ? null : { fractionLeft: draft.fraction };
  const s = amountStepper(pack);
  const n = parse(draft.text);
  if (n === null || n === s.value) return null;
  return { remainingGrams: stepperGrams(s, n) };
}

export function AmountSheet({ packs, onClose, onReplace }: { packs: StockItemDto[] | null; onClose: () => void; onReplace: (packs: StockItemDto[]) => void }) {
  const first = packs?.[0];
  return (
    <Sheet open={Boolean(first)} onClose={onClose} title={first?.productName ?? 'Change amount'}>
      {packs && first && <AmountForm key={packs.map((p) => p.id).join()} packs={packs} onClose={onClose} onReplace={onReplace} />}
    </Sheet>
  );
}

function AmountForm({ packs, onClose, onReplace }: { packs: StockItemDto[]; onClose: () => void; onReplace: (packs: StockItemDto[]) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(packs.map((p) => [p.id, initialDraft(p)])));
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const first = packs[0]!;
  const single = packs.length === 1;
  const kept = packs.filter((p) => !removed.has(p.id));
  const invalid = kept.some((p) => {
    const d = drafts[p.id]!;
    return 'text' in d && d.text.trim() !== '' && parse(d.text) === null;
  });
  const edits = packs
    .map((p) => ({ pack: p, body: removed.has(p.id) ? { fractionLeft: 0 } : patchFor(p, drafts[p.id]!) }))
    .filter((c) => c.body !== null);

  // Total of the packs being kept, when every amount is known.
  const totalGrams = kept.reduce<number | null>((sum, p) => {
    const d = drafts[p.id]!;
    if (sum === null || 'fraction' in d) return null;
    const n = parse(d.text);
    return n === null ? null : sum + stepperGrams(amountStepper(p), n);
  }, 0);

  const undoAll = (events: string[]) => async () => {
    try {
      for (const e of [...events].reverse()) await api.post(`/api/events/${e}/undo`);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
    await qc.invalidateQueries({ queryKey: ['stock'] });
  };

  /** Save the edits and removals; returns the events written. */
  const applyEdits = async (events: string[]) => {
    for (const c of edits) events.push((await api.patch<StockChangeDto>(`/api/stock/${c.pack.id}`, c.body)).eventId);
  };

  const run = async (fn: (events: string[]) => Promise<string | null>) => {
    setBusy(true);
    const events: string[] = [];
    try {
      const message = await fn(events);
      await qc.invalidateQueries({ queryKey: ['stock'] });
      if (message) toast.show(message, { action: { label: 'Undo', onClick: undoAll(events) } });
    } catch (e) {
      await qc.invalidateQueries({ queryKey: ['stock'] });
      // Anything already saved can still be undone.
      toast.show(errorMessage(e), { tone: 'error', ...(events.length ? { action: { label: 'Undo', onClick: undoAll(events) } } : {}) });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async (events) => {
      if (!edits.length) {
        onClose();
        return null;
      }
      await applyEdits(events);
      onClose();
      const gone = removed.size;
      return gone && edits.length === gone ? `Removed ${gone === 1 ? 'a pack' : `${gone} packs`} of ${first.productName}.` : `Updated the ${first.productName}.`;
    });

  // Saves any edits first, then merges what's left into the pack that's used first.
  const merge = () =>
    run(async (events) => {
      await applyEdits(events);
      const r = await api.post<StockMergeDto>('/api/stock/merge', { ids: kept.map((p) => p.id) });
      events.push(...r.eventIds);
      onReplace([r.item]);
      return `Merged ${kept.length} packs of ${first.productName} into one.`;
    });

  const where = single
    ? [first.locationName, first.state === 'closed' ? '' : stateLabel[first.state], first.bestBefore ? `best before ${longDate(first.bestBefore)}` : ''].filter(Boolean).join(' · ')
    : [first.locationName, `${kept.length} ${kept.length === 1 ? 'pack' : 'packs'}`, totalGrams !== null ? `${amountText(totalGrams, first)} in all` : ''].filter(Boolean).join(' · ');

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !busy) void save();
      }}
    >
      <p className="-mt-3 text-sm text-muted lg:-mt-2">{where}</p>
      {packs.map((p, i) => (
        <PackStepper
          key={p.id}
          pack={p}
          label={single ? null : [`Pack ${i + 1}`, p.state === 'closed' ? '' : stateLabel[p.state], p.bestBefore ? longDate(p.bestBefore) : ''].filter(Boolean).join(' · ')}
          draft={drafts[p.id]!}
          onChange={(d) => setDrafts((all) => ({ ...all, [p.id]: d }))}
          removed={removed.has(p.id)}
          onRemove={
            single
              ? undefined
              : (on) =>
                  setRemoved((s) => {
                    const next = new Set(s);
                    if (on) next.add(p.id);
                    else next.delete(p.id);
                    return next;
                  })
          }
          quick={single}
          autoFocus={i === 0}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {single ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              void run(async (events) => {
                events.push((await api.patch<StockChangeDto>(`/api/stock/${first.id}`, { fractionLeft: 0 })).eventId);
                onClose();
                return `Removed the ${first.productName}.`;
              });
            }}
            title="Take it off the list without counting it as waste (use Bin for that)"
          >
            <Icon name="trash" className="size-4" /> Remove
          </Button>
        ) : (
          <Button disabled={busy || invalid || kept.length < 2} onClick={() => void merge()} title="One pack with the amounts added up and the earliest best-before">
            <Icon name="group" className="size-4" /> Merge into one
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || invalid}>
          Save
        </Button>
      </div>
    </form>
  );
}

function PackStepper({
  pack,
  label,
  draft,
  onChange,
  removed,
  onRemove,
  quick,
  autoFocus,
}: {
  pack: StockItemDto;
  label: string | null;
  draft: Draft;
  onChange: (d: Draft) => void;
  removed: boolean;
  onRemove?: (on: boolean) => void;
  quick: boolean;
  autoFocus: boolean;
}) {
  const s = amountStepper(pack);
  const text = 'text' in draft ? draft.text : '';
  const value = parse(text);
  const step = (delta: number) => onChange({ text: show(stepAmount(value ?? 0, delta)) });
  const word = unitWord(s, pack);
  const unitName = s.unit === 'g' ? 'grams' : s.unit === 'ml' ? 'millilitres' : word;
  const big = s.steps[1];
  const small = s.steps[0]!;
  const stepBtn = 'min-w-11 px-2 tabular-nums lg:min-w-9';
  // Grams and ml in whole numbers; items and portions in halves.
  const precision = s.unit === 'g' || s.unit === 'ml' ? 1 : 0.5;
  const over = s.packSize !== null && value !== null && value > s.packSize;
  const name = label ?? `Amount of ${pack.productName}`;

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="sr-only">{name}</legend>
      {label && (
        <div className="flex items-center justify-between gap-2">
          <span aria-hidden className={`text-sm font-medium ${removed ? 'text-muted line-through' : ''}`}>
            {label}
          </span>
          {onRemove &&
            (removed ? (
              <Button size="xs" variant="ghost" onClick={() => onRemove(false)}>
                Keep
              </Button>
            ) : (
              <button
                type="button"
                aria-label={`Remove ${label.split(' · ')[0]!.toLowerCase()}`}
                title="Remove this pack (not counted as waste)"
                onClick={() => onRemove(true)}
                className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-danger lg:size-7 lg:rounded-md"
              >
                <Icon name="trash" className="size-4" />
              </button>
            ))}
        </div>
      )}
      {removed ? (
        <p className="text-sm text-muted">Removed when you save.</p>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            {big !== undefined && (
              <Button size="sm" className={stepBtn} aria-label={`Take off ${withUnit(big, s, pack)}`} onClick={() => step(-big)}>
                −{stepLabel(big)}
              </Button>
            )}
            <Button size="sm" className={stepBtn} aria-label={`Take off ${withUnit(small, s, pack)}`} onClick={() => step(-small)}>
              {big === undefined ? <Icon name="minus" className="size-4" /> : `−${stepLabel(small)}`}
            </Button>
            <label
              className={`flex min-h-11 min-w-0 flex-1 items-baseline gap-1 rounded-lg border bg-card px-2.5 py-2 focus-within:border-accent lg:min-h-8 lg:rounded-md lg:py-1 ${over ? 'border-accent' : 'border-line'}`}
              title={over ? 'More than the pack holds: it becomes a bigger pack' : undefined}
            >
              <span className="sr-only">Amount left in {unitName}</span>
              <input
                inputMode="decimal"
                autoFocus={autoFocus}
                value={text}
                placeholder={'fraction' in draft ? `${Math.round(draft.fraction * 100)}%` : s.packSize === null ? '?' : undefined}
                onChange={(e) => onChange({ text: e.target.value })}
                onFocus={(e) => e.target.select()}
                className="w-full min-w-0 bg-transparent text-right text-base font-semibold tabular-nums text-ink outline-none lg:text-sm"
              />
              <span className="shrink-0 whitespace-nowrap text-sm text-muted">
                {s.packSize !== null ? `/ ${s.suffix ? `${show(s.packSize)}${s.suffix}` : `${show(s.packSize)} ${word}`}` : word}
              </span>
            </label>
            <Button size="sm" className={stepBtn} aria-label={`Add ${withUnit(small, s, pack)}`} onClick={() => step(small)}>
              {big === undefined ? <Icon name="plus" className="size-4" /> : `+${stepLabel(small)}`}
            </Button>
            {big !== undefined && (
              <Button size="sm" className={stepBtn} aria-label={`Add ${withUnit(big, s, pack)}`} onClick={() => step(big)}>
                +{stepLabel(big)}
              </Button>
            )}
          </div>
          {quick && (
            <div className="grid grid-cols-5 gap-1" role="group" aria-label="Quick amounts">
              {FRACTIONS.map(([f, fname]) => (
                <Button
                  key={f}
                  size="xs"
                  variant="ghost"
                  className="border border-line"
                  aria-label={f === 0 ? 'None left' : f === 1 ? 'Full' : `${fname} left`}
                  onClick={() => onChange(s.packSize === null ? { fraction: f } : { text: show(Math.round((s.packSize * f) / precision) * precision) })}
                >
                  {fname}
                </Button>
              ))}
            </div>
          )}
          {s.packSize === null && <p className="text-xs text-muted">We don't know this pack's size yet; what you enter becomes its size.</p>}
        </>
      )}
    </fieldset>
  );
}
