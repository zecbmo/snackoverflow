import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { receiptLinesInput, receiptTextInput, updateReceiptLineInput } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { receipts } from '../db/schema';
import { badRequest, notFound, parse } from '../http';
import {
  confirmReceipt,
  deleteReceipt,
  getReceipt,
  listReceipts,
  readInBackground,
  receiptFile,
  receiptFromFile,
  receiptFromText,
  setReceiptLines,
  updateLine,
} from '../services/receipts';

const fileInput = z.object({
  /** base64 of the photo or PDF. */
  data: z.string().min(10).max(17_000_000),
  type: z.string().max(60),
  source: z.enum(['photo', 'upload']).default('upload'),
});

export async function receiptRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/receipts', async (req) => listReceipts(ctx.db, requireAuth(req)));
  app.get<{ Params: { id: string } }>('/api/receipts/:id', async (req) => getReceipt(ctx.db, requireAuth(req), req.params.id, ctx.now()));

  /** Pasted receipt text or an online-order email's text. */
  app.post('/api/receipts/text', async (req) => {
    const auth = requireAuth(req);
    const { text } = parse(receiptTextInput, req.body);
    return { id: await receiptFromText(ctx, auth.household.id, auth.user.id, text, 'text') };
  });

  /** A photo, screenshot or PDF (base64 in JSON, so the app needs nothing extra). */
  app.post('/api/receipts/file', { bodyLimit: 18 * 1024 * 1024 }, async (req) => {
    const auth = requireAuth(req);
    const input = parse(fileInput, req.body);
    const buf = Buffer.from(input.data, 'base64');
    if (!buf.length) throw badRequest('That file is empty.');
    return { id: await receiptFromFile(ctx, auth.household.id, auth.user.id, buf, input.type, input.source) };
  });

  /** Lines typed or read by an assistant, for a receipt that's waiting to be read. */
  app.post<{ Params: { id: string } }>('/api/receipts/:id/lines', async (req) => {
    const auth = requireAuth(req);
    const input = parse(receiptLinesInput, req.body);
    const [r] = await ctx.db.select({ id: receipts.id }).from(receipts).where(and(eq(receipts.id, req.params.id), eq(receipts.householdId, auth.household.id)));
    if (!r) throw notFound('No such receipt.');
    await setReceiptLines(ctx.db, auth.household.id, ctx.seed, r.id, input);
    ctx.live.publish(auth.household.id, 'receipts');
    return getReceipt(ctx.db, auth, r.id, ctx.now());
  });

  app.post<{ Params: { id: string } }>('/api/receipts/:id/retry', async (req) => {
    const auth = requireAuth(req);
    if (!ctx.config.AI_API_KEY) throw badRequest("AI reading isn't set up on this server. Send it to your assistant, or type it in.");
    await getReceipt(ctx.db, auth, req.params.id, ctx.now());
    void readInBackground(ctx, auth.household.id, req.params.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string; lineId: string } }>('/api/receipts/:id/lines/:lineId', async (req) => {
    const auth = requireAuth(req);
    await updateLine(ctx.db, auth, req.params.id, req.params.lineId, parse(updateReceiptLineInput, req.body));
    return getReceipt(ctx.db, auth, req.params.id, ctx.now());
  });

  app.post<{ Params: { id: string } }>('/api/receipts/:id/confirm', async (req) => {
    const auth = requireAuth(req);
    const r = await ctx.db.transaction((tx) => confirmReceipt({ db: tx, auth, now: ctx.now() }, ctx.seed, req.params.id));
    for (const t of ['stock', 'shopping', 'receipts', 'products'] as const) ctx.live.publish(auth.household.id, t);
    return r;
  });

  app.delete<{ Params: { id: string } }>('/api/receipts/:id', async (req) => {
    const auth = requireAuth(req);
    await deleteReceipt(ctx.db, auth, req.params.id);
    ctx.live.publish(auth.household.id, 'receipts');
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/receipts/:id/file', async (req, reply) => {
    const f = await receiptFile(ctx.db, requireAuth(req), req.params.id);
    if (!f) throw notFound('The image has been deleted now the receipt is done.');
    reply.header('Content-Type', f.type).header('Cache-Control', 'private, max-age=300');
    return reply.send(f.file);
  });
}
