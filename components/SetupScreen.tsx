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
    if (title && adminSettings.questionCount > 0) {
      // 90 seconds per question
      const timerInSeconds = adminSettings.questionCount * 90;
      onGenerate(title, adminSettings.questionCount, assessmentType, timerInSeconds, jobDescription, effectiveScope, selectedCompanyId);
    }
  };

  // Environment-only run: no person assessment, jump straight to the workplace survey.
  const handleEnvironmentOnly = () => {
    const title = getJobTitle() || (language === 'ar' ? 'تقييم بيئة العمل' : 'Work Environment');
    onGenerate(title, adminSettings.questionCount, 'text', 0, jobDescription, 'environment', selectedCompanyId);
  };

  const SCOPE_OPTIONS: { id: SurveyScope; icon: string; ar: string; en: string }[] = [
    { id: 'person', icon: '👤', ar: 'تقييم الشخص', en: 'Assess Person' },
    { id: 'environment', icon: '🏢', ar: 'تقييم بيئة العمل', en: 'Assess Environment' },
    { id: 'both', icon: '🔄', ar: 'الاثنين معاً', en: 'Both' },
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in">
      <h1 className="text-3xl font-extrabold text-slate-800 flex items-center gap-2">
        <span className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">🎯</span>
        {T.appName}
      </h1>
      <p className="mt-2 text-slate-500 text-sm">Configure and initialize your benchmarking journey</p>
      
      <form onSubmit={(e) => e.preventDefault()} className="mt-8 w-full max-w-lg text-start space-y-6">
        {/* Company picker — candidate chooses THEIR company; its sector drives the job titles below */}
        {companies.length > 0 && (
          <div className="bg-white p-5 rounded-2xl border border-emerald-200 shadow-sm">
            <label htmlFor="company-select" className="block text-sm font-bold text-slate-700 mb-2">
              {language === 'ar' ? '🏢 اختر شركتك' : '🏢 Select your company'}
            </label>
            <select
              id="company-select"
              value={selectedCompanyId}
              onChange={(e) => onCompanyChange(e.target.value)}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white text-sm font-bold"
            >
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {selectedCompany && (
              <div className="mt-3 flex items-center gap-3 bg-emerald-50/40 border border-emerald-100 rounded-xl p-3 animate-fade-in">
                {selectedCompany.logoUrl ? (
                  <img src={selectedCompany.logoUrl} alt={selectedCompany.name} className="w-11 h-11 object-contain bg-white border border-slate-200 rounded-xl" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-black text-lg border border-emerald-200">🏢</div>
                )}
                <div className="text-start min-w-0">
                  <h3 className="text-sm font-black text-slate-800 leading-tight truncate">{selectedCompany.name}</h3>
                  <p className="text-[10px] text-slate-400 font-bold mt-0.5">{selectedCompany.industry || (language === 'ar' ? 'قطاع عملي عام' : 'General Sector')}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Evaluation scope: admin-locked → read-only badge; otherwise selectable */}
        {isLocked ? (
          <div className="bg-white p-5 rounded-2xl border border-emerald-200 shadow-sm">
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-sm font-bold text-slate-700">
                {language === 'ar' ? 'نوع التقييم ونطاقه' : 'Assessment type & scope'}
              </label>
              <span className="text-[10px] font-black bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full border border-emerald-200">
                🔒 {language === 'ar' ? 'محدّد بواسطة الأدمن' : 'Locked by admin'}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {toKindArray(launchConfig!.assessmentKind).map(k => (
                <span key={k} className="text-xs font-extrabold py-2 px-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 text-emerald-700">
                  {k === 'behavioral'
                    ? (language === 'ar' ? '🧠 تقييم سلوكي' : '🧠 Behavioral')
                    : (language === 'ar' ? '🎯 تقييم جدارات' : '🎯 Competency')}
                </span>
              ))}
              <span className="text-xs font-extrabold py-2 px-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 text-emerald-700">
                {SCOPE_OPTIONS.find(o => o.id === effectiveScope)?.icon}{' '}
                {language === 'ar'
                  ? SCOPE_OPTIONS.find(o => o.id === effectiveScope)?.ar
                  : SCOPE_OPTIONS.find(o => o.id === effectiveScope)?.en}
              </span>
              {launchConfig!.mandatory && (
                <span className="text-xs font-extrabold py-2 px-3 rounded-xl border-2 border-amber-400 bg-amber-50 text-amber-700">
                  {language === 'ar' ? '⚠️ الإجابة إلزامية' : '⚠️ Mandatory'}
                </span>
              )}
            </div>
            <p className="text-[10px] text-slate-400 mt-2">
              {language === 'ar' ? 'حدّد الأدمن النوع والنطاق — تجاوب فقط دون تغييرهما.' : 'Admin set the type and scope — you only answer; you cannot change them.'}
            </p>
          </div>
        ) : (
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <label className="block text-sm font-bold text-slate-700 mb-3">
            {language === 'ar' ? 'نوع التقييم المطلوب إطلاقه' : 'Evaluation scope to launch'}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {SCOPE_OPTIONS.map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setScope(opt.id)}
                className={`flex flex-col items-center justify-center gap-1 py-3 px-2 rounded-xl border-2 text-xs font-extrabold transition-all ${
                  scope === opt.id
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700 shadow-sm'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                }`}
              >
                <span className="text-lg">{opt.icon}</span>
                {language === 'ar' ? opt.ar : opt.en}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* Role Select */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative">
          <label htmlFor="job-role" className="block text-sm font-bold text-slate-700 mb-2">{T.selectJob}</label>
          <select
            id="job-role"
            value={selectedRoleId}
            onChange={(e) => setSelectedRoleId(e.target.value)}
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white text-sm font-medium"
          >
            {roles.map(role => (
              <option key={role.id} value={role.id}>
                {language === 'en' ? role.title_en : role.title_ar}
              </option>
            ))}
            <option value="other">{language === 'en' ? 'Other...' : 'آخر...'}</option>
          </select>
        </div>

        {isOtherSelected && (
           <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm animate-fade-in">
             <label htmlFor="custom-job-title" className="block text-sm font-bold text-slate-700 mb-2">{language === 'en' ? 'Enter Custom Job Title' : 'أدخل المسمى الوظيفي المخصص'}</label>
             <input
               type="text"
               id="custom-job-title"
               value={customJobTitle}
               onChange={(e) => setCustomJobTitle(e.target.value)}
               placeholder={language === 'en' ? 'e.g., Cloud Architect' : 'مثال: مهندس أول نظم سحابية'}
               className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
             />
           </div>
        )}

        {/* Strategic Context Descriptions */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <label htmlFor="job-desc" className="block text-sm font-bold text-slate-700 mb-1">{T.jobDescription}</label>
          <p className="text-[11px] text-slate-400 mb-3">{T.jobDescriptionPlaceholder}</p>
          <textarea
            id="job-desc"
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[100px] resize-y text-sm"
          />
        </div>

        {/* ADMIN RULE PRESET SUMMARY */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-3">
          <div className="flex justify-between items-center border-b border-slate-250 pb-2">
            <span className="text-xs font-black text-slate-500 uppercase tracking-widest">
              {language === 'ar' ? 'مواصفات التقييم الجاري' : 'Configured Parameters'}
            </span>
            <span className="p-1 px-3 bg-emerald-600 text-white font-mono font-black rounded-full text-xs">
              {adminSettings.questionCount} {language === 'ar' ? 'سؤال' : 'Q'}
            </span>
          </div>

          <div className="space-y-1">
            <span className="text-xs font-bold text-slate-600 block">Assessment Methodology Tools:</span>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {adminSettings.theories.birkman && (
                <span className="text-[10px] font-black uppercase text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">Birkman Analysis</span>
              )}
              {adminSettings.theories.holland && (
                <span className="text-[10px] font-black uppercase text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">Holland RIASEC</span>
              )}
              {adminSettings.theories.psychTech && (
                <span className="text-[10px] font-black uppercase text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">Psych Tech Scenarios</span>
              )}
              {adminSettings.theories.bloomTaxonomy && (
                <span className="text-[10px] font-black uppercase text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">Bloom's Taxonomy</span>
              )}
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed mt-2">
              📂 {language === 'ar' ? 'الأسئلة وسيناريوهاتها مخصصة وفقاً لقاعدة معرفة المؤسسة.' : 'Interview scenarios are dynamically tailored using corporate Knowledge Base context documents.'}
            </p>
          </div>
        </div>

        {/* Action triggers */}
        {effectiveScope === 'environment' ? (
          <div className="pt-2">
            <button
              type="button"
              onClick={handleEnvironmentOnly}
              className="w-full flex flex-col items-center justify-center p-6 border-2 border-emerald-200 rounded-2xl hover:border-emerald-500 hover:bg-emerald-50/50 transition-all duration-300 group bg-white shadow-sm"
            >
              <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform border border-emerald-100">
                <span className="text-2xl">🏢</span>
              </div>
              <span className="font-extrabold text-slate-800 text-sm">
                {language === 'ar' ? 'ابدأ تقييم بيئة العمل' : 'Start Work Environment Survey'}
              </span>
              <span className="text-[10px] text-slate-400 mt-1 uppercase tracking-widest">
                {language === 'ar' ? 'استبيان تشخيص بيئة العمل (ISO / EFQM)' : 'Workplace diagnostics survey'}
              </span>
            </button>
          </div>
        ) : (
        <div className="pt-2">
          {/* ONE merged interview path: MCQ base with a few embedded interactive
              voice questions. Camera + mic requested at the start (lobby). */}
          <button
            type="button"
            onClick={() => handleGenerate('verbal')}
            className="w-full flex flex-col items-center justify-center p-6 border-2 border-emerald-200 rounded-2xl hover:border-emerald-500 hover:bg-emerald-50/50 transition-all duration-300 group bg-white shadow-sm"
          >
            <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform border border-emerald-100">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
            </div>
            <span className="font-extrabold text-slate-800 text-sm">
              {language === 'ar' ? 'ابدأ المقابلة التفاعلية' : 'Start Interactive Interview'}
            </span>
            <span className="text-[10px] text-slate-400 mt-1 uppercase tracking-widest text-center">
              {language === 'ar'
                ? 'أسئلة اختيار من متعدد + أسئلة صوتية تفاعلية في مسار واحد'
                : 'Multiple-choice + embedded interactive voice — one path'}
            </span>
          </button>
        </div>
        )}
      </form>
    </div>
  );
};

export default SetupScreen;
