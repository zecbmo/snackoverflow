/**
 * Scheduled notifications for phase 1:
 * - Expires tomorrow: daily at 9am, push, with Use / Freeze / Binned buttons.
 * - Going off this week: Sundays at 10am, push and email.
 * Each user picks channels per type and quiet hours. Each notification is sent
 * once (notification_log); if the server was down at the time it goes out on
 * the next tick that day.
 */
import { and, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import {
  addDays,
  bestBeforeLabel,
  type Channel,
  DEFAULT_NOTIFICATION_PREFS,
  formatShortDate,
  type NotificationPrefs,
  type MealSlot,
  SLOT_TIMES,
  wallClockIn,
} from '@snackoverflow/shared';
import type { AppContext } from '../context';
import { households, locations, mealPlanEntries, mealPlanPeople, notificationLog, notifications, products, pushSubscriptions, recipes, stockItems, users } from '../db/schema';
import { runningLow } from '../services/shopping';
import { escapeHtml } from './email';
import type { PushPayload } from './push';

type DigestType = 'expiresTomorrow' | 'weeklySummary';

export const SCHEDULE: Record<DigestType, { hour: number; weekday?: number }> = {
  expiresTomorrow: { hour: 9 },
  weeklySummary: { hour: 10, weekday: 0 },
};

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function inQuietHours(prefs: NotificationPrefs, hour: number, minute: number): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const now = hour * 60 + minute;
  const start = minutes(prefs.quietStart);
  const end = minutes(prefs.quietEnd);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function prefsOf(user: { notificationPrefs: NotificationPrefs | null }): NotificationPrefs {
  const p = user.notificationPrefs;
  return p ? { ...DEFAULT_NOTIFICATION_PREFS, ...p, channels: { ...DEFAULT_NOTIFICATION_PREFS.channels, ...p.channels } } : DEFAULT_NOTIFICATION_PREFS;
}

interface DueItem {
  id: string;
  name: string;
  location: string;
  state: string;
  bestBefore: string;
  freezable: boolean;
}

async function itemsDue(ctx: AppContext, householdId: string, from: string, to: string): Promise<DueItem[]> {
  const rows = await ctx.db
    .select({
      id: stockItems.id,
      name: products.name,
      location: locations.name,
      state: stockItems.state,
      bestBefore: stockItems.bestBefore,
    })
    .from(stockItems)
    .innerJoin(products, eq(products.id, stockItems.productId))
    .innerJoin(locations, eq(locations.id, stockItems.locationId))
    .where(
      and(
        eq(stockItems.householdId, householdId),
        isNull(stockItems.finishedAt),
        ne(stockItems.state, 'frozen'),
        gte(stockItems.bestBefore, from),
        lte(stockItems.bestBefore, to),
      ),
    )
    .orderBy(stockItems.bestBefore);
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? 'Unnamed product',
    location: r.location,
    state: r.state,
    bestBefore: r.bestBefore as string,
    freezable: r.state !== 'defrosted',
  }));
}

async function alreadySent(ctx: AppContext, userId: string, type: string, key: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ key: notificationLog.key })
    .from(notificationLog)
    .where(and(eq(notificationLog.userId, userId), eq(notificationLog.type, type), eq(notificationLog.key, key)))
    .limit(1);
  return Boolean(row);
}

async function markSent(ctx: AppContext, userId: string, type: string, key: string) {
  await ctx.db.insert(notificationLog).values({ userId, type, key }).onConflictDoNothing();
}

/** Send a push to every device a user has subscribed; drop subscriptions the browser has discarded. */
export async function pushToUser(ctx: AppContext, userId: string, payload: PushPayload): Promise<number> {
  if (!ctx.push) return 0;
  const subs = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  let sent = 0;
  for (const s of subs) {
    const outcome = await ctx.push.send(s, payload);
    if (outcome === 'sent') sent++;
    if (outcome === 'gone') await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
  }
  return sent;
}

function expiresTomorrowPushes(items: DueItem[]): PushPayload[] {
  if (items.length === 0) return [];
  if (items.length <= 3) {
    return items.map((i) => ({
      title: `${i.name} goes off tomorrow`,
      body: `${i.location}${i.state === 'opened' ? ' · opened' : ''}. Use it, freeze it or bin it.`,
      url: `/stock/${i.id}`,
      tag: `expires-${i.id}`,
      actions: [
        { action: 'use', title: 'Used it' },
        ...(i.freezable ? [{ action: 'freeze', title: 'Freeze' }] : []),
        { action: 'discard', title: 'Binned' },
      ],
      data: { stockItemId: i.id },
    }));
  }
  return [
    {
      title: `${items.length} things go off tomorrow`,
      body: items.map((i) => i.name).join(', '),
      url: '/stock',
      tag: 'expires-tomorrow',
    },
  ];
}

