// B4 — Shared portal error card.
//
// One terminal error surface for every candidate query flow (invalid/expired link,
// load failure, save failure). Replaces the survey's amber-triangle hw-card and the
// employee portal's rose-circle raw card with a single consistent error screen.
import React from 'react';
import type { Language } from '../types';

interface Props {
  message: string;
  /** Optional override title; defaults to a localized "Invalid Link". */
  title?: string;
  /** Optional secondary hint; defaults to a localized "contact the administrator". */
  hint?: string;
  language?: Language;
}

const PortalErrorCard: React.FC<Props> = ({ message, title, hint, language = 'ar' }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  return (
    <div className="hw-card p-8 max-w-md w-full text-center space-y-3">
      <div className="flex justify-center mb-1">
        <span className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-amber-50 border border-amber-200">
          <svg className="w-6 h-6 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </span>
      </div>
      {title && <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">{title}</h2>}
      <p className="text-slate-700 dark:text-slate-200 font-semibold text-sm leading-relaxed">{message}</p>
      <p className="text-xs text-slate-400">
        {hint ?? t('تواصل مع المسؤول للحصول على رابط جديد.', 'Contact the administrator for a new link.')}
      </p>
    </div>
  );
};

export default PortalErrorCard;
