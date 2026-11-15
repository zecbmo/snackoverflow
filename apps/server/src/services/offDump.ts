/**
 * A local copy of Open Food Facts (OFF_DUMP_ENABLED): their daily data export (a 1.5GB gzipped
 * CSV of every product) is streamed and filtered on the way in, keeping only named products with
 * calories sold in OFF_COUNTRY. Nothing is written to disk but the rows kept. Search as you type
 * and barcode lookups then use the copy, with no rate limit and no network. Refreshed every
 * OFF_DUMP_REFRESH_DAYS by the scheduler, or from Settings.
 *
 * Data from Open Food Facts is under the Open Database Licence; the app says so where it shows it.
 */
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Nutrition, OffDumpStatusDto } from '@snackoverflow/shared';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { offImports, offProducts } from '../db/schema';
import type { OffProduct } from './off';

const BATCH = 500;
const PROGRESS_EVERY = 50_000;

/** Lower case without accents, the same way for the stored text and the query. */
export function searchText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The country tag without its language: "en:united-kingdom" → "united-kingdom". */
export function countryKey(country: string | undefined): string | null {
  return country ? country.replace(/^[a-z]{2}:/, '').trim() || null : null;
}

type Row = typeof offProducts.$inferInsert;

/** Column positions, from the export's header line. */
export type Columns = Map<string, number>;

