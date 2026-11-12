/**
 * Import a recipe from a web page. Most recipe sites (BBC Good Food, Hello Fresh,
 * blogs) embed schema.org Recipe data as JSON-LD, which gives a good first pass.
 * The result is a draft for the review screen; nothing is saved here.
 */
import { isoDurationMinutes, type RecipeDraftDto } from '@snackoverflow/shared';
import type { Catalog } from './catalog';
import type { SeedData } from '../db/seed';
import { badRequest } from '../http';
import { draftLine } from './recipes';

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; SnackOverflow/0.1; +recipe import)';
export const NO_RECIPE = "Couldn't find a recipe on that page. You can paste the ingredients and steps in instead.";

type Json = unknown;
type Obj = Record<string, Json>;

const isObj = (v: Json): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Non-breaking space, common in recipe text. */
const NBSP = String.fromCharCode(160);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: NBSP, ndash: '–', mdash: '—', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Decode HTML entities and strip tags from text found in JSON-LD. */
export function cleanText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+\d*);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replaceAll(NBSP, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function hasType(o: Obj, type: string): boolean {
  const t = o['@type'];
  return t === type || (Array.isArray(t) && t.includes(type));
}

/** Find the first schema.org Recipe in a JSON-LD value (top-level, arrays, @graph, nested). */
export function findRecipe(value: Json, depth = 0): Obj | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = findRecipe(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (!isObj(value)) return null;
  if (hasType(value, 'Recipe')) return value;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    if (key in value) {
      const r = findRecipe(value[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Every JSON-LD block in a page, parsed (bad blocks are skipped). */
export function jsonLdBlocks(html: string): Json[] {
  const out: Json[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = (m[1] ?? '').trim().replace(/^<!--|-->$/g, '');
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Some sites put stray control characters in; try once more without them.
      try {
        out.push(JSON.parse(raw.replace(/[\r\n\t]+/g, ' ')));
      } catch {
        // Not usable.
      }
    }
  }
  return out;
}

function str(v: Json): string | null {
  if (typeof v === 'string') return cleanText(v) || null;
  if (typeof v === 'number') return String(v);
  return null;
}

/** "4", "Serves 4", ["4", "4 servings"], 4, "4-6" -> 4 */
export function readServes(v: Json): number {
  const candidates = Array.isArray(v) ? v : [v];
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return Math.round(c);
    if (typeof c === 'string') {
      const m = c.match(/\d+/);
      if (m && Number(m[0]) > 0 && Number(m[0]) <= 100) return Number(m[0]);
    }
  }
  return 4;
}

function readImage(v: Json): string | null {
  if (typeof v === 'string') return v || null;
  if (Array.isArray(v)) {
    for (const i of v) {
      const r = readImage(i);
      if (r) return r;
    }
    return null;
  }
  if (isObj(v)) return str(v.url) ?? str(v.contentUrl);
  return null;
}

/** recipeInstructions: a string, HowToStep[], HowToSection{itemListElement}, or a mix. */
export function readSteps(v: Json): string[] {
  if (typeof v === 'string') {
    return cleanText(v)
      .split(/\n+/)
      .map((s) => s.replace(/^\s*(step\s*)?\d+[.):]?\s+/i, '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) return v.flatMap((x) => readSteps(x));
  if (isObj(v)) {
    if (hasType(v, 'HowToSection') || ('itemListElement' in v && !('text' in v))) return readSteps(v.itemListElement);
    const text = str(v.text) ?? str(v.name);
    return text ? [text] : [];
  }
  return [];
}

function readTags(r: Obj): string[] {
  const raw: string[] = [];
  const add = (v: Json) => {
    if (typeof v === 'string') raw.push(...v.split(','));
    else if (Array.isArray(v)) v.forEach(add);
  };
  add(r.keywords);
  add(r.recipeCategory);
  add(r.recipeCuisine);
  const tags = raw.map((t) => cleanText(t).toLowerCase()).filter((t) => t && t.length <= 40);
  return [...new Set(tags)].slice(0, 10);
}

/** Turn a JSON-LD Recipe into a draft, matching each ingredient line. */
export function draftFromJsonLd(r: Obj, sourceUrl: string | null, catalog: Catalog, seed: SeedData): RecipeDraftDto {
  const lines = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : Array.isArray(r.ingredients) ? r.ingredients : [])
    .map((l) => str(l))
    .filter((l): l is string => Boolean(l));
  return {
    title: str(r.name) ?? 'Untitled recipe',
    serves: readServes(r.recipeYield),
    steps: readSteps(r.recipeInstructions),
    imageUrl: readImage(r.image),
    sourceUrl,
    tags: readTags(r),
    prepMinutes: isoDurationMinutes(typeof r.prepTime === 'string' ? r.prepTime : null),
    cookMinutes: isoDurationMinutes(typeof r.cookTime === 'string' ? r.cookTime : null),
    ingredients: lines.map((l) => draftLine(l, catalog, seed)),
  };
}

/** Find the recipe in a page's HTML; null when there isn't one. */
export function parseRecipePage(html: string, sourceUrl: string | null, catalog: Catalog, seed: SeedData): RecipeDraftDto | null {
  for (const block of jsonLdBlocks(html)) {
    const r = findRecipe(block);
    if (r) return draftFromJsonLd(r, sourceUrl, catalog, seed);
  }
  return null;
}

/** Download a page, politely and with limits. */
export async function fetchPage(url: string, f: typeof fetch = fetch): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest("That doesn't look like a web address.");
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('Only http and https links can be imported.');
  let res: Response;
  try {
    res = await f(u.href, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw badRequest("Couldn't load that page. Check the link, or try again in a minute.");
  }
  if (!res.ok) throw badRequest(`That page didn't load (error ${res.status}).`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw badRequest('That page is too big to import.');
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw badRequest('That page is too big to import.');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export async function importRecipe(url: string, catalog: Catalog, seed: SeedData, f?: typeof fetch): Promise<RecipeDraftDto> {
  const html = await fetchPage(url, f);
  const draft = parseRecipePage(html, url, catalog, seed);
  if (!draft) throw badRequest(NO_RECIPE);
  return draft;
}
