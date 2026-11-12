import webpush from 'web-push';
import type { Config } from '../config';

export interface PushPayload {
  title: string;
  body: string;
  /** Page to open when tapped. */
  url?: string;
  tag?: string;
  /** Buttons on the notification; handled by the service worker. */
  actions?: { action: string; title: string }[];
  /** Data the service worker needs for the actions (e.g. the stock item id). */
  data?: Record<string, unknown>;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface PushSender {
  publicKey: string;
  send(target: PushTarget, payload: PushPayload): Promise<PushOutcome>;
}

/** Web Push sender; null when VAPID keys aren't configured (push then hides). */
export function createPushSender(config: Config): PushSender | null {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return null;
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  return {
    publicKey: config.VAPID_PUBLIC_KEY,
    async send(target, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 12 },
        );
        return 'sent';
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404/410: the browser has dropped this subscription.
        return status === 404 || status === 410 ? 'gone' : 'failed';
      }
    },
  };
}
