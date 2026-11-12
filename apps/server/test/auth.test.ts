import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InviteDto, LocationDto, SessionDto, UserDto } from '@snackoverflow/shared';
import { client, cookieFrom, makeTestApp, setupAdmin, type TestApp } from './helpers';
import { ensureFirstAdmin } from '../src/services/household';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('setup and sign-in', () => {
  it('needs setup on a fresh install, then not', async () => {
    const anon = client(t.app);
    expect(await anon.get('/api/auth/status')).toMatchObject({ needsSetup: true });
    await setupAdmin(t.app);
    expect(await anon.get('/api/auth/status')).toMatchObject({ needsSetup: false });
  });

  it('creates the household, admin and seed data', async () => {
    const admin = await setupAdmin(t.app);
    const session = await admin.get<SessionDto>('/api/session');
    expect(session.user).toMatchObject({ name: 'Alex', email: 'admin@example.com', role: 'admin' });
    expect(session.household).toMatchObject({ name: 'Test household', timeZone: 'Europe/London' });
    expect(session.today).toBe('2026-11-12');
    const locations = await admin.get<LocationDto[]>('/api/locations');
    expect(locations.map((l) => l.type)).toEqual(['fridge', 'freezer', 'cupboard']);
    const ingredients = await admin.get<{ name: string; shelfLife: { closedDays: number | null } }[]>('/api/ingredients');
    const milk = ingredients.find((i) => i.name === 'Milk');
    expect(milk?.shelfLife.closedDays).toBe(8);
  });

  it('refuses a second setup', async () => {
    await setupAdmin(t.app);
    const res = await client(t.app).raw('POST', '/api/auth/setup', {
      householdName: 'Other',
      name: 'Eve',
      email: 'eve@example.com',
      password: 'another password',
    });
    expect(res.statusCode).toBe(409);
  });

  it('signs in and out', async () => {
    await setupAdmin(t.app);
    const anon = client(t.app);
    const bad = await anon.raw('POST', '/api/auth/login', { email: 'admin@example.com', password: 'wrong password' });
    expect(bad.statusCode).toBe(401);
    const good = await anon.raw('POST', '/api/auth/login', { email: 'ADMIN@example.com', password: 'correct horse battery' });
    expect(good.statusCode).toBe(200);
    const me = client(t.app, cookieFrom(good));
    expect((await me.get<SessionDto>('/api/session')).user.email).toBe('admin@example.com');
    await me.post('/api/auth/logout');
    expect((await me.raw('GET', '/api/session')).statusCode).toBe(401);
  });

  it('protects the API', async () => {
    for (const url of ['/api/stock', '/api/locations', '/api/products', '/api/users']) {
      expect((await client(t.app).raw('GET', url)).statusCode, url).toBe(401);
    }
  });

  it('creates the first admin from the environment', async () => {
    t.ctx.config.ADMIN_EMAIL = 'boss@example.com';
    t.ctx.config.ADMIN_PASSWORD = 'from the env file';
    const admin = await ensureFirstAdmin(t.ctx);
    expect(admin?.role).toBe('admin');
    expect(await ensureFirstAdmin(t.ctx)).toBeNull();
    const res = await client(t.app).raw('POST', '/api/auth/login', { email: 'boss@example.com', password: 'from the env file' });
    expect(res.statusCode).toBe(200);
  });
});

describe('invites and roles', () => {
  it('lets an admin invite a member who can then sign in', async () => {
    const admin = await setupAdmin(t.app);
    const invite = await admin.post<InviteDto & { emailed: boolean }>('/api/invites', { email: 'sam@example.com' });
    expect(invite.emailed).toBe(true);
    expect(t.mailer.sent[0]?.to).toBe('sam@example.com');
    const token = invite.url.split('/invite/')[1]!;
    const anon = client(t.app);
    expect(await anon.get(`/api/invites/${token}`)).toMatchObject({ email: 'sam@example.com', role: 'member' });
    const res = await anon.raw('POST', `/api/invites/${token}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'sams password' });
    expect(res.statusCode).toBe(200);
    const sam = client(t.app, cookieFrom(res));
    expect((await sam.get<SessionDto>('/api/session')).user.role).toBe('member');
    // Used invites can't be reused.
    expect((await anon.raw('GET', `/api/invites/${token}`)).statusCode).toBe(404);
    // Members can't manage people.
    expect((await sam.raw('POST', '/api/invites', {})).statusCode).toBe(403);
    expect((await sam.raw('PATCH', '/api/household', { name: 'Mine now' })).statusCode).toBe(403);
    // ...but share the same stock and locations.
    expect(await sam.get('/api/locations')).toHaveLength(3);
  });

  it('keeps at least one admin', async () => {
    const admin = await setupAdmin(t.app);
    const me = (await admin.get<SessionDto>('/api/session')).user;
    expect((await admin.raw('PATCH', `/api/users/${me.id}`, { role: 'member' })).statusCode).toBe(400);
    expect((await admin.raw('DELETE', `/api/users/${me.id}`)).statusCode).toBe(400);
    const users = await admin.get<UserDto[]>('/api/users');
    expect(users).toHaveLength(1);
  });

  it('changes password and signs other devices out', async () => {
    const admin = await setupAdmin(t.app);
    const other = client(
      t.app,
      cookieFrom(await client(t.app).raw('POST', '/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' })),
    );
    expect((await admin.raw('PATCH', '/api/me', { currentPassword: 'nope', newPassword: 'a new password' })).statusCode).toBe(400);
    await admin.patch('/api/me', { currentPassword: 'correct horse battery', newPassword: 'a new password' });
    expect((await other.raw('GET', '/api/session')).statusCode).toBe(401);
    expect((await admin.raw('GET', '/api/session')).statusCode).toBe(200);
  });
});
