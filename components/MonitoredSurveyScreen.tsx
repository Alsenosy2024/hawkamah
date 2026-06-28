// B3 — In-app survey proctoring wrapper.
//
// The two employer-distributed survey surfaces (EmployeePortalScreen via ?emp=,
// PublicSurveyScreen via ?s=) proctor their survey inline. The in-app self-assessment
// flow renders the SAME WorkplaceSurveyScreen through App's Screen.SURVEY, but it is
// entered programmatically right after the assessment finishes — there is no fresh
// user click, and getDisplayMedia (screen-share) REQUIRES a transient user gesture.
//
// This wrapper supplies that gesture: a one-click "begin monitored survey" gate that
// owns the screen-share request, then runs the standard useProctor engine (camera +
// screen → Gemini Live) with the shared ProctorOverlay around the real survey. On
// submit it captures the ProctorSummary and hands it back so the in-app result can
// persist it (App threads it into the assessments record via ResultsScreen).
import React, { useEffect, useRef, useState } from 'react';
import WorkplaceSurveyScreen from './WorkplaceSurveyScreen';
import ProctorOverlay from './ProctorOverlay';
import { useProctor } from '../hooks/useProctor';
import type { WorkEnvironmentAnswers, Language } from '../types';
import type { ProctorSummary } from '../services/proctorCore';

interface Props {
  onSubmit: (answers: WorkEnvironmentAnswers, proctorSummary?: ProctorSummary) => void;
  language: Language;
  wordLimits?: { [field: string]: number };
  mandatory?: boolean;
}

const MonitoredSurveyScreen: React.FC<Props> = ({ onSubmit, language, wordLimits, mandatory = true }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);

  const [phase, setPhase] = useState<'gate' | 'survey'>('gate');

  // ── Live AI proctoring (camera + screen-share → Gemini Live signals) ──
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

  // Begin proctoring on THIS click (getDisplayMedia needs a gesture). Request the
  // screen first, then start the camera + engine once the screen decision resolves so
  // the engine gets both streams (camera-only if screen-share is declined). Never throws.
  const handleBegin = () => {
    setPhase('survey');
    proctor.requestScreen().then(async (scr) => {
      if (scr && screenPreviewRef.current) {
        screenPreviewRef.current.srcObject = scr;
        screenPreviewRef.current.play().catch(() => {});
      }
      await startCamera();
      proctor.startProctor(streamRef.current, proctor.screenStreamRef.current);
    });
  };

  const handleSurveySubmit = (answers: WorkEnvironmentAnswers) => {
    stopCamera();   // stop camera + proctor and capture the integrity summary before handing it up
    onSubmit(answers, proctor.summaryRef.current ?? undefined);
  };

  // Bind the visible previews once the survey view (and its <video>s) has mounted —
  // the gesture grabs the streams before these elements exist.
  useEffect(() => {
    if (phase !== 'survey') return;
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
    const sp = screenPreviewRef.current, ss = proctor.screenStreamRef.current;
    if (sp && ss && sp.srcObject !== ss) { sp.srcObject = ss; sp.play().catch(() => {}); }
  }, [phase, proctor.status]);

  // Release camera + proctor on unmount.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    proctor.stopProctor();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'gate') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4" dir={ar ? 'rtl' : 'ltr'}>
        <div className="hw-card w-full max-w-md text-center px-8 py-10 space-y-5">
          <div className="flex justify-center">
            <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--hw-brand-50)] text-[var(--hw-brand)]">
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </span>
          </div>
          <div className="space-y-1.5">
            <h2 className="font-serif text-xl font-bold text-slate-800 dark:text-slate-100">
              {t('استبيان بيئة العمل', 'Work Environment Survey')}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              {t('الخطوة الأخيرة. تُراقَب هذه الجلسة آلياً عبر الكاميرا ومشاركة الشاشة لضمان النزاهة. بالبدء فإنك توافق على ذلك.',
                 'Final step. This session is monitored automatically via your camera and screen-share to ensure integrity. By starting, you consent to this.')}
            </p>
          </div>
          <button onClick={handleBegin} className="hw-btn hw-btn-primary hw-btn-lg w-full">
            {t('ابدأ الاستبيان المُراقَب', 'Begin monitored survey')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <WorkplaceSurveyScreen
        onSubmit={handleSurveySubmit}
        language={language}
        wordLimits={wordLimits}
        mandatory={mandatory}
      />
      <ProctorOverlay
        proctor={proctor}
        videoRef={videoRef}
        screenPreviewRef={screenPreviewRef}
        camError={camError}
        language={ar ? 'ar' : 'en'}
      />
    </>
  );
};

export default MonitoredSurveyScreen;
