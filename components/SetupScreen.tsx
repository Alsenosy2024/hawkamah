import React, { useMemo, useState } from 'react';
import { Language, AdminSettings, SurveyScope, toKindArray } from '../types';
import { TRANSLATIONS, getRolesForCompany } from '../constants';

interface SetupScreenProps {
  onGenerate: (jobTitle: string, numQuestions: number, assessmentType: 'text' | 'verbal', timerInSeconds: number, jobDescription: string | undefined, surveyScope: SurveyScope, companyId?: string) => void;
  language: Language;
  adminSettings: AdminSettings;
}

const SetupScreen: React.FC<SetupScreenProps> = ({ onGenerate, language, adminSettings }) => {
  const companies = adminSettings.clientProfiles || [];
  // Candidate picks THEIR company; default to the admin-activated one.
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(
    adminSettings.activeClientProfileId || companies[0]?.id || ''
  );
  const selectedCompany = useMemo(
    () => companies.find(c => c.id === selectedCompanyId) || null,
    [companies, selectedCompanyId]
  );
  // Job titles are derived from the chosen company's sector (or its explicit list).
  const roles = useMemo(() => getRolesForCompany(selectedCompany), [selectedCompany]);

  const [selectedRoleId, setSelectedRoleId] = useState<string>(String(roles[0]?.id ?? ''));
  const [customJobTitle, setCustomJobTitle] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  // Editable question count (defaults to the admin setting; adjustable for testing).
  const [numQuestions, setNumQuestions] = useState<number>(adminSettings.questionCount || 30);

  // When the company changes, the role set changes — snap selection to the first role.
  const onCompanyChange = (id: string) => {
    setSelectedCompanyId(id);
    const next = getRolesForCompany(companies.find(c => c.id === id) || null);
    setSelectedRoleId(String(next[0]?.id ?? ''));
  };

  // Admin lock: when locked, the employee cannot pick scope/type — config wins.
  const launchConfig = adminSettings.surveyLaunchConfig;
  const isLocked = !!launchConfig?.locked;
  const [scope, setScope] = useState<SurveyScope>(
    isLocked ? launchConfig!.scope : (adminSettings.surveyScopeDefault || 'both')
  );
  // Effective scope passed downstream always respects the lock.
  const effectiveScope: SurveyScope = isLocked ? launchConfig!.scope : scope;

  const T = TRANSLATIONS[language];
  const isOtherSelected = selectedRoleId === 'other';

  const getJobTitle = () => {
    if (isOtherSelected) {
      return customJobTitle.trim();
    }
    const selectedRole = roles.find(role => String(role.id) === selectedRoleId);
    return selectedRole ? (language === 'en' ? selectedRole.title_en : selectedRole.title_ar) : '';
  };

  const handleGenerate = (assessmentType: 'text' | 'verbal') => {
    const title = getJobTitle();
    if (title && numQuestions > 0) {
      // 90 seconds per question
      const timerInSeconds = numQuestions * 90;
      onGenerate(title, numQuestions, assessmentType, timerInSeconds, jobDescription, effectiveScope, selectedCompanyId);
    }
  };

  // Environment-only run: no person assessment, jump straight to the workplace survey.
  const handleEnvironmentOnly = () => {
    const title = getJobTitle() || (language === 'ar' ? 'تقييم بيئة العمل' : 'Work Environment');
    onGenerate(title, numQuestions, 'text', 0, jobDescription, 'environment', selectedCompanyId);
  };

  const SCOPE_OPTIONS: { id: SurveyScope; ar: string; en: string }[] = [
    { id: 'person', ar: 'تقييم الشخص', en: 'Assess Person' },
    { id: 'environment', ar: 'تقييم بيئة العمل', en: 'Assess Environment' },
    { id: 'both', ar: 'الاثنين معاً', en: 'Both' },
  ];

  return (
    <div className="flex flex-col items-center justify-start min-h-full py-10 px-4 animate-fade-in">

      {/* Page header */}
      <div className="w-full max-w-lg mb-8 text-start">
        <h1 className="font-serif text-2xl font-bold text-slate-900 leading-tight">
          {T.appName}
        </h1>
        <p className="mt-1 text-sm text-slate-500 leading-relaxed">
          {language === 'ar' ? 'اضبط معاملات الجلسة قبل البدء' : 'Configure session parameters before starting'}
        </p>
      </div>

      <form onSubmit={(e) => e.preventDefault()} className="w-full max-w-lg space-y-0">

        {/* Single outer card containing all config sections */}
        <div className="hw-card divide-y divide-slate-200 overflow-hidden">

          {/* Company picker */}
          {companies.length > 0 && (
            <div className="p-5 space-y-3">
              <label htmlFor="company-select" className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
                {language === 'ar' ? 'الجهة' : 'Organisation'}
              </label>
              <select
                id="company-select"
                value={selectedCompanyId}
                onChange={(e) => onCompanyChange(e.target.value)}
                className="hw-input text-sm font-medium"
              >
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {selectedCompany && (
                <div className="flex items-center gap-3 bg-[#EEF3F5] rounded-md px-3 py-2.5 animate-fade-in">
                  {selectedCompany.logoUrl ? (
                    <img src={selectedCompany.logoUrl} alt={selectedCompany.name} className="w-9 h-9 object-contain bg-white border border-slate-200 rounded-md flex-shrink-0" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-9 h-9 rounded-md bg-white border border-slate-200 text-slate-400 flex items-center justify-center flex-shrink-0 text-base">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-800 leading-tight truncate">{selectedCompany.name}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5 truncate">{selectedCompany.industry || (language === 'ar' ? 'قطاع عام' : 'General sector')}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Evaluation scope */}
          {isLocked ? (
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                  {language === 'ar' ? 'النطاق والنوع' : 'Scope & type'}
                </span>
                <span className="hw-badge-neutral text-[10px] flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>
                  {language === 'ar' ? 'محدّد بالأدمن' : 'Locked by admin'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {toKindArray(launchConfig!.assessmentKind).map(k => (
                  <span key={k} className="hw-badge-brand text-xs">
                    {k === 'behavioral'
                      ? (language === 'ar' ? 'سلوكي' : 'Behavioral')
                      : (language === 'ar' ? 'جدارات' : 'Competency')}
                  </span>
                ))}
                <span className="hw-badge-brand text-xs">
                  {language === 'ar'
                    ? SCOPE_OPTIONS.find(o => o.id === effectiveScope)?.ar
                    : SCOPE_OPTIONS.find(o => o.id === effectiveScope)?.en}
                </span>
                {launchConfig!.mandatory && (
                  <span className="hw-badge-warning text-xs">
                    {language === 'ar' ? 'إلزامي' : 'Mandatory'}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                {language === 'ar' ? 'حدّد الأدمن النوع والنطاق، تجاوب فقط دون تغييرهما.' : 'Admin configured the type and scope; respond only, no changes permitted.'}
              </p>
            </div>
          ) : (
            <div className="p-5 space-y-3">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
                {language === 'ar' ? 'نطاق التقييم' : 'Evaluation scope'}
              </label>
              {/* Segmented control */}
              <div className="flex rounded-md border border-slate-200 overflow-hidden divide-x divide-slate-200 rtl:divide-x-reverse">
                {SCOPE_OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setScope(opt.id)}
                    className={`flex-1 py-2.5 px-2 text-xs font-bold transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-inset ${
                      scope === opt.id
                        ? 'bg-emerald-600 text-white'
                        : 'bg-white text-slate-500 hover:bg-[#EEF3F5] hover:text-slate-700'
                    }`}
                  >
                    {language === 'ar' ? opt.ar : opt.en}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Role select */}
          <div className="p-5 space-y-2">
            <label htmlFor="job-role" className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
              {T.selectJob}
            </label>
            <select
              id="job-role"
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
              className="hw-input text-sm font-medium"
            >
              {roles.map(role => (
                <option key={role.id} value={role.id}>
                  {language === 'en' ? role.title_en : role.title_ar}
                </option>
              ))}
              <option value="other">{language === 'en' ? 'Other...' : 'آخر...'}</option>
            </select>

            {isOtherSelected && (
              <div className="pt-2 animate-fade-in">
                <label htmlFor="custom-job-title" className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
                  {language === 'en' ? 'Custom job title' : 'المسمى الوظيفي المخصص'}
                </label>
                <input
                  type="text"
                  id="custom-job-title"
                  value={customJobTitle}
                  onChange={(e) => setCustomJobTitle(e.target.value)}
                  placeholder={language === 'en' ? 'e.g., Cloud Architect' : 'مثال: مهندس أول نظم سحابية'}
                  className="hw-input text-sm"
                />
              </div>
            )}
          </div>

          {/* Job description / strategic context */}
          <div className="p-5 space-y-2">
            <label htmlFor="job-desc" className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
              {T.jobDescription}
            </label>
            <p className="text-[11px] text-slate-400 leading-relaxed">{T.jobDescriptionPlaceholder}</p>
            <textarea
              id="job-desc"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              className="hw-textarea text-sm min-h-[96px] resize-y"
            />
          </div>

          {/* Assessment parameters summary */}
          <div className="px-5 py-4 bg-[#EEF3F5]">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {language === 'ar' ? 'مواصفات التقييم' : 'Assessment parameters'}
              </span>
              <div className="inline-flex items-center gap-1.5">
                <label htmlFor="num-questions" className="text-[10px] font-semibold text-slate-400">
                  {language === 'ar' ? 'عدد الأسئلة' : 'Questions'}
                </label>
                <input
                  id="num-questions"
                  type="number"
                  min={1}
                  max={50}
                  value={numQuestions}
                  onChange={(e) => setNumQuestions(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-14 text-center bg-white border border-slate-300 rounded-md py-1 px-1.5 text-xs font-mono font-bold text-slate-800 focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
                  aria-label={language === 'ar' ? 'عدد الأسئلة' : 'Number of questions'}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {adminSettings.theories.birkman && (
                <span className="hw-badge-neutral text-[10px]">Birkman</span>
              )}
              {adminSettings.theories.holland && (
                <span className="hw-badge-neutral text-[10px]">Holland RIASEC</span>
              )}
              {adminSettings.theories.psychTech && (
                <span className="hw-badge-neutral text-[10px]">Psych Tech</span>
              )}
              {adminSettings.theories.bloomTaxonomy && (
                <span className="hw-badge-neutral text-[10px]">Bloom's Taxonomy</span>
              )}
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed mt-2.5">
              {language === 'ar' ? 'الأسئلة مخصصة وفق قاعدة معرفة المؤسسة.' : 'Scenarios tailored from the corporate knowledge base.'}
            </p>
          </div>

        </div>{/* end hw-card */}

        {/* Primary action */}
        <div className="pt-5">
          {effectiveScope === 'environment' ? (
            <button
              type="button"
              onClick={handleEnvironmentOnly}
              className="hw-btn hw-btn-primary hw-btn-lg hw-btn-w flex items-center justify-center gap-2.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <span>{language === 'ar' ? 'ابدأ تقييم بيئة العمل' : 'Start Work Environment Survey'}</span>
            </button>
          ) : (
            /* ONE merged interview path: MCQ base with a few embedded interactive
               voice questions. Camera + mic requested at the start (lobby). */
            <button
              type="button"
              onClick={() => handleGenerate('verbal')}
              className="hw-btn hw-btn-primary hw-btn-lg hw-btn-w flex items-center justify-center gap-2.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>{language === 'ar' ? 'ابدأ المقابلة التفاعلية' : 'Start Interactive Interview'}</span>
            </button>
          )}
          <p className="mt-2.5 text-center text-[11px] text-slate-400">
            {effectiveScope === 'environment'
              ? (language === 'ar' ? 'استبيان تشخيص بيئة العمل (ISO / EFQM)' : 'Workplace diagnostics survey (ISO / EFQM)')
              : (language === 'ar'
                  ? 'أسئلة اختيار من متعدد + أسئلة صوتية تفاعلية في مسار واحد'
                  : 'Multiple-choice + embedded interactive voice, one path')}
          </p>
        </div>

      </form>
    </div>
  );
};

export default SetupScreen;
