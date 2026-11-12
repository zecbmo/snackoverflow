/**
 * Receipts: add a whole shop at once. A receipt is read into lines (by the
 * text parser, AI vision, or the household's own assistant over MCP), each line
 * is matched to a product (learned wording first, then the shopping list, then
 * product names, then ingredients), reviewed, and added to stock in one go:
 * ticked off the list, with prices saved. The photo or PDF is deleted once done.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  type CalendarDate,
  daysBetween,
  estimateOnAdd,
  expandReceiptText,
  looksLikeNonFood,
  parsePackQuantity,
  parseReceiptText,
  productNameFromReceipt,
  receiptKey,
  type ReceiptDto,
  type ReceiptLineDto,
  type ReceiptLinesInput,
  type ReceiptSummaryDto,
  todayIn,
} from '@snackoverflow/shared';
import type { AppContext, Auth } from '../context';
import type { Db } from '../db/client';
import { locations, prices, products, receiptAliases, receiptLines, receipts, shoppingItems, stockItems } from '../db/schema';
import { ingredientAliases, type SeedData } from '../db/seed';
import { badRequest, conflict, notFound } from '../http';
import { readReceiptWithAi } from './ai';
import { type Catalog, loadCatalog, measuresFor, packFields, type ProductRow, productShelfLife, suggestIngredient } from './catalog';
import { addPack, firstLocationOfType, type StockDeps } from './stock';

type ReceiptRow = typeof receipts.$inferSelect;
type LineRow = typeof receiptLines.$inferSelect;

const words = (s: string) => new Set(expandReceiptText(s).split(' ').filter((w) => w.length > 1 && !/^\d/.test(w)));

/** Share of words two names have in common (0-1). */
function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w) || B.has(w.replace(/s$/, '')) || B.has(`${w}s`)) common++;
  return common / Math.max(A.size, B.size);
}

interface Match {
  productId: string | null;
  ingredientId: string | null;
  matchSource: 'alias' | 'list' | 'product' | 'ingredient' | 'none';
  confidence: 'high' | 'low' | 'none';
  skip: boolean;
}

/** Match receipt lines: learned wording first, then the shopping list, then product names, then ingredients. */
export async function matchLines(db: Db, householdId: string, seed: SeedData, texts: string[]): Promise<Match[]> {
  const catalog = await loadCatalog(db, householdId);
  const aliases = new Map((await db.select().from(receiptAliases).where(eq(receiptAliases.householdId, householdId))).map((a) => [a.key, a]));
  const list = await db.select().from(shoppingItems).where(and(eq(shoppingItems.householdId, householdId), eq(shoppingItems.checked, false)));
  const listIngredients = [...catalog.ingredients.values()].filter((i) => list.some((l) => l.ingredientId === i.id));
  const prods = (await db.select().from(products).where(and(eq(products.householdId, householdId), isNull(products.recipeId)))).filter((p) => p.name);
  const all = [...catalog.ingredients.values()];
  const ingAliases = ingredientAliases(seed);

  return texts.map((text) => {
    const learned = aliases.get(receiptKey(text));
    if (learned) {
      return { productId: learned.productId, ingredientId: learned.ingredientId, matchSource: 'alias', confidence: 'high', skip: learned.skip };
    }
    if (looksLikeNonFood(text)) return { productId: null, ingredientId: null, matchSource: 'none', confidence: 'none', skip: true };
    const expanded = expandReceiptText(text);
    const onList = suggestIngredient(expanded, listIngredients, ingAliases);
    // A product this household already buys with a very similar name.
    let best: { p: ProductRow; score: number } | null = null;
    for (const p of prods) {
      const score = similarity(text, p.name!);
      if (score > (best?.score ?? 0)) best = { p, score };
    }
    if (best && best.score >= 0.75) {
      return { productId: best.p.id, ingredientId: best.p.ingredientId, matchSource: 'product', confidence: 'high', skip: false };
    }
    if (onList) return { productId: null, ingredientId: onList.id, matchSource: 'list', confidence: 'high', skip: false };
    if (best && best.score >= 0.5) {
      return { productId: best.p.id, ingredientId: best.p.ingredientId, matchSource: 'product', confidence: 'low', skip: false };
    }
    const ing = suggestIngredient(expanded, all, ingAliases);
    if (ing) return { productId: null, ingredientId: ing.id, matchSource: 'ingredient', confidence: 'low', skip: false };
    return { productId: null, ingredientId: null, matchSource: 'none', confidence: 'none', skip: false };
  });
}

