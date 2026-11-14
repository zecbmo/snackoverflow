/**
 * Adding a product this household named to Open Food Facts, so the next person to scan it gets a name.
 * Optional: needs an Open Food Facts account in OFF_CONTRIBUTE_*, and only ever adds new products
 * (a barcode Open Food Facts already has is left alone, never overwritten).
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { isShareableBarcode } from '@snackoverflow/shared';
import type { Config } from '../config';
import type { AppContext, Auth } from '../context';
import { products } from '../db/schema';
import { badRequest, HttpError, notFound } from '../http';
import { barcodesFor, type ProductRow } from './catalog';
import { OffContributeError } from './off';

export function offContributeEnabled(c: Config): boolean {
  return c.OFF_ENABLED && Boolean(c.OFF_CONTRIBUTE_USER_ID && c.OFF_CONTRIBUTE_PASSWORD);
}

const tidy = (n: number) => String(Number(n.toFixed(3)));

/** The pack size as Open Food Facts writes it: "500 g", "2 l", "4 x 125 g". Null when it isn't known. */
export function packQuantityText(p: Pick<ProductRow, 'packAmount' | 'packUnit' | 'portionGrams'>): string | null {
  if (!p.packAmount || !p.packUnit) return null;
  if (p.packUnit === 'count') return p.portionGrams ? `${tidy(p.packAmount)} x ${tidy(p.portionGrams)} g` : null;
  return `${tidy(p.packAmount)} ${p.packUnit}`;
}

/** Stands for one person to Open Food Facts' moderators without saying who they are. */
function appUuid(ctx: AppContext, userId: string): string {
  return createHash('sha256').update(`${ctx.config.SESSION_SECRET}:off:${userId}`).digest('hex').slice(0, 32);
}

export interface OffShareResult {
  product: ProductRow;
  /** Barcodes added to Open Food Facts. */
  added: string[];
  /** Barcodes it already had (left as they were). */
  alreadyThere: string[];
}

export async function shareProductWithOff(ctx: AppContext, auth: Auth, productId: string): Promise<OffShareResult> {
  if (!offContributeEnabled(ctx.config)) throw badRequest('Adding to Open Food Facts is not set up.');
  const [p] = await ctx.db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.householdId, auth.household.id)));
  if (!p) throw notFound('No such product.');
  if (p.recipeId) throw badRequest("Cooked meals can't go on Open Food Facts.");
  if (p.source === 'off') throw badRequest('This one came from Open Food Facts already.');
  if (!p.name) throw badRequest('Give it a name first.');
  const codes = ((await barcodesFor(ctx.db, [p.id])).get(p.id) ?? []).filter(isShareableBarcode);
  if (codes.length === 0) throw badRequest('It needs the barcode from the pack to go on Open Food Facts.');

  const added: string[] = [];
  const alreadyThere: string[] = [];
  for (const code of codes) {
    const has = await ctx.off.hasProduct(code);
    if (has === null) throw new HttpError(502, "Couldn't reach Open Food Facts. Try again later.");
    if (has) {
      alreadyThere.push(code);
      continue;
    }
    try {
      await ctx.off.contribute({
        barcode: code,
        name: p.name,
        brand: p.brand,
        quantity: packQuantityText(p),
        nutritionPer100g: p.nutritionPer100g ?? null,
        appUuid: appUuid(ctx, auth.user.id),
      });
    } catch (e) {
      throw new HttpError(502, e instanceof OffContributeError ? e.message : "Couldn't add it to Open Food Facts. Try again later.");
    }
    added.push(code);
  }

  const [updated] = await ctx.db.update(products).set({ offSharedAt: ctx.now() }).where(eq(products.id, p.id)).returning();
  ctx.live.publish(auth.household.id, 'products');
  return { product: updated!, added, alreadyThere };
}
