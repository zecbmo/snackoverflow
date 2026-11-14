/**
 * Restaurant, takeaway and café chains with their published menu nutrition. The data ships in
 * docs/data (chains.csv and chain-menus/<key>.csv) and is copied into the database on start-up;
 * only chains whose files changed are rewritten.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { type ChainDto, type ChainMenuItemDto, type ChainMenuSeedItem, parseChainMenu, parseCsv } from '@snackoverflow/shared';
import type { Db } from '../db/client';
import { chainMenuItems, chains } from '../db/schema';

export interface ChainSeed {
  key: string;
  name: string;
  category: string;
  aliases: string[];
  notes: string | null;
  sourceUrl: string | null;
  retrievedOn: string | null;
  items: ChainMenuSeedItem[];
  hash: string;
}

/** Reads the chain list and every chain's menu file. Rows that can't be used are listed in `problems`. */
export function loadChainSeed(dir: string): { chains: ChainSeed[]; problems: string[] } {
  const listFile = join(dir, 'chains.csv');
  if (!existsSync(listFile)) return { chains: [], problems: [] };
  const problems: string[] = [];
  const out: ChainSeed[] = [];
  for (const r of parseCsv(readFileSync(listFile, 'utf8'))) {
    if (!r.key || !r.name || !r.category) continue;
    const menuFile = join(dir, 'chain-menus', `${r.key}.csv`);
    const menuText = existsSync(menuFile) ? readFileSync(menuFile, 'utf8') : '';
    const menu = menuText ? parseChainMenu(menuText) : { items: [], problems: [] };
    problems.push(...menu.problems.map((p) => `chain-menus/${r.key}.csv ${p}`));
    const retrievedOn = /^\d{4}-\d{2}-\d{2}$/.test(r.retrieved_on ?? '') ? r.retrieved_on! : null;
    const seed = {
      key: r.key,
      name: r.name,
      category: r.category,
      aliases: (r.aliases ?? '')
        .split(';')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
      notes: r.notes || null,
      sourceUrl: r.source_url || null,
      retrievedOn,
      items: menu.items,
    };
    out.push({ ...seed, hash: createHash('sha256').update(JSON.stringify(seed)).digest('hex') });
  }
  return { chains: out, problems };
}

const BATCH = 500;

/** Brings the chain tables in line with the seed files. Chains whose files haven't changed are skipped. */
export async function syncChains(db: Db, seed: ChainSeed[]): Promise<{ updated: number }> {
  const existing = new Map((await db.select({ key: chains.key, seedHash: chains.seedHash }).from(chains)).map((c) => [c.key, c.seedHash]));
  const keys = seed.map((c) => c.key);
  if (keys.length) await db.delete(chains).where(notInArray(chains.key, keys));
  else await db.delete(chains);
  let updated = 0;
  for (const c of seed) {
    if (existing.get(c.key) === c.hash) continue;
    updated++;
    await db.transaction(async (tx) => {
      const row = { name: c.name, category: c.category, aliases: c.aliases, notes: c.notes, sourceUrl: c.sourceUrl, retrievedOn: c.retrievedOn, seedHash: c.hash, updatedAt: new Date() };
      await tx
        .insert(chains)
        .values({ key: c.key, ...row })
        .onConflictDoUpdate({ target: chains.key, set: row });
      // Items keep their ids while their name and serving stay the same.
      const itemKeys = c.items.map((i) => i.key);
      if (itemKeys.length) await tx.delete(chainMenuItems).where(and(eq(chainMenuItems.chainKey, c.key), notInArray(chainMenuItems.key, itemKeys)));
      else await tx.delete(chainMenuItems).where(eq(chainMenuItems.chainKey, c.key));
      for (let i = 0; i < c.items.length; i += BATCH) {
        const values = c.items.slice(i, i + BATCH).map((item, j) => ({ ...item, chainKey: c.key, sortOrder: i + j }));
        await tx
          .insert(chainMenuItems)
          .values(values)
          .onConflictDoUpdate({
            target: [chainMenuItems.chainKey, chainMenuItems.key],
            set: {
              name: sql`excluded.name`,
              section: sql`excluded.section`,
              serving: sql`excluded.serving`,
              servingG: sql`excluded.serving_g`,
              kcal: sql`excluded.kcal`,
              fat: sql`excluded.fat`,
              saturates: sql`excluded.saturates`,
              carbs: sql`excluded.carbs`,
              sugars: sql`excluded.sugars`,
              fibre: sql`excluded.fibre`,
              protein: sql`excluded.protein`,
              salt: sql`excluded.salt`,
              sortOrder: sql`excluded.sort_order`,
            },
          });
      }
    });
  }
  return { updated };
}

