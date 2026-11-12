import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { SessionDto } from '@snackoverflow/shared';
import { api, ApiError } from '../lib/api';
import { connectLive } from '../lib/live';
import { configureBackgroundChecks, flushSharedFile, forgetDevice, requestNotificationPermission } from '../lib/native';
import { startQueueSync, syncQueue, useQueuedCount } from '../lib/offlineQueue';
import { hasServer, isNative } from '../lib/platform';
import { useToast } from './Toast';
import { useInbox, useProducts, useRecipes, useSession, useStock } from '../lib/queries';
import { Icon, type IconName } from './Icon';
import { Spinner } from './ui';

const SessionCtx = createContext<SessionDto | null>(null);

/** The signed-in session. Only use inside the signed-in part of the app. */
export function useMe(): SessionDto {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('useMe outside the signed-in app');
  return s;
}

const tabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Today', icon: 'home' },
  { to: '/stock', label: 'Stock', icon: 'box' },
  { to: '/plan', label: 'Plan', icon: 'calendar' },
  { to: '/shop', label: 'Shop', icon: 'cart' },
];

interface MenuLink {
  to: string;
  label: string;
  badge?: string;
}

function useMenuSections(): { title: string; links: MenuLink[] }[] {
  const unnamed = useProducts('', true).data?.length ?? 0;
  const recipes = useRecipes().data?.length;
  const portions = (useStock().data ?? []).filter((s) => s.isMeal).length;
  return [
    {
      title: 'Food',
      links: [
        { to: '/recipes', label: 'Recipes', badge: recipes ? String(recipes) : undefined },
        { to: '/meals', label: 'Batch cooks & leftovers', badge: portions ? String(portions) : undefined },
        { to: '/receipts', label: 'Receipts' },
        { to: '/products', label: 'Products & barcodes', badge: unnamed ? `${unnamed} unnamed` : undefined },
        { to: '/ingredients', label: 'Ingredients & units' },
      ],
    },
    {
      title: 'Insights',
      links: [
        { to: '/dashboard', label: 'Dashboard' },
        { to: '/waste', label: 'Waste report' },
      ],
    },
    {
      title: 'Household',
      links: [
        { to: '/locations', label: 'Locations' },
        { to: '/people', label: 'People & roles' },
        { to: '/notifications', label: 'Notifications' },
        { to: '/settings', label: 'Settings' },
      ],
    },
  ];
}

export async function signOut(navigate: ReturnType<typeof useNavigate>, clear: () => void) {
  await api.post('/api/auth/logout').catch(() => {});
  await forgetDevice();
  clear();
  navigate('/login');
}

/** The bell: notifications inbox, with a dot when something is unread. */
export function BellButton() {
  const unread = useInbox().data?.unread ?? 0;
  return (
    <Link
      to="/inbox"
      aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-full border border-line bg-card"
    >
      <Icon name="bell" />
      {unread > 0 && <span aria-hidden className="absolute right-3.5 top-3.5 size-2.5 rounded-full bg-accent ring-2 ring-card" />}
    </Link>
  );
}

/** Scans saved while offline, waiting to be sent. */
function OfflineBanner() {
  const count = useQueuedCount();
  const toast = useToast();
  if (count === 0) return null;
  return (
    <div role="status" className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-card-muted px-4 py-2">
      <p className="flex-1 text-[0.9375rem]">
        {count === 1 ? '1 scan is' : `${count} scans are`} waiting to sync. They'll go as soon as you're back online.
      </p>
      <button
        type="button"
        className="min-h-11 font-semibold text-accent-text"
        onClick={() =>
          void syncQueue().then((r) => toast.show(r.synced ? `Synced ${r.synced} scan${r.synced === 1 ? '' : 's'}.` : 'Still offline. Will try again soon.'))
        }
      >
        Sync now
      </button>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-strong font-semibold text-strong-ink">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function Logo() {
  return (
    <span aria-hidden className="inline-flex size-10 items-center justify-center rounded-xl bg-accent text-sm font-bold text-accent-ink">
      S/O
    </span>
  );
}

function MenuDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe();
  const sections = useMenuSections();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  useEffect(onClose, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <nav className="animate-slide-up absolute inset-y-0 left-0 flex w-[80%] max-w-sm flex-col overflow-y-auto rounded-r-3xl bg-card p-5 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div className="mb-5 flex items-center gap-3">
          <Logo />
          <span className="flex-1 font-display text-xl font-bold">Snack Overflow</span>
          <button type="button" aria-label="Close menu" onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-card-muted">
            <Icon name="close" className="size-5" />
          </button>
        </div>
        <Link to="/profile" className="mb-4 flex items-center gap-3 rounded-2xl bg-card-muted p-3">
          <Avatar name={me.user.name} />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{me.user.name}</span>
            <span className="block truncate text-sm text-muted">
              {me.user.role === 'admin' ? 'Admin' : 'Member'} · {me.household.name}
            </span>
          </span>
        </Link>
        {sections.map((s) => (
          <div key={s.title} className="mb-3">
            <p className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted">{s.title}</p>
            {s.links.map((l) => (
              <Link key={l.to} to={l.to} className="flex min-h-12 items-center justify-between rounded-xl px-2 text-[1.0625rem] hover:bg-card-muted">
                <span>{l.label}</span>
                {l.badge && <span className="text-sm font-semibold text-muted">{l.badge}</span>}
              </Link>
            ))}
          </div>
        ))}
        <button
          type="button"
          onClick={() => void signOut(navigate, () => qc.clear())}
          className="mt-auto flex min-h-12 items-center px-2 text-left text-[1.0625rem] font-semibold text-danger"
        >
          Sign out
        </button>
      </nav>
    </div>
  );
}

