/**
 * One pack in detail: dates, amount left, the other packs of the same product, its history and
 * a link to the product. Shown in the Stock side panel and on the /stock/:id page.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { StockChangeDto, StockEventDto, StockItemDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { amountLabel, dateLabel, longDate, stateLabel, toneClasses, toneFor } from '../lib/format';
import { useProductStock, useStockItem } from '../lib/queries';
import { Icon } from './Icon';
import { useMe } from './Layout';
import { useStockActions } from './StockActions';
import { stapleFor, StapleSettings, useStaples } from './StapleSettings';
import { StockRowActions } from './StockRowActions';
import { useToast } from './Toast';
import { Button, ErrorNote, Field, Pill, Sheet, Spinner, TextInput } from './ui';

const eventWords: Record<StockEventDto['type'], string> = {
  add: 'Added',
  use: 'Used',
  open: 'Opened',
  move: 'Moved',
  freeze: 'Frozen',
  defrost: 'Defrosted',
  discard: 'Binned',
  adjust: 'Corrected',
};

function DateSheet({ item, open, onClose }: { item: StockItemDto; open: boolean; onClose: () => void }) {
  const [value, setValue] = useState(item.bestBefore ?? '');
  const qc = useQueryClient();
  const toast = useToast();
  const save = async (bestBefore: string | null) => {
    try {
      const c = await api.patch<StockChangeDto>(`/api/stock/${item.id}`, { bestBefore });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      toast.show(item.state === 'closed' ? "Date changed. We'll remember this for next time." : 'Date changed.', {
        action: {
          label: 'Undo',
          onClick: async () => {
            await api.post(`/api/events/${c.eventId}/undo`);
            await qc.invalidateQueries({ queryKey: ['stock'] });
          },
        },
      });
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Best-before date">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value || null);
        }}
      >
        <Field label="Best before" hint="Use the date printed on the pack if there is one.">
          {(id) => <TextInput id={id} type="date" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" onClick={() => void save(null)}>
            No date
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/** One line of the food's table row, as the side panel shows it. */
export interface DetailRow {
  label: string;
  value: ReactNode;
}

/** The detail itself. `onOpenPack` switches the side panel to another pack; without it, packs are links. */
export function StockItemDetail({
  id,
  onOpenPack,
  showActions = true,
  summary,
  packs = 1,
}: {
  id: string;
  onOpenPack?: (id: string) => void;
  showActions?: boolean;
  /** The food's row from the stock table (where, state, packs, items, amount, planned), shown first. */
  summary?: DetailRow[];
  /** How many packs that row covers: with more than one, this pack's own details get a heading. */
  packs?: number;
}) {
  const me = useMe();
  const q = useStockItem(id);
  const item = q.data?.item;
  const siblings = useProductStock(item?.productId ?? '').data?.filter((s) => s.id !== id) ?? [];
  const [dateOpen, setDateOpen] = useState(false);
  const actions = useStockActions();
  const staples = useStaples().data;

  if (q.isPending) return <Spinner />;
  if (q.error || !item) return <ErrorNote error={q.error ?? 'Not found'} />;
  const gone = item.fractionLeft <= 0;
  const row = 'flex min-h-11 items-center justify-between gap-3 border-b border-line py-1.5 text-[0.9375rem] last:border-b-0 lg:min-h-9 lg:text-sm';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill className={toneClasses[toneFor(item, me.today)].pill}>{gone ? 'Used up' : dateLabel(item.bestBefore, me.today)}</Pill>
        <span className="text-sm text-muted">
          {item.locationName} · {stateLabel[item.state]}
        </span>
      </div>

      {summary && (
        <dl aria-label="In stock">
          {summary.map((s) => (
            <div key={s.label} className={row}>
              <dt className="text-muted">{s.label}</dt>
              <dd className="font-semibold">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <dl aria-label={summary && packs > 1 ? 'This pack' : undefined}>
        {summary && packs > 1 && <div className="pb-1 text-xs font-semibold uppercase tracking-wider text-muted">This pack</div>}
        <div className={row}>
          <dt className="text-muted">Best before</dt>
          <dd>
            <button type="button" onClick={() => setDateOpen(true)} className="font-semibold text-accent-text hover:underline">
              {longDate(item.bestBefore)}
            </button>
          </dd>
        </div>
        {/* With one pack the row above already says how much is left. */}
        {!(summary && packs === 1) && (
          <div className={row}>
            <dt className="text-muted">Amount left</dt>
            <dd>
              <button type="button" onClick={() => actions.changeAmount([item])} className="font-semibold text-accent-text hover:underline">
                {amountLabel(item)}
              </button>
            </dd>
          </div>
        )}
        <div className={row}>
          <dt className="text-muted">Added</dt>
          <dd>{longDate(item.addedOn)}</dd>
        </div>
        {item.openedOn && (
          <div className={row}>
            <dt className="text-muted">Opened</dt>
            <dd>{longDate(item.openedOn)}</dd>
          </div>
        )}
        {item.frozenOn && (
          <div className={row}>
            <dt className="text-muted">Frozen</dt>
            <dd>{longDate(item.frozenOn)}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        {showActions && !gone && <StockRowActions item={item} name={item.productName} size="sm" />}
        {/* The product behind it: its name, brand, pack and serving size, nutrition and barcodes. */}
        <Link
          to={`/products/${item.productId}`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-sm font-semibold text-ink hover:bg-card-muted lg:min-h-8 lg:rounded-md lg:px-2.5"
        >
          <Icon name="tag" className="size-4" /> Product details
        </Link>
      </div>

      {/* Always want this in? Below its level it puts itself on the shopping list. */}
      {!item.isMeal && <StapleSettings key={item.productId} staple={stapleFor(staples, item)} item={item} />}

      {siblings.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Other packs</h3>
          <ul className="overflow-hidden rounded-lg border border-line">
            {siblings.map((s) => {
              const content = (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {s.locationName} · {stateLabel[s.state]} · {amountLabel(s)}
                  </span>
                  <Pill className={toneClasses[toneFor(s, me.today)].pill}>{dateLabel(s.bestBefore, me.today)}</Pill>
                </>
              );
              const cls = 'flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-card-muted lg:min-h-9';
              return (
                <li key={s.id} className="border-b border-line last:border-b-0">
                  {onOpenPack ? (
                    <button type="button" className={cls} onClick={() => onOpenPack(s.id)}>
                      {content}
                    </button>
                  ) : (
                    <Link to={`/stock/${s.id}`} className={cls}>
                      {content}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">History</h3>
        <ul className="text-sm">
          {q.data.events.map((e) => (
            <li key={e.id} className={`flex justify-between gap-3 border-b border-line py-2 last:border-b-0 ${e.undoneAt ? 'text-muted line-through' : ''}`}>
              <span>
                {/* A use of a negative amount is food put back by a diary line. */}
                {e.type === 'use' && (e.grams ?? 0) < 0 ? 'Put back' : eventWords[e.type]}
                {e.userName ? ` by ${e.userName}` : ''}
              </span>
              <time dateTime={e.createdAt} className="text-muted">
                {new Date(e.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </time>
            </li>
          ))}
        </ul>
      </section>

      <DateSheet key={`d-${item.bestBefore}`} item={item} open={dateOpen} onClose={() => setDateOpen(false)} />
    </div>
  );
}
