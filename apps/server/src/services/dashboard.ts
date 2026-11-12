/**
 * Dashboard numbers: calories per person per day with 7- and 30-day averages, what was binned
 * (by week or month, item and category, and its value when pricing is on), and spending from receipts.
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  addDays,
  averageKcal,
  type CalendarDate,
  type CalorieStatsDto,
  changePercent,
  nextPeriod,
  periodLabel,
  periodStarts,
  previousPeriod,
  samePointInPrevious,
  type SpendingDto,
  type StatsPeriod,
  type WasteReportDto,
} from '@snackoverflow/shared';
import type { Auth } from '../context';
import type { Db } from '../db/client';
import { ingredients, products, receiptLines, receipts, stockEvents, users } from '../db/schema';
import { forbidden, notFound } from '../http';
import { listPlan } from './planner';
import { ingredientPrices, latestPrices } from './pricing';
import { householdToday } from './stock';

const PERIODS: Record<StatsPeriod, number> = { week: 8, month: 6 };

/** "me", "household" or a person's id. Members can see themselves and the household; admins can see anyone. */
export async function calorieStats(db: Db, auth: Auth, now: Date, who: string): Promise<CalorieStatsDto> {
  let personId: string | null = auth.user.id;
  let name = auth.user.name;
  let target = auth.user.kcalTarget ?? null;
  if (who === 'household') {
    personId = null;
    name = 'Household';
    target = null;
  } else if (who !== 'me' && who !== auth.user.id) {
    if (auth.user.role !== 'admin') throw forbidden("Only admins can see other people's calories.");
    const [u] = await db.select().from(users).where(and(eq(users.id, who), eq(users.householdId, auth.household.id)));
    if (!u) throw notFound('No such person.');
    personId = u.id;
    name = u.name;
    target = u.kcalTarget ?? null;
  }
  const today = householdToday(auth, now);
  const plan = await listPlan(db, auth, addDays(today, -29), today, personId);
  const days = plan.days.map((d) => ({ date: d.date, kcal: d.entries.filter((e) => e.status === 'cooked').reduce((s, e) => s + (e.kcal ?? 0), 0) }));
  const byDate = new Map(days.map((d) => [d.date, d.kcal]));
  return { personId, name, target, today, days, avg7: averageKcal(byDate, today, 7), avg30: averageKcal(byDate, today, 29) };
}

function periodIndex(starts: CalendarDate[], period: StatsPeriod, day: CalendarDate): number {
  for (let i = starts.length - 1; i >= 0; i--) if (day >= starts[i]! && day < nextPeriod(starts[i]!, period)) return i;
  return -1;
}

const localDay = (auth: Auth, col: typeof stockEvents.createdAt | typeof receipts.createdAt) => sql<string>`((${col} AT TIME ZONE ${auth.household.timeZone})::date)::text`;

