/** The Android app as a download: /apk and what Settings is told about it. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppDownloadDto } from '@snackoverflow/shared';
import { makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | undefined;
let dir: string | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('app download', () => {
  it('serves the APK to anyone, and tells Settings its size and date', async () => {
    dir = mkdtempSync(join(tmpdir(), 'so-apk-'));
    const path = join(dir, 'snackoverflow.apk');
    writeFileSync(path, 'not really an apk');
    t = await makeTestApp({ config: { APK_PATH: path } });

    // No sign-in: a new phone has nothing yet.
    const res = await t.app.inject({ method: 'GET', url: '/apk' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toBe('attachment; filename="snackoverflow.apk"');
    expect(res.body).toBe('not really an apk');

    // The status is for people who are signed in.
    expect((await t.app.inject({ method: 'GET', url: '/api/app-download' })).statusCode).toBe(401);
    const api = await setupAdmin(t.app);
    const status = await api.get<AppDownloadDto>('/api/app-download');
    expect(status.available).toBe(true);
    expect(status.bytes).toBe(17);
    expect(status.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('has nothing to give when the setting is empty or the file is missing', async () => {
    t = await makeTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/apk' })).statusCode).toBe(404);
    const api = await setupAdmin(t.app);
    expect(await api.get<AppDownloadDto>('/api/app-download')).toEqual({ available: false, bytes: null, updatedAt: null });
    await t.close();

    dir = mkdtempSync(join(tmpdir(), 'so-apk-'));
    t = await makeTestApp({ config: { APK_PATH: join(dir, 'missing.apk') } });
    expect((await t.app.inject({ method: 'GET', url: '/apk' })).statusCode).toBe(404);
  });
});
