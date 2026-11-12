/**
 * Settings and the household's lists (products, ingredients, locations, people, notifications)
 * share one area: a sub-menu down the left on desktop, a row of tabs on phones.
 */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useProducts } from '../lib/queries';
import { Icon, type IconName } from './Icon';

export const SETTINGS_PATHS = ['/settings', '/shelf-life', '/products', '/ingredients', '/locations', '/people', '/notifications', '/profile'];

export function SettingsShell({ children }: { children: ReactNode }) {
  const unnamed = useProducts('', true).data?.length ?? 0;
  const links: { to: string; label: string; icon: IconName; badge?: string }[] = [
    { to: '/settings', label: 'General', icon: 'sliders' },
    { to: '/shelf-life', label: 'Shelf life', icon: 'calendar' },
    { to: '/products', label: 'Products & barcodes', icon: 'tag', badge: unnamed ? `${unnamed} new` : undefined },
    { to: '/ingredients', label: 'Ingredients & units', icon: 'leaf' },
    { to: '/locations', label: 'Locations', icon: 'pin' },
    { to: '/people', label: 'People & roles', icon: 'users' },
    { to: '/notifications', label: 'Notifications', icon: 'bell' },
    { to: '/profile', label: 'Your profile', icon: 'user' },
  ];
  return (
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6">
      <nav aria-label="Settings" className="sticky top-0 hidden self-start pt-4 lg:block">
        <p className="mb-2 px-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted">Settings</p>
        <ul className="flex flex-col gap-0.5">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                end
                className={({ isActive }) =>
                  `flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm ${isActive ? 'bg-accent-soft font-semibold text-accent-text' : 'text-ink hover:bg-card-muted'}`
                }
              >
                <Icon name={l.icon} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{l.label}</span>
                {l.badge && <span className="text-xs font-normal text-muted">{l.badge}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0">
        <nav aria-label="Settings sections" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 pt-3 lg:hidden">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end
              className={({ isActive }) =>
                `-mb-px flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-2.5 text-sm font-semibold ${isActive ? 'border-accent text-ink' : 'border-transparent text-muted'}`
              }
            >
              {l.label}
              {l.badge && <span className="ml-1 font-normal text-muted">· {l.badge}</span>}
            </NavLink>
          ))}
        </nav>
        {children}
      </div>
    </div>
  );
}
