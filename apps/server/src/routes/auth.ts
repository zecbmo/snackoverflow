import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { acceptInviteInput, appCodeInput, loginInput, setupInput, type SessionDto, todayIn } from '@snackoverflow/shared';
import { hashPassword, hashToken, newToken, verifyPassword } from '../auth/crypto';
import { createDevice, createSession, destroySession, LoginLimiter, requireAuth } from '../auth/session';
import { backupsEnabled } from '../backup';
import type { AppContext, Auth } from '../context';
import { appLoginCodes, devices, households, invites, users } from '../db/schema';
import { conflict, forbidden, HttpError, notFound, parse, unauthorized } from '../http';
import { createFirstAdmin, getUserByEmail, householdDto, theHousehold, userCount, userDto } from '../services/household';

export function features(ctx: AppContext): SessionDto['features'] {
  const c = ctx.config;
  return {
    push: Boolean(ctx.push),
    vapidPublicKey: ctx.push?.publicKey ?? null,
    email: Boolean(ctx.mailer),
    oidc: {
      enabled: Boolean(c.OIDC_ISSUER_URL && c.OIDC_CLIENT_ID),
      displayName: c.OIDC_DISPLAY_NAME,
      allowPassword: !(c.OIDC_ISSUER_URL && c.OIDC_CLIENT_ID) || c.OIDC_ALLOW_PASSWORD_LOGIN,
    },
    backups: backupsEnabled(c),
    receiptEmail: Boolean(c.RECEIPT_IMAP_HOST),
    ai: Boolean(c.AI_API_KEY),
    mcp: Boolean(c.MCP_TOKEN),
  };
}

export function sessionDto(ctx: AppContext, auth: Auth): SessionDto {
  return {
    user: userDto(auth.user),
    household: householdDto(auth.household, ctx.config.PRICING_ENABLED),
    features: features(ctx),
    today: todayIn(auth.household.timeZone, ctx.now()),
  };
}

async function findInvite(ctx: AppContext, token: string) {
  const [inv] = await ctx.db
    .select({ invite: invites, householdName: households.name })
    .from(invites)
    .innerJoin(households, eq(households.id, invites.householdId))
    .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.usedAt), gt(invites.expiresAt, ctx.now())))
    .limit(1);
  return inv ?? null;
}

