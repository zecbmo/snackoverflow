/**
 * Receipts by email: forward an online-order confirmation (Tesco, Asda,
 * Sainsbury's, Ocado...) to a mailbox the app checks. Off unless
 * RECEIPT_IMAP_HOST is set.
 *
 * Who may send: addresses or @domains in RECEIPT_ALLOWED_SENDERS. When that's
 * empty, only mail from a household member's own email address is accepted, so
 * a leaked mailbox address can't fill the household's stock with junk.
 */
import { eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config';
import type { AppContext } from '../context';
import { users } from '../db/schema';
import { deliver, prefsOf } from '../notify/notifications';
import { readReceiptTextWithAi } from './ai';
import { theHousehold } from './household';
import { getReceipt, receiptFromLines, receiptFromText } from './receipts';

export interface ReceiptMail {
  uid: number;
  from: string;
  subject: string;
  text: string;
}

/** The mailbox, injectable so tests don't need a mail server. */
export interface ReceiptMailbox {
  fetchUnseen(): Promise<ReceiptMail[]>;
  markSeen(uid: number): Promise<void>;
  close(): Promise<void>;
}

/** Plain text from an HTML email: tags out, entities decoded, one table row per line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&pound;/g, '£')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** The real IMAP mailbox. */
export async function openImapMailbox(config: Config): Promise<ReceiptMailbox> {
  const client = new ImapFlow({
    host: config.RECEIPT_IMAP_HOST!,
    port: config.RECEIPT_IMAP_PORT,
    secure: config.RECEIPT_IMAP_PORT === 993,
    auth: { user: config.RECEIPT_IMAP_USER ?? '', pass: config.RECEIPT_IMAP_PASSWORD ?? '' },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  return {
    async fetchUnseen() {
      const out: ReceiptMail[] = [];
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, 20)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const text = mail.text?.trim() || (typeof mail.html === 'string' ? htmlToText(mail.html) : '');
        out.push({ uid, from: mail.from?.value[0]?.address?.toLowerCase() ?? '', subject: mail.subject ?? '', text });
      }
      return out;
    },
    async markSeen(uid) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    },
    async close() {
      lock.release();
      await client.logout();
    },
  };
}

/** For forwarded mail: the original sender written in the body ("From: Tesco <orders@tesco.com>"). */
function forwardedFrom(text: string): string | null {
  const m = text.match(/^\s*From:.*?<?([\w.+-]+@[\w.-]+\.[a-z]{2,})>?/im);
  return m ? m[1]!.toLowerCase() : null;
}

function senderAllowed(sender: string, allowed: string[]): boolean {
  return allowed.some((a) => (a.startsWith('@') ? sender.endsWith(a) : sender === a));
}

let running = false;

/** Check the mailbox once: each new receipt email becomes a receipt to review. */
export async function checkReceiptMail(ctx: AppContext, open: (config: Config) => Promise<ReceiptMailbox> = openImapMailbox): Promise<number> {
  if (!ctx.config.RECEIPT_IMAP_HOST || running) return 0;
  running = true;
  let made = 0;
  let mailbox: ReceiptMailbox | null = null;
  try {
    const household = await theHousehold(ctx.db);
    if (!household) return 0;
    const members = await ctx.db.select().from(users).where(eq(users.householdId, household.id));
    const allowed = (ctx.config.RECEIPT_ALLOWED_SENDERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    mailbox = await open(ctx.config);
    for (const mail of await mailbox.fetchUnseen()) {
      const member = members.find((m) => m.email.toLowerCase() === mail.from);
      const ok = allowed.length
        ? senderAllowed(mail.from, allowed) || senderAllowed(forwardedFrom(mail.text) ?? '', allowed)
        : Boolean(member);
      // Mail from anyone else is left unread and untouched.
      if (!ok) continue;
      let id: string | null = null;
      try {
        id = await receiptFromText(ctx, household.id, member?.id ?? null, `${mail.subject}\n${mail.text}`, 'email');
      } catch {
        if (ctx.config.AI_API_KEY) {
          try {
            const read = await readReceiptTextWithAi(ctx.config, `${mail.subject}\n${mail.text}`, ctx.fetch);
            if (read.lines.length) id = await receiptFromLines(ctx, household.id, member?.id ?? null, 'email', read, mail.text);
          } catch {
            id = null;
          }
        }
      }
      await mailbox.markSeen(mail.uid);
      if (!id) continue;
      made++;
      const receipt = await getReceipt(ctx.db, { user: member ?? members[0]!, household }, id, ctx.now());
      for (const m of member ? [member] : members) {
        const channels = prefsOf(m).channels.receiptReady ?? [];
        if (!channels.length) continue;
        await deliver(ctx, m, channels, 'receiptReady', {
          title: `Receipt${receipt.store ? ` from ${receipt.store}` : ''} ready to check`,
          body: `${receipt.lineCount} item${receipt.lineCount === 1 ? '' : 's'}. Check the matches, then add it all to stock.`,
          url: `/receipts/${id}`,
          tag: `receipt-${id}`,
        });
      }
    }
  } finally {
    running = false;
    await mailbox?.close().catch(() => {});
  }
  return made;
}
