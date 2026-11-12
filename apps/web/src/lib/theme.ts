/** Light, dark, or follow the device. A per-device choice kept in localStorage; index.html applies it before first paint. */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'so-theme';
const COLOURS = { light: '#f5f5f8', dark: '#101014' };

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  // The browser bar (and the phone's status bar in the installed app) follows the page.
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? COLOURS.dark : COLOURS.light));
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
  applyTheme(theme);
}
