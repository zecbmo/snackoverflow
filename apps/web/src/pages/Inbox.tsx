import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { BackButton } from '../components/Layout';
import { Card, EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useInbox } from '../lib/queries';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Everything the app has told you, newest first (the bell). Opening it marks them read. */
export function InboxPage() {
  const inbox = useInbox();
  const qc = useQueryClient();
  const unread = inbox.data?.unread ?? 0;
  useEffect(() => {
    if (unread > 0) void api.post('/api/notifications/read', {}).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  }, [unread, qc]);

  return (
    <>
      <PageHeader title="Notifications" left={<BackButton />} />
      <ErrorNote error={inbox.error} />
      {inbox.isPending ? (
        <Spinner />
      ) : inbox.data?.items.length ? (
        <Card className="overflow-hidden">
          <ul>
            {inbox.data.items.map((n) => (
              <li key={n.id} className="border-b border-line last:border-b-0">
                <Link to={n.url ?? '/'} className="flex gap-3 px-4 py-3.5">
                  <span aria-hidden className={`mt-2 size-2.5 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{n.title}</span>
                    <span className="block text-muted">{n.body}</span>
                    <time dateTime={n.createdAt} className="mt-1 block text-sm text-muted">
                      {when(n.createdAt)}
                    </time>
                  </span>
                  {!n.readAt && <span className="sr-only">Unread</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState title="Nothing yet">
          <p>Reminders about food going off will show up here.</p>
        </EmptyState>
      )}
    </>
  );
}
