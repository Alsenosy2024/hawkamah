// B4 — Shared monitoring/consent notice.
//
// The environment survey, the employee assessment, and the in-app survey gate each
// showed a near-identical amber "this session is monitored via camera + screen" box
// before proctoring begins. This is the single source of truth for that disclosure,
// so every candidate query flow shows the SAME consent copy and styling.
import React from 'react';
import type { Language } from '../types';

interface Props {
  language?: Language;
  /** Tunes the noun ("survey" vs "assessment"); the wording is otherwise identical. */
  context?: 'survey' | 'assessment';
  className?: string;
}

const MonitoringConsentNotice: React.FC<Props> = ({ language = 'ar', context = 'survey', className = '' }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const noun = context === 'assessment'
    ? t('التقييم', 'assessment')
    : t('الاستبيان', 'survey');
  const nounEnd = context === 'assessment'
    ? t('بالبدء', 'By starting')
    : t('بالمتابعة', 'By continuing');

  return (
    <div className={`flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800 ${className}`}>
      <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      <span className="text-xs leading-relaxed">
        {t(
          `تُراقَب هذه الجلسة آلياً عبر الكاميرا ومشاركة الشاشة لضمان نزاهة ${noun}. ${nounEnd} فإنك توافق على ذلك.`,
          `This session is monitored automatically via your camera and screen-share to ensure ${noun} integrity. ${nounEnd}, you consent to this.`,
        )}
      </span>
    </div>
  );
};

export default MonitoringConsentNotice;