/** Store the lines read from a receipt and get it ready for review. */
export async function setReceiptLines(db: Db, householdId: string, seed: SeedData, receiptId: string, read: ReceiptLinesInput): Promise<void> {
  const matches = await matchLines(db, householdId, seed, read.lines.map((l) => l.text));
  await db.delete(receiptLines).where(eq(receiptLines.receiptId, receiptId));
  if (read.lines.length) {
    await db.insert(receiptLines).values(
      read.lines.map((l, i) => ({
        receiptId,
        position: i,
        text: l.text,
        quantity: l.quantity,
        pricePence: l.pricePence ?? null,
        ...matches[i]!,
      })),
    );
  }
  await db
    .update(receipts)
    .set({ status: 'review', store: read.store ?? null, purchasedOn: read.date ?? null, error: null })
    .where(eq(receipts.id, receiptId));
}

export async function receiptFromText(ctx: AppContext, householdId: string, userId: string | null, text: string, source: 'text' | 'email' | 'mcp'): Promise<string> {
  const parsed = parseReceiptText(text);
  if (!parsed.lines.length) throw badRequest("Couldn't find any items with prices in that. Each item needs its price on the same line.");
  const [r] = await ctx.db
    .insert(receipts)
    .values({ householdId, source, status: 'review', rawText: text.slice(0, 50_000), createdBy: userId })
    .returning({ id: receipts.id });
  await setReceiptLines(ctx.db, householdId, ctx.seed, r!.id, { store: parsed.store, date: parsed.date, lines: parsed.lines });
  ctx.live.publish(householdId, 'receipts');
  return r!.id;
}

const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

/** A photo, screenshot or PDF. Read by AI when it's set up; otherwise it waits for the household's assistant (MCP). */
export async function receiptFromFile(ctx: AppContext, householdId: string, userId: string | null, file: Buffer, fileType: string, source: 'photo' | 'upload'): Promise<string> {
  if (!FILE_TYPES.includes(fileType)) throw badRequest('Use a photo (JPEG, PNG, WebP) or a PDF.');
  if (file.length > 12 * 1024 * 1024) throw badRequest('That file is too big. Try a smaller photo.');
  const aiReady = Boolean(ctx.config.AI_API_KEY);
  const [r] = await ctx.db
    .insert(receipts)
    .values({ householdId, source, status: aiReady ? 'reading' : 'waiting', file, fileType, createdBy: userId })
    .returning({ id: receipts.id });
  ctx.live.publish(householdId, 'receipts');
  if (aiReady) void readInBackground(ctx, householdId, r!.id);
  return r!.id;
}

/** Read a receipt image with AI, then match its lines. Failures leave a friendly error on the receipt. */
export async function readInBackground(ctx: AppContext, householdId: string, receiptId: string): Promise<void> {
  try {
    const [r] = await ctx.db.select().from(receipts).where(eq(receipts.id, receiptId));
    if (!r?.file || !r.fileType) return;
    await ctx.db.update(receipts).set({ status: 'reading', error: null }).where(eq(receipts.id, receiptId));
    const read = await readReceiptWithAi(ctx.config, r.file, r.fileType, ctx.fetch);
    if (!read.lines.length) throw new Error("Couldn't find any items on that receipt. Try a clearer photo.");
    await setReceiptLines(ctx.db, householdId, ctx.seed, receiptId, read);
  } catch (e) {
    await ctx.db
      .update(receipts)
      .set({ status: 'failed', error: e instanceof Error ? e.message : "Couldn't read that receipt." })
      .where(eq(receipts.id, receiptId));
  }
  ctx.live.publish(householdId, 'receipts');
}

