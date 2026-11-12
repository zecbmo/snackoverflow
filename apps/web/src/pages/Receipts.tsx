/** Add a whole shop at once: photograph a receipt, upload a photo or PDF, or paste an order email. */
import { useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatPence, formatShortDate, type ReceiptSummaryDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Sheet, Spinner } from '../components/ui';
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

  const pickerClass = 'flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl font-semibold';
  return (
    <>
      <PageHeader title="Receipts" left={<BackButton to="/shop" />} />
      <Card className="mb-5 flex flex-col gap-3 p-5">
        <p className="text-muted">Add a whole shop at once. We match each line to your food, you check it, and it all goes into stock.</p>
        <label className={`${pickerClass} bg-accent text-accent-ink ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          <Icon name="camera" className="size-5" /> Take a photo
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile('photo')} disabled={busy} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={`${pickerClass} border border-line bg-card ${busy ? 'pointer-events-none opacity-50' : ''}`}>
            Upload photo or PDF
            <input type="file" accept="image/*,application/pdf" className="sr-only" onChange={onFile('upload')} disabled={busy} />
          </label>
          <Button size="lg" onClick={() => setPasting(true)} disabled={busy}>
            Paste text
          </Button>
        </div>
        {!me.features.ai && (
          <p className="text-sm text-muted">
            Photos and PDFs are read by AI when it's set up on the server. Without it, your own assistant can read them for you
            {me.features.mcp ? ' (it can see receipts waiting to be read)' : ''}, or you can paste the text.
          </p>
        )}
        {me.features.receiptEmail && (
          <p className="text-sm text-muted">You can also forward online-order emails (Tesco, Asda, Sainsbury's, Ocado…) to the household's receipts mailbox. They'll show up here ready to check.</p>
        )}
        {busy && <Spinner label="Sending" />}
      </Card>

      <h2 className="mb-2 text-xl font-bold">Recent</h2>
      <ErrorNote error={receipts.error} />
      {receipts.isPending ? (
        <Spinner />
      ) : receipts.data?.length ? (
        <ul className="overflow-hidden rounded-[18px] border border-line bg-card">
          {receipts.data.map((r) => (
            <li key={r.id} className="border-b border-line last:border-b-0">
              <Link to={`/receipts/${r.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3">
                <span className="flex-1">
                  <span className="block font-semibold">
                    {r.store ?? 'Receipt'}
                    {r.purchasedOn ? ` · ${formatShortDate(r.purchasedOn)}` : ''}
                  </span>
                  <span className="block text-sm text-muted">
                    {STATUS_LABEL[r.status]}
                    {r.lineCount ? ` · ${r.lineCount} items` : ''}
                    {r.totalPence !== null ? ` · ${formatPence(r.totalPence)}` : ''}
                  </span>
                </span>
                <Icon name="chevronRight" className="size-5 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">No receipts yet.</p>
      )}

      <Sheet open={pasting} onClose={() => setPasting(false)} title="Paste a receipt">
        <div className="flex flex-col gap-3">
          <Field label="Receipt or order email" hint="Each item needs its price on the same line. Totals and payments are skipped.">
            {(id) => <textarea id={id} rows={10} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-xl border border-line bg-card p-3 text-[16px]" />}
          </Field>
          <Button variant="primary" size="lg" disabled={busy || text.trim().length < 3} onClick={() => void paste()}>
            Read it
          </Button>
        </div>
      </Sheet>
    </>
  );
}
