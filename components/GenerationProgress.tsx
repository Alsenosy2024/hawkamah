// GenerationProgress — shared spinner/progress/cancel/retry block for the three
// exam portals' question-generation screen (PaperAssessmentPortal, Unified
// AssessmentPortal, OnlineAssessmentPortal). Each portal previously reimplemented
// its own <Spinner> + injected @keyframes with drifting cancel/retry behavior;
// this owns ONLY the inner content (spinner/message/progress bar/buttons) so each
// portal keeps its own outer card/wrapper markup and just drops this in.
import React from 'react';
import type { Language } from '../types';

export interface GenerationProgressProps {
  language: Language;
  title?: string;                 // defaults to a generic "generating questions" title; pass '' to omit (host already shows one)
  message?: string;               // status line under the title
  hint?: string;                  // small helper text (e.g. "may take 30-60s")
  done?: number;                  // completed question count, for a real progress bar
  total?: number;                 // target question count
  error?: string | null;          // when set, shows an error state with retry instead of the spinner
  onCancel?: () => void;          // shown next to the spinner while generation is in flight
  onRetry?: () => void;           // shown in the error state
}

export default function GenerationProgress({
  language, title, message, hint, done, total, error, onCancel, onRetry,
}: GenerationProgressProps) {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const pct = total && total > 0 ? Math.min(100, Math.round((Math.min(done ?? 0, total) / total) * 100)) : null;

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center">
          <svg className="w-6 h-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
        </div>
        <p className="text-rose-600 text-sm leading-relaxed">{error}</p>
        {onRetry && (
          <button type="button" className="hw-btn hw-btn-primary hw-btn-sm" onClick={onRetry}>
            {t('إعادة المحاولة', 'Retry')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center w-full">
      <div className="flex justify-center">
        <svg className="animate-spin h-9 w-9 text-emerald-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>

      {(title !== '' || message) && (
        <div className="space-y-1">
          {title !== '' && (
            <h2 className="text-lg font-bold text-slate-900">{title ?? t('جارٍ توليد الأسئلة', 'Generating questions')}</h2>
          )}
          {message && <p className="text-sm text-slate-500">{message}</p>}
        </div>
      )}

      {/* Real progress bar with counts, once batches start reporting completions. */}
      {pct !== null && (
        <div className="w-full max-w-xs space-y-1">
          <div className="hw-progress">
            <div className="hw-progress-bar transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-slate-400 tabular-nums">
            {t(`${Math.min(done ?? 0, total ?? 0)} من ${total} سؤالاً`, `${Math.min(done ?? 0, total ?? 0)} of ${total} questions`)}
          </p>
        </div>
      )}

      {hint && <p className="text-xs text-slate-400 leading-relaxed max-w-xs">{hint}</p>}

      {onCancel && (
        <button type="button" className="hw-btn hw-btn-danger-ghost hw-btn-sm" onClick={onCancel}>
          {t('إلغاء', 'Cancel')}
        </button>
      )}
    </div>
  );
}
