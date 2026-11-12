/**
 * The top of a list page: title and main actions, then a toolbar row with search and the view
 * pickers (filter, sort, group). On phones the title row keeps its menu or back button and the
 * pickers scroll sideways under the search box.
 */
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function PageTop({ title, subtitle, left, actions }: { title: string; subtitle?: ReactNode; left?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-3 pt-5 lg:pb-2 lg:pt-4">
      {left}
      <div className="min-w-0 flex-1 basis-40 lg:flex lg:items-baseline lg:gap-2">
        <h1 className="line-clamp-2 text-2xl font-bold leading-tight sm:text-3xl lg:text-xl">{title}</h1>
        {subtitle && <p className="truncate text-sm text-muted lg:text-[0.8125rem]">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Toolbar({ children, search }: { children?: ReactNode; search?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-1 lg:border-b lg:border-line lg:pb-2">
      {search && <div className="lg:order-last lg:ml-auto lg:w-72">{search}</div>}
      {children && <div className="no-scrollbar -mx-4 flex items-center gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">{children}</div>}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-lg border border-line bg-card px-3 focus-within:border-accent lg:min-h-8 lg:rounded-md lg:px-2.5">
      <Icon name="search" className="size-4 shrink-0 text-muted" />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted lg:text-sm"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="inline-flex size-6 items-center justify-center rounded text-muted hover:text-ink">
          <Icon name="close" className="size-4" />
        </button>
      )}
    </label>
  );
}

/** Two to five choices side by side (views, periods). */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: V;
  options: { value: V; label: ReactNode }[];
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-lg bg-card-muted p-0.5 lg:rounded-md">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-10 whitespace-nowrap rounded-md px-3 text-sm font-medium lg:min-h-7 lg:rounded lg:px-2.5 ${
            value === o.value ? 'bg-card font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
