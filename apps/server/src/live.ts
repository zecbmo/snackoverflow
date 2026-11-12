import type { LiveMessage, LiveTopic } from '@snackoverflow/shared';

interface Socket {
  send(data: string): void;
  readyState: number;
}

/** Keeps the open WebSockets per household and tells them what changed. */
export class LiveHub {
  private sockets = new Map<string, Set<Socket>>();

  add(householdId: string, socket: Socket): () => void {
    let set = this.sockets.get(householdId);
    if (!set) {
      set = new Set();
      this.sockets.set(householdId, set);
    }
    set.add(socket);
    return () => {
      set.delete(socket);
      if (set.size === 0) this.sockets.delete(householdId);
    };
  }

  publish(householdId: string, ...topics: LiveTopic[]): void {
    const set = this.sockets.get(householdId);
    if (!set) return;
    const msg: LiveMessage = { type: 'invalidate', topics };
    const data = JSON.stringify(msg);
    for (const s of set) {
      if (s.readyState === 1) {
        try {
          s.send(data);
        } catch {
          // A dead socket is cleaned up when it closes.
        }
      }
    }
  }

  count(householdId: string): number {
    return this.sockets.get(householdId)?.size ?? 0;
  }
}
