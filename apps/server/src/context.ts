import type { Config } from './config';
import type { Db } from './db/client';
import type { households, users } from './db/schema';
import type { SeedData } from './db/seed';
import type { LiveHub } from './live';
import type { Mailer } from './notify/email';
import type { PushSender } from './notify/push';
import type { OpenFoodFacts } from './services/off';

export type UserRow = typeof users.$inferSelect;
export type HouseholdRow = typeof households.$inferSelect;

export interface AppContext {
  db: Db;
  config: Config;
  seed: SeedData;
  live: LiveHub;
  off: OpenFoodFacts;
  mailer: Mailer | null;
  push: PushSender | null;
  now: () => Date;
}

export interface Auth {
  user: UserRow;
  household: HouseholdRow;
  /** Set when signed in with a phone's device token rather than a browser cookie. */
  deviceId?: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth: Auth | null;
  }
}
