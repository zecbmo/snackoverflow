/** Built-in scheduler: checks once a minute for notifications and the nightly backup. */
import { wallClockIn } from '@snackoverflow/shared';
import { backupsEnabled, listBackups, runBackup } from './backup';
import type { AppContext } from './context';
import { runNotifications } from './notify/notifications';
import { checkReceiptMail } from './services/receiptEmail';

interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export function startScheduler(ctx: AppContext, log: Logger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const now = ctx.now();
    try {
      const stats = await runNotifications(ctx, now);
      if (stats.app || stats.push || stats.email) log.info(stats, 'notifications sent');
    } catch (err) {
      log.error({ err }, 'notification run failed');
    }
    // Receipts forwarded by email: every 5 minutes.
    if (ctx.config.RECEIPT_IMAP_HOST && now.getTime() - lastMailCheck >= 5 * 60_000) {
      lastMailCheck = now.getTime();
      try {
        const made = await checkReceiptMail(ctx);
        if (made) log.info({ receipts: made }, 'receipts imported from email');
      } catch (err) {
        log.error({ err }, 'checking the receipt mailbox failed');
      }
    }
    try {
      await maybeBackup(ctx, now, log);
    } catch (err) {
      log.error({ err }, 'backup failed');
    }
    running = false;
  };
  const timer = setInterval(() => void tick(), 60_000);
  void tick();
  return () => clearInterval(timer);
}

async function maybeBackup(ctx: AppContext, now: Date, log: Logger) {
  if (!backupsEnabled(ctx.config)) return;
  const clock = wallClockIn(ctx.config.TZ, now);
  const [h, m] = ctx.config.BACKUP_TIME.split(':').map(Number);
  if (clock.hour * 60 + clock.minute < (h ?? 3) * 60 + (m ?? 30)) return;
  if (lastFailedOn === clock.date) return; // tried and failed today; don't retry every minute
  const latest = (await listBackups(ctx.config))[0];
  if (latest && wallClockIn(ctx.config.TZ, new Date(latest.createdAt)).date === clock.date) return;
  try {
    const b = await runBackup(ctx.config, now);
    log.info({ backup: b.name }, 'backup written');
  } catch (err) {
    lastFailedOn = clock.date;
    throw err;
  }
}

let lastFailedOn: string | null = null;
let lastMailCheck = 0;
