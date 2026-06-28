// Employee Portal — company-specific assessment portal accessed via /?emp=TOKEN.
// Flow: token validation → employee info → pre-assessment briefing →
//       competency questions → work environment survey → thank-you.
import React, { useState, useEffect, useRef } from 'react';
import { getEmployeeToken, saveEmployeeResponse } from '../services/employeePortalService';
import { notifySurveyComplete } from '../services/notifyService';
import { generateQuestions } from '../services/geminiService';
import { speak, cancelSpeech } from '../services/ttsService';
import WorkplaceSurveyScreen from './WorkplaceSurveyScreen';
import ProctorOverlay from './ProctorOverlay';
import { useProctor } from '../hooks/useProctor';
import { useToast } from './ToastProvider';
import type {
  EmployeeToken, Question, UserResponse, WorkEnvironmentAnswers, Language,
} from '../types';

type Phase =
  | 'loading'
  | 'error'
  | 'info_form'
  | 'generating'
  | 'instructions'
  | 'assessment'
  | 'survey'
  | 'saving'
  | 'done';

interface Props {
  token: string;
}

// W3: survey size now comes from the launch token (questionCount), not a constant.
const DEFAULT_QUESTION_COUNT = 30;
const FIRST_BATCH = 3;   // tiny first batch → assessment starts in ~8s (mirrors App.tsx)
const REFILL_CHUNK = 7;  // background refill chunk size (mirrors App.tsx)

// W4: ground the generated scenarios in the company's real industry + name so the
// questions read like the company's own domain (real-estate/construction, not a
// generic IT default). The public portal has no project read, so the token carries
// this snapshot.
function buildOrgContext(tok: EmployeeToken): string {
  let ctx = `[EVALUATED TARGET ENTERPRISE PROFILE]:\n- Company Name: ${tok.companyName}\n`;
  if (tok.industry) ctx += `- Sector/Industry: ${tok.industry}\n`;
  if (tok.specialization) ctx += `- Specialization: ${tok.specialization}\n`;
  if (tok.companyDescription) ctx += `- Context & Specific Environment Details: ${tok.companyDescription}\n`;
  ctx += `(IMPORTANT: ground every candidate scenario in this company's exact operational domain, and reference the company name "${tok.companyName}" explicitly in several questions.)\n`;
  return ctx;
}

