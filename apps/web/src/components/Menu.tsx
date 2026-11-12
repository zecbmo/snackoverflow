/**
 * Dropdown menus: the "⋯" row menu and the toolbar's Filter / Sort / Group pickers.
 * Rendered in a portal with fixed positioning so tables that scroll sideways don't clip them.
 * Keyboard: arrows move, Enter/Space choose, Esc closes and returns focus to the button.
 */
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** For pickers: shows a tick and uses menuitemradio. */
  checked?: boolean;
}

export type MenuEntry = MenuItem | { heading: string } | 'divider';

export function Menu({
  label,
  items,
  trigger,
  align = 'end',
  triggerClassName = '',
}: {
  /** The button's accessible name (and the menu's). */
  label: string;
  items: MenuEntry[];
  /** What the button shows; defaults to a "⋯" icon. */
  trigger?: ReactNode;
  align?: 'start' | 'end';
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; maxHeight: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    setPos({
      top: up ? Math.max(8, r.top - Math.min(above, 360) - 4) : r.bottom + 4,
      maxHeight: Math.min(up ? above : below, 360),
      ...(align === 'end' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onScroll = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      els[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      els[els.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={
          triggerClassName ||
          'inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink lg:size-7 lg:rounded-md'
        }
      >
        {trigger ?? <Icon name="more" className="size-5" strokeWidth={3} />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right, maxHeight: pos.maxHeight }}
            className="z-[60] min-w-48 max-w-72 overflow-y-auto rounded-lg border border-line bg-card p-1 text-ink shadow-xl"
          >
            {items.map((item, i) => {
              if (item === 'divider') return <hr key={i} className="my-1 border-line" />;
              if ('heading' in item)
                return (
                  <p key={i} className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted">
                    {item.heading}
                  </p>
                );
              const checkable = item.checked !== undefined;
              return (
                <button
                  key={i}
                  type="button"
                  role={checkable ? 'menuitemradio' : 'menuitem'}
                  aria-checked={checkable ? item.checked : undefined}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
                  onClick={() => {
                    if (item.disabled) return;
                    close();
                    item.onSelect();
                  }}
                  className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left text-[0.9375rem] outline-none focus:bg-card-muted lg:min-h-8 lg:text-sm ${
                    item.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-card-muted'
                  } ${item.danger ? 'text-danger' : ''}`}
                >
                  {checkable ? (
                    <Icon name="check" className={`size-4 shrink-0 ${item.checked ? 'text-accent-text' : 'invisible'}`} strokeWidth={2.4} />
                  ) : item.icon ? (
                    <Icon name={item.icon} className="size-4 shrink-0 text-muted" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A toolbar picker: "Filter", "Sort: Best before", "Group: Location". Highlighted when it's not on
 * its default, so people can see the view has been changed.
 */
export function PickerMenu<V extends string>({
  label,
  icon,
  value,
  options,
  onChange,
  defaultValue,
  showValue = true,
}: {
  label: string;
  icon: IconName;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  defaultValue: V;
  showValue?: boolean;
}) {
  const active = value !== defaultValue;
  const current = options.find((o) => o.value === value)?.label;
  return (
    <Menu
      label={label}
      align="start"
      items={options.map((o) => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }))}
      triggerClassName={`inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium lg:min-h-8 lg:rounded-md ${
        active ? 'bg-accent-soft text-accent-text' : 'text-ink hover:bg-card-muted'
      }`}
      trigger={
        <>
          <Icon name={icon} className="size-4" />
          {label}
          {showValue && active && current ? <span className="font-semibold">: {current}</span> : null}
          <span className="sr-only">{current ? `, ${current}` : ''}</span>
        </>
      }
    />
  );
}
