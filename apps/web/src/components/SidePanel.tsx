/**
 * A record opened from a table: slides in from the right on desktop (the table stays usable),
 * fills the screen on phones. The open record lives in the URL (?open=id), so links work and
 * the browser's back button closes it.
 */
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Icon } from './Icon';

export function usePanelParam(key = 'open'): [string | null, (id: string) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const current = params.get(key);
  const open = (id: string) => {
    if (id === current) return;
    setParams(
      (p) => {
        p.set(key, id);
        return p;
      },
      // Opening from the table adds a history entry; switching records replaces it.
      { replace: Boolean(current), state: { panel: true } },
    );
  };
  const close = () => {
    if ((location.state as { panel?: boolean } | null)?.panel) navigate(-1);
    else
      setParams(
        (p) => {
          p.delete(key);
          return p;
        },
        { replace: true },
      );
  };
  return [current, open, close];
}

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  headerActions,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Leave Escape to an open dialog or menu first.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], [role="menu"]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="animate-panel-in fixed inset-0 z-40 flex flex-col bg-card text-ink outline-none lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[30rem] lg:max-w-[calc(100vw-4rem)] lg:border-l lg:border-line lg:shadow-2xl"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:px-4 lg:py-3">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink lg:size-8 lg:rounded-md"
        >
          <Icon name="close" className="size-5 lg:size-[18px]" />
        </button>
        <div className="min-w-0 flex-1 pt-1.5 lg:pt-0.5">
          <h2 id={titleId} className="text-lg font-bold leading-snug lg:text-base">
            {title}
          </h2>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {headerActions && <div className="flex shrink-0 items-center gap-1 pt-0.5">{headerActions}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      {footer && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
    </div>,
    document.body,
  );
}
