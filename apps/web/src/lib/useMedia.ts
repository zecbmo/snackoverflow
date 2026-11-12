import { useSyncExternalStore } from 'react';

/** Whether a media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The desktop layout (sidebar, tables, side panels): Tailwind's `lg` breakpoint. */
export const useIsDesktop = () => useMedia('(min-width: 1024px)');
