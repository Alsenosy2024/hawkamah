// B4 — Shared portal thank-you / completion card.
//
// One terminal success surface for every candidate query flow. Replaces the survey's
// and the employee portal's separately-built thank-you cards with a single consistent
// completion screen (green check + title + message + optional footnote).
import React from 'react';
import type { Language } from '../types';

interface Props {
  message: React.ReactNode;
  title?: string;
  footnote?: string;
  language?: Language;
}

const PortalThankYou: React.FC<Props> = ({ message, title, footnote, language = 'ar' }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  return (
    <div className="hw-card p-8 max-w-md w-full text-center space-y-4">
      <div className="flex justify-center mb-1">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-50 dark:bg-green-900/30">
          <svg className="w-6 h-6 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      </div>
      <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{title ?? t('شكراً جزيلاً!', 'Thank you!')}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{message}</p>
      {footnote && <p className="text-xs text-slate-400">{footnote}</p>}
    </div>
  );
};

export default PortalThankYou;
