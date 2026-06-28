// Public survey page — accessed via ?s=TOKEN (no admin login needed).
// Reads the token to get tenant/company context, shows a participant info form,
// then shows WorkplaceSurveyScreen. No other company names or data are ever shown here.
import React, { useState, useEffect, useRef } from 'react';
import { getSurveyToken, savePublicResponse } from '../services/surveyTokenService';
import WorkplaceSurveyScreen from './WorkplaceSurveyScreen';
import ProctorOverlay from './ProctorOverlay';
import { useProctor } from '../hooks/useProctor';
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

  // ── B3: live AI proctoring (camera + screen-share → Gemini Live signals) ──
  // The environment survey is candidate-facing; the owner asked for full proctoring
  // here too. The shared useProctor hook owns the engine lifecycle; this screen owns
  // the camera stream and the visible preview tiles (rendered via ProctorOverlay).
  const proctor = useProctor({ language: ar ? 'ar' : 'en', intervalMs: 4000 });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const screenPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [camError, setCamError] = useState('');

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
    } catch {
      setCamError(t('تعذّر الوصول للكاميرا — يستمر الاستبيان.', 'Camera unavailable — the survey continues.'));
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    streamRef.current = null;
    proctor.stopProctor();   // captures the integrity summary + releases screen tracks & hidden engine feeds
  };

  // Bind the visible previews once the survey view (and its <video>s) has mounted —
  // the gesture grabs the streams before these elements exist.
  useEffect(() => {
    if (state !== 'survey' && state !== 'submitting') return;
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
    const sp = screenPreviewRef.current, ss = proctor.screenStreamRef.current;
    if (sp && ss && sp.srcObject !== ss) { sp.srcObject = ss; sp.play().catch(() => {}); }
  }, [state, proctor.status]);

  // Release camera + proctor on unmount.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    proctor.stopProctor();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // B3 — begin proctoring on THIS user gesture (getDisplayMedia requires one).
    // Request the screen first, then start the camera + Gemini-Live engine once the
    // screen decision resolves, so the engine receives both streams (or camera-only
    // if screen-share is declined). Never throws — degrades gracefully.
    proctor.requestScreen().then(async (scr) => {
      if (scr && screenPreviewRef.current) {
        screenPreviewRef.current.srcObject = scr;
        screenPreviewRef.current.play().catch(() => {});
      }
      await startCamera();
      proctor.startProctor(streamRef.current, proctor.screenStreamRef.current);
    });
  };

  const handleSubmit = async (answers: WorkEnvironmentAnswers) => {
    if (!tokenData) return;
    setState('submitting');
    stopCamera();   // stop camera + proctor and capture the integrity summary before persisting
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
        ...(proctor.summaryRef.current ? { proctorSummary: proctor.summaryRef.current } : {}),
      });
      setState('done');
    } catch {
      setErrorMsg(t('حدث خطأ أثناء الإرسال. أعد المحاولة.', 'An error occurred. Please try again.'));
      setState('error');
    }
  };

  const dir = tokenData?.language === 'en' ? 'ltr' : 'rtl';

  return (
    <div className="min-h-screen flex flex-col bg-[#F7FAFB] dark:bg-slate-950" dir={dir}>
      {/* Slim branded header — hairline bottom, no heavy shadow */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 h-12 flex items-center gap-3">
        {tokenData?.companyName && (
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-emerald-600 text-white font-bold text-xs select-none">
            {tokenData.companyName[0]}
          </span>
        )}
        <div className="flex items-center gap-2 min-w-0">
          {tokenData && (
            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
              {tokenData.companyName}
            </span>
          )}
          {tokenData && (
            <span className="hidden sm:inline text-slate-300 dark:text-slate-600 text-xs select-none">·</span>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {t('استبيان بيئة العمل', 'Workplace Environment Survey')}
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8">
        {state === 'loading' && (
          <div className="flex flex-col items-center gap-3 text-slate-400 dark:text-slate-500">
            <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">{t('جارٍ التحميل…', 'Loading…')}</span>
          </div>
        )}

        {state === 'error' && (
          <div className="hw-card p-8 max-w-md w-full text-center space-y-3">
            {/* Warning icon */}
            <div className="flex justify-center mb-1">
              <svg className="w-9 h-9 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <p className="text-slate-700 dark:text-slate-200 font-semibold text-sm leading-relaxed">{errorMsg}</p>
            <p className="text-xs text-slate-400">{t('تواصل مع المسؤول للحصول على رابط جديد.', 'Contact the administrator for a new link.')}</p>
          </div>
        )}

        {state === 'submitting' && (
          <div className="flex flex-col items-center gap-3 text-slate-400 dark:text-slate-500">
            <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">{t('جارٍ إرسال إجاباتك…', 'Submitting your answers…')}</span>
          </div>
        )}

        {state === 'done' && (
          <div className="hw-card p-8 max-w-md w-full text-center space-y-4">
            {/* Check icon */}
            <div className="flex justify-center mb-1">
              <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-50 dark:bg-green-900/30">
                <svg className="w-6 h-6 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </span>
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('شكراً جزيلاً!', 'Thank you!')}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {t('تم استلام إجاباتك بنجاح.', 'Your answers have been received successfully.')}
              {tokenData && <> {t('ستصل نتائجك لإدارة', 'Results will reach the management of')} <strong>{tokenData.companyName}</strong>.</>}
            </p>
            <p className="text-xs text-slate-400">{t('يمكنك إغلاق هذه النافذة الآن.', 'You may close this window now.')}</p>
          </div>
        )}

        {state === 'info_form' && tokenData && (
          <div className="hw-card w-full max-w-md">
            {/* Card header with serif hero title */}
            <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800 text-center">
              <h2 className="font-serif text-2xl font-bold text-slate-800 dark:text-slate-100 leading-snug">
                {t('بياناتك الشخصية', 'Your Information')}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">
                {t('نحتاج هذه المعلومات لمعرفة من ملأ الاستبيان', 'We need this information to know who completed the survey')}
              </p>
            </div>

            {/* Form fields */}
            <div className="px-8 py-6 space-y-5">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('الاسم الكامل', 'Full Name')}
                  <span className="text-rose-500 ms-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={participant.name}
                  onChange={e => setParticipant(p => ({ ...p, name: e.target.value }))}
                  className="hw-input w-full"
                  placeholder={t('أدخل اسمك الكامل', 'Enter your full name')}
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('البريد الإلكتروني', 'Email')}
                  <span className="text-rose-500 ms-0.5">*</span>
                </label>
                <input
                  type="email"
                  value={participant.email}
                  onChange={e => setParticipant(p => ({ ...p, email: e.target.value }))}
                  className="hw-input w-full"
                  placeholder={t('example@company.com', 'example@company.com')}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('المسمى الوظيفي', 'Job Title')}
                  <span className="text-rose-500 ms-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={participant.jobTitle}
                  onChange={e => setParticipant(p => ({ ...p, jobTitle: e.target.value }))}
                  className="hw-input w-full"
                  placeholder={t('مثال: مهندس مدني، محاسب، مدير مشروع', 'e.g., Civil Engineer, Accountant, Project Manager')}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('الإدارة / القسم', 'Department')}
                  <span className="text-slate-400 text-xs font-normal ms-1">{t('(اختياري)', '(optional)')}</span>
                </label>
                <input
                  type="text"
                  value={participant.department}
                  onChange={e => setParticipant(p => ({ ...p, department: e.target.value }))}
                  className="hw-input w-full"
                  placeholder={t('التطوير', 'Development')}
                />
              </div>

              {formErr && (
                <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400">
                  <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  <span className="text-sm">{formErr}</span>
                </div>
              )}

              {/* B3 — proctoring disclosure: capture starts on «متابعة», so warn here first. */}
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800">
                <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                <span className="text-xs leading-relaxed">
                  {t('تُراقَب هذه الجلسة آلياً عبر الكاميرا ومشاركة الشاشة لضمان نزاهة الاستبيان. بالمتابعة فإنك توافق على ذلك.',
                     'This session is monitored automatically via your camera and screen-share to ensure survey integrity. By continuing, you consent to this.')}
                </span>
              </div>

              <button
                type="button"
                onClick={handleInfoSubmit}
                className="hw-btn hw-btn-primary hw-btn-lg w-full mt-1"
              >
                {t('متابعة', 'Continue')}
                <svg className={`w-4 h-4 ${ar ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
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

      {/* B3 — live proctoring furniture (camera tile + screen preview + status chip + alert banner) */}
      {(state === 'survey' || state === 'submitting') && (
        <ProctorOverlay
          proctor={proctor}
          videoRef={videoRef}
          screenPreviewRef={screenPreviewRef}
          camError={camError}
          language={ar ? 'ar' : 'en'}
        />
      )}
    </div>
  );
};

export default PublicSurveyScreen;
