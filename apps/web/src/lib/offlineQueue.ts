/**
 * Scans made with no signal are kept on the phone and sent when it's back
 * online, with the time they were really scanned. Works in the browser and the
 * Android app.
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError, isOffline } from './api';

export interface QueuedScan {
  id: string;
  mode: 'add' | 'use' | 'eat';
  barcode: string;
  locationId?: string;
  slot?: string;
  scannedAt: string;
}

const KEY = 'so.offline.scans';
const EVENT = 'so-offline-queue';

function load(): QueuedScan[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedScan[]) : [];
  } catch {
    return [];
  }
}

function save(items: QueuedScan[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Nothing more we can do without storage.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function queuedScans(): QueuedScan[] {
  return load();
}

export function enqueueScan(scan: Omit<QueuedScan, 'id' | 'scannedAt'>): QueuedScan {
  const item: QueuedScan = { ...scan, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, scannedAt: new Date().toISOString() };
  save([...load(), item]);
  return item;
}

export function removeQueued(id: string) {
  save(load().filter((s) => s.id !== id));
}

let syncing: Promise<{ synced: number; dropped: number }> | null = null;

/** Send queued scans in order. Stops at the first network failure; drops scans the server rejects. */
export function syncQueue(): Promise<{ synced: number; dropped: number }> {
  syncing ??= (async () => {
    let synced = 0;
    let dropped = 0;
    try {
      for (const scan of load()) {
        try {
          await api.post(`/api/scan/${scan.mode}`, {
            barcode: scan.barcode,
            locationId: scan.mode === 'eat' ? undefined : scan.locationId,
            ...(scan.mode === 'add' ? { scannedAt: scan.scannedAt } : {}),
            ...(scan.mode === 'eat' && scan.slot ? { slot: scan.slot } : {}),
          });
          synced++;
        } catch (e) {
          if (isOffline(e)) break;
          // Signed out: keep the scans until they sign back in.
          if (e instanceof ApiError && e.status === 401) break;
          dropped++;
        }
        save(load().filter((s) => s.id !== scan.id));
      }
    } finally {
      syncing = null;
    }
    return { synced, dropped };
  })();
  return syncing;
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export function useQueuedCount(): number {
  return useSyncExternalStore(subscribe, () => load().length);
}

/** Keep trying while anything is queued: on reconnect, on focus and every 30 seconds. */
export function startQueueSync(onSynced: (r: { synced: number; dropped: number }) => void): () => void {
  const run = () => {
    if (load().length === 0) return;
    void syncQueue().then((r) => {
      if (r.synced || r.dropped) onSynced(r);
    });
  };
  window.addEventListener('online', run);
  window.addEventListener('focus', run);
  const timer = setInterval(run, 30_000);
  run();
  return () => {
    window.removeEventListener('online', run);
    window.removeEventListener('focus', run);
    clearInterval(timer);
  };
}
