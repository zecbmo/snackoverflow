import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationListDto, ReceiptSummaryDto } from '@snackoverflow/shared';
import { checkReceiptMail, htmlToText, type ReceiptMail, type ReceiptMailbox } from '../src/services/receiptEmail';
import { type Client, makeTestApp, setupAdmin, type TestApp } from './helpers';

const ORDER = `Your Tesco order has been delivered on 12 November 2026
2 x Tesco Semi Skimmed Milk 2.272L £3.10
1 x Tesco Basmati Rice 1kg £1.99
Total £5.09`;

class FakeMailbox implements ReceiptMailbox {
  seen: number[] = [];
  closed = false;
  constructor(private mails: ReceiptMail[]) {}
  async fetchUnseen() {
    return this.mails.filter((m) => !this.seen.includes(m.uid));
  }
  async markSeen(uid: number) {
    this.seen.push(uid);
  }
  async close() {
    this.closed = true;
  }
}

let t: TestApp | undefined;
let api: Client;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup(allowed?: string) {
  t = await makeTestApp({ config: { RECEIPT_IMAP_HOST: 'imap.example.com', RECEIPT_ALLOWED_SENDERS: allowed } });
  api = await setupAdmin(t!.app);
}

describe('receipts by email', () => {
  it('turns an order email from a household member into a receipt to review, and tells them', async () => {
    await setup();
    const box = new FakeMailbox([
      { uid: 1, from: 'admin@example.com', subject: 'Fwd: Your Tesco order', text: ORDER },
      { uid: 2, from: 'stranger@example.net', subject: 'Buy now', text: '1 x Junk £9.99' },
    ]);
    expect(await checkReceiptMail(t!.ctx, async () => box)).toBe(1);
    // Only the member's mail is read and marked; the stranger's is left alone.
    expect(box.seen).toEqual([1]);
    expect(box.closed).toBe(true);
    const receipts = await api.get<ReceiptSummaryDto[]>('/api/receipts');
    expect(receipts).toEqual([expect.objectContaining({ source: 'email', status: 'review', store: 'Tesco', purchasedOn: '2026-11-12', lineCount: 2 })]);
    const inbox = await api.get<NotificationListDto>('/api/notifications');
    expect(inbox.items[0]).toMatchObject({ type: 'receiptReady', title: 'Receipt from Tesco ready to check', url: `/receipts/${receipts[0]!.id}` });
  });

  it('accepts only the allowed senders when a list is set', async () => {
    await setup('@tesco.com, shopper@example.org');
    const box = new FakeMailbox([
      { uid: 1, from: 'orders@tesco.com', subject: 'Your order', text: ORDER },
      { uid: 2, from: 'admin@example.com', subject: 'Fwd', text: ORDER },
      { uid: 3, from: 'friend@example.org', subject: 'Fwd', text: `From: Tesco <noreply@tesco.com>\n${ORDER}` },
    ]);
    expect(await checkReceiptMail(t!.ctx, async () => box)).toBe(2);
    expect(box.seen.sort()).toEqual([1, 3]);
  });

  it('marks emails with no items as read without making a receipt', async () => {
    await setup();
    const box = new FakeMailbox([{ uid: 7, from: 'admin@example.com', subject: 'Hello', text: 'No prices in here' }]);
    expect(await checkReceiptMail(t!.ctx, async () => box)).toBe(0);
    expect(box.seen).toEqual([7]);
    expect(await api.get('/api/receipts')).toEqual([]);
  });

  it('does nothing when no mailbox is set up', async () => {
    t = await makeTestApp();
    await setupAdmin(t!.app);
    let opened = false;
    expect(
      await checkReceiptMail(t!.ctx, async () => {
        opened = true;
        return new FakeMailbox([]);
      }),
    ).toBe(0);
    expect(opened).toBe(false);
  });

  it('turns order-email HTML into lines', () => {
    expect(htmlToText('<table><tr><td>2 x Milk</td><td>&pound;3.10</td></tr><tr><td>Rice&nbsp;1kg</td><td>&pound;1.99</td></tr></table>')).toBe(
      '2 x Milk £3.10\nRice 1kg £1.99',
    );
  });
});
