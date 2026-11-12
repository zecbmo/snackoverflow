import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';

type Variant = 'primary' | 'dark' | 'outline' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50',
  dark: 'bg-strong text-strong-ink hover:opacity-90 disabled:opacity-50',
  outline: 'border border-line bg-card text-ink hover:bg-card-muted disabled:opacity-50',
  ghost: 'text-ink hover:bg-card-muted disabled:opacity-50',
  danger: 'border border-line bg-card text-danger hover:bg-card-muted disabled:opacity-50',
};

export function Button({
  variant = 'outline',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  // Phones keep 44px targets; with a wide screen (and the 14px desktop root) controls get compact.
  const sizes = {
    xs: 'min-h-10 px-2.5 text-sm lg:min-h-7 lg:px-2 lg:text-[0.8125rem]',
    sm: 'min-h-11 px-3 text-sm lg:min-h-8 lg:px-2.5',
    md: 'min-h-11 px-4 text-[0.9375rem] lg:min-h-8 lg:px-3 lg:text-sm',
    lg: 'min-h-12 px-5 text-base lg:min-h-9 lg:px-4 lg:text-sm',
  };
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition lg:rounded-md ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function IconButton({ icon, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Parameters<typeof Icon>[0]['name']; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-line bg-card text-ink hover:bg-card-muted lg:size-8 lg:rounded-md ${className}`}
      {...props}
    >
      <Icon name={icon} className="size-5 lg:size-[18px]" />
    </button>
  );
}

export function Card({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <div id={id} className={`rounded-xl border border-line bg-card lg:rounded-lg ${className}`}>
      {children}
    </div>
  );
}

export function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold lg:px-2 lg:text-xs ${className}`}>{children}</span>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="text-sm text-muted">{hint}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

const inputClass =
  'min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base text-ink placeholder:text-muted focus:border-accent focus:outline-none lg:min-h-8 lg:rounded-md lg:px-2.5 lg:text-sm';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-8 w-13 shrink-0 items-center rounded-full transition ${checked ? 'bg-accent' : 'bg-line'}`}
    >
      <span className={`inline-block size-6 rounded-full bg-white shadow transition ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

/** Bottom sheet on phones, centred dialog on wide screens. Uses <dialog> for focus handling and Escape. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 mt-auto w-full max-w-none bg-transparent p-0 backdrop:bg-black/40 sm:m-auto sm:max-w-md lg:max-w-[28rem]"
    >
      {open && (
        <div className="animate-slide-up max-h-[85vh] overflow-y-auto rounded-t-2xl bg-card p-5 pb-8 text-ink shadow-xl sm:rounded-xl lg:p-4 lg:pb-5">
          <div className="mb-4 flex items-center justify-between gap-3 lg:mb-3">
            <h2 id={titleId} className="text-xl font-bold lg:text-base">{title}</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-card-muted lg:size-8 lg:rounded-md">
              <Icon name="close" className="size-5" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function PageHeader({ title, subtitle, left, right }: { title: string; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex items-center gap-3 pb-4 pt-5 lg:pb-3 lg:pt-4">
      {left}
      <div className="min-w-0 flex-1">
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        <h1 className="line-clamp-2 text-2xl font-bold leading-tight sm:text-3xl lg:text-xl">{title}</h1>
      </div>
      {right}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="text-lg font-semibold lg:text-base">{title}</p>
      {children && <div className="text-muted">{children}</div>}
    </Card>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex justify-center py-10">
      <span className="size-7 animate-spin rounded-full border-[3px] border-line border-t-accent" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-fresh-red-soft px-3 py-2 text-sm text-fresh-red-text">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
