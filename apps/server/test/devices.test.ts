import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceDto, LocationDto, NotificationListDto, ScanAddResult, SessionDto } from '@snackoverflow/shared';
import { hashToken } from '../src/auth/crypto';
import { appLoginCodes, users } from '../src/db/schema';
import { runNotifications } from '../src/notify/notifications';
import { client, FakeOff, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp({ off: new FakeOff({ '1001': { name: 'Chicken thighs', quantity: '500 g' } }) });
});
afterEach(async () => {
  await t.close();
});

/** A client that signs in like the Android app: Bearer token, no cookie. */
function bearer(token: string) {
  const call = async <T>(method: string, url: string, body?: unknown) => {
    const res = await t.app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: () => res.json() as T };
  };
  return {
    get: <T>(url: string) => call<T>('GET', url),
    post: <T>(url: string, body: unknown = {}) => call<T>('POST', url, body),
  };
}

async function phoneLogin(name = 'Pixel'): Promise<string> {
  const res = await client(t.app).raw('POST', '/api/auth/login', {
    email: 'admin@example.com',
    password: 'correct horse battery',
    device: { name, platform: 'android' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.cookies.find((c) => c.name === 'so_session')).toBeUndefined();
  return (res.json() as { token: string }).token;
}

describe('device tokens', () => {
  it('signs a phone in with a token that works as a Bearer header', async () => {
    await setupAdmin(t.app);
    const phone = bearer(await phoneLogin());
    const s = await phone.get<SessionDto>('/api/session');
    expect(s.status).toBe(200);
    expect(s.json().user.email).toBe('admin@example.com');
    const devices = await phone.get<DeviceDto[]>('/api/devices');
    expect(devices.json()).toMatchObject([{ name: 'Pixel', platform: 'android', current: true }]);
  });

  it('signing out on the phone revokes its token', async () => {
    await setupAdmin(t.app);
    const phone = bearer(await phoneLogin());
    await phone.post('/api/auth/logout');
    expect((await phone.get('/api/session')).status).toBe(401);
  });

  it('lets you sign a lost phone out from the browser', async () => {
    const admin = await setupAdmin(t.app);
    const phone = bearer(await phoneLogin());
    const [device] = await admin.get<DeviceDto[]>('/api/devices');
    expect(device?.current).toBe(false);
    await admin.del(`/api/devices/${device!.id}`);
    expect((await phone.get('/api/session')).status).toBe(401);
  });

  it('a password change signs other phones out', async () => {
    const admin = await setupAdmin(t.app);
    const phone = bearer(await phoneLogin());
    await admin.patch('/api/me', { currentPassword: 'correct horse battery', newPassword: 'a new password' });
    expect((await phone.get('/api/session')).status).toBe(401);
  });

  it('rejects unknown tokens', async () => {
    await setupAdmin(t.app);
    expect((await bearer('not-a-real-token').get('/api/stock')).status).toBe(401);
  });

  it('swaps a single sign-on code for a token, once', async () => {
    await setupAdmin(t.app);
    const [user] = await t.ctx.db.select().from(users);
    const code = 'a-one-time-code-from-the-browser';
    await t.ctx.db.insert(appLoginCodes).values({ codeHash: hashToken(code), userId: user!.id, expiresAt: new Date('2026-11-12T12:02:00Z') });
    const anon = client(t.app);
    const res = await anon.raw('POST', '/api/auth/app-code', { code, device: { name: 'Pixel' } });
    expect(res.statusCode).toBe(200);
    expect((await bearer(res.json().token).get('/api/session')).status).toBe(200);
    expect((await anon.raw('POST', '/api/auth/app-code', { code, device: { name: 'Pixel' } })).statusCode).toBe(401);
  });
});

describe('notification inbox', () => {
  it('collects notifications for the bell and for phones checking in the background', async () => {
    const admin = await setupAdmin(t.app);
    const phone = bearer(await phoneLogin());
    const fridge = (await admin.get<LocationDto[]>('/api/locations')).find((l) => l.type === 'fridge')!;
    const r = await admin.post<ScanAddResult>('/api/scan/add', { barcode: '1001', locationId: fridge.id });
    await admin.patch(`/api/stock/${r.change.item.id}`, { bestBefore: '2026-11-13' });

    const before = (await phone.get<NotificationListDto>('/api/notifications?after=0')).json();
    expect(before).toEqual({ items: [], unread: 0, cursor: 0 });

    t.setNow('2026-11-12T09:05:00Z');
    expect((await runNotifications(t.ctx)).app).toBe(1);

    // The phone asks for everything after its cursor.
    const fresh = (await phone.get<NotificationListDto>(`/api/notifications?after=${before.cursor}`)).json();
    expect(fresh.items).toHaveLength(1);
    expect(fresh.items[0]).toMatchObject({
      type: 'expiresTomorrow',
      title: 'Chicken thighs goes off tomorrow',
      url: `/stock/${r.change.item.id}`,
      data: { stockItemId: r.change.item.id },
    });
    expect(fresh.items[0]!.actions.map((a) => a.action)).toEqual(['use', 'freeze', 'discard']);
    expect((await phone.get<NotificationListDto>(`/api/notifications?after=${fresh.cursor}`)).json().items).toEqual([]);

    // The bell shows it as unread until read.
    expect((await admin.get<NotificationListDto>('/api/notifications')).unread).toBe(1);
    await admin.post('/api/notifications/read', {});
    expect((await admin.get<NotificationListDto>('/api/notifications')).unread).toBe(0);
  });

  it('skips the inbox when the person turns the app channel off', async () => {
    const admin = await setupAdmin(t.app);
    await admin.put('/api/me/notifications', {
      channels: { expiresTomorrow: ['push'], weeklySummary: ['email'] },
      quietStart: null,
      quietEnd: null,
    });
    const fridge = (await admin.get<LocationDto[]>('/api/locations')).find((l) => l.type === 'fridge')!;
    const r = await admin.post<ScanAddResult>('/api/scan/add', { barcode: '1001', locationId: fridge.id });
    await admin.patch(`/api/stock/${r.change.item.id}`, { bestBefore: '2026-11-13' });
    t.setNow('2026-11-12T09:05:00Z');
    expect((await runNotifications(t.ctx)).app).toBe(0);
  });
});

describe('offline scans', () => {
  it('keeps the day a queued scan really happened', async () => {
    const admin = await setupAdmin(t.app);
    const fridge = (await admin.get<LocationDto[]>('/api/locations')).find((l) => l.type === 'fridge')!;
    // Scanned yesterday evening without signal, synced today.
    const r = await admin.post<ScanAddResult>('/api/scan/add', { barcode: '1001', locationId: fridge.id, scannedAt: '2026-11-11T19:30:00Z' });
    expect(r.change.item).toMatchObject({ addedOn: '2026-11-11', bestBefore: '2026-11-14' });
  });

  it('ignores scan times in the future', async () => {
    const admin = await setupAdmin(t.app);
    const r = await admin.post<ScanAddResult>('/api/scan/add', { barcode: '1001', scannedAt: '2027-01-01T10:00:00Z' });
    expect(r.change.item.addedOn).toBe('2026-11-12');
  });
});
