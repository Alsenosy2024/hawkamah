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
              className={`pointer-events-auto group relative overflow-hidden rounded-xl border ${v.border} ${v.bg} ${v.text} shadow-lg backdrop-blur-sm px-4 py-3 text-sm font-bold text-start flex items-start gap-2.5 animate-fade-in transition-all hover:shadow-xl`}
              title="إغلاق"
            >
              <span className={`absolute inset-y-0 ${dir === 'rtl' ? 'right-0' : 'left-0'} w-1 ${v.accent}`} />
              <span className="text-base leading-5 shrink-0">{v.icon}</span>
              <span className="leading-relaxed whitespace-pre-wrap break-words flex-1">{t.message}</span>
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
