/**
 * The app's list view. Desktop: a dense table with a header, optional group rows and selection
 * checkboxes, and an actions column that is always visible. Phone: the same rows as a compact list.
 * Clicking a row (or its title) opens it, usually in a side panel.
 */
import { type ReactNode, useState } from 'react';
import { useIsDesktop } from '../lib/useMedia';
import { Icon } from './Icon';
import { Menu } from './Menu';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** The row's name: rendered as the button that opens the row. */
  primary?: boolean;
  align?: 'left' | 'right';
  /** Extra classes for the cells (width, colour). */
  className?: string;
  /** Its name in the Columns menu (defaults to the header when that's text). */
  label?: string;
  /** False for columns that must always show (the name, the freshness dot). */
  hideable?: boolean;
}

/** Which columns someone has hidden in a table, remembered per device. */
export function useHiddenColumns(table: string, defaults: string[] = []): [Set<string>, (key: string) => void] {
  const storageKey = `so-columns-${table}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      // Nothing remembered.
    }
    return new Set(defaults);
  });
  const toggle = (key: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...n]));
      } catch {
        // Not remembered.
      }
      return n;
    });
  return [hidden, toggle];
}

/** The "Columns" button beside the search box: tick which columns show. */
export function ColumnsMenu<T>({ columns, hidden, onToggle }: { columns: Column<T>[]; hidden: Set<string>; onToggle: (key: string) => void }) {
  const choices = columns.filter((c) => c.hideable !== false && !c.primary);
  return (
    <Menu
      label="Show columns"
      items={[
        { heading: 'Show columns' },
        ...choices.map((c) => ({ label: c.label ?? (typeof c.header === 'string' ? c.header : c.key), checked: !hidden.has(c.key), keepOpen: true, onSelect: () => onToggle(c.key) })),
      ]}
      triggerClassName="hidden size-8 shrink-0 items-center justify-center rounded-md border border-line bg-card text-muted hover:bg-card-muted hover:text-ink lg:inline-flex"
      trigger={
        <>
          <Icon name="columns" className="size-4" />
          <span className="sr-only">Show columns</span>
        </>
      }
    />
  );
}

export interface PhoneRow {
  title: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  /** A thin coloured bar or icon at the start of the row. */
  lead?: ReactNode;
  actions?: ReactNode;
}

export interface TableGroup<T> {
  key: string;
  label: ReactNode;
  rows: T[];
}

interface Props<T> {
  /** What the table lists, for screen readers ("Stock"). */
  label: string;
  columns: Column<T>[];
  rows?: T[];
  /** Grouped rows; takes the place of `rows`. */
  groups?: TableGroup<T>[];
  rowKey: (row: T) => string;
  /** Column keys to leave out (from the Columns menu). */
  hidden?: Set<string>;
  onOpen?: (row: T) => void;
  /** Accessible name of the open button, e.g. "Semi Skimmed Milk, details". */
  openLabel?: (row: T) => string;
  actions?: (row: T) => ReactNode;
  actionsHeader?: ReactNode;
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void };
  phone: (row: T) => PhoneRow;
  /** The row whose panel is open, highlighted. */
  activeKey?: string | null;
  empty?: ReactNode;
}

const interactive = 'button, a, input, select, textarea, label, [role="menu"], [role="menuitem"]';

/** A small coloured dot with its meaning as a tooltip (and for screen readers). */
export function StatusDot({ className, meaning }: { className: string; meaning: string }) {
  return (
    <span role="img" aria-label={meaning} title={meaning} className="inline-flex size-4 cursor-help items-center justify-center">
      <span className={`inline-block size-2 rounded-full ${className}`} />
    </span>
  );
}

export function DataTable<T>(props: Props<T>) {
  const desktop = useIsDesktop();
  const groups: TableGroup<T>[] = props.groups ?? [{ key: '', label: null, rows: props.rows ?? [] }];
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total === 0 && props.empty) return <>{props.empty}</>;
  const columns = props.hidden ? props.columns.filter((c) => !props.hidden!.has(c.key)) : props.columns;
  return desktop ? <Desktop {...props} columns={columns} groups={groups} /> : <Phone {...props} groups={groups} />;
}

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return [collapsed, toggle] as const;
}

function GroupToggle({ label, count, open, onToggle }: { label: ReactNode; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="inline-flex items-center gap-1.5 font-semibold text-ink">
      <Icon name={open ? 'chevronDown' : 'chevronRight'} className="size-4 text-muted" strokeWidth={2.2} />
      {label}
      <span className="font-normal text-muted">{count}</span>
    </button>
  );
}

function Desktop<T>({ label, columns, groups, rowKey, onOpen, openLabel, actions, actionsHeader, selection, activeKey }: Props<T> & { groups: TableGroup<T>[] }) {
  const [collapsed, toggle] = useCollapsed();
  const grouped = groups.length > 1 || groups[0]!.key !== '';
  const all = groups.flatMap((g) => g.rows.map(rowKey));
  const allSelected = selection ? all.length > 0 && all.every((k) => selection.selected.has(k)) : false;
  const span = columns.length + (selection ? 1 : 0) + (actions ? 1 : 0);
  const setSel = (k: string, on: boolean) => {
    if (!selection) return;
    const n = new Set(selection.selected);
    if (on) n.add(k);
    else n.delete(k);
    selection.onChange(n);
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-card">
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-card-muted/60 text-left text-xs text-muted">
            {selection && (
              <th scope="col" className="w-9 pl-3">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={(e) => selection.onChange(e.target.checked ? new Set(all) : new Set())}
                  className="size-4 accent-[var(--accent)]"
                />
              </th>
            )}
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`h-8 px-3 font-medium whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}>
                {c.header}
              </th>
            ))}
            {actions && (
              <th scope="col" className="h-8 px-3 text-right font-medium">
                {actionsHeader ?? <span className="sr-only">Actions</span>}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const open = !collapsed.has(g.key);
            return [
              grouped && (
                <tr key={`g:${g.key}`} className="border-b border-line bg-card-muted/40">
                  <td colSpan={span} className="h-8 px-3">
                    <GroupToggle label={g.label} count={g.rows.length} open={open} onToggle={() => toggle(g.key)} />
                  </td>
                </tr>
              ),
              ...(open
                ? g.rows.map((row) => {
                    const k = rowKey(row);
                    return (
                      <tr
                        key={k}
                        onClick={(e) => {
                          if (!onOpen || (e.target as HTMLElement).closest(interactive)) return;
                          onOpen(row);
                        }}
                        className={`group/row border-b border-line last:border-b-0 ${onOpen ? 'cursor-pointer' : ''} ${
                          activeKey === k ? 'bg-accent-soft/60' : selection?.selected.has(k) ? 'bg-accent-soft/30' : 'hover:bg-card-muted/60'
                        }`}
                      >
                        {selection && (
                          <td className="w-9 pl-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${openLabel ? openLabel(row) : k}`}
                              checked={selection.selected.has(k)}
                              onChange={(e) => setSel(k, e.target.checked)}
                              className="size-4 accent-[var(--accent)]"
                            />
                          </td>
                        )}
                        {columns.map((c) => (
                          <td key={c.key} className={`h-10 px-3 ${c.align === 'right' ? 'text-right' : ''} ${c.primary ? '' : 'text-muted'} ${c.className ?? ''}`}>
                            {c.primary && onOpen ? (
                              <button
                                type="button"
                                aria-label={openLabel?.(row)}
                                onClick={() => onOpen(row)}
                                className="max-w-full truncate text-left font-semibold text-ink hover:underline"
                              >
                                {c.cell(row)}
                              </button>
                            ) : (
                              c.cell(row)
                            )}
                          </td>
                        ))}
                        {actions && (
                          <td className="h-10 px-3">
                            <div className="flex items-center justify-end gap-1">{actions(row)}</div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function Phone<T>({ label, groups, rowKey, onOpen, openLabel, phone, activeKey }: Props<T> & { groups: TableGroup<T>[] }) {
  const [collapsed, toggle] = useCollapsed();
  const grouped = groups.length > 1 || groups[0]!.key !== '';
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => {
        const open = !collapsed.has(g.key);
        return (
          <section key={g.key} aria-label={grouped ? undefined : label}>
            {grouped && (
              <h2 className="mb-1.5 px-1 text-sm">
                <GroupToggle label={g.label} count={g.rows.length} open={open} onToggle={() => toggle(g.key)} />
              </h2>
            )}
            {open && (
              <ul className="overflow-hidden rounded-xl border border-line bg-card">
                {g.rows.map((row) => {
                  const k = rowKey(row);
                  const r = phone(row);
                  const body = (
                    <>
                      <span className="block truncate font-semibold">{r.title}</span>
                      {r.meta && <span className="block truncate text-sm text-muted">{r.meta}</span>}
                    </>
                  );
                  return (
                    <li key={k} className={`border-b border-line px-3 py-2.5 last:border-b-0 ${activeKey === k ? 'bg-accent-soft/60' : ''}`}>
                      <div className="flex items-center gap-3">
                        {r.lead}
                        {onOpen ? (
                          <button type="button" aria-label={openLabel?.(row)} onClick={() => onOpen(row)} className="min-h-11 min-w-0 flex-1 text-left">
                            {body}
                          </button>
                        ) : (
                          <div className="min-w-0 flex-1">{body}</div>
                        )}
                        {r.badge}
                      </div>
                      {r.actions && <div className={`mt-1.5 flex flex-wrap items-center gap-2 ${r.lead ? 'pl-4' : ''}`}>{r.actions}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
