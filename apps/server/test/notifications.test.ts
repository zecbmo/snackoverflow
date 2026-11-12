import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS, type LocationDto, type ScanAddResult } from '@snackoverflow/shared';
import { inQuietHours, runNotifications } from '../src/notify/notifications';
import { type Client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
let api: Client;
let fridge: LocationDto;

beforeEach(async () => {
  // Thursday 12 Nov 2026.
  t = await makeTestApp({
    off: new FakeOff({
      '1001': { name: 'Chicken thighs', quantity: '500 g' },
      '1002': { name: 'Baby spinach', quantity: '200 g' },
      '1003': { name: 'Cheddar', quantity: '400 g' },
    }),
  });
  api = await setupAdmin(t.app);
  fridge = (await api.get<LocationDto[]>('/api/locations')).find((l) => l.type === 'fridge')!;
  await api.post('/api/push/subscriptions', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } });
});
afterEach(async () => {
  await t.close();
});

const add = async (barcode: string, bestBefore: string) => {
  const r = await api.post<ScanAddResult>('/api/scan/add', { barcode, locationId: fridge.id });
  await api.patch(`/api/stock/${r.change.item.id}`, { bestBefore });
};

describe('expires tomorrow', () => {
  it('sends one push per item at 9am with action buttons, once', async () => {
    await add('1001', '2026-11-13');
    await add('1003', '2026-12-30');
    t.setNow('2026-11-12T08:30:00Z');
    expect((await runNotifications(t.ctx)).push).toBe(0);
    t.setNow('2026-11-12T09:01:00Z');
    expect((await runNotifications(t.ctx)).push).toBe(1);
    const sent = t.push.sent[0]!.payload;
    expect(sent.title).toBe('Chicken thighs goes off tomorrow');
    expect(sent.actions?.map((a) => a.action)).toEqual(['use', 'freeze', 'discard']);
    t.setNow('2026-11-12T11:00:00Z');
    expect((await runNotifications(t.ctx)).push).toBe(0);
  });

  it('respects quiet hours and catches up after them', async () => {
    await add('1002', '2026-11-13');
    await api.put('/api/me/notifications', { ...DEFAULT_NOTIFICATION_PREFS, quietStart: '08:00', quietEnd: '10:00' });
    t.setNow('2026-11-12T09:30:00Z');
    expect((await runNotifications(t.ctx)).push).toBe(0);
    t.setNow('2026-11-12T10:00:00Z');
    expect((await runNotifications(t.ctx)).push).toBe(1);
  });

  it('respects turning a notification off', async () => {
    await add('1002', '2026-11-13');
    await api.put('/api/me/notifications', {
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: { ...DEFAULT_NOTIFICATION_PREFS.channels, expiresTomorrow: [] },
    });
    t.setNow('2026-11-12T09:30:00Z');
    expect((await runNotifications(t.ctx)).push).toBe(0);
  });
});

describe('weekly summary', () => {
  it('goes out on Sunday at 10am by push and email', async () => {
    await add('1001', '2026-11-17');
    await add('1002', '2026-11-19');
    await add('1003', '2026-12-30');
    t.setNow('2026-11-15T10:05:00Z'); // Sunday
    const stats = await runNotifications(t.ctx);
    expect(stats).toEqual({ push: 1, email: 1 });
    const email = t.mailer.sent[0]!;
    expect(email.subject).toBe('2 things go off this week');
    expect(email.text).toContain('Chicken thighs: 17 Nov');
    expect(email.text).not.toContain('Cheddar');
  });
});

describe('quiet hours', () => {
  it('handles windows over midnight', () => {
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, quietStart: '22:00', quietEnd: '07:00' };
    expect(inQuietHours(prefs, 23, 0)).toBe(true);
    expect(inQuietHours(prefs, 6, 59)).toBe(true);
    expect(inQuietHours(prefs, 7, 0)).toBe(false);
    expect(inQuietHours(prefs, 12, 0)).toBe(false);
  });
});
