import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';

type Variant = 'primary' | 'dark' | 'outline' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50',
  dark: 'bg-ink text-bg hover:opacity-90 disabled:opacity-50',
  outline: 'border border-line bg-card text-ink hover:bg-card-muted disabled:opacity-50',
  ghost: 'text-ink hover:bg-card-muted disabled:opacity-50',
  danger: 'border border-line bg-card text-danger hover:bg-card-muted disabled:opacity-50',
};

export function Button({
  variant = 'outline',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'min-h-11 px-3 text-sm', md: 'min-h-11 px-4 text-[15px]', lg: 'min-h-14 px-5 text-base' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function IconButton({ icon, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Parameters<typeof Icon>[0]['name']; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`inline-flex size-11 items-center justify-center rounded-full border border-line bg-card text-ink hover:bg-card-muted ${className}`}
      {...props}
    >
      <Icon name={icon} className="size-5" />
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[18px] border border-line bg-card ${className}`}>{children}</div>;
}

export function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold ${className}`}>{children}</span>;
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
  'min-h-11 w-full rounded-xl border border-line bg-card px-3 text-[16px] text-ink placeholder:text-muted focus:border-accent focus:outline-none';

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
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 mt-auto w-full max-w-none bg-transparent p-0 backdrop:bg-black/40 sm:m-auto sm:max-w-md"
    >
      {open && (
        <div className="animate-slide-up max-h-[85vh] overflow-y-auto rounded-t-3xl bg-card p-5 pb-8 text-ink sm:rounded-3xl">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-bold">{title}</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-card-muted">
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
    <header className="flex items-center gap-4 pb-5 pt-6">
      {left}
      <div className="min-w-0 flex-1">
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        <h1 className="truncate text-3xl font-bold lg:text-[32px]">{title}</h1>
      </div>
      {right}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
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
    <p role="alert" className="rounded-xl bg-fresh-red-soft px-3 py-2 text-sm text-fresh-red-text">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
