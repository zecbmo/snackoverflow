import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { StockChangeDto, StockEventDto, StockItemDto } from '@snackoverflow/shared';
import { BackButton, useMe } from '../components/Layout';
import { useStockActions } from '../components/StockActions';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Pill, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { amountLabel, dateLabel, longDate, stateLabel, toneClasses, toneFor } from '../lib/format';
import { useProductStock, useStockItem } from '../lib/queries';
import { StockActionsRow } from './Stock';

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
      <div className="grid grid-cols-2 gap-3">
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
          <Button key={f} variant={f === 0 ? 'dark' : 'outline'} size="lg" onClick={() => void set({ fractionLeft: f })}>
            {label}
          </Button>
        ))}
      </div>
    </Sheet>
  );
}

export function ItemDetailPage() {
  const { id = '' } = useParams();
  const me = useMe();
  const q = useStockItem(id);
  const item = q.data?.item;
  const siblings = useProductStock(item?.productId ?? '').data?.filter((s) => s.id !== id) ?? [];
  const actions = useStockActions();
  const [dateOpen, setDateOpen] = useState(false);
  const [amountOpen, setAmountOpen] = useState(false);

  if (q.isPending) return <Spinner />;
  if (q.error || !item) return <ErrorNote error={q.error ?? 'Not found'} />;
  const t = toneClasses[toneFor(item, me.today)];
  const gone = item.fractionLeft <= 0;

  return (
    <>
      <PageHeader title={item.productName} subtitle={item.brand ?? undefined} left={<BackButton />} />
      <Card className="mb-4 p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Pill className={t.pill}>{gone ? 'Used up' : dateLabel(item.bestBefore, me.today)}</Pill>
          <span className="text-muted">
            {item.locationName} · {stateLabel[item.state]} · {amountLabel(item)}
          </span>
        </div>
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[0.9375rem]">
          <div>
            <dt className="text-muted">Best before</dt>
            <dd>
              <button type="button" onClick={() => setDateOpen(true)} className="min-h-11 font-semibold text-accent-text underline-offset-2 hover:underline">
                {longDate(item.bestBefore)}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Amount left</dt>
            <dd>
              <button type="button" onClick={() => setAmountOpen(true)} className="min-h-11 font-semibold text-accent-text underline-offset-2 hover:underline">
                {amountLabel(item)}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Added</dt>
            <dd className="font-medium">{longDate(item.addedOn)}</dd>
          </div>
          {item.openedOn && (
            <div>
              <dt className="text-muted">Opened</dt>
              <dd className="font-medium">{longDate(item.openedOn)}</dd>
            </div>
          )}
          {item.frozenOn && (
            <div>
              <dt className="text-muted">Frozen</dt>
              <dd className="font-medium">{longDate(item.frozenOn)}</dd>
            </div>
          )}
        </dl>
        {!gone && (
          <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap">
            <StockActionsRow item={item} />
            {item.actions.open === null && (
              <Button variant="outline" onClick={() => void actions.open(item)}>
                Mark as opened
              </Button>
            )}
          </div>
        )}
      </Card>

      {siblings.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-2 text-xl font-bold">Other packs</h2>
          <ul className="overflow-hidden rounded-[18px] border border-line bg-card">
            {siblings.map((s) => (
              <li key={s.id} className="border-b border-line last:border-b-0">
                <Link to={`/stock/${s.id}`} className="flex min-h-14 items-center gap-3 px-4 py-2">
                  <span className="flex-1">
                    {s.locationName} · {stateLabel[s.state]} · {amountLabel(s)}
                  </span>
                  <Pill className={toneClasses[toneFor(s, me.today)].pill}>{dateLabel(s.bestBefore, me.today)}</Pill>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-4">
        <h2 className="mb-2 text-xl font-bold">History</h2>
        <Card className="p-2">
          <ul>
            {q.data.events.map((e) => (
              <li key={e.id} className={`flex justify-between gap-3 px-3 py-2 text-[0.9375rem] ${e.undoneAt ? 'text-muted line-through' : ''}`}>
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
        </Card>
      </section>

      <Link to={`/products/${item.productId}`} className="inline-flex min-h-11 items-center font-semibold text-accent-text">
        Product details and barcodes
      </Link>

      <DateSheet key={`d-${item.bestBefore}`} item={item} open={dateOpen} onClose={() => setDateOpen(false)} />
      <AmountSheet item={item} open={amountOpen} onClose={() => setAmountOpen(false)} />
    </>
  );
}
