/**
 * One pack in detail: dates, amount left, the other packs of the same product, its history and
 * a link to the product. Shown in the Stock side panel and on the /stock/:id page.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { StockChangeDto, StockEventDto, StockItemDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { amountLabel, dateLabel, longDate, stateLabel, toneClasses, toneFor } from '../lib/format';
import { useProductStock, useStockItem } from '../lib/queries';
import { Icon } from './Icon';
import { useMe } from './Layout';
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

function AmountSheet({ item, open, onClose }: { item: StockItemDto; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const set = async (body: object) => {
    try {
      await api.patch(`/api/stock/${item.id}`, body);
      await qc.invalidateQueries({ queryKey: ['stock'] });
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="How much is left?">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            [1, 'Full'],
            [0.75, 'About ¾'],
            [0.5, 'About half'],
            [0.25, 'About ¼'],
            [0.1, 'Nearly gone'],
            [0, 'None'],
          ] as const
        ).map(([f, label]) => (
          <Button key={f} variant={f === 0 ? 'dark' : 'outline'} onClick={() => void set({ fractionLeft: f })}>
            {label}
          </Button>
        ))}
      </div>
    </Sheet>
  );
}

/** The detail itself. `onOpenPack` switches the side panel to another pack; without it, packs are links. */
export function StockItemDetail({ id, onOpenPack, showActions = true }: { id: string; onOpenPack?: (id: string) => void; showActions?: boolean }) {
  const me = useMe();
  const q = useStockItem(id);
  const item = q.data?.item;
  const siblings = useProductStock(item?.productId ?? '').data?.filter((s) => s.id !== id) ?? [];
  const [dateOpen, setDateOpen] = useState(false);
  const [amountOpen, setAmountOpen] = useState(false);

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

      <dl>
        <div className={row}>
          <dt className="text-muted">Best before</dt>
          <dd>
            <button type="button" onClick={() => setDateOpen(true)} className="font-semibold text-accent-text hover:underline">
              {longDate(item.bestBefore)}
            </button>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Amount left</dt>
          <dd>
            <button type="button" onClick={() => setAmountOpen(true)} className="font-semibold text-accent-text hover:underline">
              {amountLabel(item)}
            </button>
          </dd>
        </div>
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

      {showActions && !gone && (
        <div className="flex flex-wrap items-center gap-2">
          <StockRowActions item={item} name={item.productName} size="sm" />
        </div>
      )}

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
                {eventWords[e.type]}
                {e.userName ? ` by ${e.userName}` : ''}
              </span>
              <time dateTime={e.createdAt} className="text-muted">
                {new Date(e.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </time>
            </li>
          ))}
        </ul>
      </section>

      <Link to={`/products/${item.productId}`} className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-accent-text lg:min-h-8">
        Product details and barcodes <Icon name="chevronRight" className="size-4" />
      </Link>

      <DateSheet key={`d-${item.bestBefore}`} item={item} open={dateOpen} onClose={() => setDateOpen(false)} />
      <AmountSheet item={item} open={amountOpen} onClose={() => setAmountOpen(false)} />
    </div>
  );
}