const EmployeePortalScreen: React.FC<Props> = ({ token }) => {
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [empToken, setEmpToken] = useState<EmployeeToken | null>(null);
  const language = empToken?.language ?? 'ar';
  const ar = language === 'ar';
  const t = (a: string, e: string) => ar ? a : e;

  // Employee info form
  const [empName, setEmpName] = useState('');
  const [empEmail, setEmpEmail] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [formErr, setFormErr] = useState('');

  // Assessment state
  const [questions, setQuestions] = useState<Question[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<UserResponse[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState('');

  // Work env survey
  const [workplaceAnswers, setWorkplaceAnswers] = useState<WorkEnvironmentAnswers | null>(null);

  const startTime = useRef<number>(0);
  // Per-question timer
  const [qElapsed, setQElapsed] = useState(0);
  const qStartRef = useRef<number>(0);
  const qTimerRef = useRef<number | null>(null);
  // Per-question durations (seconds) saved to report
  const qDurationsRef = useRef<number[]>([]);

  // ── B3: live AI proctoring (camera + screen-share → Gemini Live signals) ──
  // The employee assessment is a graded, candidate-facing exam, so it runs the
  // standard full proctoring via the shared useProctor hook (same engine as the
  // Unified/Online/Verbal portals). This screen owns the camera stream + the visible
  // preview tiles (rendered via ProctorOverlay); the hook owns the engine lifecycle
  // and the integrity score, and captures the ProctorSummary on stop.
  const proctor = useProctor({ language: ar ? 'ar' : 'en', getQuestion: () => qIndex, intervalMs: 4000 });
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
      setCamError(t('تعذّر الوصول للكاميرا — يستمر التقييم.', 'Camera unavailable — the assessment continues.'));
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    streamRef.current = null;
    proctor.stopProctor();   // captures the integrity summary + releases screen tracks & hidden engine feeds
  };

  // Bind the visible previews once a proctored phase (and its <video>s) has mounted —
  // the gesture grabs the streams before these elements exist.
  useEffect(() => {
    if (phase !== 'assessment' && phase !== 'survey') return;
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

  // Shared proctoring furniture (camera tile + screen preview + status chip + alert
  // banner), rendered in the proctored phases below.
  const proctorOverlay = (
    <ProctorOverlay
      proctor={proctor}
      videoRef={videoRef}
      screenPreviewRef={screenPreviewRef}
      camError={camError}
      language={ar ? 'ar' : 'en'}
    />
  );

  // Load token on mount
  useEffect(() => {
    getEmployeeToken(token)
      .then(tok => {
        if (!tok) { setErrorMsg(ar ? 'الرابط غير صالح أو منتهي الصلاحية.' : 'Invalid or expired link.'); setPhase('error'); return; }
        setEmpToken(tok);
        setPhase('info_form');
      })
      .catch(() => { setErrorMsg(ar ? 'فشل التحقق من الرابط.' : 'Failed to verify link.'); setPhase('error'); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleInfoSubmit = async () => {
    if (!empName.trim()) { setFormErr(t('الاسم مطلوب.', 'Name is required.')); return; }
    if (!empEmail.trim() || !empEmail.includes('@')) { setFormErr(t('بريد إلكتروني صالح مطلوب.', 'Valid email required.')); return; }
    if (!jobTitle.trim()) { setFormErr(t('المسمى الوظيفي مطلوب.', 'Job title required.')); return; }
    setFormErr('');
    setPhase('generating');
    const total = empToken?.questionCount || DEFAULT_QUESTION_COUNT;
    const orgContext = empToken ? buildOrgContext(empToken) : undefined;
    const firstBatch = Math.min(total, FIRST_BATCH);
    try {
      // Tiny first batch (fast LOW-thinking path) shown immediately so the candidate
      // starts in ~8s; the rest refills in steady background chunks while they read
      // the briefing — instead of one slow 20-question blocking call.
      const qs = await generateQuestions(jobTitle, firstBatch, language, true, undefined, orgContext);
      setQuestions(qs);
      setPhase('instructions');

      if (total > firstBatch) {
        let have = firstBatch;
        const asked = qs.map(q => q.questionText);
        (async () => {
          while (have < total) {
            const n = Math.min(REFILL_CHUNK, total - have);
            let chunk;
            try {
              chunk = await generateQuestions(jobTitle, n, language, false, undefined, orgContext, undefined, asked);
            } catch (err) {
              console.error('background question chunk failed (keeping loaded questions):', err);
              break;
            }
            if (!chunk.length) break;
            setQuestions(prev => [...prev, ...chunk]);
            asked.push(...chunk.map(q => q.questionText));
            have += chunk.length;
          }
        })();
      }
    } catch (err: any) {
      toast.error(t('فشل توليد الأسئلة: ', 'Failed to generate questions: ') + (err?.message || err));
      setPhase('info_form');
    }
  };

  // Reset per-question timer + fire TTS when entering/advancing assessment
  useEffect(() => {
    if (phase !== 'assessment' || questions.length === 0) return;
    if (qTimerRef.current) clearInterval(qTimerRef.current);
    setQElapsed(0);
    qStartRef.current = Date.now();
    qTimerRef.current = window.setInterval(() => {
      setQElapsed(Math.round((Date.now() - qStartRef.current) / 1000));
    }, 1000);
    // TTS: read question aloud
    const q = questions[qIndex];
    if (q) speak(q.questionText, { lang: language === 'ar' ? 'ar' : 'en' }).catch(() => {});
    return () => { if (qTimerRef.current) clearInterval(qTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, qIndex]);

  const handleStartAssessment = () => {
    startTime.current = Date.now();
    qDurationsRef.current = [];
    setQIndex(0);
    setAnswers([]);
    setCurrentAnswer('');
    setPhase('assessment');
    // B3 — begin proctoring on THIS user gesture (getDisplayMedia requires one).
    // Request the screen first, then start the camera + Gemini-Live engine once the
    // screen decision resolves so the engine receives both streams (camera-only if
    // screen-share is declined). Never throws — degrades gracefully.
    proctor.requestScreen().then(async (scr) => {
      if (scr && screenPreviewRef.current) {
        screenPreviewRef.current.srcObject = scr;
        screenPreviewRef.current.play().catch(() => {});
      }
      await startCamera();
      proctor.startProctor(streamRef.current, proctor.screenStreamRef.current);
    });
  };

  const handleAnswerSubmit = () => {
    if (!currentAnswer.trim()) { toast.error(t('الرجاء كتابة إجابة.', 'Please write an answer.')); return; }
    // Record how long this question took
    qDurationsRef.current = [...qDurationsRef.current, Math.round((Date.now() - qStartRef.current) / 1000)];
    cancelSpeech();
    const next: UserResponse = { questionIndex: qIndex, selectedAnswer: currentAnswer.trim() };
    const updated = [...answers, next];
    setAnswers(updated);
    setCurrentAnswer('');
    if (qIndex + 1 < questions.length) {
      setQIndex(prev => prev + 1);
    } else {
      setPhase('survey');
    }
  };

  const handleSurveySubmit = async (wa: WorkEnvironmentAnswers) => {
    setWorkplaceAnswers(wa);
    setPhase('saving');
    if (!empToken) {
      toast.error(t('خطأ: رابط التقييم غير صالح.', 'Error: assessment link is invalid.'));
      setPhase('survey');
      return;
    }
    stopCamera();   // stop camera + proctor and capture the integrity summary before persisting
    const elapsed = Math.round((Date.now() - startTime.current) / 1000);
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(t('انتهت مهلة الحفظ — تحقق من الاتصال وأعد المحاولة.', 'Save timed out — check connection and retry.'))), 15000)
      );
      await Promise.race([
        saveEmployeeResponse({
          tokenId: empToken.id,
          tenantId: empToken.tenantId,
          projectId: empToken.projectId,
          companyName: empToken.companyName,
          employeeName: empName,
          employeeEmail: empEmail,
          jobTitle,
          department: department || '',
          competencyAnswers: answers,
          questions,
          workplaceAnswers: wa,
          submittedAt: new Date().toISOString(),
          completedInSeconds: elapsed,
          language,
          ...(proctor.summaryRef.current ? { proctorSummary: proctor.summaryRef.current } : {}),
        }),
        timeout,
      ]);
      setPhase('done');
      // W5: fire-and-forget confirmation email. Must not block or break the
      // thank-you screen — notifySurveyComplete swallows its own errors.
      if (empEmail.includes('@')) {
        notifySurveyComplete({ to: empEmail, employeeName: empName, companyName: empToken.companyName, language });
      }
    } catch (err: any) {
      toast.error(t('فشل حفظ الإجابات: ', 'Failed to save responses: ') + (err?.message || err));
      setPhase('survey');
    }
  };

  // ── LOADING ──
  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB]" dir="rtl">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-500 text-sm">جارٍ التحقق من الرابط…</p>
        </div>
      </div>
    );
  }

  // ── ERROR ──
  if (phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-6" dir={ar ? 'rtl' : 'ltr'}>
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-sm w-full text-center space-y-4">
          <div className="w-10 h-10 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center mx-auto">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-rose-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <h2 className="text-base font-bold text-slate-800">{t('رابط غير صالح', 'Invalid Link')}</h2>
          <p className="text-slate-500 text-sm leading-relaxed">{errorMsg}</p>
        </div>
      </div>
    );
  }

  const dir = ar ? 'rtl' : 'ltr';
  const companyName = empToken?.companyName || '';
  const logoUrl = empToken?.companyLogoUrl;

  // Shared header
  const header = (
    <div className="flex flex-col items-center gap-3 mb-6">
      {logoUrl ? (
        <img src={logoUrl} alt={companyName} className="h-12 max-w-[180px] object-contain" />
      ) : (
        <div className="w-11 h-11 rounded-lg bg-emerald-600 text-white flex items-center justify-center text-lg font-bold">
          {companyName.slice(0, 1)}
        </div>
      )}
      <div className="text-center space-y-0.5">
        <h1 className="text-base font-bold text-slate-800">{companyName}</h1>
        <p className="text-xs text-slate-400">{t('بوابة تقييم الموظفين', 'Employee Assessment Portal')}</p>
      </div>
    </div>
  );

  // ── INFO FORM ──
  if (phase === 'info_form') {
    const jobRoles = empToken?.jobRoles || [];
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-4" dir={dir}>
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-md w-full">
          {header}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('الاسم الكامل *', 'Full Name *')}</label>
              <input
                className="hw-input w-full"
                placeholder={t('أدخل اسمك الكامل', 'Enter your full name')}
                value={empName} onChange={e => setEmpName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('البريد الإلكتروني *', 'Email *')}</label>
              <input
                type="email"
                className="hw-input w-full"
                placeholder={t('example@company.com', 'example@company.com')}
                value={empEmail} onChange={e => setEmpEmail(e.target.value)}
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('المسمى الوظيفي *', 'Job Title *')}</label>
              {jobRoles.length > 0 ? (
                <select
                  className="hw-input w-full bg-white"
                  value={jobTitle} onChange={e => setJobTitle(e.target.value)}
                >
                  <option value="">{t('اختر مسماك الوظيفي', 'Select your job title')}</option>
                  {jobRoles.map(r => (
                    <option key={r.id} value={ar ? r.title_ar : r.title_en}>
                      {ar ? r.title_ar : r.title_en}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="hw-input w-full"
                  placeholder={t('مثال: مدير موارد بشرية', 'e.g. HR Manager')}
                  value={jobTitle} onChange={e => setJobTitle(e.target.value)}
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('الإدارة / القسم', 'Department')}</label>
              <input
                className="hw-input w-full"
                placeholder={t('اختياري', 'Optional')}
                value={department} onChange={e => setDepartment(e.target.value)}
              />
            </div>
            {formErr && (
              <p className="text-xs text-rose-600 font-medium flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {formErr}
              </p>
            )}
            <button
              onClick={handleInfoSubmit}
              className="hw-btn hw-btn-primary hw-btn-w mt-2"
            >
              {t('متابعة', 'Continue')}
            </button>
          </div>
          <p className="text-xs text-center text-slate-400 mt-5">
            {t('بياناتك محمية ولن تُشارك مع أطراف خارجية.', 'Your data is protected and will not be shared with third parties.')}
          </p>
        </div>
      </div>
    );
  }

  // ── GENERATING ──
  if (phase === 'generating') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-4" dir={dir}>
        <div className="bg-white border border-slate-200 rounded-xl p-10 max-w-sm w-full text-center space-y-5">
          {header}
          <div className="space-y-3">
            <div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-slate-500 text-sm leading-relaxed">
              {t('يجري إعداد أسئلة التقييم المخصصة لمسماك الوظيفي…', 'Preparing personalized assessment questions for your role…')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── INSTRUCTIONS ──
  if (phase === 'instructions') {
    const qCount = empToken?.questionCount || DEFAULT_QUESTION_COUNT;
    const steps = ar ? [
      { num: '1', title: 'أسئلة الجدارات', desc: `${qCount} أسئلة مخصصة لمسماك الوظيفي (${jobTitle})` },
      { num: '2', title: 'استبيان بيئة العمل', desc: 'تقييم بيئة العمل والمحيط المؤسسي' },
      { num: '3', title: 'السرية التامة', desc: 'إجاباتك آمنة ومحمية — لا يُعرض عليها إلا القيادة المختصة' },
    ] : [
      { num: '1', title: 'Competency Questions', desc: `${qCount} questions tailored to your role (${jobTitle})` },
      { num: '2', title: 'Work Environment Survey', desc: 'Assessment of your work environment and organizational context' },
      { num: '3', title: 'Full Confidentiality', desc: 'Your answers are secure — only relevant leadership can view them' },
    ];

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-4" dir={dir}>
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-lg w-full space-y-6">
          {header}
          <div className="text-center space-y-1">
            <h2 className="text-lg font-bold text-slate-800">
              {t('أهلاً بك في التقييم', `Welcome, ${empName}`)}
            </h2>
            <p className="text-sm text-slate-500 leading-relaxed">
              {t(`مرحباً ${empName}، قبل البدء اطّلع على هيكل التقييم.`, `Before we begin, here's what to expect.`)}
            </p>
          </div>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-3 border border-slate-200 rounded-lg px-4 py-3 bg-white">
                <span className="flex-shrink-0 w-5 h-5 rounded-full border-2 border-emerald-600 text-emerald-600 flex items-center justify-center text-[10px] font-bold mt-0.5">{s.num}</span>
                <div>
                  <div className="font-semibold text-slate-800 text-sm">{s.title}</div>
                  <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="border border-slate-200 rounded-lg px-4 py-3 bg-[#EEF3F5] text-xs text-slate-600 leading-relaxed">
            {t(
              'الوقت المتوقع: 15–25 دقيقة. أجب بصدق وشمولية — الإجابات القصيرة تؤثر على دقة التقرير.',
              'Expected time: 15–25 minutes. Answer honestly and thoroughly — short answers affect report accuracy.',
            )}
          </div>
          {/* B3 — proctoring disclosure: capture starts on «ابدأ التقييم», so warn here first. */}
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800">
            <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <span className="text-xs leading-relaxed">
              {t('تُراقَب هذه الجلسة آلياً عبر الكاميرا ومشاركة الشاشة لضمان نزاهة التقييم. بالبدء فإنك توافق على ذلك.',
                 'This session is monitored automatically via your camera and screen-share to ensure assessment integrity. By starting, you consent to this.')}
            </span>
          </div>

          <button
            onClick={handleStartAssessment}
            className="hw-btn hw-btn-primary hw-btn-w"
          >
            {t('ابدأ التقييم', 'Start Assessment')}
          </button>
        </div>
      </div>
    );
  }

  // ── ASSESSMENT ──
  if (phase === 'assessment' && questions.length > 0) {
    const q = questions[qIndex];
    const progress = Math.round(((qIndex) / questions.length) * 100);
    const isMultiChoice = q.options && q.options.length >= 2;

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-4" dir={dir}>
        {proctorOverlay}
        <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl w-full space-y-5">
          {/* Progress bar + metadata row */}
          <div className="space-y-2">
            <div className="w-full bg-[#EEF3F5] rounded-full h-1">
              <div className="bg-emerald-600 h-1 rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                {logoUrl ? (
                  <img src={logoUrl} alt={companyName} className="h-5 w-auto object-contain opacity-70" />
                ) : (
                  <div className="w-5 h-5 rounded bg-emerald-600 text-white flex items-center justify-center text-[10px] font-bold">{companyName.slice(0, 1)}</div>
                )}
                <span className="text-xs text-slate-400">{companyName}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400 tabular-nums">
                {/* Per-question elapsed timer */}
                <span className="flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                  </svg>
                  {`${String(Math.floor(qElapsed / 60)).padStart(2, '0')}:${String(qElapsed % 60).padStart(2, '0')}`}
                </span>
                <span className="text-slate-300">|</span>
                <span>{t(`${qIndex + 1} / ${questions.length}`, `${qIndex + 1} / ${questions.length}`)}</span>
              </div>
            </div>
          </div>

          {/* Question */}
          <div className="space-y-2 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-sm font-semibold tracking-wide uppercase ${q.type === 'Technical' ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-purple-50 text-purple-600 border border-purple-200'}`}>
                {q.type === 'Technical' ? t('فني', 'Technical') : t('سلوكي', 'Behavioral')}
              </span>
              {q.framework && <span className="text-xs text-slate-400">{q.framework}</span>}
            </div>
            <p className="font-semibold text-slate-800 text-base leading-relaxed">{q.questionText}</p>
          </div>

          {/* Answer area */}
          {isMultiChoice ? (
            <div className="space-y-2">
              {q.options.map((opt, i) => {
                const letter = ['A', 'B', 'C', 'D'][i];
                const selected = currentAnswer === `${letter}. ${opt}`;
                return (
                  <button
                    key={i}
                    onClick={() => setCurrentAnswer(`${letter}. ${opt}`)}
                    className={`w-full text-start px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${
                      selected
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-emerald-400 hover:bg-emerald-50'
                    }`}
                  >
                    <span className="font-bold me-2 opacity-60">{letter}.</span>{opt}
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <textarea
                className="hw-textarea w-full resize-none"
                rows={5}
                placeholder={t('اكتب إجابتك هنا بالتفصيل…', 'Write your answer in detail here…')}
                value={currentAnswer}
                onChange={e => setCurrentAnswer(e.target.value)}
              />
              {q.minWords && (
                <p className="text-xs text-slate-400 mt-1.5">
                  {t(`الحد الأدنى: ${q.minWords} كلمة`, `Minimum: ${q.minWords} words`)}
                </p>
              )}
            </div>
          )}

          <button
            onClick={handleAnswerSubmit}
            disabled={!currentAnswer.trim()}
            className="hw-btn hw-btn-primary hw-btn-w disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {qIndex + 1 < questions.length
              ? t('السؤال التالي', 'Next Question')
              : t('انتقل لاستبيان بيئة العمل', 'Go to Work Environment Survey')}
          </button>
        </div>
      </div>
    );
  }

  // ── SURVEY ──
  if (phase === 'survey') {
    return (
      <div className="min-h-screen bg-[#F7FAFB] p-4" dir={dir}>
        {proctorOverlay}
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt={companyName} className="h-7 w-auto object-contain" />
            ) : (
              <div className="w-7 h-7 rounded bg-emerald-600 text-white flex items-center justify-center text-xs font-bold">{companyName.slice(0, 1)}</div>
            )}
            <div>
              <div className="font-semibold text-slate-800 text-sm">{companyName}</div>
              <div className="text-xs text-slate-400">{t('استبيان بيئة العمل', 'Work Environment Survey')}</div>
            </div>
          </div>
          <WorkplaceSurveyScreen
            onSubmit={handleSurveySubmit}
            language={language}
            mandatory={true}
          />
        </div>
      </div>
    );
  }

  // ── SAVING ──
  if (phase === 'saving') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-4" dir={dir}>
        <div className="bg-white border border-slate-200 rounded-xl p-10 max-w-sm w-full text-center space-y-4">
          <div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-500 text-sm">
            {t('جارٍ حفظ إجاباتك…', 'Saving your responses…')}
          </p>
        </div>
      </div>
    );
  }

  // ── DONE ──
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F7FAFB] p-4" dir={dir}>
      <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-sm w-full text-center space-y-5">
        {header}
        <div className="w-12 h-12 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-green-600" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-bold text-slate-800">
            {t('شكراً لك!', 'Thank You!')}
          </h2>
          <p className="text-slate-500 text-sm leading-relaxed">
            {t(
              `تم تسجيل إجاباتك بنجاح يا ${empName}. سيتم مراجعة نتائج التقييم من قِبل الفريق المختص وإعداد تقرير شامل.`,
              `Your responses have been recorded successfully, ${empName}. The assessment results will be reviewed by the relevant team and a comprehensive report will be prepared.`,
            )}
          </p>
        </div>
        <div className="border border-green-200 rounded-lg px-4 py-3 bg-green-50 text-sm text-green-700 font-medium">
          {t('التقييم مكتمل — يمكنك إغلاق هذه الصفحة.', 'Assessment complete — you may close this page.')}
        </div>
        <p className="text-xs text-slate-400">
          {companyName} · {new Date().toLocaleDateString(ar ? 'ar-SA' : 'en-US')}
        </p>
      </div>
    </div>
  );
};

export default EmployeePortalScreen;
