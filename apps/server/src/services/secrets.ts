/**
 * The AI key, AI model and MCP token can be set in Settings as well as in the environment.
 * The environment wins (Settings then shows "set by the server"). Values set in Settings are
 * stored encrypted with a key derived from SESSION_SECRET, so database backups don't hold them
 * in plain text, and are applied onto ctx.config so the rest of the app reads them as before.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { appSecrets } from '../db/schema';

export const SECRET_NAMES = ['AI_API_KEY', 'AI_MODEL', 'MCP_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const keyFrom = (sessionSecret: string) => createHash('sha256').update(`snackoverflow-secrets:${sessionSecret}`).digest();

export function encryptSecret(text: string, sessionSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(sessionSecret), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** Null when it can't be read (SESSION_SECRET changed, or the value is damaged). */
export function decryptSecret(value: string, sessionSecret: string): string | null {
  const [v, iv, tag, data] = value.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(sessionSecret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Load what Settings stored and apply it under whatever the environment set. Call at start-up and after changes. */
export async function applyStoredSecrets(ctx: AppContext): Promise<void> {
  ctx.envSecrets ??= Object.fromEntries(SECRET_NAMES.map((n) => [n, ctx.config[n] || undefined])) as Record<SecretName, string | undefined>;
  const rows = await ctx.db.select().from(appSecrets);
  const stored = new Map(rows.map((r) => [r.name, decryptSecret(r.value, ctx.config.SESSION_SECRET)]));
  for (const n of SECRET_NAMES) ctx.config[n] = ctx.envSecrets[n] ?? stored.get(n) ?? undefined;
}

/** Where a setting comes from, for the Settings page. */
export function secretSource(ctx: AppContext, name: SecretName): 'server' | 'settings' | null {
  if (ctx.envSecrets?.[name]) return 'server';
  return ctx.config[name] ? 'settings' : null;
}

export async function setSecret(ctx: AppContext, name: SecretName, value: string | null): Promise<void> {
  if (value) {
    const enc = encryptSecret(value, ctx.config.SESSION_SECRET);
    await ctx.db
      .insert(appSecrets)
      .values({ name, value: enc })
      .onConflictDoUpdate({ target: appSecrets.name, set: { value: enc, updatedAt: new Date() } });
  } else {
    await ctx.db.delete(appSecrets).where(eq(appSecrets.name, name));
  }
  await applyStoredSecrets(ctx);
}

/** "…a1b2": enough to recognise a key without showing it. */
export const hint = (s: string | undefined) => (s ? `…${s.slice(-4)}` : null);
