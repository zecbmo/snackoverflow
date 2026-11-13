/** Live updates: the server says which topics changed and we refetch them, so every phone stays in step. */
import type { QueryClient } from '@tanstack/react-query';
import type { LiveMessage } from '@snackoverflow/shared';
import { deviceToken, serverUrl } from './platform';

export function connectLive(queryClient: QueryClient): () => void {
  let socket: WebSocket | null = null;
  let retry = 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (stopped) return;
    const base = serverUrl() || `${location.protocol}//${location.host}`;
    const token = deviceToken();
    socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/live${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    socket.onopen = () => {
      retry = 1000;
      // We may have missed changes while disconnected.
      void queryClient.invalidateQueries();
    };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as LiveMessage;
        if (msg.type === 'invalidate') {
          for (const topic of msg.topics) void queryClient.invalidateQueries({ queryKey: [topic] });
          // The list's "For your plan" part follows the plan and stock, so it may have changed too.
          if (msg.topics.some((t) => t === 'plan' || t === 'stock') && !msg.topics.includes('shopping')) void queryClient.invalidateQueries({ queryKey: ['shopping'] });
        }
      } catch {
        // Ignore anything we don't understand.
      }
    };
    socket.onclose = (ev) => {
      if (stopped || ev.code === 4401) return;
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
