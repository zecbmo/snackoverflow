/**
 * Restaurant, takeaway, café and drink chains and their published menu nutrition
 * (docs/data/chains.csv and docs/data/chain-menus/<key>.csv).
 */
import { z } from 'zod';
import { parseCsv } from './csv';

/** The order chain categories are shown in (the categories used in chains.csv). */
export const CHAIN_CATEGORIES = [
  'Burgers and fried chicken',
  'Pizza',
  'Sandwiches, bakery and grab-and-go',
  'Coffee and café',
  'Asian',
  'Mexican and Tex-Mex',
  'Chicken, peri-peri and grills',
  'Casual dining and family restaurants',
  'Pubs and carveries',
  'Fish and chips',
  'Desserts, doughnuts and shakes',
  'Bubble tea and drinks',
  'In-store cafés',
] as const;

export interface ChainDto {
  key: string;
  name: string;
  category: string;
  aliases: string[];
  notes: string | null;
  /** The chain's own nutrition page or file the menu came from. */
  sourceUrl: string | null;
  retrievedOn: string | null;
  itemCount: number;
  kcalMin: number | null;
  kcalMax: number | null;
}

/** Nutrition per serving as sold, as the chain publishes it; null where it doesn't. */
export interface ChainMenuItemDto {
  id: string;
  chainKey: string;
  chainName: string;
  name: string;
  section: string | null;
  serving: string | null;
  servingG: number | null;
  kcal: number;
  fat: number | null;
  saturates: number | null;
  carbs: number | null;
  sugars: number | null;
  fibre: number | null;
  protein: number | null;
  salt: number | null;
}

export const chainItemSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  chain: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** One parsed row of a chain's menu file. */
export interface ChainMenuSeedItem {
  key: string;
  name: string;
  section: string | null;
  serving: string | null;
  servingG: number | null;
  kcal: number;
  fat: number | null;
  saturates: number | null;
  carbs: number | null;
  sugars: number | null;
  fibre: number | null;
  protein: number | null;
  salt: number | null;
}

export const CHAIN_MENU_HEADER = ['item', 'section', 'serving', 'serving_g', 'kcal', 'fat_g', 'sat_fat_g', 'carbs_g', 'sugars_g', 'fibre_g', 'protein_g', 'salt_g'] as const;

/** A stable key for a menu item within its chain: its name and serving, lower case, joined with dashes. */
export function chainItemKey(name: string, serving: string | null): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const base = slug(name);
  const s = serving ? slug(serving) : '';
  return s && !base.endsWith(s) ? `${base}--${s}` : base;
}

/**
 * Reads a chain's menu file. Rows without a name or a valid kcal are skipped, as are repeats of
 * the same item and serving; each is reported in `problems` (row numbers count the header as 1).
 */
export function parseChainMenu(text: string): { items: ChainMenuSeedItem[]; problems: string[] } {
  const rows = parseCsv(text);
  const problems: string[] = [];
  const items: ChainMenuSeedItem[] = [];
  const seen = new Set<string>();
  const num = (v: string | undefined, field: string, row: number): number | null => {
    if (v === undefined || v.trim() === '') return null;
    const n = Number(v.trim());
    if (!Number.isFinite(n) || n < 0) {
      problems.push(`row ${row}: ${field} "${v}" isn't a number`);
      return null;
    }
    return n;
  };
  rows.forEach((r, i) => {
    const row = i + 2;
    const name = (r.item ?? '').trim();
    if (!name) {
      problems.push(`row ${row}: no item name`);
      return;
    }
    const kcal = num(r.kcal, 'kcal', row);
    if (kcal === null) {
      problems.push(`row ${row}: ${name} has no kcal`);
      return;
    }
    const serving = r.serving?.trim() || null;
    const key = chainItemKey(name, serving);
    if (!key || seen.has(key)) {
      problems.push(`row ${row}: ${name}${serving ? ` (${serving})` : ''} is listed twice`);
      return;
    }
    seen.add(key);
    items.push({
      key,
      name,
      section: r.section?.trim() || null,
      serving,
      servingG: num(r.serving_g, 'serving_g', row),
      kcal,
      fat: num(r.fat_g, 'fat_g', row),
      saturates: num(r.sat_fat_g, 'sat_fat_g', row),
      carbs: num(r.carbs_g, 'carbs_g', row),
      sugars: num(r.sugars_g, 'sugars_g', row),
      fibre: num(r.fibre_g, 'fibre_g', row),
      protein: num(r.protein_g, 'protein_g', row),
      salt: num(r.salt_g, 'salt_g', row),
    });
  });
  return { items, problems };
}
