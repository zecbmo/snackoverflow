/**
 * Light, dark or follow the device, and the colour palette. Both are per-device choices kept in
 * localStorage; index.html applies them before first paint so there's no flash.
 */
import { DEFAULT_PALETTE, PALETTES, type PaletteId } from './palettes';

export type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'so-theme';
const PALETTE_KEY = 'so-palette';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
}

export function getTheme(): Theme {
  const t = read(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function getPalette(): PaletteId {
  const p = read(PALETTE_KEY);
  return PALETTES.some((x) => x.id === p) ? (p as PaletteId) : DEFAULT_PALETTE;
}

export function applyTheme(theme: Theme = getTheme(), palette: PaletteId = getPalette()): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.dataset.palette = palette;
  // The browser bar (and the phone's status bar in the installed app) follows the page background.
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const p = PALETTES.find((x) => x.id === palette) ?? PALETTES[0];
  const colour = dark ? p.dark.bg : p.light.bg;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', colour));
}

export function setTheme(theme: Theme): void {
  write(THEME_KEY, theme === 'system' ? null : theme);
  applyTheme(theme);
}

export function setPalette(palette: PaletteId): void {
  write(PALETTE_KEY, palette === DEFAULT_PALETTE ? null : palette);
  applyTheme(getTheme(), palette);
}
