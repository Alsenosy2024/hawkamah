// B4 — Shared participant info form.
//
// One identity-capture card for every candidate query flow. Reconciles the two
// previously hand-built forms (survey: name/email/jobTitle/department; employee
// assessment: same + an optional jobRoles <select> when the token carries roles)
// into a single component. Presentational + controlled: the parent owns the values,
// validation, and the submit handler (which is the user gesture that may start
// proctoring) — this just renders the fields, the optional monitoring consent
// notice, the validation error, and the continue button.
import React from 'react';
import MonitoringConsentNotice from './MonitoringConsentNotice';
import type { Language, JobRole } from '../types';

export interface ParticipantValues {
  name: string;
  email: string;
  jobTitle: string;
  department: string;
}
// The job-role shape is the canonical JobRole from types.ts (id is a number).
export type ParticipantJobRole = JobRole;

interface Props {
  values: ParticipantValues;
  onChange: (patch: Partial<ParticipantValues>) => void;
  onSubmit: () => void;
  error?: string;
  language?: Language;
  /** When provided & non-empty, the job-title field becomes a <select> of these roles. */
  jobRoles?: ParticipantJobRole[];
  /** Optional serif hero title above the fields (survey shows one; employee relies on the header). */
  title?: string;
  subtitle?: string;
  /** Continue-button label; defaults to متابعة / Continue. */
  submitLabel?: string;
  /** Show the camera/screen monitoring consent notice above the button (when proctoring starts on submit). */
  showConsent?: boolean;
  consentContext?: 'survey' | 'assessment';
}

const labelCls = 'block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5';

const ParticipantInfoForm: React.FC<Props> = ({
  values, onChange, onSubmit, error, language = 'ar', jobRoles,
  title, subtitle, submitLabel, showConsent = false, consentContext = 'survey',
}) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const hasRoles = !!(jobRoles && jobRoles.length);

  return (
    <div className="hw-card w-full max-w-md">
      {title && (
        <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800 text-center">
          <h2 className="font-serif text-2xl font-bold text-slate-800 dark:text-slate-100 leading-snug">{title}</h2>
          {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">{subtitle}</p>}
        </div>
      )}

      <div className="px-8 py-6 space-y-5">
        <div>
          <label className={labelCls}>{t('الاسم الكامل', 'Full Name')}<span className="text-rose-500 ms-0.5">*</span></label>
          <input
            type="text"
            value={values.name}
            onChange={e => onChange({ name: e.target.value })}
            className="hw-input w-full"
            placeholder={t('أدخل اسمك الكامل', 'Enter your full name')}
            autoFocus
          />
        </div>

        <div>
          <label className={labelCls}>{t('البريد الإلكتروني', 'Email')}<span className="text-rose-500 ms-0.5">*</span></label>
          <input
            type="email"
            value={values.email}
            onChange={e => onChange({ email: e.target.value })}
            className="hw-input w-full"
            placeholder="example@company.com"
            dir="ltr"
          />
        </div>

        <div>
          <label className={labelCls}>{t('المسمى الوظيفي', 'Job Title')}<span className="text-rose-500 ms-0.5">*</span></label>
          {hasRoles ? (
            <select
              value={values.jobTitle}
              onChange={e => onChange({ jobTitle: e.target.value })}
              className="hw-input w-full bg-white dark:bg-slate-900"
            >
              <option value="">{t('اختر مسماك الوظيفي', 'Select your job title')}</option>
              {jobRoles!.map(r => (
                <option key={r.id} value={ar ? r.title_ar : r.title_en}>{ar ? r.title_ar : r.title_en}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values.jobTitle}
              onChange={e => onChange({ jobTitle: e.target.value })}
              className="hw-input w-full"
              placeholder={t('مثال: مهندس مدني، محاسب، مدير مشروع', 'e.g. Civil Engineer, Accountant, Project Manager')}
            />
          )}
        </div>

        <div>
          <label className={labelCls}>
            {t('الإدارة / القسم', 'Department')}
            <span className="text-slate-400 text-xs font-normal ms-1">{t('(اختياري)', '(optional)')}</span>
          </label>
          <input
            type="text"
            value={values.department}
            onChange={e => onChange({ department: e.target.value })}
            className="hw-input w-full"
            placeholder={t('التطوير', 'Development')}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400">
            <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-sm">{error}</span>
          </div>
        )}

        {showConsent && <MonitoringConsentNotice language={language} context={consentContext} />}

        <button type="button" onClick={onSubmit} className="hw-btn hw-btn-primary hw-btn-lg w-full mt-1">
          {submitLabel ?? t('متابعة', 'Continue')}
          <svg className={`w-4 h-4 ${ar ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default ParticipantInfoForm;
