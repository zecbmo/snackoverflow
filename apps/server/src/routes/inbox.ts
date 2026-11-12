/** The in-app notification inbox (the bell) and signed-in phones. */
import { and, asc, count, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceDto, NotificationDto, NotificationListDto } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';
import { devices, notifications } from '../db/schema';
import { notFound, parse } from '../http';

const listQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const readInput = z.object({ ids: z.array(z.uuid()).max(500).optional() });

type Row = typeof notifications.$inferSelect;
const dto = (n: Row): NotificationDto => ({
  id: n.id,
  seq: n.seq,
  type: n.type,
  title: n.title,
  body: n.body,
  url: n.url,
  actions: n.actions ?? [],
  data: n.data ?? {},
  createdAt: n.createdAt.toISOString(),
  readAt: n.readAt?.toISOString() ?? null,
});

export async function inboxRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /**
   * Without `after`: the latest notifications, newest first (the bell).
   * With `after`: everything newer than that seq, oldest first (the phone's background check).
   */
  app.get('/api/notifications', async (req): Promise<NotificationListDto> => {
    const auth = requireAuth(req);
    const q = parse(listQuery, req.query);
    const mine = eq(notifications.userId, auth.user.id);
    const items =
      q.after !== undefined
        ? await ctx.db.select().from(notifications).where(and(mine, gt(notifications.seq, q.after))).orderBy(asc(notifications.seq)).limit(q.limit)
        : await ctx.db.select().from(notifications).where(mine).orderBy(desc(notifications.seq)).limit(q.limit);
    const [stats] = await ctx.db
      .select({ top: max(notifications.seq) })
      .from(notifications)
      .where(mine);
    const [unread] = await ctx.db.select({ n: count() }).from(notifications).where(and(mine, isNull(notifications.readAt)));
    return { items: items.map(dto), unread: unread?.n ?? 0, cursor: Number(stats?.top ?? 0) };
  });

  app.post('/api/notifications/read', async (req) => {
    const auth = requireAuth(req);
    const { ids } = parse(readInput, req.body);
    const mine = and(eq(notifications.userId, auth.user.id), isNull(notifications.readAt));
    await ctx.db
      .update(notifications)
      .set({ readAt: ctx.now() })
      .where(ids?.length ? and(mine, inArray(notifications.id, ids)) : mine);
    ctx.live.publish(auth.household.id, 'notifications');
    return { ok: true };
  });

  app.get('/api/devices', async (req): Promise<DeviceDto[]> => {
    const auth = requireAuth(req);
    const rows = await ctx.db.select().from(devices).where(eq(devices.userId, auth.user.id)).orderBy(desc(devices.lastSeenAt));
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      lastSeenAt: d.lastSeenAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
      current: d.id === auth.deviceId,
    }));
  });

  /** Sign a phone out remotely (e.g. a lost phone). */
  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req) => {
    const auth = requireAuth(req);
    const gone = await ctx.db
      .delete(devices)
      .where(and(eq(devices.id, req.params.id), eq(devices.userId, auth.user.id)))
      .returning({ id: devices.id });
    if (gone.length === 0) throw notFound('No such device.');
    return { ok: true };
  });
}
