/**
 * Shopping staples: food the household always wants in. One switch and one level ("keep at
 * least 2L"); below the level, the food puts itself on the shopping list. The same settings show
 * in the stock side panel (where a food is made a staple) and under Settings → Shopping staples.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { itemOf, type StapleDto, type StockItemDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { TextInput, Toggle } from './ui';

export const useStaples = () => useQuery({ queryKey: ['shopping', 'staples'], queryFn: () => api.get<StapleDto[]>('/api/staples') });

/** "250g", "2 eggs", "1 pack", "500ml". */
export function stapleAmount(s: Pick<StapleDto, 'unit' | 'unitName'>, n: number): string {
  const shown = String(Math.round(n * 10) / 10);
  if (s.unit === 'g') return n >= 1000 ? `${Math.round(n / 10) / 100}kg` : `${shown}g`;
  if (s.unit === 'ml') return n >= 1000 ? `${Math.round(n / 10) / 100}L` : `${shown}ml`;
  return `${shown} ${s.unitName ?? 'item'}${n === 1 ? '' : 's'}`;
}

const unitWord = (s: Pick<StapleDto, 'unit' | 'unitName'>) => (s.unit === 'g' || s.unit === 'ml' ? s.unit : `${s.unitName ?? 'item'}s`);

/** The staple for a stock item, if it is one: by its generic food, else by the product. */
export function stapleFor(staples: StapleDto[] | undefined, item: Pick<StockItemDto, 'ingredientId' | 'productId'>): StapleDto | undefined {
  return staples?.find((s) => (item.ingredientId ? s.ingredientId === item.ingredientId : s.productId === item.productId));
}

/** A sensible first level for something in stock, in the unit the staple will use. */
function firstLevel(item: StockItemDto): number {
  if (!item.ingredientId) return 1; // packs
  if (itemOf(item)) return 2;
  return item.displayUnit === 'ml' ? 500 : 250;
}

/**
 * The switch and the level. With `item` (the stock side panel) a food that isn't a staple yet
 * can be made one; with only `staple` (the settings page) the level is changed or the staple removed.
 */
export function StapleSettings({ staple, item }: { staple: StapleDto | undefined; item?: StockItemDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = text ?? (staple ? String(staple.min) : '');

  const done = async (list: StapleDto[]) => {
    qc.setQueryData(['shopping', 'staples'], list);
    await qc.invalidateQueries({ queryKey: ['shopping'] });
  };
  const save = async (min: number) => {
    if (!(min > 0) || busy) return;
    setBusy(true);
    try {
      const target = staple ? { ingredientId: staple.ingredientId, productId: staple.productId } : { productId: item!.productId };
      await done(await api.put<StapleDto[]>('/api/staples', { ...target, min }));
      setText(null);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!staple || busy) return;
    setBusy(true);
    try {
      await done(await api.del<StapleDto[]>(`/api/staples/${staple.id}`));
      toast.show(`${staple.name} is no longer a staple.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const step = 'inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-card text-xl disabled:opacity-40 lg:size-8 lg:text-base';
  const value = Number(shown);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-card-muted p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Shopping staple</p>
          <p className="text-sm text-muted">{staple ? 'Goes on the shopping list by itself when you have less than this.' : 'Something you always want in: it goes on the shopping list when you run low.'}</p>
        </div>
        <Toggle checked={Boolean(staple)} onChange={(on) => void (on ? item && save(firstLevel(item)) : remove())} label="Shopping staple" />
      </div>
      {staple && (
        <>
          <div className="flex items-center gap-2">
            <span className="mr-auto text-sm font-medium">Keep at least</span>
            <button type="button" aria-label="Lower the level" disabled={busy || staple.min <= staple.step} onClick={() => void save(Math.max(staple.step, staple.min - staple.step))} className={step}>
              −
            </button>
            <label className="flex items-center gap-1.5">
              <span className="sr-only">Keep at least ({unitWord(staple)})</span>
              <TextInput
                inputMode="decimal"
                value={shown}
                onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ''))}
                onBlur={() => (value > 0 && value !== staple.min ? void save(value) : setText(null))}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className="!w-20 text-right font-semibold"
              />
              <span className="min-w-8 text-sm text-muted">{unitWord(staple)}</span>
            </label>
            <button type="button" aria-label="Raise the level" disabled={busy} onClick={() => void save(staple.min + staple.step)} className={step}>
              +
            </button>
          </div>
          <p className="flex items-center gap-1.5 text-sm text-muted" role="status">
            <Icon name={staple.low ? 'cart' : 'check'} className="size-4 shrink-0" />
            {staple.have > 0 ? `You have ${stapleAmount(staple, staple.have)}.` : 'None in stock.'}
            {staple.low ? (staple.onList ? " It's on the shopping list." : ' Below the level: it will go on the list.') : ''}
          </p>
        </>
      )}
    </div>
  );
}
