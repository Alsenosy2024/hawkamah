// B5 — Shared pre-test onboarding ceremony (the "starting module" + onboarding +
// anti-cheat disclosure screen). This is the SAME ceremony the unified «الاثنين معاً»
// portal (UnifiedAssessmentPortal) shows between job-pick and the exam — device
// checks → rules → prohibitions (mirrored to the real proctor signals) → multi-
// monitor warning → an EXPLICIT «I read & agree» consent checkbox — extracted so the
// employee assessment (?emp=) and the environment survey (?s=) get the identical gate.
//
// Renders CARD content only (no full-screen wrapper): drop it inside a <PortalShell>
// like the other portal phases. The host owns proctoring (useProctor + ProctorOverlay);
// this component is pure UI + a consent gate.
//
// CRITICAL — gesture chain: the «أوافق وأبدأ» button calls onStart() SYNCHRONOUSLY in
// its onClick. The host's onStart must, in that same gesture, run getDisplayMedia
// (proctor.requestScreen) + unlockAudio before any await — both require a live user
// gesture. Do not wrap onStart behind an await here.
import React, { useState, useEffect } from 'react';
import type { Language } from '../types';
import { isExtendedDisplayNow } from '../services/displayDetection';

export interface AssessmentGateProps {
  language?: Language;
  jobTitle?: string;
  /** Exam composition (omit for surveyOnly). */
  totalQuestions?: number;
  voiceQuestions?: number;
  /** When set, the gate shows a per-question time chip + the auto-advance rule. */
  secondsPerQuestion?: number;
  /** 1 → "one attempt only"; shown in the onboarding step (exam only). */
  maxAttempts?: number;
  /** Camera + screen proctoring on for this link → device-cam check + vision rules + monitoring notice. */
  cameraProctoring?: boolean;
  /** A mic check is shown when the flow has voice answers. */
  micRequired?: boolean;
  /** Expected access code; when set, the candidate must enter a matching code to proceed. */
  accessCode?: string;
  /** Survey flow → hide exam-composition copy, use survey-appropriate wording. */
  surveyOnly?: boolean;
  /** Called SYNCHRONOUSLY in the consent button click (preserves the user gesture). */
  onStart: () => void;
  onBack?: () => void;
}

