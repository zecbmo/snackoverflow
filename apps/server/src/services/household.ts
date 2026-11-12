import { count, eq } from 'drizzle-orm';
import { DEFAULT_HOUSEHOLD_SETTINGS, DEFAULT_TIME_ZONE, type HouseholdDto, type HouseholdSettings, type UserDto } from '@snackoverflow/shared';
import { hashPassword } from '../auth/crypto';
import type { AppContext, HouseholdRow, UserRow } from '../context';
import type { Db } from '../db/client';
import { households, users } from '../db/schema';
import { seedHousehold, type SeedData } from '../db/seed';

export function userDto(u: UserRow): UserDto {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

/** The household's settings with defaults filled in. PRICING_ENABLED sets the starting value for pricing. */
export function householdSettings(h: Pick<HouseholdRow, 'settings'>, pricingDefault = false): HouseholdSettings {
  return { ...DEFAULT_HOUSEHOLD_SETTINGS, pricingEnabled: pricingDefault, ...(h.settings ?? {}) };
}

export function householdDto(h: HouseholdRow, pricingDefault = false): HouseholdDto {
  return { id: h.id, name: h.name, timeZone: h.timeZone, settings: householdSettings(h, pricingDefault) };
}

export async function userCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

/** A new household with the seed data and default locations. */
export async function createHousehold(db: Db, seed: SeedData, name: string, timeZone = DEFAULT_TIME_ZONE): Promise<HouseholdRow> {
  const [h] = await db.insert(households).values({ name, timeZone }).returning();
  if (!h) throw new Error('Could not create the household');
  await seedHousehold(db, h.id, seed, { locations: true });
  return h;
}

/** The single household of this install (the model allows more later). */
export async function theHousehold(db: Db): Promise<HouseholdRow | null> {
  const [h] = await db.select().from(households).orderBy(households.createdAt).limit(1);
  return h ?? null;
}

export async function createFirstAdmin(
  ctx: AppContext,
  input: { householdName: string; name: string; email: string; password: string | null; oidcSubject?: string },
): Promise<UserRow> {
  return ctx.db.transaction(async (tx) => {
    const h = (await theHousehold(tx)) ?? (await createHousehold(tx, ctx.seed, input.householdName, ctx.config.TZ));
    const [u] = await tx
      .insert(users)
      .values({
        householdId: h.id,
        name: input.name,
        email: input.email.toLowerCase(),
        role: 'admin',
        passwordHash: input.password ? await hashPassword(input.password) : null,
        oidcSubject: input.oidcSubject ?? null,
      })
      .returning();
    if (!u) throw new Error('Could not create the admin');
    return u;
  });
}

/** On first start, create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if there are no users. */
export async function ensureFirstAdmin(ctx: AppContext): Promise<UserRow | null> {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = ctx.config;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return null;
  if ((await userCount(ctx.db)) > 0) return null;
  return createFirstAdmin(ctx, {
    householdName: ctx.config.HOUSEHOLD_NAME ?? 'Our household',
    name: ctx.config.ADMIN_NAME ?? ADMIN_EMAIL.split('@')[0] ?? 'Admin',
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
}

export async function getUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const all = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return all[0] ?? null;
}
