import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth, AppContext } from '../context';
import { households, sessions, users } from '../db/schema';
import { forbidden, unauthorized } from '../http';
import { hashToken, newToken } from './crypto';

export const SESSION_COOKIE = 'so_session';
const SESSION_DAYS = 90;
const REFRESH_WHEN_DAYS_LEFT = 60;

export async function createSession(ctx: AppContext, reply: FastifyReply, userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(ctx.now().getTime() + SESSION_DAYS * 86_400_000);
  await ctx.db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    expires: expiresAt,
  });
}

export async function destroySession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await ctx.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolve the signed-in user from the session cookie (or null). */
export async function loadAuth(ctx: AppContext, req: FastifyRequest): Promise<Auth | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const now = ctx.now();
  const tokenHash = hashToken(token);
  const [row] = await ctx.db
    .select({ session: sessions, user: users, household: households })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(households, eq(households.id, users.householdId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  if (row.session.expiresAt.getTime() - now.getTime() < REFRESH_WHEN_DAYS_LEFT * 86_400_000) {
    // Rolling sessions: stay signed in on phones that are used regularly.
    await ctx.db
      .update(sessions)
      .set({ expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000) })
      .where(eq(sessions.tokenHash, tokenHash));
  }
  return { user: row.user, household: row.household };
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireAdmin(req: FastifyRequest): Auth {
  const auth = requireAuth(req);
  if (auth.user.role !== 'admin') throw forbidden('Only admins can do that.');
  return auth;
}

/** Simple in-memory limiter for failed sign-ins: 10 failures per 15 minutes per IP and email. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    private max = 10,
    private windowMs = 15 * 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(key, list);
    return list;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
