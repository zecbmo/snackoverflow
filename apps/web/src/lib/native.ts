/**
 * Android app glue: sign-in hand-off from the browser, notification taps and
 * buttons, and the background check of the notification inbox. There is no
 * Firebase: the app's own Inbox plugin (apps/android/.../InboxWorker.java) asks
 * the server about every 15 minutes. Everything here is a no-op in the browser.
 */
import { registerPlugin } from '@capacitor/core';
import type { QueryClient } from '@tanstack/react-query';
import type { NotificationListDto } from '@snackoverflow/shared';
import { api } from './api';
import { deviceName, deviceToken, isNative, serverUrl, setDeviceToken } from './platform';

interface InboxPlugin {
  configure(options: { server: string; token: string; cursor: number }): Promise<void>;
  checkNow(): Promise<void>;
  signOut(): Promise<void>;
  dismiss(options: { id: number }): Promise<void>;
  requestNotifications(): Promise<{ granted: boolean }>;
  /** A receipt shared in from another app's share sheet, once. */
  takeSharedFile(): Promise<{ data?: string; type?: string; name?: string }>;
  addListener(event: 'sharedFile', handler: () => void): Promise<{ remove: () => Promise<void> }>;
}

/** A shared receipt waiting for the person to sign in. */
let pendingShare: { data: string; type: string } | null = null;

/**
 * Upload a receipt shared from another app (photo, screenshot or PDF) and open
 * its review page. Kept until after sign-in when nobody is signed in yet.
 */
async function handleSharedFile(navigate: Navigate, toast: (msg: string) => void): Promise<void> {
  try {
    const f = await Inbox.takeSharedFile();
    if (f.data && f.type) pendingShare = { data: f.data, type: f.type };
  } catch {
    // No share support (e.g. an older app build).
  }
  if (!pendingShare || !deviceToken()) return;
  const share = pendingShare;
  pendingShare = null;
  try {
    const { id } = await api.post<{ id: string }>('/api/receipts/file', { data: share.data, type: share.type, source: 'upload' });
    navigate(`/receipts/${id}`);
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't add that receipt.");
  }
}

/** Call after signing in on the phone, so a receipt shared before sign-in gets added. */
export function flushSharedFile(navigate: Navigate, toast: (msg: string) => void): void {
  if (isNative() && (pendingShare || deviceToken())) void handleSharedFile(navigate, toast);
}

const Inbox = registerPlugin<InboxPlugin>('Inbox');

type Navigate = (to: string) => void;

/** Turn on background checks for this phone, starting from the newest notification. */
export async function configureBackgroundChecks(): Promise<void> {
  if (!isNative()) return;
  const token = deviceToken();
  if (!token) return;
  try {
    const latest = await api.get<NotificationListDto>('/api/notifications?limit=1');
    await Inbox.configure({ server: serverUrl(), token, cursor: latest.cursor });
  } catch {
    // Background checks are a nicety; the bell still works in the app.
  }
}

export async function requestNotificationPermission(): Promise<void> {
  if (!isNative()) return;
  try {
    await Inbox.requestNotifications();
  } catch {
    // The user can allow notifications later in Android settings.
  }
}

/** Forget this phone's sign-in, here and in the background checks. */
export async function forgetDevice(): Promise<void> {
  setDeviceToken(null);
  if (!isNative()) return;
  try {
    await Inbox.signOut();
  } catch {
    // Nothing to tidy.
  }
}

/** Sign in from the app with email and password: the server hands back a device token. */
export async function nativePasswordLogin(email: string, password: string): Promise<void> {
  const r = await api.post<{ token: string }>('/api/auth/login', { email, password, device: { name: deviceName(), platform: 'android' } });
  setDeviceToken(r.token);
}

/** Single sign-on opens the phone's browser; the server sends us back with a one-time code. */
export function startNativeSso() {
  window.location.assign(`${serverUrl()}/api/auth/oidc/start?app=1`);
}

const ACTIONS: Record<string, [string, unknown, string]> = {
  use: ['use', { amount: { kind: 'all' } }, 'Marked as used.'],
  freeze: ['freeze', {}, 'In the freezer.'],
  discard: ['discard', {}, 'Binned.'],
};

/** snackoverflow://notification?action=freeze&stockItemId=...&url=...&id=... */
async function handleNotificationLink(u: URL, queryClient: QueryClient, navigate: Navigate, toast: (msg: string) => void) {
  const path = u.searchParams.get('url') || '/inbox';
  const id = Number(u.searchParams.get('id'));
  const actionName = u.searchParams.get('action') ?? '';
  const entryId = u.searchParams.get('entryId');
  const recipeId = u.searchParams.get('recipeId');
  // Meal-time prompt: "Cooking Fish pie tonight?"
  if (entryId && ['cooked', 'skip', 'move'].includes(actionName)) {
    if (Number.isFinite(id)) void Inbox.dismiss({ id });
    if (actionName === 'cooked' && recipeId) return navigate(`/recipes/${recipeId}/cook?entry=${entryId}`);
    if (actionName === 'move') return navigate(`/plan?entry=${entryId}`);
    try {
      await api.patch(`/api/plan/${entryId}`, { status: 'skipped' });
      await queryClient.invalidateQueries({ queryKey: ['plan'] });
      toast('Skipped.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.');
    }
    return navigate('/plan');
  }
  const action = ACTIONS[actionName];
  const stockItemId = u.searchParams.get('stockItemId');
  if (action && stockItemId) {
    try {
      await api.post(`/api/stock/${stockItemId}/${action[0]}`, action[1]);
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      toast(action[2]);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.');
    }
    if (Number.isFinite(id)) void Inbox.dismiss({ id });
  }
  navigate(path.startsWith('/') ? path : '/inbox');
}

let started = false;

export async function initNative(queryClient: QueryClient, navigate: Navigate, toast: (msg: string) => void): Promise<void> {
  if (!isNative() || started) return;
  started = true;
  const { App } = await import('@capacitor/app');

  const onLink = async (url: string) => {
    const u = new URL(url);
    if (u.protocol !== 'snackoverflow:') return;
    if (u.host === 'notification') return handleNotificationLink(u, queryClient, navigate, toast);
    const code = u.searchParams.get('code');
    if (u.host !== 'auth' || !code) return;
    try {
      const r = await api.post<{ token: string }>('/api/auth/app-code', { code, device: { name: deviceName(), platform: 'android' } });
      setDeviceToken(r.token);
      await queryClient.invalidateQueries();
      navigate('/');
    } catch {
      navigate('/login?error=' + encodeURIComponent('Sign-in timed out. Please try again.'));
    }
  };

  await App.addListener('appUrlOpen', ({ url }) => void onLink(url));
  // Opened from a notification while the app wasn't running.
  const launch = await App.getLaunchUrl();
  if (launch?.url) void onLink(launch.url);

  await App.addListener('resume', () => {
    void queryClient.invalidateQueries();
    void handleSharedFile(navigate, toast);
  });

  // Receipts shared in from other apps: at start-up, on resume, and while open.
  await Inbox.addListener('sharedFile', () => void handleSharedFile(navigate, toast));
  void handleSharedFile(navigate, toast);
}

/** For testing on a device: check the inbox now instead of waiting up to 15 minutes. */
export function checkInboxNow(): Promise<void> {
  return isNative() ? Inbox.checkNow() : Promise.resolve();
}
