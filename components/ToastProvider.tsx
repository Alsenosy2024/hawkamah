// ===========================================================================
//  Unified toast notification system. One provider, one look (TOAST_VARIANTS),
//  RTL-aware, stacked top-corner, auto-dismiss, click-to-dismiss. Replaces the
//  three fragmented notifiers (AdminPanel banner, GovernanceCenter window.alert,
//  App error banner) so every surface notifies identically.
// ===========================================================================

import React, { createContext, useCallback, useContext, useState } from 'react';
import { TOAST_VARIANTS, ToastVariant } from '../services/designTokens';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastApi {
  notify: (message: string, variant?: ToastVariant, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let _seq = 0;
const nextId = () => `toast_${++_seq}_${Date.now()}`;

export const ToastProvider: React.FC<{ children: React.ReactNode; dir?: 'rtl' | 'ltr' }> = ({ children, dir = 'rtl' }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const notify = useCallback((message: string, variant: ToastVariant = 'info', duration = 4000) => {
    if (!message) return;
    const id = nextId();
    setToasts(prev => [...prev, { id, message, variant, duration }]);
    if (duration > 0) {
      setTimeout(() => remove(id), duration);
    }
  }, [remove]);

  const api: ToastApi = {
    notify,
    success: (m, d) => notify(m, 'success', d),
    error: (m, d) => notify(m, 'error', d ?? 6000),
    warning: (m, d) => notify(m, 'warning', d ?? 5000),
    info: (m, d) => notify(m, 'info', d),
  };

  const sidePos = dir === 'rtl' ? 'left-4' : 'right-4';

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className={`fixed top-4 ${sidePos} z-[100] flex flex-col gap-2.5 w-[min(90vw,360px)] pointer-events-none`}
        dir={dir}
        aria-live="polite"
        role="status"
      >
        {toasts.map(t => {
          const v = TOAST_VARIANTS[t.variant];
          return (
            <button
              key={t.id}
              onClick={() => remove(t.id)}
              className={`pointer-events-auto group relative rounded-lg border ${v.border} ${v.bg} ${v.text} shadow-md px-3.5 py-3 text-sm text-start flex items-start gap-3 animate-fade-in transition-shadow duration-150 hover:shadow-lg`}
              title="إغلاق"
            >
              <span className={`mt-0.5 shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-sm leading-none ${v.accent} bg-opacity-10`}>{v.icon}</span>
              <span className="leading-relaxed whitespace-pre-wrap break-words flex-1 font-medium pt-0.5">{t.message}</span>
              <span className="shrink-0 mt-0.5 text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300 transition-colors duration-150 leading-none select-none" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
            </button>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

/** Access the unified toast API. Throws if used outside <ToastProvider>. */
export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
};