function summary(r: ReceiptRow, lines: LineRow[]): ReceiptSummaryDto {
  const priced = lines.filter((l) => !l.skip && l.pricePence !== null);
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    store: r.store,
    purchasedOn: r.purchasedOn,
    lineCount: lines.filter((l) => !l.skip).length,
    totalPence: priced.length ? priced.reduce((s, l) => s + l.pricePence!, 0) : null,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listReceipts(db: Db, auth: Auth): Promise<ReceiptSummaryDto[]> {
  const rows = await db
    .select({ r: receipts })
    .from(receipts)
    .where(eq(receipts.householdId, auth.household.id))
    .orderBy(desc(receipts.createdAt))
    .limit(50);
  const lines = rows.length ? await db.select().from(receiptLines).where(inArray(receiptLines.receiptId, rows.map((x) => x.r.id))) : [];
  return rows.map(({ r }) => summary(r, lines.filter((l) => l.receiptId === r.id)));
}

async function loadReceipt(db: Db, auth: Auth, id: string): Promise<ReceiptRow> {
  const [r] = await db.select().from(receipts).where(and(eq(receipts.id, id), eq(receipts.householdId, auth.household.id)));
  if (!r) throw notFound('No such receipt.');
  return r;
}

/** Where a product usually goes, and its estimated date, for the review screen. */
async function defaults(db: Db, auth: Auth, catalog: Catalog, line: LineRow, day: CalendarDate) {
  const [product] = line.productId ? await db.select().from(products).where(eq(products.id, line.productId)) : [];
  let locationId = line.locationId;
  if (!locationId && product) {
    const [last] = await db.select({ id: stockItems.locationId }).from(stockItems).where(eq(stockItems.productId, product.id)).orderBy(desc(stockItems.addedAt)).limit(1);
    locationId = last?.id ?? null;
  }
  const ing = (product?.ingredientId ?? line.ingredientId) ? catalog.ingredients.get((product?.ingredientId ?? line.ingredientId)!) : undefined;
  const catId = product?.shelfLifeCategoryId ?? ing?.shelfLifeCategoryId;
  if (!locationId) locationId = (await firstLocationOfType(db, auth.household.id, (catId ? catalog.categories.get(catId)?.defaultLocation : undefined) ?? 'cupboard'))?.id ?? null;
  let bestBefore = line.bestBefore;
  if (!bestBefore && locationId) {
    const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
    const shelfLife = product ? productShelfLife(product, catalog) : productShelfLife({ ingredientId: ing?.id ?? null, shelfLifeCategoryId: null } as ProductRow, catalog);
    bestBefore = estimateOnAdd({ today: day, locationType: loc?.type ?? 'cupboard', shelfLife, learnedClosedDays: product?.learnedClosedDays, learnedFrozenDays: product?.learnedFrozenDays }).bestBefore;
  }
  return { product, locationId, bestBefore };
}

/** The day the shopping was done (the receipt's date when recent), for best-before estimates. */
function shopDay(r: ReceiptRow, auth: Auth, now: Date): CalendarDate {
  const today = todayIn(auth.household.timeZone, now);
  return r.purchasedOn && r.purchasedOn <= today && daysBetween(r.purchasedOn, today) <= 14 ? r.purchasedOn : today;
}

export async function getReceipt(db: Db, auth: Auth, id: string, now: Date): Promise<ReceiptDto> {
  const r = await loadReceipt(db, auth, id);
  const lines = await db.select().from(receiptLines).where(eq(receiptLines.receiptId, id)).orderBy(asc(receiptLines.position));
  const catalog = await loadCatalog(db, auth.household.id);
  const list = await db.select().from(shoppingItems).where(and(eq(shoppingItems.householdId, auth.household.id), eq(shoppingItems.checked, false)));
  const day = shopDay(r, auth, now);
  const out: ReceiptLineDto[] = [];
  for (const l of lines) {
    const d = await defaults(db, auth, catalog, l, day);
    const ingredientId = d.product?.ingredientId ?? l.ingredientId;
    out.push({
      id: l.id,
      text: l.text,
      quantity: l.quantity,
      pricePence: l.pricePence,
      productId: l.productId,
      productName: d.product?.name ?? null,
      ingredientId,
      ingredientName: ingredientId ? (catalog.ingredients.get(ingredientId)?.name ?? null) : null,
      matchSource: l.matchSource as ReceiptLineDto['matchSource'],
      confidence: l.confidence as ReceiptLineDto['confidence'],
      onList: list.some((i) => (ingredientId && i.ingredientId === ingredientId) || (l.productId && i.productId === l.productId)),
      skip: l.skip,
      locationId: d.locationId,
      bestBefore: d.bestBefore,
    });
  }
  return { ...summary(r, lines), lines: out, hasFile: Boolean(r.file) };
}

export async function updateLine(
  db: Db,
  auth: Auth,
  receiptId: string,
  lineId: string,
  patch: { productId?: string | null; ingredientId?: string | null; quantity?: number; skip?: boolean; locationId?: string; bestBefore?: string | null },
) {
  const r = await loadReceipt(db, auth, receiptId);
  if (r.status === 'done') throw conflict('That receipt has already been added.');
  const set: Partial<LineRow> = { ...patch };
  // Picking a match by hand is certain; a new match also gets a fresh date estimate.
  if (patch.productId !== undefined || patch.ingredientId !== undefined) {
    set.confidence = 'high';
    set.matchSource = patch.productId ? 'product' : patch.ingredientId ? 'ingredient' : 'none';
    if (patch.bestBefore === undefined) set.bestBefore = null;
    if (patch.productId && patch.ingredientId === undefined) {
      const [p] = await db.select().from(products).where(and(eq(products.id, patch.productId), eq(products.householdId, auth.household.id)));
      if (!p) throw notFound('No such product.');
      set.ingredientId = p.ingredientId;
    }
  }
  const updated = await db.update(receiptLines).set(set).where(and(eq(receiptLines.id, lineId), eq(receiptLines.receiptId, receiptId))).returning({ id: receiptLines.id });
  if (!updated.length) throw notFound('No such line.');
}

/** Add the reviewed receipt to stock: one pack per item, ticked off the list, prices saved, wording learned. */
export async function confirmReceipt(deps: StockDeps, seed: SeedData, receiptId: string): Promise<{ added: number; ticked: number; prices: number }> {
  const { db, auth, now } = deps;
  const r = await loadReceipt(db, auth, receiptId);
  if (r.status === 'done') throw conflict('That receipt has already been added.');
  if (r.status !== 'review') throw badRequest("That receipt hasn't been read yet.");
  const dto = await getReceipt(db, auth, receiptId, now);
  const catalog = await loadCatalog(db, auth.household.id);
  const day = shopDay(r, auth, now);
  let added = 0;
  let ticked = 0;
  let priceCount = 0;
  for (const line of dto.lines) {
    const key = receiptKey(line.text);
    if (line.skip) {
      await db.insert(receiptAliases).values({ householdId: auth.household.id, key, skip: true }).onConflictDoUpdate({
        target: [receiptAliases.householdId, receiptAliases.key],
        set: { skip: true, productId: null, ingredientId: null },
      });
      continue;
    }
    if (!line.productId && !line.ingredientId) continue;
    let product: ProductRow | undefined;
    if (line.productId) [product] = await db.select().from(products).where(eq(products.id, line.productId));
    if (!product) {
      // No product yet: make one from the receipt wording; the barcode gets linked the first time it's scanned.
      const name = productNameFromReceipt(line.text);
      const qty = parsePackQuantity(expandReceiptText(line.text).replace(/(\d)(pt|pts)\b/, '$1 pint'));
      const [created] = await db
        .insert(products)
        .values({
          householdId: auth.household.id,
          name,
          ingredientId: line.ingredientId,
          source: 'receipt',
          ...packFields(qty?.amount, qty?.unit, seed.units, measuresFor(line.ingredientId, catalog)),
        })
        .returning();
      product = created!;
    }
    for (let i = 0; i < line.quantity; i++) {
      if (!line.locationId) break;
      await addPack(deps, { product, locationId: line.locationId, bestBefore: line.bestBefore, catalog, addedOn: day });
      added++;
    }
    await db
      .insert(receiptAliases)
      .values({ householdId: auth.household.id, key, productId: product.id, ingredientId: product.ingredientId })
      .onConflictDoUpdate({ target: [receiptAliases.householdId, receiptAliases.key], set: { productId: product.id, ingredientId: product.ingredientId, skip: false } });
    // Tick it off the shopping list.
    const listed = await db
      .update(shoppingItems)
      .set({ checked: true, checkedAt: now })
      .where(
        and(
          eq(shoppingItems.householdId, auth.household.id),
          eq(shoppingItems.checked, false),
          product.ingredientId ? eq(shoppingItems.ingredientId, product.ingredientId) : eq(shoppingItems.productId, product.id),
        ),
      )
      .returning({ id: shoppingItems.id });
    ticked += listed.length;
    if (line.pricePence !== null && line.quantity > 0) {
      await db.insert(prices).values({
        householdId: auth.household.id,
        productId: product.id,
        store: r.store,
        pricePence: Math.round(line.pricePence / line.quantity),
        date: day,
        source: 'receipt',
      });
      priceCount++;
    }
  }
  // Photos are kept (the app sends them shrunk to a small JPEG) so the receipt can be looked at again;
  // PDFs, which can be large, are dropped once the receipt is reviewed.
  const [kept] = await db.select({ fileType: receipts.fileType }).from(receipts).where(eq(receipts.id, receiptId));
  const keepFile = Boolean(kept?.fileType?.startsWith('image/'));
  await db
    .update(receipts)
    .set({ status: 'done', doneAt: now, ...(keepFile ? {} : { file: null }) })
    .where(eq(receipts.id, receiptId));
  return { added, ticked, prices: priceCount };
}

export async function deleteReceipt(db: Db, auth: Auth, id: string) {
  await loadReceipt(db, auth, id);
  await db.delete(receipts).where(eq(receipts.id, id));
}

export async function receiptFile(db: Db, auth: Auth, id: string): Promise<{ file: Buffer; type: string } | null> {
  const r = await loadReceipt(db, auth, id);
  return r.file && r.fileType ? { file: r.file, type: r.fileType } : null;
}

/** A receipt whose lines were read elsewhere (e.g. AI reading an order email's text). */
export async function receiptFromLines(
  ctx: AppContext,
  householdId: string,
  userId: string | null,
  source: 'text' | 'email' | 'mcp',
  read: ReceiptLinesInput,
  rawText?: string,
): Promise<string> {
  const [r] = await ctx.db
    .insert(receipts)
    .values({ householdId, source, status: 'review', rawText: rawText?.slice(0, 50_000) ?? null, createdBy: userId })
    .returning({ id: receipts.id });
  await setReceiptLines(ctx.db, householdId, ctx.seed, r!.id, read);
  ctx.live.publish(householdId, 'receipts');
  return r!.id;
}