function weeklySummary(items: DueItem[], today: string, appUrl: string) {
  const lines = items.map((i) => `${i.name} (${bestBeforeLabel(i.bestBefore, today).toLowerCase()}, ${i.location})`);
  const push: PushPayload = {
    title: items.length === 1 ? '1 thing goes off this week' : `${items.length} things go off this week`,
    body: lines.slice(0, 4).join(', ') + (lines.length > 4 ? ` and ${lines.length - 4} more` : ''),
    url: '/stock',
    tag: 'weekly-summary',
  };
  const text = [
    'Going off this week:',
    '',
    ...items.map((i) => `- ${i.name}: ${formatShortDate(i.bestBefore)} (${i.location})`),
    '',
    `See your stock: ${appUrl}/stock`,
  ].join('\n');
  const html = `<h2 style="font-family:sans-serif">Going off this week</h2><ul style="font-family:sans-serif">${items
    .map((i) => `<li><strong>${escapeHtml(i.name)}</strong>: ${formatShortDate(i.bestBefore)} (${escapeHtml(i.location)})</li>`)
    .join('')}</ul><p style="font-family:sans-serif"><a href="${escapeHtml(appUrl)}/stock">See your stock</a></p>`;
  return { push, email: { subject: push.title, text, html } };
}

export interface NotificationRunStats {
  app: number;
  push: number;
  email: number;
}

function add(total: NotificationRunStats, more: NotificationRunStats) {
  total.app += more.app;
  total.push += more.push;
  total.email += more.email;
}

/**
 * Send one notification to a person on the channels they picked:
 * app = the in-app inbox (the bell, and the Android app checks it), push = Web Push, email.
 */
export async function deliver(
  ctx: AppContext,
  user: { id: string; email: string; householdId: string },
  channels: Channel[],
  type: string,
  payload: PushPayload,
  email?: { subject: string; text: string; html?: string },
): Promise<NotificationRunStats> {
  const stats: NotificationRunStats = { app: 0, push: 0, email: 0 };
  if (channels.includes('app')) {
    await ctx.db.insert(notifications).values({
      userId: user.id,
      type,
      title: payload.title,
      body: payload.body,
      url: payload.url ?? null,
      actions: payload.actions ?? null,
      data: payload.data ?? null,
      createdAt: ctx.now(),
    });
    ctx.live.publish(user.householdId, 'notifications');
    stats.app++;
  }
  if (channels.includes('push')) stats.push += await pushToUser(ctx, user.id, payload);
  if (channels.includes('email') && email && ctx.mailer) {
    try {
      await ctx.mailer.send({ to: user.email, ...email });
      stats.email++;
    } catch {
      // Email is optional; a failure must not stop the rest.
    }
  }
  return stats;
}

/** One scheduler tick: send anything that is due and not yet sent. */
export async function runNotifications(ctx: AppContext, now: Date = ctx.now()): Promise<NotificationRunStats> {
  const stats: NotificationRunStats = { app: 0, push: 0, email: 0 };
  const allHouseholds = await ctx.db.select().from(households);
  for (const h of allHouseholds) {
    const clock = wallClockIn(h.timeZone, now);
    const members = await ctx.db.select().from(users).where(eq(users.householdId, h.id));
    for (const type of Object.keys(SCHEDULE) as DigestType[]) {
      const when = SCHEDULE[type];
      if (clock.hour < when.hour) continue;
      if (when.weekday !== undefined && clock.weekday !== when.weekday) continue;
      const key = clock.date;
      let items: DueItem[] | null = null;
      for (const user of members) {
        const prefs = prefsOf(user);
        const channels: Channel[] = prefs.channels[type] ?? [];
        if (channels.length === 0) continue;
        if (inQuietHours(prefs, clock.hour, clock.minute)) continue;
        if (await alreadySent(ctx, user.id, type, key)) continue;
        items ??=
          type === 'expiresTomorrow'
            ? await itemsDue(ctx, h.id, addDays(clock.date, 1), addDays(clock.date, 1))
            : await itemsDue(ctx, h.id, clock.date, addDays(clock.date, 7));
        if (items.length > 0) {
          if (type === 'expiresTomorrow') {
            for (const p of expiresTomorrowPushes(items)) add(stats, await deliver(ctx, user, channels, type, p));
          } else {
            const msg = weeklySummary(items, clock.date, ctx.config.APP_URL.replace(/\/$/, ''));
            add(stats, await deliver(ctx, user, channels, type, msg.push, msg.email));
          }
        }
        await markSent(ctx, user.id, type, key);
      }
    }
    add(stats, await mealTimePrompts(ctx, h, members, clock));
    if (clock.hour >= RUNNING_LOW_HOUR) add(stats, await runningLowReminders(ctx, h, members, clock, now));
  }
  return stats;
}