function Sidebar() {
  const me = useMe();
  const sections = useMenuSections();
  const stockCount = useStock().data?.length;
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center justify-between rounded-xl px-3 text-[0.9375rem] ${isActive ? 'bg-card-muted font-semibold' : 'hover:bg-card-muted'}`;
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-card p-4 lg:flex">
      <div className="mb-4 flex items-center gap-3 px-1">
        <Logo />
        <span className="font-display text-lg font-bold leading-tight">
          Snack
          <br />
          Overflow
        </span>
      </div>
      <Link to="/scan" className="mb-4 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent font-semibold text-accent-ink hover:brightness-110">
        <Icon name="scan" className="size-5" /> Scan items
      </Link>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.to === '/'} className={linkClass}>
          <span>{t.label === 'Shop' ? 'Shopping list' : t.label === 'Plan' ? 'Planner' : t.label}</span>
          {t.to === '/stock' && stockCount !== undefined && <span className="text-sm text-muted">{stockCount}</span>}
        </NavLink>
      ))}
      {sections.map((s) => (
        <div key={s.title} className="mt-3">
          <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">{s.title}</p>
          {s.links.map((l) => (
            <NavLink key={l.to} to={l.to} className={linkClass}>
              <span>{l.label}</span>
              {l.badge && <span className="text-xs text-muted">{l.badge.replace(' unnamed', ' new')}</span>}
            </NavLink>
          ))}
        </div>
      ))}
      <Link to="/profile" className="mt-auto flex items-center gap-3 rounded-2xl bg-card-muted p-3">
        <Avatar name={me.user.name} />
        <span className="truncate text-sm font-medium">
          {me.user.name} · {me.user.role === 'admin' ? 'Admin' : 'Member'}
        </span>
      </Link>
    </aside>
  );
}

function BottomBar() {
  const item = 'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[0.8125rem]';
  const cls = ({ isActive }: { isActive: boolean }) => `${item} ${isActive ? 'font-semibold text-ink' : 'text-muted'}`;
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card lg:hidden">
      <div className="mx-auto flex max-w-xl items-end px-2">
        {tabs.slice(0, 2).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'} className={cls}>
            <Icon name={t.icon} />
            {t.label}
          </NavLink>
        ))}
        <div className="flex flex-1 justify-center">
          <Link
            to="/scan"
            aria-label="Scan"
            className="-mt-8 inline-flex size-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_8px_24px_-6px_var(--accent)]"
          >
            <Icon name="scan" className="size-8" />
          </Link>
        </div>
        {tabs.slice(2).map((t) => (
          <NavLink key={t.to} to={t.to} className={cls}>
            <Icon name={t.icon} />
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

const MenuCtx = createContext<() => void>(() => {});
/** The menu button shown at the top left of main screens on phones. */
export function MenuButton() {
  const open = useContext(MenuCtx);
  return (
    <button
      type="button"
      aria-label="Open menu"
      onClick={open}
      className="inline-flex size-14 shrink-0 items-center justify-center rounded-full border border-line bg-card lg:hidden"
    >
      <Icon name="menu" />
    </button>
  );
}

export function BackButton({ to }: { to?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Back"
      onClick={() => (to ? navigate(to) : navigate(-1))}
      className="inline-flex size-12 shrink-0 items-center justify-center rounded-full border border-line bg-card"
    >
      <Icon name="chevronLeft" />
    </button>
  );
}

/** Signed-in app: loads the session, keeps live updates connected, and lays out navigation. */
export function AppShell({ bare = false }: { bare?: boolean }) {
  const serverSet = hasServer();
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const signedIn = Boolean(session.data);
  useEffect(() => (signedIn ? connectLive(qc) : undefined), [signedIn, qc]);
  useEffect(
    () =>
      signedIn
        ? startQueueSync((r) => {
            void qc.invalidateQueries({ queryKey: ['stock'] });
            toast.show(`Synced ${r.synced} scan${r.synced === 1 ? '' : 's'} made offline.${r.dropped ? ` ${r.dropped} couldn't be added.` : ''}`);
          })
        : undefined,
    [signedIn, qc, toast],
  );
  const navigateTo = useNavigate();
  useEffect(() => {
    if (!signedIn || !isNative()) return;
    void requestNotificationPermission().then(configureBackgroundChecks);
    // A receipt shared into the app before signing in.
    flushSharedFile(navigateTo, (msg) => toast.show(msg, { tone: 'error' }));
  }, [signedIn, navigateTo, toast]);

  if (!serverSet) return <Navigate to="/connect" replace />;
  if (session.isPending) return <Spinner />;
  if (session.error) {
    if (session.error instanceof ApiError && session.error.status === 401) {
      if (isNative()) void forgetDevice();
      return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
    }
    if (session.error instanceof ApiError && session.error.status === 0 && isNative()) {
      return (
        <div className="mx-auto max-w-md p-6 text-center">
          <p className="mb-4">{session.error.message}</p>
          <Link to="/connect" className="font-semibold text-accent-text">
            Check the server address
          </Link>
        </div>
      );
    }
    return <p className="p-6 text-center">{session.error.message}</p>;
  }
  return (
    <SessionCtx.Provider value={session.data}>
      <MenuCtx.Provider value={() => setMenuOpen(true)}>
        {bare ? (
          <Outlet />
        ) : (
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="mx-auto w-full max-w-5xl flex-1 lg:max-w-7xl px-4 pb-32 pt-[env(safe-area-inset-top)] sm:px-6 lg:px-10 lg:pb-12">
              <OfflineBanner />
              <Outlet />
            </main>
            <BottomBar />
            <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />
          </div>
        )}
      </MenuCtx.Provider>
    </SessionCtx.Provider>
  );
}
