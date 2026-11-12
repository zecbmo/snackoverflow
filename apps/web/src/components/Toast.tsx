/** Short confirmations at the bottom of the screen, with an optional Undo. */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
  tone: 'info' | 'error';
}

interface ToastApi {
  show(message: string, opts?: { action?: ToastAction; tone?: 'info' | 'error' }): void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback<ToastApi['show']>(
    (message, opts) => {
      const id = next.current++;
      setItems((all) => [...all.slice(-2), { id, message, action: opts?.action, tone: opts?.tone ?? 'info' }]);
      setTimeout(() => dismiss(id), opts?.action ? 6000 : 3500);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`animate-slide-up pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3 shadow-lg ${
              t.tone === 'error' ? 'bg-fresh-red-text text-white' : 'bg-ink text-bg'
            }`}
          >
            <p className="flex-1 text-[15px]">{t.message}</p>
            {t.action && (
              <button
                type="button"
                className="min-h-11 rounded-lg px-3 font-semibold text-accent-soft underline-offset-2 hover:underline"
                onClick={() => {
                  dismiss(t.id);
                  void t.action?.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
