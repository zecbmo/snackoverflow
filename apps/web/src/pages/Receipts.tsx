/** Add a whole shop at once: photograph a receipt, upload a photo or PDF, or paste an order email. */
import { useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { formatPence, formatShortDate, type ReceiptSummaryDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { type Column, DataTable } from '../components/DataTable';
import { PageTop, Toolbar } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Field, Pill, Sheet, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useReceipts } from '../lib/queries';

export const STATUS_LABEL: Record<ReceiptSummaryDto['status'], string> = {
  reading: 'Reading…',
  waiting: 'Waiting to be read',
  review: 'Ready to check',
  done: 'Added to stock',
  failed: "Couldn't read",
};

/** Big photos are slow to send and no easier to read: shrink to 2000px JPEG first. */
async function shrinkImage(file: File): Promise<{ data: string; type: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { data: url.slice(url.indexOf(',') + 1), type: 'image/jpeg' };
}

async function readRaw(file: File): Promise<{ data: string; type: string }> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
  return { data: url.slice(url.indexOf(',') + 1), type: file.type };
}

export function ReceiptsPage() {
  const me = useMe();
  const receipts = useReceipts();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');

  const send = async (file: File, source: 'photo' | 'upload') => {
    setBusy(true);
    try {
      const body = file.type === 'application/pdf' ? await readRaw(file) : await shrinkImage(file).catch(() => readRaw(file));
      const { id } = await api.post<{ id: string }>('/api/receipts/file', { ...body, source });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      navigate(`/receipts/${id}`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const onFile = (source: 'photo' | 'upload') => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void send(f, source);
  };
  const paste = async () => {
    setBusy(true);
    try {
      const { id } = await api.post<{ id: string }>('/api/receipts/text', { text });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      setPasting(false);
      setText('');
      navigate(`/receipts/${id}`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const fileButton = 'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold lg:min-h-8 lg:rounded-md';
  const columns: Column<ReceiptSummaryDto>[] = [
    { key: 'store', header: 'Shop', primary: true, cell: (r) => r.store ?? 'Receipt' },
    { key: 'date', header: 'Date', className: 'whitespace-nowrap', cell: (r) => (r.purchasedOn ? formatShortDate(r.purchasedOn) : '') },
    { key: 'status', header: 'Status', cell: (r) => <Pill className={r.status === 'review' ? 'bg-accent-soft text-accent-text' : 'bg-card-muted text-muted'}>{STATUS_LABEL[r.status]}</Pill> },
    { key: 'items', header: 'Items', align: 'right', className: 'tabular-nums', cell: (r) => r.lineCount || '' },
    { key: 'total', header: 'Total', align: 'right', className: 'tabular-nums', cell: (r) => (r.totalPence !== null ? formatPence(r.totalPence) : '') },
  ];
  return (
    <>
      <PageTop
        title="Receipts"
        left={<BackButton to="/shop" />}
        actions={
          <>
            <label className={`${fileButton} bg-accent text-accent-ink hover:brightness-110 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              <Icon name="camera" className="size-4" /> <span className="hidden sm:inline">Take a photo</span>
              <span className="sm:hidden">Photo</span>
              <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile('photo')} disabled={busy} />
            </label>
          </>
        }
      />
      <Toolbar>
        <label className={`${fileButton} hover:bg-card-muted ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          <Icon name="download" className="size-4" /> Upload photo or PDF
          <input type="file" accept="image/*,application/pdf" className="sr-only" onChange={onFile('upload')} disabled={busy} />
        </label>
        <Button size="sm" variant="ghost" onClick={() => setPasting(true)} disabled={busy}>
          <Icon name="copy" className="size-4" /> Paste text
        </Button>
      </Toolbar>
      <p className="mb-3 max-w-3xl text-sm text-muted">
        Add a whole shop at once: each line is matched to your food, you check it, and it all goes into stock.{' '}
        {!me.features.ai &&
          `Photos and PDFs are read by AI when it's set up on the server; without it, your own assistant can read them${me.features.mcp ? ' (it can see receipts waiting to be read)' : ''}, or paste the text.`}{' '}
        {me.features.receiptEmail && "You can also forward online-order emails to the household's receipts mailbox."}
      </p>
      {busy && <Spinner label="Sending" />}
      <ErrorNote error={receipts.error} />
      {receipts.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Receipts"
          columns={columns}
          rows={receipts.data ?? []}
          rowKey={(r) => r.id}
          onOpen={(r) => navigate(`/receipts/${r.id}`)}
          openLabel={(r) => `${r.store ?? 'Receipt'}${r.purchasedOn ? `, ${formatShortDate(r.purchasedOn)}` : ''}`}
          phone={(r) => ({
            title: `${r.store ?? 'Receipt'}${r.purchasedOn ? ` · ${formatShortDate(r.purchasedOn)}` : ''}`,
            meta: `${STATUS_LABEL[r.status]}${r.lineCount ? ` · ${r.lineCount} items` : ''}${r.totalPence !== null ? ` · ${formatPence(r.totalPence)}` : ''}`,
            badge: <Icon name="chevronRight" className="size-4 text-muted" />,
          })}
          empty={<EmptyState title="No receipts yet">Take a photo of your next receipt, or paste an online order.</EmptyState>}
        />
      )}

      <Sheet open={pasting} onClose={() => setPasting(false)} title="Paste a receipt">
        <div className="flex flex-col gap-3">
          <Field label="Receipt or order email" hint="Each item needs its price on the same line. Totals and payments are skipped.">
            {(id) => <textarea id={id} rows={10} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg border border-line bg-card p-3 text-base lg:text-sm" />}
          </Field>
          <Button variant="primary" disabled={busy || text.trim().length < 3} onClick={() => void paste()}>
            Read it
          </Button>
        </div>
      </Sheet>
    </>
  );
}