const SLOT_WORDS: Record<MealSlot, string> = { breakfast: 'this morning', lunch: 'for lunch', dinner: 'tonight', snack: 'today' };
const RUNNING_LOW_HOUR = 10;

/** "Cooking Fish pie tonight?" at the meal's usual time, with Cooked it / Skip / Move. */
async function mealTimePrompts(
  ctx: AppContext,
  h: { id: string; timeZone: string },
  members: (typeof users.$inferSelect)[],
  clock: { date: string; hour: number; minute: number },
): Promise<NotificationRunStats> {
  const stats: NotificationRunStats = { app: 0, push: 0, email: 0 };
  const due = await ctx.db
    .select({ entry: mealPlanEntries, title: recipes.title, serves: recipes.serves })
    .from(mealPlanEntries)
    .innerJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(and(eq(mealPlanEntries.householdId, h.id), eq(mealPlanEntries.date, clock.date), eq(mealPlanEntries.status, 'planned'), eq(mealPlanEntries.kind, 'recipe')));
  const now = clock.hour * 60 + clock.minute;
  for (const { entry, title } of due) {
    const at = SLOT_TIMES[entry.slot];
    const start = at.hour * 60 + at.minute;
    // Only around the meal: from its time to three hours after.
    if (now < start || now > start + 180) continue;
    const eaters = await ctx.db.select({ userId: mealPlanPeople.userId }).from(mealPlanPeople).where(eq(mealPlanPeople.entryId, entry.id));
    const recipients = eaters.length ? members.filter((m) => eaters.some((e) => e.userId === m.id)) : members;
    for (const user of recipients) {
      const prefs = prefsOf(user);
      const channels: Channel[] = prefs.channels.mealTime ?? [];
      if (!channels.length || inQuietHours(prefs, clock.hour, clock.minute)) continue;
      if (await alreadySent(ctx, user.id, 'mealTime', entry.id)) continue;
      add(
        stats,
        await deliver(ctx, user, channels, 'mealTime', {
          title: `Cooking ${title} ${SLOT_WORDS[entry.slot]}?`,
          body: `${entry.slot.charAt(0).toUpperCase()}${entry.slot.slice(1)} · ${entry.servings} ${entry.servings === 1 ? 'serving' : 'servings'}`,
          url: `/calendar?date=${entry.date}`,
          tag: `meal-${entry.id}`,
          actions: [
            { action: 'cooked', title: 'Cooked it' },
            { action: 'skip', title: 'Skip' },
            { action: 'move', title: 'Move' },
          ],
          data: { entryId: entry.id, recipeId: entry.recipeId },
        }),
      );
      await markSent(ctx, user.id, 'mealTime', entry.id);
    }
  }
  return stats;
}

/** Staples running low: one reminder per staple per week. */
async function runningLowReminders(
  ctx: AppContext,
  h: { id: string; timeZone: string; name: string; createdAt: Date },
  members: (typeof users.$inferSelect)[],
  clock: { date: string; hour: number; minute: number },
  now: Date,
): Promise<NotificationRunStats> {
  const stats: NotificationRunStats = { app: 0, push: 0, email: 0 };
  const listeners = members.filter((m) => (prefsOf(m).channels.runningLow ?? []).length > 0);
  if (!listeners.length) return stats;
  const anyone = members[0];
  if (!anyone) return stats;
  const low = (await runningLow(ctx.db, { user: anyone, household: h as typeof households.$inferSelect }, now)).filter((l) => !l.onList);
  if (!low.length) return stats;
  const week = Math.floor(Date.parse(`${clock.date}T00:00:00Z`) / (7 * 86_400_000));
  for (const user of listeners) {
    const prefs = prefsOf(user);
    if (inQuietHours(prefs, clock.hour, clock.minute)) continue;
    const fresh = [];
    for (const l of low) if (!(await alreadySent(ctx, user.id, 'runningLow', `${l.ingredientId}:${week}`))) fresh.push(l);
    if (!fresh.length) continue;
    add(
      stats,
      await deliver(ctx, user, prefs.channels.runningLow ?? [], 'runningLow', {
        title: 'Running low',
        body: `${fresh.map((l) => l.name).join(', ')}. Add ${fresh.length === 1 ? 'it' : 'them'} to the shopping list?`,
        url: '/shop',
        tag: 'running-low',
      }),
    );
    for (const l of fresh) await markSent(ctx, user.id, 'runningLow', `${l.ingredientId}:${week}`);
  }
  return stats;
}
