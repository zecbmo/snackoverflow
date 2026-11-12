import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { type Config, testConfig } from '../src/config';
import type { AppContext } from '../src/context';
import type { Db } from '../src/db/client';
import * as schema from '../src/db/schema';
import { loadSeedData } from '../src/db/seed';
import { LiveHub } from '../src/live';
import type { EmailMessage, Mailer } from '../src/notify/email';
import type { PushPayload, PushSender } from '../src/notify/push';
import type { OffProduct, OpenFoodFacts } from '../src/services/off';
import { migrationsDir, seedDataDir } from '../src/paths';

export class FakeOff implements OpenFoodFacts {
  calls: string[] = [];
  constructor(public products: Record<string, Partial<OffProduct>> = {}) {}
  async lookup(barcode: string): Promise<OffProduct | null> {
    this.calls.push(barcode);
    const p = this.products[barcode];
    if (!p) return null;
    return { barcode, name: null, brand: null, quantity: null, imageUrl: null, categories: [], nutritionPer100g: null, ...p };
  }
}

export class FakePush implements PushSender {
  publicKey = 'test-public-key';
  sent: { endpoint: string; payload: PushPayload }[] = [];
  async send(target: { endpoint: string }, payload: PushPayload) {
    this.sent.push({ endpoint: target.endpoint, payload });
    return 'sent' as const;
  }
}

export class FakeMailer implements Mailer {
  sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
  }
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  off: FakeOff;
  push: FakePush;
  mailer: FakeMailer;
  setNow(iso: string): void;
  close(): Promise<void>;
}

const seed = loadSeedData(seedDataDir());

export async function makeTestApp(opts: { now?: string; config?: Partial<Config>; off?: FakeOff } = {}): Promise<TestApp> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  let now = new Date(opts.now ?? '2026-11-12T12:00:00Z');
  const off = opts.off ?? new FakeOff();
  const push = new FakePush();
  const mailer = new FakeMailer();
  const ctx: AppContext = {
    db: db as unknown as Db,
    config: testConfig({ OFF_ENABLED: true, ...opts.config }),
    seed,
    live: new LiveHub(),
    off,
    push,
    mailer,
    now: () => now,
  };
  const app = await buildApp(ctx);
  return {
    app,
    ctx,
    off,
    push,
    mailer,
    setNow: (iso) => {
      now = new Date(iso);
    },
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}

export interface Client {
  cookie: string;
  get<T = unknown>(url: string): Promise<T>;
  post<T = unknown>(url: string, body?: unknown): Promise<T>;
  patch<T = unknown>(url: string, body?: unknown): Promise<T>;
  put<T = unknown>(url: string, body?: unknown): Promise<T>;
  del<T = unknown>(url: string, body?: unknown): Promise<T>;
  raw(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse>;
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const c = res.cookies.find((c) => c.name === 'so_session');
  if (!c) throw new Error(`no session cookie (status ${res.statusCode}: ${res.body})`);
  return `so_session=${c.value}`;
}

export function client(app: FastifyInstance, cookie = ''): Client {
  const raw = (method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await raw(method, url, body);
    if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
    return res.json() as T;
  };
  return {
    cookie,
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body ?? {}),
    patch: (url, body) => call('PATCH', url, body ?? {}),
    put: (url, body) => call('PUT', url, body ?? {}),
    del: (url, body) => call('DELETE', url, body),
    raw,
  };
}

/** Set up the household with an admin and return a signed-in client. */
export async function setupAdmin(app: FastifyInstance, email = 'admin@example.com'): Promise<Client> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { householdName: 'Test household', name: 'Alex', email, password: 'correct horse battery' },
  });
  return client(app, cookieFrom(res));
}
