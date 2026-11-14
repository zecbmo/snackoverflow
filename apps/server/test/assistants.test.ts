import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantSettingsDto, InviteDto, SessionDto } from '@snackoverflow/shared';
import { appSecrets } from '../src/db/schema';
import { applyStoredSecrets, decryptSecret, encryptSecret } from '../src/services/secrets';
import { client, cookieFrom, makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const KEY = 'sk-ant-test-key-0123456789abcdef';

/** A fake Models API: the right key finds the model, anything else is rejected. */
function fakeModels(calls: string[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    calls.push(url);
    // The SDK sends the key as a Bearer token.
    if (headers.get('authorization') !== `Bearer ${KEY}`) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const id = decodeURIComponent(url.split('/v1/models/')[1]!.split('?')[0]!);
    if (id !== 'claude-opus-5-5') {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id, type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function setup(config: Parameters<typeof makeTestApp>[0] = {}) {
  const calls: string[] = [];
  t = await makeTestApp({ fetch: fakeModels(calls), ...config });
  const api = await setupAdmin(t.app);
  return { api, calls };
}

const mcpInit = (token: string) =>
  t!.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  });

describe('AI key and MCP token in Settings', () => {
  it('saves a key that works, encrypted, and turns AI on', async () => {
    const { api, calls } = await setup();
    expect((await api.get<AssistantSettingsDto>('/api/settings/assistants')).ai).toMatchObject({ source: null, keyHint: null, model: 'claude-opus-5-5' });
    const out = await api.put<AssistantSettingsDto>('/api/settings/ai', { apiKey: KEY });
    expect(out.ai).toMatchObject({ source: 'settings', keyHint: '…cdef' });
    expect(calls.some((u) => u.includes('/v1/models/claude-opus-5-5'))).toBe(true);
    expect((await api.get<SessionDto>('/api/session')).features.ai).toBe(true);
    // Stored encrypted, never in plain text, and readable again after a restart.
    const [row] = await t!.ctx.db.select().from(appSecrets);
    expect(row!.value).not.toContain(KEY);
    t!.ctx.config.AI_API_KEY = undefined;
    await applyStoredSecrets(t!.ctx);
    expect(t!.ctx.config.AI_API_KEY).toBe(KEY);
    // Removing it turns AI off.
    await api.put('/api/settings/ai', { apiKey: null });
    expect((await api.get<SessionDto>('/api/session')).features.ai).toBe(false);
  });

  it("refuses a key that doesn't work, or a model that doesn't exist", async () => {
    const { api } = await setup();
    const bad = await api.raw('PUT', '/api/settings/ai', { apiKey: 'sk-ant-wrong-key-0000000000000' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/rejected/);
    const noModel = await api.raw('PUT', '/api/settings/ai', { apiKey: KEY, model: 'claude-nope' });
    expect(noModel.json().error).toMatch(/no model called "claude-nope"/);
    expect((await api.get<SessionDto>('/api/session')).features.ai).toBe(false);
  });

  it('tests the key in use', async () => {
    const { api } = await setup();
    expect((await api.raw('POST', '/api/settings/ai/test', {})).statusCode).toBe(400);
    await api.put('/api/settings/ai', { apiKey: KEY });
    expect(await api.post('/api/settings/ai/test', {})).toEqual({ ok: true, model: 'claude-opus-5-5' });
  });

  it("leaves a key the server's environment sets alone", async () => {
    const { api } = await setup({ config: { AI_API_KEY: 'sk-ant-from-the-environment-1234' } });
    expect((await api.get<AssistantSettingsDto>('/api/settings/assistants')).ai).toMatchObject({ source: 'server', keyHint: '…1234' });
    expect((await api.raw('PUT', '/api/settings/ai', { apiKey: KEY })).statusCode).toBe(409);
  });

  it('makes an MCP token that works, shows it once, and can turn MCP off', async () => {
    const { api } = await setup();
    expect((await mcpInit('anything')).statusCode).toBe(404);
    const { token, settings } = await api.post<{ token: string; settings: AssistantSettingsDto }>('/api/settings/mcp-token', {});
    expect(settings.mcp).toMatchObject({ source: 'settings', tokenHint: `…${token.slice(-4)}` });
    expect(JSON.stringify(await api.get('/api/settings/assistants'))).not.toContain(token);
    expect((await mcpInit(token)).statusCode).toBe(200);
    // A new token replaces the old one.
    const second = await api.post<{ token: string }>('/api/settings/mcp-token', {});
    expect((await mcpInit(token)).statusCode).toBe(401);
    expect((await mcpInit(second.token)).statusCode).toBe(200);
    await api.del('/api/settings/mcp-token');
    expect((await mcpInit(second.token)).statusCode).toBe(404);
  });

  it('is for admins only', async () => {
    const { api } = await setup();
    const inv = await api.post<InviteDto>('/api/invites', { role: 'member' });
    const res = await client(t!.app).raw('POST', `/api/invites/${inv.url.split('/invite/')[1]}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'a password' });
    const member = client(t!.app, cookieFrom(res));
    expect((await member.raw('GET', '/api/settings/assistants')).statusCode).toBe(403);
    expect((await member.raw('PUT', '/api/settings/ai', { apiKey: KEY })).statusCode).toBe(403);
  });
});

describe('secret encryption', () => {
  it('round-trips, and gives nothing back with the wrong session secret', () => {
    const enc = encryptSecret('hello', 'a-session-secret-of-some-length');
    expect(decryptSecret(enc, 'a-session-secret-of-some-length')).toBe('hello');
    expect(decryptSecret(enc, 'another-session-secret-entirely')).toBeNull();
    expect(decryptSecret('garbage', 'a-session-secret-of-some-length')).toBeNull();
  });
});