export async function wasteReport(db: Db, auth: Auth, now: Date, pricing: boolean, period: StatsPeriod): Promise<WasteReportDto> {
  const today = householdToday(auth, now);
  const starts = periodStarts(today, period, PERIODS[period]);
  // One period further back, for the "down 40%" comparison.
  const rangeStart = previousPeriod(starts[0]!, period);
  const day = localDay(auth, stockEvents.createdAt);
  const rows = await db
    .select({
      day,
      grams: stockEvents.grams,
      fraction: stockEvents.fraction,
      productId: stockEvents.productId,
      name: products.name,
      packGrams: products.packGrams,
      ingredientId: products.ingredientId,
      ingredientName: ingredients.name,
      aisle: ingredients.aisle,
    })
    .from(stockEvents)
    .innerJoin(products, eq(products.id, stockEvents.productId))
    .leftJoin(ingredients, eq(ingredients.id, products.ingredientId))
    .where(
      and(
        eq(stockEvents.householdId, auth.household.id),
        eq(stockEvents.type, 'discard'),
        isNull(stockEvents.undoneAt),
        gte(sql`(${stockEvents.createdAt} AT TIME ZONE ${auth.household.timeZone})::date`, sql`${rangeStart}::date`),
      ),
    );
  const [latest, byIngredient] = pricing ? await Promise.all([latestPrices(db, auth.household.id), ingredientPrices(db, auth.household.id)]) : [new Map(), new Map()];
  const valued = rows.map((r) => {
    const grams = r.grams ?? (r.fraction != null && r.packGrams ? r.fraction * r.packGrams : 0);
    let pence: number | null = null;
    if (pricing) {
      const own = latest.get(r.productId);
      if (own && r.packGrams) pence = (own.pricePence / r.packGrams) * grams;
      else if (own && r.fraction != null) pence = own.pricePence * r.fraction;
      else if (r.ingredientId && byIngredient.get(r.ingredientId)) pence = byIngredient.get(r.ingredientId)!.pencePerGram * grams;
    }
    return { ...r, day: r.day as CalendarDate, grams, pence };
  });
  const sumPence = (xs: { pence: number | null }[]) => (pricing && xs.some((x) => x.pence !== null) ? Math.round(xs.reduce((s, x) => s + (x.pence ?? 0), 0)) : null);

  const periods = starts.map((start, i) => {
    const inIt = valued.filter((v) => periodIndex(starts, period, v.day) === i);
    return { start, label: periodLabel(start, period, today), grams: Math.round(inIt.reduce((s, v) => s + v.grams, 0)), pence: sumPence(inIt), items: inIt.length };
  });
  const current = starts[starts.length - 1]!;
  const prev = samePointInPrevious(current, period, today);
  const prevGrams = valued.filter((v) => v.day >= prev.from && v.day < prev.to).reduce((s, v) => s + v.grams, 0);
  const inCurrent = valued.filter((v) => v.day >= current);

  const group = (key: (v: (typeof valued)[number]) => string) => {
    const map = new Map<string, (typeof valued)[number][]>();
    for (const v of inCurrent) map.set(key(v), [...(map.get(key(v)) ?? []), v]);
    return [...map.entries()]
      .map(([name, xs]) => ({ name, grams: Math.round(xs.reduce((s, x) => s + x.grams, 0)), pence: sumPence(xs), items: xs.length }))
      .sort((a, b) => b.grams - a.grams || b.items - a.items);
  };
  return {
    period,
    pricing,
    periods,
    changePercent: changePercent(periods[periods.length - 1]!.grams, prevGrams),
    byItem: group((v) => v.name ?? v.ingredientName ?? 'Unnamed product').slice(0, 10),
    byCategory: group((v) => v.aisle ?? 'Other').map(({ name, grams, pence }) => ({ name, grams, pence })),
  };
}

export async function spending(db: Db, auth: Auth, now: Date, period: StatsPeriod): Promise<SpendingDto> {
  const today = householdToday(auth, now);
  const starts = periodStarts(today, period, PERIODS[period]);
  const rangeStart = previousPeriod(starts[0]!, period);
  const rows = await db
    .select({
      id: receipts.id,
      day: sql<string>`coalesce(${receipts.purchasedOn}::text, ${localDay(auth, receipts.createdAt)})`,
      pence: sql<number>`coalesce(sum(${receiptLines.pricePence}) filter (where not ${receiptLines.skip}), 0)`,
    })
    .from(receipts)
    .leftJoin(receiptLines, eq(receiptLines.receiptId, receipts.id))
    .where(and(eq(receipts.householdId, auth.household.id), eq(receipts.status, 'done')))
    .groupBy(receipts.id);
  const shops = rows.map((r) => ({ day: r.day as CalendarDate, pence: Number(r.pence) })).filter((r) => r.day >= rangeStart);
  const periods = starts.map((start, i) => {
    const inIt = shops.filter((s) => periodIndex(starts, period, s.day) === i);
    return { start, label: periodLabel(start, period, today), pence: inIt.reduce((s, x) => s + x.pence, 0), receipts: inIt.length };
  });
  const prev = samePointInPrevious(starts[starts.length - 1]!, period, today);
  const prevPence = shops.filter((s) => s.day >= prev.from && s.day < prev.to).reduce((s, x) => s + x.pence, 0);
  return { period, periods, changePercent: changePercent(periods[periods.length - 1]!.pence, prevPence) };
}