const OIDC_COOKIE = 'so_oidc';
/** Deep-link scheme the Android app registers. */
export const APP_SCHEME = 'snackoverflow';

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const limiter = new LoginLimiter();
  let oidcConfig: Promise<oidc.Configuration> | null = null;
  const getOidc = () => {
    const c = ctx.config;
    if (!c.OIDC_ISSUER_URL || !c.OIDC_CLIENT_ID) throw notFound('Single sign-on is not set up.');
    oidcConfig ??= oidc.discovery(new URL(c.OIDC_ISSUER_URL), c.OIDC_CLIENT_ID, c.OIDC_CLIENT_SECRET).catch((e) => {
      oidcConfig = null;
      throw new HttpError(502, `Couldn't reach the sign-in provider: ${(e as Error).message}`);
    });
    return oidcConfig;
  };
  const passwordAllowed = () => features(ctx).oidc.allowPassword;

  app.get('/api/auth/status', async () => ({
    needsSetup: (await userCount(ctx.db)) === 0,
    oidc: features(ctx).oidc,
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    const input = parse(setupInput, req.body);
    if ((await userCount(ctx.db)) > 0) throw conflict('Snack Overflow is already set up. Sign in instead.');
    const user = await createFirstAdmin(ctx, { ...input });
    await createSession(ctx, reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!passwordAllowed()) throw forbidden('Use single sign-on to sign in.');
    const input = parse(loginInput, req.body);
    const key = `${req.ip}|${input.email}`;
    if (limiter.blocked(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const user = await getUserByEmail(ctx.db, input.email);
    const ok = await verifyPassword(input.password, user?.passwordHash);
    if (!user || !ok) {
      limiter.fail(key);
      throw unauthorized("That email and password don't match.");
    }
    limiter.reset(key);
    if (input.device) {
      // Phones get a device token instead of a cookie.
      const { token } = await createDevice(ctx, user.id, input.device);
      return { ok: true, token };
    }
    await createSession(ctx, reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth?.deviceId) {
      await ctx.db.delete(devices).where(eq(devices.id, req.auth.deviceId));
      return { ok: true };
    }
    await destroySession(ctx, req, reply);
    return { ok: true };
  });

  /** The app swaps the one-time code from a single sign-on login for its device token. */
  app.post('/api/auth/app-code', async (req) => {
    const input = parse(appCodeInput, req.body);
    const [row] = await ctx.db
      .delete(appLoginCodes)
      .where(eq(appLoginCodes.codeHash, hashToken(input.code)))
      .returning();
    if (!row || row.expiresAt < ctx.now()) throw unauthorized('That sign-in link has expired. Please try again.');
    const { token } = await createDevice(ctx, row.userId, input.device);
    return { ok: true, token };
  });

  app.get('/api/session', async (req) => sessionDto(ctx, requireAuth(req)));

  app.get<{ Params: { token: string } }>('/api/invites/:token', async (req) => {
    const inv = await findInvite(ctx, req.params.token);
    if (!inv) throw notFound('This invite has expired or been used. Ask for a new one.');
    return { email: inv.invite.email, role: inv.invite.role, householdName: inv.householdName, passwordAllowed: passwordAllowed() };
  });

  app.post<{ Params: { token: string } }>('/api/invites/:token/accept', async (req, reply) => {
    const input = parse(acceptInviteInput, req.body);
    const inv = await findInvite(ctx, req.params.token);
    if (!inv) throw notFound('This invite has expired or been used. Ask for a new one.');
    if (await getUserByEmail(ctx.db, input.email)) throw conflict('Someone already uses that email. Sign in instead.');
    const user = await ctx.db.transaction(async (tx) => {
      await tx.update(invites).set({ usedAt: ctx.now() }).where(eq(invites.id, inv.invite.id));
      const [u] = await tx
        .insert(users)
        .values({
          householdId: inv.invite.householdId,
          name: input.name,
          email: input.email,
          role: inv.invite.role,
          passwordHash: await hashPassword(input.password),
        })
        .returning();
      return u;
    });
    if (!user) throw new Error('Could not create the user');
    ctx.live.publish(inv.invite.householdId, 'users');
    await createSession(ctx, reply, user.id);
    return { ok: true };
  });

  // --- Single sign-on (OpenID Connect) ---------------------------------------
  const redirectUri = () => `${ctx.config.APP_URL.replace(/\/$/, '')}/api/auth/oidc/callback`;

  app.get<{ Querystring: { invite?: string; app?: string } }>('/api/auth/oidc/start', async (req, reply) => {
    const config = await getOidc();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(),
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
    });
    reply.setCookie(OIDC_COOKIE, JSON.stringify({ verifier, state, invite: req.query.invite ?? null, app: req.query.app === '1' }), {
      path: '/api/auth/oidc',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.secureCookies,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`/login?error=${encodeURIComponent(msg)}`);
    const raw = req.cookies[OIDC_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(OIDC_COOKIE, { path: '/api/auth/oidc' });
    if (!unsigned?.valid || !unsigned.value) return fail('Sign-in timed out. Please try again.');
    const saved = JSON.parse(unsigned.value) as { verifier: string; state: string; invite: string | null; app?: boolean };
    let claims: oidc.IDToken | undefined;
    try {
      const config = await getOidc();
      const current = new URL(req.url, ctx.config.APP_URL);
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: saved.verifier,
        expectedState: saved.state,
      });
      claims = tokens.claims();
    } catch {
      return fail("Sign-in didn't work. Please try again.");
    }
    if (!claims?.sub) return fail("Sign-in didn't work. Please try again.");
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const name = (typeof claims.name === 'string' && claims.name) || (typeof claims.preferred_username === 'string' && claims.preferred_username) || email?.split('@')[0] || 'New user';

    let [user] = await ctx.db.select().from(users).where(eq(users.oidcSubject, claims.sub)).limit(1);
    if (!user && email) {
      const byEmail = await getUserByEmail(ctx.db, email);
      if (byEmail) {
        [user] = await ctx.db.update(users).set({ oidcSubject: claims.sub }).where(eq(users.id, byEmail.id)).returning();
      }
    }
    if (!user && (await userCount(ctx.db)) === 0 && email) {
      user = await createFirstAdmin(ctx, { householdName: ctx.config.HOUSEHOLD_NAME ?? 'Our household', name, email, password: null, oidcSubject: claims.sub });
    }
    if (!user && saved.invite && email) {
      const inv = await findInvite(ctx, saved.invite);
      const household = await theHousehold(ctx.db);
      if (inv && household) {
        await ctx.db.update(invites).set({ usedAt: ctx.now() }).where(eq(invites.id, inv.invite.id));
        [user] = await ctx.db
          .insert(users)
          .values({ householdId: inv.invite.householdId, name, email, role: inv.invite.role, oidcSubject: claims.sub })
          .returning();
      }
    }
    if (!user) return fail("You don't have an account here yet. Ask an admin for an invite.");
    if (saved.app) {
      // Hand the login back to the Android app with a short-lived one-time code.
      const code = newToken();
      await ctx.db.insert(appLoginCodes).values({ codeHash: hashToken(code), userId: user.id, expiresAt: new Date(ctx.now().getTime() + 120_000) });
      return reply.redirect(`${APP_SCHEME}://auth?code=${encodeURIComponent(code)}`);
    }
    await createSession(ctx, reply, user.id);
    return reply.redirect('/');
  });

}
