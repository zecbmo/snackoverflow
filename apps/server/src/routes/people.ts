import { and, count, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createInviteInput,
  DEFAULT_NOTIFICATION_PREFS,
  type InviteDto,
  type NotificationSettingsDto,
  notificationPrefsInput,
  pushSubscriptionInput,
  updateHouseholdInput,
  updateMeInput,
  updateUserInput,
} from '@snackoverflow/shared';
import { hashPassword, hashToken, newToken, verifyPassword } from '../auth/crypto';
import { requireAdmin, requireAuth } from '../auth/session';
import { devices, households, invites, pushSubscriptions, sessions, users } from '../db/schema';
import { badRequest, conflict, notFound, parse } from '../http';
import { escapeHtml } from '../notify/email';
import { deliver, prefsOf } from '../notify/notifications';
import { getUserByEmail, householdDto, userDto } from '../services/household';

const INVITE_DAYS = 7;

export async function peopleRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const appUrl = () => ctx.config.APP_URL.replace(/\/$/, '');

  // --- Household --------------------------------------------------------------
  app.get('/api/household', async (req) => householdDto(requireAuth(req).household, ctx.config.PRICING_ENABLED));

  app.patch('/api/household', async (req) => {
    const auth = requireAdmin(req);
    const { settings, ...input } = parse(updateHouseholdInput, req.body);
    const patch: Partial<typeof households.$inferInsert> = { ...input };
    if (settings) patch.settings = { ...(auth.household.settings ?? {}), ...settings };
    const [h] = await ctx.db.update(households).set(patch).where(eq(households.id, auth.household.id)).returning();
    if (!h) throw notFound();
    ctx.live.publish(h.id, 'household');
    return householdDto(h, ctx.config.PRICING_ENABLED);
  });

  // --- Users (admin) ------------------------------------------------------------
  app.get('/api/users', async (req) => {
    const auth = requireAuth(req);
    const rows = await ctx.db.select().from(users).where(eq(users.householdId, auth.household.id)).orderBy(users.createdAt);
    return rows.map(userDto);
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const auth = requireAdmin(req);
    const input = parse(updateUserInput, req.body);
    const [target] = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.id, req.params.id), eq(users.householdId, auth.household.id)));
    if (!target) throw notFound('No such person.');
    if (input.role === 'member' && target.role === 'admin') await ensureAnotherAdmin(auth.household.id, target.id);
    const [u] = await ctx.db.update(users).set(input).where(eq(users.id, target.id)).returning();
    ctx.live.publish(auth.household.id, 'users');
    return userDto(u!);
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const auth = requireAdmin(req);
    if (req.params.id === auth.user.id) throw badRequest("You can't remove yourself.");
    const [target] = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.id, req.params.id), eq(users.householdId, auth.household.id)));
    if (!target) throw notFound('No such person.');
    if (target.role === 'admin') await ensureAnotherAdmin(auth.household.id, target.id);
    await ctx.db.delete(users).where(eq(users.id, target.id));
    ctx.live.publish(auth.household.id, 'users');
    return { ok: true };
  });

  async function ensureAnotherAdmin(householdId: string, exceptUserId: string) {
    const [row] = await ctx.db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.householdId, householdId), eq(users.role, 'admin'), ne(users.id, exceptUserId)));
    if (!row?.n) throw badRequest('The household needs at least one admin.');
  }

  // --- Invites (admin) ------------------------------------------------------------
  app.get('/api/invites', async (req) => {
    const auth = requireAdmin(req);
    const rows = await ctx.db
      .select()
      .from(invites)
      .where(and(eq(invites.householdId, auth.household.id), isNull(invites.usedAt), gt(invites.expiresAt, ctx.now())))
      .orderBy(desc(invites.createdAt));
    // The token is only shown once, when the invite is made.
    return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, url: null, expiresAt: r.expiresAt.toISOString() }));
  });

  app.post('/api/invites', async (req): Promise<InviteDto & { emailed: boolean }> => {
    const auth = requireAdmin(req);
    const input = parse(createInviteInput, req.body);
    if (input.email && (await getUserByEmail(ctx.db, input.email))) throw conflict('Someone already uses that email.');
    const token = newToken();
    const expiresAt = new Date(ctx.now().getTime() + INVITE_DAYS * 86_400_000);
    const [inv] = await ctx.db
      .insert(invites)
      .values({
        householdId: auth.household.id,
        tokenHash: hashToken(token),
        email: input.email ?? null,
        role: input.role,
        createdBy: auth.user.id,
        expiresAt,
      })
      .returning();
    const url = `${appUrl()}/invite/${token}`;
    let emailed = false;
    if (input.email && ctx.mailer) {
      try {
        await ctx.mailer.send({
          to: input.email,
          subject: `${auth.user.name} invited you to Snack Overflow`,
          text: `${auth.user.name} has invited you to join ${auth.household.name} on Snack Overflow.\n\nAccept the invite: ${url}\n\nThe link works for ${INVITE_DAYS} days.`,
          html: `<p style="font-family:sans-serif">${escapeHtml(auth.user.name)} has invited you to join <strong>${escapeHtml(auth.household.name)}</strong> on Snack Overflow.</p><p style="font-family:sans-serif"><a href="${escapeHtml(url)}">Accept the invite</a></p><p style="font-family:sans-serif;color:#666">The link works for ${INVITE_DAYS} days.</p>`,
        });
        emailed = true;
      } catch {
        emailed = false;
      }
    }
    return { id: inv!.id, email: inv!.email, role: inv!.role, url, expiresAt: expiresAt.toISOString(), emailed };
  });

  app.delete<{ Params: { id: string } }>('/api/invites/:id', async (req) => {
    const auth = requireAdmin(req);
    await ctx.db.delete(invites).where(and(eq(invites.id, req.params.id), eq(invites.householdId, auth.household.id)));
    return { ok: true };
  });

  // --- Me -------------------------------------------------------------------------
  app.patch('/api/me', async (req) => {
    const auth = requireAuth(req);
    const input = parse(updateMeInput, req.body);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name) patch.name = input.name;
    if (input.email && input.email !== auth.user.email) {
      const other = await getUserByEmail(ctx.db, input.email);
      if (other && other.id !== auth.user.id) throw conflict('Someone already uses that email.');
      patch.email = input.email;
    }
    if (input.newPassword) {
      if (auth.user.passwordHash && !(await verifyPassword(input.currentPassword ?? '', auth.user.passwordHash))) {
        throw badRequest('Your current password is wrong.');
      }
      patch.passwordHash = await hashPassword(input.newPassword);
    }
    if (Object.keys(patch).length === 0) return userDto(auth.user);
    const [u] = await ctx.db.update(users).set(patch).where(eq(users.id, auth.user.id)).returning();
    if (input.newPassword) {
      // Sign out other browsers and phones after a password change.
      const current = auth.deviceId ? undefined : req.cookies.so_session;
      await ctx.db
        .delete(sessions)
        .where(and(eq(sessions.userId, auth.user.id), ne(sessions.tokenHash, current ? hashToken(current) : '')));
      await ctx.db
        .delete(devices)
        .where(and(eq(devices.userId, auth.user.id), ne(devices.id, auth.deviceId ?? '00000000-0000-0000-0000-000000000000')));
    }
    ctx.live.publish(auth.household.id, 'users');
    return userDto(u!);
  });

  // --- Notifications ----------------------------------------------------------------
  const settings = async (userId: string, prefs = DEFAULT_NOTIFICATION_PREFS): Promise<NotificationSettingsDto> => {
    const [row] = await ctx.db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    return { prefs, available: { app: true, push: Boolean(ctx.push), email: Boolean(ctx.mailer) }, pushSubscribed: row?.n ?? 0 };
  };

  app.get('/api/me/notifications', async (req) => {
    const auth = requireAuth(req);
    return settings(auth.user.id, prefsOf(auth.user));
  });

  app.put('/api/me/notifications', async (req) => {
    const auth = requireAuth(req);
    const prefs = parse(notificationPrefsInput, req.body);
    await ctx.db.update(users).set({ notificationPrefs: prefs }).where(eq(users.id, auth.user.id));
    return settings(auth.user.id, prefsOf({ notificationPrefs: prefs }));
  });

  app.post('/api/push/subscriptions', async (req) => {
    const auth = requireAuth(req);
    if (!ctx.push) throw badRequest('Push notifications are not set up on this server.');
    const sub = parse(pushSubscriptionInput, req.body);
    await ctx.db
      .insert(pushSubscriptions)
      .values({
        endpoint: sub.endpoint,
        userId: auth.user.id,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: auth.user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
    return { ok: true };
  });

  app.delete<{ Body: { endpoint?: string } }>('/api/push/subscriptions', async (req) => {
    const auth = requireAuth(req);
    const endpoint = req.body?.endpoint;
    if (!endpoint) throw badRequest('endpoint: Required');
    await ctx.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, auth.user.id)));
    return { ok: true };
  });

  app.post('/api/me/notifications/test', async (req) => {
    const auth = requireAuth(req);
    const sent = await deliver(ctx, auth.user, ['app', 'push'], 'test', {
      title: 'Snack Overflow',
      body: 'Notifications are working.',
      url: '/',
      tag: 'test',
    });
    const pushed = sent.push;
    let emailed = false;
    if (ctx.mailer) {
      try {
        await ctx.mailer.send({ to: auth.user.email, subject: 'Snack Overflow test', text: 'Email notifications are working.' });
        emailed = true;
      } catch {
        emailed = false;
      }
    }
    return { pushed, emailed };
  });
}