export function columnsOf(header: string): Columns {
  return new Map(header.split('\t').map((name, i) => [name.trim(), i]));
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * One line of the export as a product to keep, or null: it must have a real barcode, a name and
 * calories (kcal, or kJ worked out), and be sold in the country when one is set.
 */
export function parseDumpLine(line: string, cols: Columns, country: string | null): Row | null {
  const f = line.split('\t');
  const get = (name: string) => {
    const i = cols.get(name);
    return i === undefined ? undefined : f[i];
  };
  const code = get('code')?.trim();
  if (!code || !/^[0-9]{6,24}$/.test(code)) return null;
  if (country) {
    const tags = get('countries_tags') ?? '';
    if (!tags.split(',').some((t) => countryKey(t.trim()) === country)) return null;
  }
  const name = get('product_name')?.trim();
  if (!name) return null;
  const kcal = num(get('energy-kcal_100g')) ?? (num(get('energy_100g')) !== null ? Math.round(num(get('energy_100g'))! / 4.184) : null);
  // Over 900 kcal per 100g isn't food (pure fat is 900): a typo in the data.
  if (kcal === null || kcal > 900) return null;
  const nutrition: Nutrition = {
    kcal,
    protein: num(get('proteins_100g')),
    carbs: num(get('carbohydrates_100g')),
    sugars: num(get('sugars_100g')),
    fat: num(get('fat_100g')),
    saturates: num(get('saturated-fat_100g')),
    fibre: num(get('fiber_100g')),
    salt: num(get('salt_100g')),
  };
  const brand = get('brands')?.split(',')[0]?.trim() || null;
  const quantity = get('quantity')?.trim() || (num(get('product_quantity')) !== null ? `${num(get('product_quantity'))} g` : null);
  const categories = (get('categories_tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  return {
    barcode: code,
    name: name.slice(0, 300),
    brand: brand?.slice(0, 200) ?? null,
    quantity: quantity?.slice(0, 100) ?? null,
    categories,
    imageUrl: get('image_small_url')?.trim() || null,
    nutritionPer100g: nutrition,
    scans: Math.round(num(get('unique_scans_n')) ?? 0),
    search: searchText(`${name} ${brand ?? ''}`).slice(0, 500),
  };
}

async function saveBatch(db: Db, rows: Row[]) {
  if (!rows.length) return;
  // The export can list a barcode twice; the last one wins.
  const unique = [...new Map(rows.map((r) => [r.barcode, r])).values()];
  await db
    .insert(offProducts)
    .values(unique)
    .onConflictDoUpdate({
      target: offProducts.barcode,
      set: {
        name: sql`excluded.name`,
        brand: sql`excluded.brand`,
        quantity: sql`excluded.quantity`,
        categories: sql`excluded.categories`,
        imageUrl: sql`excluded.image_url`,
        nutritionPer100g: sql`excluded.nutrition_per_100g`,
        scans: sql`excluded.scans`,
        search: sql`excluded.search`,
        importId: sql`excluded.import_id`,
      },
    });
}

let running: Promise<void> | null = null;
type Log = { info(o: object, m?: string): void; error(o: object, m?: string): void };

/**
 * Start a refresh in the background, unless one is already going (false then). Resolves once
 * the run is recorded, so its status shows straight away; the download carries on after.
 */
export async function startOffImport(ctx: AppContext, log?: Log): Promise<boolean> {
  if (running) return false;
  let recorded!: () => void;
  const ready = new Promise<void>((r) => (recorded = r));
  running = (async () => {
    try {
      const run = await beginImport(ctx);
      recorded();
      log?.info(await runImport(ctx, run.id), 'Open Food Facts copy refreshed');
    } catch (err) {
      log?.error({ err }, 'Open Food Facts copy refresh failed');
    } finally {
      recorded();
      running = null;
    }
  })();
  await ready;
  return true;
}

/** Wait for a refresh started in the background (tests). */
export async function offImportSettled() {
  await running;
}

/** Download and filter the export into the local copy. Throws (after recording why) on failure. */
export async function importOffDump(ctx: AppContext): Promise<{ lines: number; products: number; removed: number }> {
  return runImport(ctx, (await beginImport(ctx)).id);
}

async function beginImport(ctx: AppContext) {
  const { db } = ctx;
  // Only one server process: anything still "running" was cut short by a restart.
  await db.update(offImports).set({ status: 'failed', error: 'Stopped when the server restarted.', finishedAt: ctx.now() }).where(eq(offImports.status, 'running'));
  const [run] = await db.insert(offImports).values({ status: 'running', country: countryKey(ctx.config.OFF_COUNTRY), startedAt: ctx.now() }).returning();
  return run!;
}

async function runImport(ctx: AppContext, runId: string): Promise<{ lines: number; products: number; removed: number }> {
  const { db, config } = ctx;
  const country = countryKey(config.OFF_COUNTRY);
  const run = { id: runId };
  const before = (await db.select({ n: sql<number>`count(*)::int` }).from(offProducts))[0]?.n ?? 0;
  let lines = 0;
  let products = 0;
  try {
    const res = await (ctx.fetch ?? fetch)(config.OFF_DUMP_URL, { headers: { 'User-Agent': config.OFF_USER_AGENT }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Couldn't download the Open Food Facts export (${res.status}).`);
    let input: NodeJS.ReadableStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    if (config.OFF_DUMP_URL.endsWith('.gz') || /gzip/.test(res.headers.get('content-type') ?? '')) input = input.pipe(createGunzip());
    const rl = createInterface({ input, crlfDelay: Infinity });
    let cols: Columns | null = null;
    let batch: Row[] = [];
    for await (const line of rl) {
      if (!cols) {
        cols = columnsOf(line);
        if (!cols.has('code') || !cols.has('product_name')) throw new Error("That doesn't look like the Open Food Facts export (no code or product_name column).");
        continue;
      }
      lines++;
      const row = parseDumpLine(line, cols, country);
      if (row) {
        batch.push({ ...row, importId: run.id });
        products++;
        if (batch.length >= BATCH) {
          await saveBatch(db, batch);
          batch = [];
        }
      }
      if (lines % PROGRESS_EVERY === 0) await db.update(offImports).set({ lines, products }).where(eq(offImports.id, run.id));
    }
    await saveBatch(db, batch);
    if (!products) throw new Error(country ? `No products sold in ${country.replace(/-/g, ' ')} were found in the export.` : 'No products were found in the export.');
    // Remove products the export no longer lists, unless this run looks cut short.
    let removed = 0;
    if (products >= before * 0.5) {
      removed = (await db.delete(offProducts).where(sql`${offProducts.importId} is distinct from ${run.id}`).returning({ b: offProducts.barcode })).length;
    }
    await db.update(offImports).set({ status: 'done', lines, products, finishedAt: ctx.now() }).where(eq(offImports.id, run.id));
    return { lines, products, removed };
  } catch (e) {
    await db
      .update(offImports)
      .set({ status: 'failed', lines, products, finishedAt: ctx.now(), error: (e as Error).message.slice(0, 500) })
      .where(eq(offImports.id, run.id));
    throw e;
  }
}

/** Due for a refresh: never done, or the last good one is older than the refresh interval. Waits 6 hours after a failure. */
export function importDue(lastDone: Date | null, lastFailed: Date | null, now: Date, refreshDays: number): boolean {
  if (lastFailed && now.getTime() - lastFailed.getTime() < 6 * 3_600_000 && (!lastDone || lastFailed > lastDone)) return false;
  return !lastDone || now.getTime() - lastDone.getTime() >= refreshDays * 86_400_000;
}

/** Scheduler: refresh the copy when it's due. */
export async function maybeImportOff(ctx: AppContext, log: Log) {
  if (!ctx.config.OFF_DUMP_ENABLED || running) return;
  const [done] = await ctx.db.select().from(offImports).where(eq(offImports.status, 'done')).orderBy(desc(offImports.seq)).limit(1);
  const [failed] = await ctx.db.select().from(offImports).where(eq(offImports.status, 'failed')).orderBy(desc(offImports.seq)).limit(1);
  if (importDue(done?.finishedAt ?? null, failed?.finishedAt ?? null, ctx.now(), ctx.config.OFF_DUMP_REFRESH_DAYS)) {
    if (await startOffImport(ctx, log)) log.info({}, 'refreshing the Open Food Facts copy');
  }
}

export async function offDumpStatus(ctx: AppContext): Promise<OffDumpStatusDto> {
  const [last] = await ctx.db.select().from(offImports).orderBy(desc(offImports.seq)).limit(1);
  const products = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(offProducts))[0]?.n ?? 0;
  return {
    enabled: ctx.config.OFF_DUMP_ENABLED,
    country: countryKey(ctx.config.OFF_COUNTRY),
    products,
    refreshDays: ctx.config.OFF_DUMP_REFRESH_DAYS,
    last: last
      ? {
          status: last.status as 'running' | 'done' | 'failed',
          startedAt: last.startedAt.toISOString(),
          finishedAt: last.finishedAt?.toISOString() ?? null,
          lines: last.lines,
          products: last.products,
          error: last.error,
        }
      : null,
  };
}

function toOff(r: typeof offProducts.$inferSelect): OffProduct {
  return { barcode: r.barcode, name: r.name, brand: r.brand, quantity: r.quantity, imageUrl: r.imageUrl, categories: r.categories, nutritionPer100g: r.nutritionPer100g };
}

/** A barcode from the local copy (no network). */
export async function lookupLocalOff(db: Db, code: string): Promise<OffProduct | null> {
  const [r] = await db.select().from(offProducts).where(eq(offProducts.barcode, code));
  return r ? toOff(r) : null;
}

/** Products whose name or brand has every word, best matches and most scanned first. */
export async function searchLocalOff(db: Db, q: string, limit = 15): Promise<OffProduct[]> {
  const phrase = searchText(q).replace(/[%_\\]/g, '');
  const words = phrase.split(' ').filter(Boolean).slice(0, 8);
  if (!words.length) return [];
  const rows = await db
    .select()
    .from(offProducts)
    .where(and(...words.map((w) => sql`${offProducts.search} like ${`%${w}%`}`)))
    .orderBy(sql`case when ${offProducts.search} like ${`${phrase}%`} then 0 when ${offProducts.search} like ${`% ${phrase}%`} then 1 else 2 end`, desc(offProducts.scans), offProducts.name)
    .limit(limit);
  return rows.map(toOff);
}

/** Is there a copy to search? */
export async function hasLocalOff(db: Db): Promise<boolean> {
  return (await db.select({ b: offProducts.barcode }).from(offProducts).limit(1)).length > 0;
}