export async function listChains(db: Db): Promise<ChainDto[]> {
  const counts = await db
    .select({
      chainKey: chainMenuItems.chainKey,
      n: sql<number>`count(*)::int`,
      min: sql<number | null>`min(${chainMenuItems.kcal})`,
      max: sql<number | null>`max(${chainMenuItems.kcal})`,
    })
    .from(chainMenuItems)
    .groupBy(chainMenuItems.chainKey);
  const byKey = new Map(counts.map((c) => [c.chainKey, c]));
  const rows = await db.select().from(chains).orderBy(asc(chains.name));
  return rows.map((c) => {
    const n = byKey.get(c.key);
    return {
      key: c.key,
      name: c.name,
      category: c.category,
      aliases: c.aliases,
      notes: c.notes,
      sourceUrl: c.sourceUrl,
      retrievedOn: c.retrievedOn,
      itemCount: n?.n ?? 0,
      kcalMin: n?.min === null || n?.min === undefined ? null : Number(n.min),
      kcalMax: n?.max === null || n?.max === undefined ? null : Number(n.max),
    };
  });
}

const itemColumns = {
  id: chainMenuItems.id,
  chainKey: chainMenuItems.chainKey,
  chainName: chains.name,
  name: chainMenuItems.name,
  section: chainMenuItems.section,
  serving: chainMenuItems.serving,
  servingG: chainMenuItems.servingG,
  kcal: chainMenuItems.kcal,
  fat: chainMenuItems.fat,
  saturates: chainMenuItems.saturates,
  carbs: chainMenuItems.carbs,
  sugars: chainMenuItems.sugars,
  fibre: chainMenuItems.fibre,
  protein: chainMenuItems.protein,
  salt: chainMenuItems.salt,
};

export async function chainMenu(db: Db, key: string): Promise<ChainMenuItemDto[]> {
  return db
    .select(itemColumns)
    .from(chainMenuItems)
    .innerJoin(chains, eq(chains.key, chainMenuItems.chainKey))
    .where(eq(chainMenuItems.chainKey, key))
    .orderBy(asc(chainMenuItems.sortOrder));
}

/**
 * Menu items whose name, chain or chain nickname contain every word of the query
 * ("maccies big mac", "nandos chips"). Names that start with the query come first.
 */
export async function searchChainItems(db: Db, q: string, opts: { chain?: string; limit: number }): Promise<ChainMenuItemDto[]> {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[%_\\]/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return [];
  const hay = sql`lower(${chainMenuItems.name} || ' ' || coalesce(${chainMenuItems.section}, '') || ' ' || ${chains.name} || ' ' || ${chains.aliases}::text)`;
  const conds = words.map((w) => sql`${hay} like ${`%${w}%`}`);
  if (opts.chain) conds.push(sql`${chainMenuItems.chainKey} = ${opts.chain}`);
  const phrase = q.trim().toLowerCase().replace(/[%_\\]/g, '');
  return db
    .select(itemColumns)
    .from(chainMenuItems)
    .innerJoin(chains, eq(chains.key, chainMenuItems.chainKey))
    .where(and(...conds))
    .orderBy(
      // Most of the words in the item's own name first ("maccies big mac": Big Mac before Big Arch).
      sql`(${sql.join(
        words.map((w) => sql`case when lower(${chainMenuItems.name}) like ${`%${w}%`} then 1 else 0 end`),
        sql` + `,
      )}) desc`,
      sql`case when lower(${chainMenuItems.name}) like ${`${phrase}%`} then 0 when lower(${chainMenuItems.name}) like ${`%${phrase}%`} then 1 else 2 end`,
      asc(chains.name),
      asc(chainMenuItems.sortOrder),
    )
    .limit(opts.limit);
}

