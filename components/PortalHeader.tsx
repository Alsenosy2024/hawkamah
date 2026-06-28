// B4 — Shared portal header (slim persistent top bar).
//
// Standardizes the branded header across every candidate query flow. Previously the
// survey used a slim top bar with a letter-avatar while the employee portal used a
// stacked, centered header with an optional logo image — two different looks. This
// is the single header: a slim hairline-bottom bar with the company logo (image when
// the token carries one, letter-avatar fallback) + name + a per-flow subtitle.
import React from 'react';
import type { Language } from '../types';

interface Props {
  companyName?: string;
  logoUrl?: string;
  /** Right-side context label, e.g. "Workplace Environment Survey" / "Employee Assessment". */
  subtitle: string;
  language?: Language;
}

const PortalHeader: React.FC<Props> = ({ companyName, logoUrl, subtitle, language = 'ar' }) => (
  <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 h-12 flex items-center gap-3 shrink-0">
    {logoUrl ? (
      <img src={logoUrl} alt={companyName || ''} className="h-7 max-w-[120px] object-contain select-none" />
    ) : companyName ? (
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-emerald-600 text-white font-bold text-xs select-none">
        {companyName[0]}
      </span>
    ) : null}
    <div className="flex items-center gap-2 min-w-0">
      {companyName && (
        <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{companyName}</span>
      )}
      {companyName && (
        <span className="hidden sm:inline text-slate-300 dark:text-slate-600 text-xs select-none">·</span>
      )}
      <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{subtitle}</span>
    </div>
  </header>
);

export default PortalHeader;
