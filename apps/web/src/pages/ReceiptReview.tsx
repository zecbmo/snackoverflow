/**
 * The receipt review screen: every line with its match, quantity, place and
 * best-before. Uncertain matches are highlighted; non-food is already left out.
 * One tap adds it all to stock, ticks the list and saves the prices.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { formatPence, formatShortDate, parseReceiptText, type ReceiptDto, type ReceiptLineDto } from '@snackoverflow/shared';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage, fetchObjectUrl } from '../lib/api';
import { useIngredients, useLocations, useProducts, useReceipt } from '../lib/queries';
import { STATUS_LABEL } from './Receipts';

function ReceiptImage({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    void fetchObjectUrl(`/api/receipts/${id}/file`).then((u) => {
      made = u;
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  if (!url) return null;
  return <img src={url} alt="The receipt" className="max-h-96 w-full rounded-lg border border-line object-contain" />;
}

export function ReceiptReviewPage() {
  const { id = '' } = useParams();
  const me = useMe();
  const receipt = useReceipt(id);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (receipt.isPending) return <Spinner />;
  if (receipt.error || !receipt.data) return <ErrorNote error={receipt.error ?? 'Not found'} />;
  const r = receipt.data;
  const included = r.lines.filter((l) => !l.skip && (l.productId || l.ingredientId));
  const items = included.reduce((n, l) => n + l.quantity, 0);

  const setData = (d: ReceiptDto) => qc.setQueryData(['receipts', id], d);
  const patchLine = async (line: ReceiptLineDto, body: Record<string, unknown>) => {
    try {
      setData(await api.patch<ReceiptDto>(`/api/receipts/${id}/lines/${line.id}`, body));
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ added: number; ticked: number }>(`/api/receipts/${id}/confirm`);
      await Promise.all(['stock', 'shopping', 'receipts'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.show(`Added ${res.added} to stock${res.ticked ? `, ticked ${res.ticked} off the list` : ''}.`);
      navigate('/stock');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const submitTyped = async () => {
    const parsed = parseReceiptText(text);
    if (!parsed.lines.length) {
      toast.show('Each item needs its price on the same line.', { tone: 'error' });
      return;
    }
    try {
      setData(await api.post<ReceiptDto>(`/api/receipts/${id}/lines`, parsed));
      setTyping(false);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const retry = async () => {
    await api.post(`/api/receipts/${id}/retry`).catch((e) => toast.show(errorMessage(e), { tone: 'error' }));
    await receipt.refetch();
  };
  const remove = async () => {
    await api.del(`/api/receipts/${id}`).catch(() => {});
    await qc.invalidateQueries({ queryKey: ['receipts'] });
    navigate('/receipts');
  };

  return (
    <>
      <PageHeader
        title={r.store ?? 'Receipt'}
        subtitle={[STATUS_LABEL[r.status], r.purchasedOn ? formatShortDate(r.purchasedOn) : null, r.totalPence !== null ? formatPence(r.totalPence) : null].filter(Boolean).join(' · ')}
        left={<BackButton to="/receipts" />}
      />
      <div className="flex max-w-3xl flex-col gap-4 pb-28">
        {(r.status === 'reading' || r.status === 'waiting' || r.status === 'failed') && (
          <Card className="flex flex-col gap-3 p-5">
            {r.status === 'reading' && (
              <>
                <Spinner label="Reading" />
                <p className="text-center text-muted">Reading your receipt. This takes a few seconds.</p>
              </>
            )}
            {r.status === 'waiting' && (
              <p>
                {me.features.mcp
                  ? 'This is waiting to be read. Ask your assistant (for example Claude) to read your waiting Snack Overflow receipts, or type the items in.'
                  : "This is waiting to be read: AI reading isn't set up on this server. Type the items in instead."}
              </p>
            )}
            {r.status === 'failed' && <ErrorNote error={r.error ?? "Couldn't read that receipt."} />}
            <div className="grid grid-cols-2 gap-3">
              {r.status === 'failed' && me.features.ai && <Button onClick={() => void retry()}>Try again</Button>}
              {r.status !== 'reading' && <Button onClick={() => setTyping(true)}>Type the items in</Button>}
            </div>
            {r.hasFile && <ReceiptImage id={id} />}
          </Card>
        )}

        {r.status === 'done' && (
          <Card className="p-5">
            <p>This receipt has been added to stock.</p>
          </Card>
        )}

        {r.status === 'review' && (
          <>
            <p className="text-muted">Check each line. Highlighted ones need a look; things that aren't food are already left out.</p>
            {r.lines.map((l) => (
              <LineCard key={l.id} line={l} onChange={(body) => void patchLine(l, body)} />
            ))}
            {r.hasFile && <ReceiptImage id={id} />}
          </>
        )}
        <button type="button" className="min-h-11 self-start font-semibold text-danger" onClick={() => setConfirmDelete(true)}>
          Delete this receipt
        </button>
      </div>

      {r.status === 'review' && (
        <div className="fixed inset-x-4 bottom-24 z-20 mx-auto max-w-xl lg:bottom-6">
          <Button variant="primary" size="lg" className="w-full shadow-lg" disabled={busy || items === 0} onClick={() => void confirm()}>
            {busy ? 'Adding…' : `Add ${items} item${items === 1 ? '' : 's'} to stock`}
          </Button>
        </div>
      )}

      <Sheet open={typing} onClose={() => setTyping(false)} title="Type the items in">
        <div className="flex flex-col gap-3">
          <Field label="Items" hint="One per line with its price, e.g. “Semi skimmed milk 4 pints 1.55”. Start with “2 x” for more than one.">
            {(fid) => <textarea id={fid} rows={8} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-xl border border-line bg-card p-3 text-base" />}
          </Field>
          <Button variant="primary" size="lg" onClick={() => void submitTyped()}>
            Use these
          </Button>
        </div>
      </Sheet>
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this receipt?">
        <p className="mb-4 text-muted">Anything already added to stock stays in stock.</p>
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <Button variant="dark" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function LineCard({ line, onChange }: { line: ReceiptLineDto; onChange: (body: Record<string, unknown>) => void }) {
  const ingredients = useIngredients().data ?? [];
  const products = (useProducts().data ?? []).filter((p) => p.name);
  const locations = useLocations().data ?? [];
  const check = !line.skip && line.confidence !== 'high';
  const value = line.productId ? `p:${line.productId}` : line.ingredientId ? `i:${line.ingredientId}` : '';
  return (
    <Card className={`flex flex-col gap-3 p-4 ${line.skip ? 'opacity-60' : ''} ${check ? 'border-accent bg-accent-soft/40' : ''}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`Add ${line.text}`}
          checked={!line.skip}
          onChange={(e) => onChange({ skip: !e.target.checked })}
          className="mt-1 size-6 shrink-0 accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm text-muted">{line.text}</p>
          <p className="font-semibold">
            {line.skip ? 'Left out' : (line.productName ?? line.ingredientName ?? 'Not matched yet')}
            {line.onList && !line.skip && <span className="ml-2 text-sm font-normal text-muted">on your list</span>}
          </p>
          {check && <p className="text-sm font-semibold text-accent-text">{line.ingredientId || line.productId ? 'Check this match' : 'Pick what this is'}</p>}
        </div>
        <span className="whitespace-nowrap font-semibold">{line.pricePence !== null ? formatPence(line.pricePence) : ''}</span>
      </div>
      {!line.skip && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="col-span-2">
            <Select
              aria-label="What it is"
              value={value}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v.startsWith('p:') ? { productId: v.slice(2) } : v.startsWith('i:') ? { productId: null, ingredientId: v.slice(2) } : { productId: null, ingredientId: null });
              }}
            >
              <option value="">Not matched</option>
              <optgroup label="Your products">
                {products.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Ingredients">
                {ingredients.map((i) => (
                  <option key={i.id} value={`i:${i.id}`}>
                    {i.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </div>
          <Select aria-label="How many" value={line.quantity} onChange={(e) => onChange({ quantity: Number(e.target.value) })}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                × {n}
              </option>
            ))}
          </Select>
          <Select aria-label="Where" value={line.locationId ?? ''} onChange={(e) => onChange({ locationId: e.target.value })}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <div className="col-span-2 sm:col-span-4">
            <TextInput aria-label="Best before" type="date" value={line.bestBefore ?? ''} onChange={(e) => onChange({ bestBefore: e.target.value || null })} />
          </div>
        </div>
      )}
    </Card>
  );
}
