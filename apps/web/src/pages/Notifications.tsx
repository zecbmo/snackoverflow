import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Channel, NotificationPrefs, NotificationSettingsDto, NotificationType } from '@snackoverflow/shared';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Spinner, TextInput, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { currentSubscription, pushSupported, subscribePush, unsubscribePush } from '../lib/push';
import { keys, useNotificationSettings } from '../lib/queries';

const TYPES: { type: NotificationType; title: string; when: string; channels: Channel[] }[] = [
  { type: 'expiresTomorrow', title: 'Expires tomorrow', when: 'Daily at 9am, with Use, Freeze and Binned buttons', channels: ['app', 'push'] },
  { type: 'weeklySummary', title: 'Going off this week', when: 'Sundays at 10am', channels: ['app', 'push', 'email'] },
  { type: 'mealTime', title: 'Did you cook it?', when: 'At meal times, for planned meals, with Cooked it, Skip and Move', channels: ['app', 'push'] },
  { type: 'runningLow', title: 'Running low', when: 'When staples look like running out', channels: ['app', 'push'] },
  { type: 'listChanged', title: 'Shopping list changed', when: 'When someone else adds to the list', channels: ['app', 'push'] },
];

const channelName: Record<Channel, string> = { app: 'In the app', push: 'Browser push', email: 'Email' };

export function NotificationsPage() {
  const settings = useNotificationSettings();
  return (
    <>
      <PageHeader title="Notifications" left={<MenuButton />} />
      {settings.isPending ? <Spinner /> : settings.error ? <ErrorNote error={settings.error} /> : <PrefsForm settings={settings.data} />}
    </>
  );
}

function PrefsForm({ settings }: { settings: NotificationSettingsDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [prefs, setPrefs] = useState<NotificationPrefs>(settings.prefs);

  const save = async (next: NotificationPrefs) => {
    setPrefs(next);
    try {
      const saved = await api.put<NotificationSettingsDto>('/api/me/notifications', next);
      qc.setQueryData(keys.notifications, saved);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const toggle = (type: NotificationType, channel: Channel, on: boolean) => {
    const current = prefs.channels[type] ?? [];
    const channels = on ? [...new Set([...current, channel])] : current.filter((c) => c !== channel);
    void save({ ...prefs, channels: { ...prefs.channels, [type]: channels } });
  };

  const quietOn = prefs.quietStart !== null && prefs.quietEnd !== null;

  return (
    <div className="flex flex-col gap-5">
      <ThisDevice pushSubscribed={settings.pushSubscribed} />
      {TYPES.map((t) => (
        <Card key={t.type} className="p-5">
          <h2 className="text-lg font-bold">{t.title}</h2>
          <p className="mb-3 text-sm text-muted">{t.when}</p>
          {t.channels.map((c) =>
            settings.available[c] ? (
              <div key={c} className="flex min-h-12 items-center justify-between gap-3">
                <span className="font-medium">{channelName[c]}</span>
                <Toggle checked={(prefs.channels[t.type] ?? []).includes(c)} onChange={(on) => toggle(t.type, c, on)} label={`${t.title} by ${channelName[c].toLowerCase()}`} />
              </div>
            ) : (
              <p key={c} className="py-2 text-sm text-muted">
                {c === 'push' ? "Push isn't set up on this server." : "Email isn't set up on this server."}
              </p>
            ),
          )}
        </Card>
      ))}
      <Card className="p-5">
        <div className="flex min-h-12 items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Quiet hours</h2>
            <p className="text-sm text-muted">Nothing is sent in this window; it waits until it ends.</p>
          </div>
          <Toggle
            checked={quietOn}
            label="Quiet hours"
            onChange={(on) => void save({ ...prefs, quietStart: on ? '22:00' : null, quietEnd: on ? '07:00' : null })}
          />
        </div>
        {quietOn && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="From">
              {(id) => <TextInput id={id} type="time" value={prefs.quietStart ?? ''} onChange={(e) => e.target.value && void save({ ...prefs, quietStart: e.target.value })} />}
            </Field>
            <Field label="Until">
              {(id) => <TextInput id={id} type="time" value={prefs.quietEnd ?? ''} onChange={(e) => e.target.value && void save({ ...prefs, quietEnd: e.target.value })} />}
            </Field>
          </div>
        )}
      </Card>
    </div>
  );
}

function ThisDevice({ pushSubscribed }: { pushSubscribed: number }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(Boolean(s)));
  }, []);

  const key = me.features.vapidPublicKey;
  const refresh = () => qc.invalidateQueries({ queryKey: keys.notifications });

  const enable = async () => {
    if (!key) return;
    setBusy(true);
    try {
      await subscribePush(key);
      setSubscribed(true);
      toast.show('Notifications are on for this device.');
      await refresh();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await unsubscribePush();
      setSubscribed(false);
      toast.show('Notifications are off for this device.');
      await refresh();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const r = await api.post<{ pushed: number; emailed: boolean }>('/api/me/notifications/test');
      const parts = [r.pushed ? `sent to ${r.pushed} device${r.pushed === 1 ? '' : 's'}` : null, r.emailed ? 'emailed you' : null].filter(Boolean);
      toast.show(parts.length ? `Test ${parts.join(' and ')}.` : 'Nothing to send to yet. Turn on push or set up email.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-lg font-bold">This device</h2>
      {!key ? (
        <p className="mt-1 text-muted">Push isn't set up on this server.</p>
      ) : !pushSupported() ? (
        <p className="mt-1 text-muted">This browser can't show notifications. On iPhone, add Snack Overflow to your home screen first.</p>
      ) : (
        <>
          <p className="mt-1 mb-3 text-muted">
            {subscribed ? 'Notifications are on here.' : 'Get reminders on this phone or computer.'}
            {pushSubscribed > 0 && ` ${pushSubscribed} device${pushSubscribed === 1 ? '' : 's'} signed up in total.`}
          </p>
          {subscribed ? (
            <Button disabled={busy} onClick={() => void disable()}>
              Turn off on this device
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || subscribed === null} onClick={() => void enable()}>
              Turn on notifications
            </Button>
          )}
        </>
      )}
      <Button variant="ghost" className="mt-2" onClick={() => void test()}>
        Send a test
      </Button>
    </Card>
  );
}
