import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
/** Works for both node-postgres (production) and PGlite (tests). Transactions are Dbs too. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

// Return DATE columns as plain 'YYYY-MM-DD' strings, never JS Dates (no time zone shifts).
pg.types.setTypeParser(1082, (v: string) => v);

export async function connect(url: string, migrationsFolder: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pool.end() };
}
