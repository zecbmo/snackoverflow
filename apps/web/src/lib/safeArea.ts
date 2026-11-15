/**
 * The room the phone's own bars take (status bar, back / home buttons), in px, for code that
 * places things itself (menus). CSS uses the --safe-* tokens in index.css; this reads the same ones.
 */
let probe: HTMLDivElement | null = null;

export function safeInsets(): { top: number; bottom: number } {
  if (typeof document === 'undefined') return { top: 0, bottom: 0 };
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:0;padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)';
    document.body.appendChild(probe);
  }
  const s = getComputedStyle(probe);
  return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 };
}