const AssessmentGate: React.FC<AssessmentGateProps> = ({
  language = 'ar', jobTitle, totalQuestions = 0, voiceQuestions = 0, secondsPerQuestion,
  maxAttempts, cameraProctoring = false, micRequired = false, accessCode, surveyOnly = false,
  onStart, onBack,
}) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);

  const [step, setStep] = useState<'briefing' | 'onboarding'>('briefing');
  const [micChecked, setMicChecked] = useState(false);
  const [camChecked, setCamChecked] = useState(false);
  const [deviceMsg, setDeviceMsg] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [ack, setAck] = useState(false);
  const [extendedDisplay, setExtendedDisplay] = useState(false);

  const camNeeded = !!cameraProctoring;
  const micNeeded = !!micRequired;
  const codeNeeded = !!(accessCode && accessCode.trim());

  // Poll the display layout while the gate is open so a second monitor is warned
  // about before entry (and the warning clears live if disconnected). Graceful:
  // isExtendedDisplayNow() returns null on unsupported browsers → never a false positive.
  useEffect(() => {
    const check = () => setExtendedDisplay(isExtendedDisplayNow() === true);
    check();
    const id = window.setInterval(check, 3000);
    return () => window.clearInterval(id);
  }, []);

  const checkMic = async () => {
    setDeviceMsg('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(tr => tr.stop());
      setMicChecked(true);
    } catch {
      setMicChecked(false);
      setDeviceMsg(t('تعذّر الوصول للميكروفون — فعّل الإذن من المتصفح.', 'Microphone unavailable — enable the browser permission.'));
    }
  };

  const checkCam = async () => {
    setDeviceMsg('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach(tr => tr.stop());
      setCamChecked(true);
    } catch {
      setCamChecked(false);
      setDeviceMsg(t('تعذّر الوصول للكاميرا — فعّل الإذن من المتصفح.', 'Camera unavailable — enable the browser permission.'));
    }
  };

  const proceedToOnboarding = () => {
    if (codeNeeded && codeInput.trim() !== accessCode!.trim()) {
      setCodeError(t('رمز الوصول غير صحيح.', 'Incorrect access code.'));
      return;
    }
    setAck(false);
    setStep('onboarding');
  };

  const ready = (!micNeeded || micChecked) && (!camNeeded || camChecked) && (!codeNeeded || codeInput.trim().length > 0);

  const title = surveyOnly ? t('تعليمات الاستبيان', 'Survey Instructions') : t('تجهيز الاختبار', 'Prepare for the Assessment');
  const noun = surveyOnly ? t('الاستبيان', 'the survey') : t('الاختبار', 'the assessment');

  // ─── Briefing: device checks + access code ────────────────────────────
  if (step === 'briefing') {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-md w-full space-y-5">
        <div className="text-center space-y-1">
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          {jobTitle && <p className="text-sm text-slate-500">{surveyOnly ? '' : t(`اختبار ${jobTitle}`, `${jobTitle} assessment`)}</p>}
        </div>

        {/* Composition (exam only) */}
        {!surveyOnly && totalQuestions > 0 && (
          <div className="bg-[#EEF3F5] border border-slate-200 rounded-lg p-4 space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('إجمالي الأسئلة', 'Total questions')}</span>
              <span className="font-bold text-slate-800 tabular-nums">{totalQuestions}</span>
            </div>
            {voiceQuestions > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('أسئلة صوتية', 'Voice questions')}</span>
                <span className="font-semibold text-slate-700 tabular-nums">{voiceQuestions}</span>
              </div>
            )}
            {secondsPerQuestion ? (
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('الوقت لكل سؤال', 'Time per question')}</span>
                <span className="font-semibold text-slate-700 tabular-nums">{secondsPerQuestion}{t('ث', 's')}</span>
              </div>
            ) : null}
          </div>
        )}

        {/* Device checks */}
        {(micNeeded || camNeeded) && (
          <div className="space-y-2.5">
            <div className="text-sm font-semibold text-slate-600">{t('فحص الأجهزة', 'Device check')}</div>
            {micNeeded && (
              <button
                onClick={checkMic}
                className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-150 ${
                  micChecked ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                }`}
              >
                <span>{t('الميكروفون', 'Microphone')}</span>
                {micChecked ? (
                  <span className="flex items-center gap-1.5"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg> {t('جاهز', 'Ready')}</span>
                ) : <span className="text-emerald-600">{t('فحص', 'Check')}</span>}
              </button>
            )}
            {camNeeded && (
              <button
                onClick={checkCam}
                className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-150 ${
                  camChecked ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                }`}
              >
                <span>{t('الكاميرا', 'Camera')}</span>
                {camChecked ? (
                  <span className="flex items-center gap-1.5"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg> {t('جاهز', 'Ready')}</span>
                ) : <span className="text-emerald-600">{t('فحص', 'Check')}</span>}
              </button>
            )}
            {deviceMsg && <p className="text-rose-600 text-xs">{deviceMsg}</p>}
            {camNeeded && (
              <p className="text-slate-400 text-xs leading-relaxed">
                {t(`عند البدء ستُطلب مشاركة الشاشة للمراقبة. اسمح بها للمتابعة.`, 'On start you will be asked to share your screen for monitoring. Allow it to proceed.')}
              </p>
            )}
          </div>
        )}

        {/* Access code */}
        {codeNeeded && (
          <div>
            <label className="block text-sm font-semibold text-slate-600 mb-1.5">{t('رمز الوصول', 'Access code')}</label>
            <input
              className={`hw-input w-full${codeError ? ' border-rose-400 focus:border-rose-500' : ''}`}
              placeholder={t('أدخل رمز الوصول', 'Enter the access code')}
              value={codeInput}
              onChange={e => { setCodeInput(e.target.value); setCodeError(''); }}
            />
            {codeError && <p className="text-rose-600 text-xs mt-1">{codeError}</p>}
          </div>
        )}

        <div className="pt-1 space-y-3">
          <button className="hw-btn hw-btn-primary hw-btn-w disabled:opacity-40 disabled:cursor-not-allowed" disabled={!ready} onClick={proceedToOnboarding}>
            {t('التالي: التعليمات', 'Next: Instructions')}
          </button>
          {onBack && (
            <button className="text-slate-400 text-xs w-full text-center hover:text-slate-600 transition-colors duration-150" onClick={onBack}>
              {t('رجوع', 'Back')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── Onboarding: rules, prohibitions, multi-monitor, consent ──────────
  const maxA = maxAttempts ?? 1;
  const attemptsLabel = maxA === 1 ? t('محاولة واحدة فقط', 'one attempt only')
    : maxA === 2 ? t('محاولتان فقط', 'two attempts only')
    : t(`${maxA} محاولات فقط`, `${maxA} attempts only`);

  // Prohibitions mirror the signals services/proctorCore.ts actually detects. In
  // these flows enforcement is the live camera + screen-share proctor (B3/Gemini
  // Live), not DOM hard-blocks — so the wording reflects what the proctor flags
  // (screen/app switching, external content) rather than claiming copy/paste is
  // disabled. They are disclosed only when camera proctoring is on.
  const domRules = ar ? [
    'لا تفتح تبويبات أو نوافذ أو تطبيقات أخرى أثناء الجلسة.',
    'أبقِ هذه الصفحة فقط معروضة؛ الانتقال إلى غيرها يُسجَّل.',
    'لا تنسخ الأسئلة ولا تستعن بأي مصدر خارجي.',
    'أبقِ شاشتك المُشارَكة خاليةً من أي محتوى آخر.',
  ] : [
    'Do not open other tabs, windows or apps during the session.',
    'Keep only this page in view; switching away is logged.',
    'Do not copy the questions or use any external source.',
    'Keep your shared screen free of any other content.',
  ];
  const visionRules = ar ? [
    'ابقَ وحدك أمام الكاميرا ووجهك ظاهر طوال الوقت.',
    'لا تستخدم الهاتف المحمول.',
    'حافظ على النظر إلى الشاشة؛ النظر المتكرّر للخارج يُسجَّل.',
    'ممنوع فتح أدوات الذكاء الاصطناعي (مثل ChatGPT أو Gemini).',
    'لا تفتح أي تطبيق أو مستند آخر على الشاشة المُشارَكة.',
    'تجنّب الضوضاء أو وجود أصوات أخرى في الخلفية.',
  ] : [
    'Stay alone in front of the camera with your face visible at all times.',
    'Do not use a mobile phone.',
    'Keep looking at the screen; repeated looking away is logged.',
    'AI tools (e.g. ChatGPT or Gemini) are forbidden.',
    'Do not open any other app or document on the shared screen.',
    'Avoid noise or other voices in the background.',
  ];
  const prohibitions = [...domRules, ...(camNeeded ? visionRules : [])];

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-md w-full space-y-5">
      <div className="text-center space-y-1">
        <h2 className="text-lg font-bold text-slate-800">{surveyOnly ? t('تعليمات الاستبيان', 'Survey Instructions') : t('تعليمات الاختبار', 'Assessment Instructions')}</h2>
        {jobTitle && !surveyOnly && <p className="text-sm text-slate-500">{t(`اختبار ${jobTitle}`, `${jobTitle} assessment`)}</p>}
      </div>

      {/* How it works */}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-slate-700">{surveyOnly ? t('قبل أن تبدأ', 'Before you begin') : t('كيف تعمل الجلسة', 'How it works')}</h3>
        <ul className="space-y-1.5 text-sm text-slate-600 leading-relaxed list-disc ps-5">
          {surveyOnly ? (
            <>
              <li>{t('استبيان عن بيئة العمل والمحيط المؤسسي.', 'A survey about your work environment and organizational context.')}</li>
              <li>{t('أجب بصدق وشمولية — إجاباتك سرّية ولا يطّلع عليها إلا الجهة المختصّة.', 'Answer honestly and fully — your responses are confidential and seen only by the relevant party.')}</li>
            </>
          ) : (
            <>
              <li>{t('عدد الأسئلة:', 'Questions:')} <span className="font-semibold text-slate-800">{totalQuestions}</span>{voiceQuestions > 0 ? <>{t('، منها ', ', incl. ')}<span className="font-semibold text-slate-800">{voiceQuestions}</span>{t(' صوتية', ' voice')}</> : null}.</li>
              {secondsPerQuestion ? (
                <li>{t('لكل سؤال وقت محدّد:', 'Each question is timed:')} <span className="font-semibold text-slate-800">{secondsPerQuestion} {t('ثانية', 'seconds')}</span>{t('، وعند انتهائه ينتقل تلقائياً.', '; it auto-advances when time runs out.')}</li>
              ) : (
                <li>{t('أجب على كل سؤال ثم انتقل إلى التالي.', 'Answer each question, then move to the next.')}</li>
              )}
              <li>{t('بعد الأسئلة ستُكمل استبيان بيئة العمل.', 'After the questions you will complete the work-environment survey.')}</li>
            </>
          )}
        </ul>
      </section>

      {/* Attempts (exam only) */}
      {!surveyOnly && (
        <div className="bg-[#EEF3F5] border border-slate-200 rounded-lg p-3.5 flex items-center gap-2.5">
          <svg className="w-5 h-5 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <p className="text-sm text-slate-700">{t('لديك', 'You have')} <span className="font-bold text-slate-900">{attemptsLabel}</span> {t('لإكمال هذا الاختبار.', 'to complete this assessment.')}</p>
        </div>
      )}

      {/* Prohibitions — only meaningful when proctoring is on (DOM + optionally vision) */}
      {camNeeded && (
        <section className="space-y-2">
          <h3 className="text-sm font-bold text-rose-700">{t('الممنوعات', 'Prohibitions')}</h3>
          <ul className="space-y-1.5 text-sm text-slate-700 leading-relaxed">
            {prohibitions.map(r => (
              <li key={r} className="flex items-start gap-2">
                <svg className="w-4 h-4 text-rose-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364M5.636 5.636l12.728 12.728" /></svg>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Monitoring notice (camera proctoring on) */}
      {camNeeded && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 flex items-start gap-2.5">
          <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          <p className="text-xs text-amber-800 leading-relaxed">{t(`تُراقَب هذه الجلسة آلياً عبر الكاميرا ومشاركة الشاشة لضمان نزاهة ${noun}. أي مخالفة تُسجَّل وتؤثّر في درجة النزاهة.`, `This session is monitored automatically via your camera and screen-share to ensure ${noun} integrity. Any violation is logged and affects the integrity score.`)}</p>
        </div>
      )}

      {/* Multi-monitor warning (warn + flag, not a hard block) */}
      {camNeeded && extendedDisplay && (
        <div className="flex items-start gap-2 text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5 text-xs leading-relaxed" role="alert">
          <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          <span>{t('تم رصد شاشة عرض ثانية (سطح مكتب ممتد). يُرجى فصل الشاشة الثانية قبل البدء — وإلا سيُسجَّل ذلك كمخالفة.', 'A second display was detected (extended desktop). Please disconnect it before starting — otherwise it is logged as a violation.')}</span>
        </div>
      )}

      {/* Explicit consent gate */}
      <label className="flex items-start gap-2.5 cursor-pointer select-none">
        <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="mt-0.5 w-4 h-4 accent-emerald-600 flex-shrink-0" />
        <span className="text-sm text-slate-700 leading-relaxed">{t('قرأتُ التعليمات أعلاه وأوافق على الالتزام بها.', 'I have read the instructions above and agree to abide by them.')}</span>
      </label>

      <div className="pt-1 space-y-3">
        <button
          className="hw-btn hw-btn-primary hw-btn-w disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={!ack}
          onClick={onStart}
        >
          {t('أوافق وأبدأ', 'I agree, begin')}
        </button>
        <button className="text-slate-400 text-xs w-full text-center hover:text-slate-600 transition-colors duration-150" onClick={() => setStep('briefing')}>
          {t('رجوع', 'Back')}
        </button>
      </div>
    </div>
  );
};

export default AssessmentGate;
