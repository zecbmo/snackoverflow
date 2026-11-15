/**
 * Light, dark or follow the device, and the colour palette. Both are per-device choices kept in
 * localStorage; index.html applies them before first paint so there's no flash.
 */
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { DEFAULT_PALETTE, PALETTES, type PaletteId } from './palettes';
import { isNative } from './platform';

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
  appDark = dark;
  syncSystemBars();
}

let appDark = false;
let overCamera = 0;
let watching = false;

/**
 * The Android app draws behind the phone's status bar and buttons, so their icons have to suit the
 * app's theme, not the phone's: a light app on a dark-mode phone had white icons on white.
 */
function syncSystemBars(): void {
  if (!isNative()) return;
  if (!watching) {
    watching = true;
    // "Match device": follow the phone when it changes while the app is open.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  }
  // Style.Dark means a dark screen, so light icons.
  void SystemBars.setStyle({ style: appDark || overCamera > 0 ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
}

/** A screen that is dark whatever the theme (the scanner's camera): light icons while it's up. Returns the undo. */
export function darkSystemBars(): () => void {
  overCamera += 1;
  syncSystemBars();
  return () => {
    overCamera -= 1;
    syncSystemBars();
  };
}

export function setTheme(theme: Theme): void {
  write(THEME_KEY, theme === 'system' ? null : theme);
  applyTheme(theme);
}

export function setPalette(palette: PaletteId): void {
  write(PALETTE_KEY, palette === DEFAULT_PALETTE ? null : palette);
  applyTheme(getTheme(), palette);
}
