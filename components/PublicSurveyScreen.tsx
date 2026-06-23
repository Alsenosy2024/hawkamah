// Public survey page — accessed via ?s=TOKEN (no admin login needed).
// Reads the token to get tenant/company context, shows a participant info form,
// then shows WorkplaceSurveyScreen. No other company names or data are ever shown here.
import React, { useState, useEffect } from 'react';
import { getSurveyToken, savePublicResponse } from '../services/surveyTokenService';
import WorkplaceSurveyScreen from './WorkplaceSurveyScreen';
import type { SurveyToken, WorkEnvironmentAnswers } from '../types';
import { UI } from '../services/designTokens';

interface Props {
  token: string;
}

interface ParticipantInfo {
  name: string;
  email: string;
  jobTitle: string;
  department: string;
}

const PublicSurveyScreen: React.FC<Props> = ({ token }) => {
  const [tokenData, setTokenData] = useState<SurveyToken | null>(null);
  const [state, setState] = useState<'loading' | 'info_form' | 'survey' | 'submitting' | 'done' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [participant, setParticipant] = useState<ParticipantInfo>({ name: '', email: '', jobTitle: '', department: '' });
  const [formErr, setFormErr] = useState('');

  const ar = tokenData?.language !== 'en';
  const t = (a: string, e: string) => ar ? a : e;

  useEffect(() => {
    getSurveyToken(token)
      .then(tok => {
        if (!tok) {
          setErrorMsg('هذا الرابط غير صحيح أو انتهت صلاحيته.');
          setState('error');
          return;
        }
        setTokenData(tok);
        setState('info_form');
      })
      .catch(() => {
        setErrorMsg('تعذّر تحميل الاستبيان. تحقق من اتصالك وأعد المحاولة.');
        setState('error');
      });
  }, [token]);

  const handleInfoSubmit = () => {
    if (!participant.name.trim()) { setFormErr(t('الاسم مطلوب.', 'Name is required.')); return; }
    if (!participant.email.trim() || !participant.email.includes('@')) { setFormErr(t('بريد إلكتروني صالح مطلوب.', 'Valid email required.')); return; }
    if (!participant.jobTitle.trim()) { setFormErr(t('المسمى الوظيفي مطلوب.', 'Job title required.')); return; }
    setFormErr('');
    setState('survey');
  };

  const handleSubmit = async (answers: WorkEnvironmentAnswers) => {
    if (!tokenData) return;
    setState('submitting');
    try {
      await savePublicResponse({
        tokenId: token,
        tenantId: tokenData.tenantId,
        projectId: tokenData.projectId,
        companyName: tokenData.companyName,
        answers,
        submittedAt: new Date().toISOString(),
        respondentName: participant.name,
        respondentEmail: participant.email,
        respondentJobTitle: participant.jobTitle,
        ...(participant.department.trim() ? { respondentDepartment: participant.department } : {}),
      });
      setState('done');
    } catch {
      setErrorMsg(t('حدث خطأ أثناء الإرسال. أعد المحاولة.', 'An error occurred. Please try again.'));
      setState('error');
    }
  };

  const dir = tokenData?.language === 'en' ? 'ltr' : 'rtl';

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950" dir={dir}>
      {/* Minimal branded header */}
      <header className="bg-slate-900 text-white px-6 py-4 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold text-sm">
          {tokenData?.companyName?.[0] ?? ''}
        </div>
        <div>
          {tokenData && (
            <div className="font-semibold text-sm">{tokenData.companyName}</div>
          )}
          <div className="text-xs text-slate-400">
            {t('استبيان بيئة العمل', 'Workplace Environment Survey')}
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4">
        {state === 'loading' && (
          <div className="flex flex-col items-center gap-3 text-slate-500">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">{t('جارٍ التحميل…', 'Loading…')}</span>
          </div>
        )}

        {state === 'error' && (
          <div className={`${UI.sectionFrame} max-w-md p-8 text-center space-y-3`}>
            <div className="text-4xl">⚠️</div>
            <p className="text-slate-700 dark:text-slate-200 font-medium">{errorMsg}</p>
            <p className="text-xs text-slate-500">{t('تواصل مع المسؤول للحصول على رابط جديد.', 'Contact the administrator for a new link.')}</p>
          </div>
        )}

        {state === 'submitting' && (
          <div className="flex flex-col items-center gap-3 text-slate-500">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">{t('جارٍ إرسال إجاباتك…', 'Submitting your answers…')}</span>
          </div>
        )}

        {state === 'done' && (
          <div className={`${UI.sectionFrame} max-w-md p-10 text-center space-y-4`}>
            <div className="text-5xl">✅</div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('شكراً جزيلاً!', 'Thank you!')}</h2>
            <p className="text-slate-600 dark:text-slate-300">
              {t('تم استلام إجاباتك بنجاح.', 'Your answers have been received successfully.')}
              {tokenData && <> {t('ستصل نتائجك لإدارة', 'Results will reach the management of')} <strong>{tokenData.companyName}</strong>.</>}
            </p>
            <p className="text-xs text-slate-400">{t('يمكنك إغلاق هذه النافذة الآن.', 'You may close this window now.')}</p>
          </div>
        )}

        {state === 'info_form' && tokenData && (
          <div className={`${UI.sectionFrame} w-full max-w-md p-8`}>
            <div className="text-center mb-6">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 dark:bg-emerald-900/40 flex items-center justify-center text-3xl mx-auto mb-3">📋</div>
              <h2 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">
                {t('بياناتك الشخصية', 'Your Information')}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {t('نحتاج هذه المعلومات لمعرفة من ملأ الاستبيان', 'We need this information to know who filled out the survey')}
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  {t('الاسم الكامل *', 'Full Name *')}
                </label>
                <input
                  type="text"
                  value={participant.name}
                  onChange={e => setParticipant(p => ({ ...p, name: e.target.value }))}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                  placeholder={t('أدخل اسمك الكامل', 'Enter your full name')}
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  {t('البريد الإلكتروني *', 'Email *')}
                </label>
                <input
                  type="email"
                  value={participant.email}
                  onChange={e => setParticipant(p => ({ ...p, email: e.target.value }))}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                  placeholder={t('example@company.com', 'example@company.com')}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  {t('المسمى الوظيفي *', 'Job Title *')}
                </label>
                <input
                  type="text"
                  value={participant.jobTitle}
                  onChange={e => setParticipant(p => ({ ...p, jobTitle: e.target.value }))}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                  placeholder={t('مثال: مهندس مدني، محاسب، مدير مشروع', 'e.g., Civil Engineer, Accountant, Project Manager')}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  {t('الإدارة / القسم', 'Department')}
                </label>
                <input
                  type="text"
                  value={participant.department}
                  onChange={e => setParticipant(p => ({ ...p, department: e.target.value }))}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                  placeholder={t('التطوير', 'Development')}
                />
              </div>

              {formErr && (
                <p className="text-rose-600 dark:text-rose-400 text-sm font-medium">{formErr}</p>
              )}

              <button
                type="button"
                onClick={handleInfoSubmit}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold py-3.5 rounded-xl shadow-lg transition-colors mt-2"
              >
                {t('متابعة ←', '→ Continue')}
              </button>
            </div>
          </div>
        )}

        {state === 'survey' && tokenData && (
          <div className="w-full max-w-3xl">
            <WorkplaceSurveyScreen
              onSubmit={handleSubmit}
              language={tokenData.language}
              mandatory={true}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default PublicSurveyScreen;
