// Unified Assessment Portal — employee-facing exam portal.
// URL param: ?assess=TOKEN
// Flow: identify → job_pick → [access] → generating → exam → attempt_done → all_done
// No per-user credentials — employees self-identify with name+email+job title.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getUnifiedToken, saveUnifiedResult, scoreAttempt } from '../services/unifiedAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
import type { UnifiedAssessmentToken, UnifiedAssessmentResult, UnifiedAttempt, PaperQuestion } from '../types';

// ─── SpeechRecognition type declarations ───────────────────────────────────
type SRConstructor = new () => SpeechRecognition;
interface SpeechRecognition extends EventTarget {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEvent { results: SpeechRecognitionResultList; }
interface SpeechRecognitionResultList { readonly length: number; [i: number]: SpeechRecognitionResult; }
interface SpeechRecognitionResult { readonly length: number; [i: number]: SpeechRecognitionAlternative; }
interface SpeechRecognitionAlternative { readonly transcript: string; }

// ─── FaceDetector type declarations ────────────────────────────────────────
interface FaceDetectorType {
  detect(img: HTMLVideoElement): Promise<unknown[]>;
}

const w = window as unknown as Record<string, unknown>;
const SR: SRConstructor | null = (w['SpeechRecognition'] ?? w['webkitSpeechRecognition'] ?? null) as SRConstructor | null;
const FD: FaceDetectorType | null = (() => {
  if (!('FaceDetector' in window)) return null;
  try {
    return new (w['FaceDetector'] as new (opts: Record<string, unknown>) => FaceDetectorType)({
      fastMode: true, maxDetectedFaces: 1,
    });
  } catch { return null; }
})();

const MAX_VIOLATIONS = 5;

// ─── Styles ────────────────────────────────────────────────────────────────
const NAVY = {
  bg:       'min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white',
  card:     'bg-white/5 border border-white/10 rounded-2xl',
  btn:      'bg-teal-500 hover:bg-teal-400 text-white font-bold py-3 px-8 rounded-xl transition disabled:opacity-40 disabled:cursor-not-allowed',
  btnGhost: 'bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-6 rounded-xl transition',
  input:    'w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-white/40 focus:outline-none focus:border-teal-400',
  label:    'block text-sm font-semibold text-white/70 mb-1.5',
};

// ─── TTS helper ────────────────────────────────────────────────────────────
function speakArabic(text: string): void {
  window.speechSynthesis?.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'ar-SA';
  utt.rate = 0.9;
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const ar = voices.find(v => v.lang.startsWith('ar'));
  if (ar) utt.voice = ar;
  window.speechSynthesis?.speak(utt);
}

// ─── Timer hook ────────────────────────────────────────────────────────────
function useTimer(seconds: number, onExpire: () => void) {
  const [remaining, setRemaining] = useState(seconds);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(() => {
    setRemaining(seconds);
    if (ref.current) clearInterval(ref.current);
    ref.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) {
          clearInterval(ref.current!);
          onExpire();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
  }, [seconds, onExpire]);

  const stop = useCallback(() => {
    if (ref.current) clearInterval(ref.current);
  }, []);

  useEffect(() => () => { if (ref.current) clearInterval(ref.current); }, []);

  return { remaining, start, stop };
}

// ─── Types ────────────────────────────────────────────────────────────────
type Stage = 'loading' | 'identify' | 'job_pick' | 'access' | 'generating' | 'exam' | 'attempt_done' | 'all_done' | 'error';

interface ExamState {
  qIndex: number;
  answers: Record<number, string>;
  voiceAnswers: Record<number, string>;
  violations: number;
  startedAt: string;
  recording: boolean;
  transcript: string;
}

// ─── Component ─────────────────────────────────────────────────────────────
export default function UnifiedAssessmentPortal({ token: tokenId }: { token: string }) {
  const [stage, setStage]         = useState<Stage>('loading');
  const [tok, setTok]             = useState<UnifiedAssessmentToken | null>(null);
  const [error, setError]         = useState('');
  const [name, setName]           = useState('');
  const [email, setEmail]         = useState('');
  const [jobTitle, setJobTitle]   = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [accessError, setAccessError] = useState('');
  const [questions, setQuestions] = useState<PaperQuestion[]>([]);
  const [examState, setExamState] = useState<ExamState | null>(null);
  const [attemptScore, setAttemptScore] = useState(0);
  const [attempts, setAttempts]   = useState<UnifiedAttempt[]>([]);
  const [resultId, setResultId]   = useState<string | null>(null);
  const [genError, setGenError]   = useState('');
  const [camError, setCamError]   = useState('');
  const [fullscreenBanner, setFullscreenBanner] = useState(false);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const recogRef    = useRef<InstanceType<SRConstructor> | null>(null);
  const violRef     = useRef(0);
  const examRef     = useRef<ExamState | null>(null);
  const faceCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef    = useRef<AbortController | null>(null);

  // ─── Load token ──────────────────────────────────────────────────────────
  useEffect(() => {
    getUnifiedToken(tokenId).then(t => {
      if (!t) { setError('الرابط غير صالح أو منتهي الصلاحية.'); setStage('error'); return; }
      if (!t.active) { setError('هذا الاختبار لم يعد نشطاً.'); setStage('error'); return; }
      if (t.expiresAt && new Date(t.expiresAt) < new Date()) {
        setError('انتهت صلاحية هذا الرابط.'); setStage('error'); return;
      }
      setTok(t);
      setStage('identify');
    }).catch(() => { setError('تعذّر تحميل بيانات الاختبار.'); setStage('error'); });
  }, [tokenId]);

  // ─── Anti-cheat listeners ─────────────────────────────────────────────
  const addViolation = useCallback((reason: string) => {
    violRef.current += 1;
    setExamState(prev => {
      if (!prev) return prev;
      const v = prev.violations + 1;
      const next = { ...prev, violations: v };
      examRef.current = next;
      return next;
    });
    if (violRef.current >= MAX_VIOLATIONS) {
      handleCancelAttempt(reason);
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    if (stage !== 'exam') return;
    const onVis = () => { if (document.hidden) addViolation('tab_switch'); };
    const onBlur = () => addViolation('window_blur');
    const onFull = () => { if (!document.fullscreenElement) setFullscreenBanner(true); };
    const onCopy = (e: Event) => e.preventDefault();
    const onCtx  = (e: Event) => e.preventDefault();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFull);
    document.addEventListener('copy', onCopy);
    document.addEventListener('contextmenu', onCtx);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFull);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('contextmenu', onCtx);
    };
  }, [stage, addViolation]);

  // ─── Face detection (camera proctoring) ──────────────────────────────
  const startFaceCheck = useCallback(() => {
    if (!FD || !videoRef.current) return;
    faceCheckRef.current = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;
      try {
        const faces = await FD.detect(videoRef.current);
        if (faces.length === 0) addViolation('no_face');
        if (faces.length > 1)  addViolation('multiple_faces');
      } catch { /* ignore */ }
    }, 3000);
  }, [addViolation]);

  // ─── Camera setup ─────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      startFaceCheck();
    } catch {
      setCamError('لم يتمكن من الوصول للكاميرا. الاختبار سيستمر بدون مراقبة.');
    }
  }, [startFaceCheck]);

  const stopCamera = useCallback(() => {
    if (faceCheckRef.current) clearInterval(faceCheckRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // ─── Cancel attempt ───────────────────────────────────────────────────
  const handleCancelAttempt = useCallback(async (reason = '') => {
    window.speechSynthesis?.cancel();
    recogRef.current?.abort();
    stopCamera();
    const es = examRef.current;
    if (!es) { setStage('attempt_done'); return; }

    const attempt: UnifiedAttempt = {
      attemptNumber: attempts.length + 1,
      answers: es.answers,
      voiceAnswers: es.voiceAnswers,
      score: scoreAttempt(questions, es.answers),
      violations: es.violations,
      cancelled: true,
      jobTitle,
      startedAt: es.startedAt,
      finishedAt: new Date().toISOString(),
    };
    const newAttempts = [...attempts, attempt];
    setAttempts(newAttempts);
    setAttemptScore(0);
    setStage('attempt_done');

    if (!tok) return;
    const bestScore = Math.max(...newAttempts.map(a => a.score));
    const result: UnifiedAssessmentResult = {
      tokenId, tenantId: tok.tenantId, projectId: tok.projectId,
      companyName: tok.companyName, employeeName: name, employeeEmail: email,
      jobTitle, attempts: newAttempts, bestScore,
      passed: bestScore >= (tok.passingScore ?? 60),
      submittedAt: new Date().toISOString(),
    };
    if (resultId) result.id = resultId;
    const id = await saveUnifiedResult(result).catch(() => null);
    if (id && !resultId) setResultId(id);
  }, [attempts, questions, jobTitle, tok, name, email, tokenId, resultId, stopCamera]);

  // ─── Finish attempt ───────────────────────────────────────────────────
  const handleFinishAttempt = useCallback(async (es: ExamState) => {
    window.speechSynthesis?.cancel();
    recogRef.current?.abort();
    stopCamera();
    if (!tok) return;

    const score = scoreAttempt(questions, es.answers);
    const attempt: UnifiedAttempt = {
      attemptNumber: attempts.length + 1,
      answers: es.answers,
      voiceAnswers: es.voiceAnswers,
      score,
      violations: es.violations,
      cancelled: false,
      jobTitle,
      startedAt: es.startedAt,
      finishedAt: new Date().toISOString(),
    };
    const newAttempts = [...attempts, attempt];
    setAttempts(newAttempts);
    setAttemptScore(score);
    setStage('attempt_done');

    const bestScore = Math.max(...newAttempts.map(a => a.score));
    const result: UnifiedAssessmentResult = {
      tokenId, tenantId: tok.tenantId, projectId: tok.projectId,
      companyName: tok.companyName, employeeName: name, employeeEmail: email,
      jobTitle, attempts: newAttempts, bestScore,
      passed: bestScore >= (tok.passingScore ?? 60),
      submittedAt: new Date().toISOString(),
    };
    if (resultId) result.id = resultId;
    const id = await saveUnifiedResult(result).catch(() => null);
    if (id && !resultId) setResultId(id);
  }, [attempts, questions, jobTitle, tok, name, email, tokenId, resultId, stopCamera]);

  // ─── Timer expiry ─────────────────────────────────────────────────────
  const onExpire = useCallback(() => {
    const es = examRef.current;
    if (!es) return;
    if (es.qIndex < questions.length - 1) {
      goNextQ(es);
    } else {
      handleFinishAttempt(es);
    }
  }, [questions, handleFinishAttempt]); // eslint-disable-line

  const { remaining, start: startTimer, stop: stopTimer } = useTimer(tok?.secondsPerQuestion ?? 90, onExpire);

  // ─── Voice recording ──────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    if (!SR) return;
    const r = new SR();
    r.lang = 'ar-SA';
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? '';
      setExamState(prev => {
        if (!prev) return prev;
        const next = { ...prev, transcript: text, recording: false };
        examRef.current = next;
        return next;
      });
    };
    r.onerror = () => setExamState(prev => prev ? { ...prev, recording: false } : prev);
    r.onend   = () => setExamState(prev => prev ? { ...prev, recording: false } : prev);
    recogRef.current = r;
    r.start();
    setExamState(prev => prev ? { ...prev, recording: true, transcript: '' } : prev);
  }, []);

  const stopRecording = useCallback(() => {
    recogRef.current?.stop();
    setExamState(prev => prev ? { ...prev, recording: false } : prev);
  }, []);

  const saveVoiceAnswer = useCallback(() => {
    const es = examRef.current;
    if (!es) return;
    const next = {
      ...es,
      voiceAnswers: { ...es.voiceAnswers, [es.qIndex]: es.transcript },
      transcript: '',
      recording: false,
    };
    examRef.current = next;
    setExamState(next);
  }, []);

  // ─── Navigate questions ───────────────────────────────────────────────
  const goNextQ = useCallback((es: ExamState) => {
    const next = es.qIndex + 1;
    if (next >= questions.length) { handleFinishAttempt(es); return; }
    const nextQ = questions[next];
    const nextState = { ...es, qIndex: next, transcript: '', recording: false };
    examRef.current = nextState;
    setExamState(nextState);
    startTimer();
    window.speechSynthesis?.cancel();
    if (nextQ.isVoice) setTimeout(() => speakArabic(nextQ.text), 400);
  }, [questions, handleFinishAttempt, startTimer]);

  const handleAnswer = useCallback((opt: string) => {
    const es = examRef.current;
    if (!es) return;
    stopTimer();
    const next = { ...es, answers: { ...es.answers, [es.qIndex]: opt } };
    examRef.current = next;
    setExamState(next);
    if (next.qIndex < questions.length - 1) {
      setTimeout(() => goNextQ(next), 400);
    } else {
      setTimeout(() => handleFinishAttempt(next), 400);
    }
  }, [stopTimer, goNextQ, handleFinishAttempt, questions]);

  // ─── Start exam ───────────────────────────────────────────────────────
  const startExam = useCallback(async () => {
    if (!tok) return;
    violRef.current = 0;
    const init: ExamState = {
      qIndex: 0, answers: {}, voiceAnswers: {}, violations: 0,
      startedAt: new Date().toISOString(), recording: false, transcript: '',
    };
    examRef.current = init;
    setExamState(init);
    setFullscreenBanner(false);
    setStage('exam');
    startTimer();
    if (tok.cameraProctoring) await startCamera();
    const first = questions[0];
    if (first?.isVoice) setTimeout(() => speakArabic(first.text), 600);
    try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
  }, [tok, questions, startTimer, startCamera]);

  // ─── Generate questions ───────────────────────────────────────────────
  const generateQuestions = useCallback(async () => {
    if (!tok) return;
    setStage('generating');
    setGenError('');
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const qs = await generatePaperQuestions(
        jobTitle,
        tok.questionCount,
        tok.difficulty,
        tok.behavioralPct,
        tok.theories,
        ctrl.signal,
      );
      if (!qs.length) throw new Error('الأسئلة فارغة');
      // Mark voice questions
      const voiceCount = tok.voiceQuestionCount ?? 0;
      const final = qs.map((q, i) => ({ ...q, isVoice: i < voiceCount }));
      setQuestions(final);
      setStage('exam');
      // Actually start the exam
      violRef.current = 0;
      const init: ExamState = {
        qIndex: 0, answers: {}, voiceAnswers: {}, violations: 0,
        startedAt: new Date().toISOString(), recording: false, transcript: '',
      };
      examRef.current = init;
      setExamState(init);
      setFullscreenBanner(false);
      startTimer();
      if (tok.cameraProctoring) await startCamera();
      if (final[0]?.isVoice) setTimeout(() => speakArabic(final[0].text), 600);
      try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
    } catch (err: unknown) {
      if (ctrl.signal.aborted) return;
      setGenError((err as Error)?.message ?? 'فشل توليد الأسئلة');
      setStage('generating'); // stay on generating screen to show error
    }
  }, [tok, jobTitle, startTimer, startCamera]);

  // ─── Proceed to generation ────────────────────────────────────────────
  const proceedToGenerate = useCallback(() => {
    if (!tok) return;
    if (tok.accessCode && accessCode.trim() !== tok.accessCode.trim()) {
      setAccessError('رمز الوصول غير صحيح.'); return;
    }
    generateQuestions();
  }, [tok, accessCode, generateQuestions]);

  // ─── Retry ────────────────────────────────────────────────────────────
  const retry = useCallback(() => {
    setQuestions([]);
    generateQuestions();
  }, [generateQuestions]);

  // ─── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => () => {
    stopCamera();
    abortRef.current?.abort();
    window.speechSynthesis?.cancel();
  }, [stopCamera]);

  // ─── Render helpers ───────────────────────────────────────────────────
  const Logo = () => tok?.companyLogoUrl ? (
    <img src={tok.companyLogoUrl} alt={tok.companyName} className="h-10 max-w-[140px] object-contain mx-auto mb-2 rounded" />
  ) : null;

  const Header = ({ title, sub }: { title: string; sub?: string }) => (
    <div className="text-center mb-8">
      <Logo />
      <div className="text-xs font-semibold text-teal-400 uppercase tracking-widest mb-2">{tok?.companyName}</div>
      <h1 className="text-2xl font-black text-white">{title}</h1>
      {sub && <p className="text-white/60 text-sm mt-1">{sub}</p>}
    </div>
  );

  // ─── STAGE: loading ───────────────────────────────────────────────────
  if (stage === 'loading') return (
    <div className={`${NAVY.bg} flex items-center justify-center`} dir="rtl">
      <div className="text-white/60">جارٍ التحميل…</div>
    </div>
  );

  // ─── STAGE: error ────────────────────────────────────────────────────
  if (stage === 'error') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-8 max-w-sm w-full text-center space-y-4`}>
        <div className="text-4xl">⚠️</div>
        <h2 className="text-xl font-bold text-white">تعذّر فتح الاختبار</h2>
        <p className="text-white/60 text-sm">{error}</p>
      </div>
    </div>
  );

  // ─── STAGE: identify ──────────────────────────────────────────────────
  if (stage === 'identify') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-8 max-w-md w-full space-y-5`}>
        <Header title="تعريف الموظف" sub="أدخل بياناتك لبدء الاختبار" />
        <div>
          <label className={NAVY.label}>الاسم الكامل</label>
          <input className={NAVY.input} placeholder="محمد أحمد" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <label className={NAVY.label}>البريد الإلكتروني</label>
          <input className={NAVY.input} type="email" dir="ltr" placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <button
          className={`${NAVY.btn} w-full`}
          disabled={!name.trim() || !email.trim()}
          onClick={() => setStage('job_pick')}
        >
          التالي →
        </button>
      </div>
    </div>
  );

  // ─── STAGE: job_pick ──────────────────────────────────────────────────
  if (stage === 'job_pick') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-8 max-w-md w-full space-y-5`}>
        <Header title="اختر مسماك الوظيفي" sub="ستُولَّد الأسئلة بناءً على وظيفتك" />
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {(tok?.allowedJobTitles ?? []).map(jt => (
            <button
              key={jt}
              className={`w-full text-right px-4 py-3 rounded-xl border transition font-semibold ${
                jobTitle === jt
                  ? 'bg-teal-500 border-teal-500 text-white'
                  : 'bg-white/5 border-white/20 text-white/80 hover:border-teal-400'
              }`}
              onClick={() => setJobTitle(jt)}
            >
              {jt}
            </button>
          ))}
          {(tok?.allowedJobTitles ?? []).length === 0 && (
            <div className="text-white/50 text-sm text-center">لا توجد مسميات محددة — أدخل مسماك يدوياً</div>
          )}
        </div>
        {(tok?.allowedJobTitles ?? []).length === 0 && (
          <input className={NAVY.input} placeholder="المسمى الوظيفي" value={jobTitle} onChange={e => setJobTitle(e.target.value)} />
        )}

        {/* Access code field (shown only if token requires it) */}
        {tok?.accessCode && (
          <div>
            <label className={NAVY.label}>رمز الوصول</label>
            <input
              className={`${NAVY.input} ${accessError ? 'border-rose-400' : ''}`}
              placeholder="أدخل رمز الوصول"
              value={accessCode}
              onChange={e => { setAccessCode(e.target.value); setAccessError(''); }}
            />
            {accessError && <p className="text-rose-400 text-xs mt-1">{accessError}</p>}
          </div>
        )}

        <div className="pt-2 space-y-3">
          {/* Exam info pills */}
          <div className="flex flex-wrap gap-2">
            {[
              `${tok?.questionCount} سؤال`,
              tok?.difficulty === 'easy' ? 'سهل' : tok?.difficulty === 'hard' ? 'صعب' : 'متوسط',
              `${tok?.secondsPerQuestion}ث/سؤال`,
              `${tok?.maxAttempts} محاولات`,
              ...(tok?.cameraProctoring ? ['📷 مراقبة بالكاميرا'] : []),
            ].map(p => (
              <span key={p} className="bg-white/10 text-white/70 text-xs px-3 py-1 rounded-full">{p}</span>
            ))}
          </div>
          <button
            className={`${NAVY.btn} w-full`}
            disabled={!jobTitle.trim()}
            onClick={proceedToGenerate}
          >
            ابدأ الاختبار
          </button>
          <button className="text-white/40 text-xs w-full text-center hover:text-white/60 transition" onClick={() => setStage('identify')}>
            ← رجوع
          </button>
        </div>
      </div>
    </div>
  );

  // ─── STAGE: generating ────────────────────────────────────────────────
  if (stage === 'generating') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-10 max-w-sm w-full text-center space-y-6`}>
        <Header title="جارٍ توليد الأسئلة" sub={`اختبار ${jobTitle}`} />
        {!genError ? (
          <>
            <div className="flex justify-center">
              <svg className="animate-spin h-12 w-12 text-teal-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <p className="text-white/50 text-sm">يُولَّد {tok?.questionCount} سؤالاً مخصصاً لـ &quot;{jobTitle}&quot;…</p>
          </>
        ) : (
          <>
            <div className="text-4xl">⚠️</div>
            <p className="text-rose-300 text-sm">{genError}</p>
            <button className={NAVY.btn} onClick={retry}>إعادة المحاولة</button>
          </>
        )}
      </div>
    </div>
  );

  // ─── STAGE: exam ──────────────────────────────────────────────────────
  if (stage === 'exam' && examState && questions.length) {
    const q = questions[examState.qIndex];
    const progress = ((examState.qIndex + 1) / questions.length) * 100;
    const timerColor = remaining < 10 ? 'text-rose-400' : remaining < 20 ? 'text-amber-400' : 'text-teal-400';

    return (
      <div className={`${NAVY.bg} p-4 relative`} dir="rtl" onContextMenu={e => e.preventDefault()}>
        {/* Camera corner */}
        {tok?.cameraProctoring && (
          <div className="fixed bottom-4 left-4 z-50">
            <video
              ref={videoRef}
              muted
              playsInline
              className="w-28 h-20 rounded-xl object-cover border-2 border-teal-500/50 bg-black"
            />
            {camError && <p className="text-rose-400 text-xs mt-1 w-28 text-center">{camError}</p>}
          </div>
        )}

        {/* Fullscreen banner */}
        {fullscreenBanner && (
          <div className="fixed top-0 inset-x-0 z-50 bg-amber-500 text-black font-bold text-center py-2 text-sm">
            ⚠️ يُفضَّل الاختبار بوضع ملء الشاشة —{' '}
            <button className="underline" onClick={() => { document.documentElement.requestFullscreen().catch(() => {}); setFullscreenBanner(false); }}>
              تفعيل
            </button>
          </div>
        )}

        <div className="max-w-2xl mx-auto space-y-6 pt-4">
          {/* Header bar */}
          <div className="flex items-center justify-between">
            <div className="text-white/60 text-sm">{name} — {jobTitle}</div>
            <div className={`font-mono font-black text-2xl ${timerColor}`}>{remaining}s</div>
            {examState.violations > 0 && (
              <div className="text-rose-400 text-xs">⚠️ {examState.violations}/{MAX_VIOLATIONS} مخالفات</div>
            )}
          </div>

          {/* Progress bar */}
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-teal-500 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-white/40 text-xs text-center">
            {examState.qIndex + 1} / {questions.length}
            {q.isVoice && ' 🎤 سؤال صوتي'}
          </div>

          {/* Question */}
          <div className={`${NAVY.card} p-6 space-y-4`}>
            <div className="text-xs font-semibold text-teal-400 uppercase tracking-wider">
              {q.type === 'behavioral' ? 'سلوكي' : 'فني'}
            </div>
            <p className="text-white text-lg leading-relaxed font-semibold">{q.text}</p>

            {/* Voice question recording */}
            {q.isVoice && (
              <div className="space-y-2">
                {!examState.recording ? (
                  <button
                    className="flex items-center gap-2 bg-rose-500/20 border border-rose-400/40 text-rose-300 px-4 py-2 rounded-xl text-sm"
                    onClick={startRecording}
                  >
                    🎤 ابدأ التسجيل
                  </button>
                ) : (
                  <button
                    className="flex items-center gap-2 bg-rose-500 text-white px-4 py-2 rounded-xl text-sm animate-pulse"
                    onClick={stopRecording}
                  >
                    ⏹ إيقاف التسجيل
                  </button>
                )}
                {examState.transcript && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white/80">
                    🗣️ {examState.transcript}
                    <button className="mr-2 text-teal-400 text-xs" onClick={saveVoiceAnswer}>حفظ</button>
                  </div>
                )}
                {examState.voiceAnswers[examState.qIndex] && (
                  <div className="text-teal-400 text-xs">✓ الإجابة محفوظة</div>
                )}
              </div>
            )}

            {/* MCQ options */}
            {!q.isVoice && (
              <div className="space-y-2 pt-2">
                {q.options.map(opt => {
                  const chosen = examState.answers[examState.qIndex];
                  const isChosen = chosen === opt;
                  return (
                    <button
                      key={opt}
                      className={`w-full text-right px-4 py-3 rounded-xl border transition font-medium text-sm ${
                        isChosen
                          ? 'bg-teal-500 border-teal-500 text-white'
                          : 'bg-white/5 border-white/20 text-white/80 hover:border-teal-400 hover:bg-teal-500/10'
                      }`}
                      onClick={() => handleAnswer(opt)}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Voice question: next button after saving answer */}
            {q.isVoice && examState.voiceAnswers[examState.qIndex] !== undefined && (
              <button className={`${NAVY.btn} w-full`} onClick={() => goNextQ(examState)}>
                {examState.qIndex < questions.length - 1 ? 'السؤال التالي →' : 'إنهاء الاختبار'}
              </button>
            )}
          </div>

          {/* Attempt count */}
          <p className="text-white/30 text-xs text-center">
            المحاولة {attempts.length + 1} من {tok?.maxAttempts}
          </p>
        </div>
      </div>
    );
  }

  // ─── STAGE: attempt_done ──────────────────────────────────────────────
  if (stage === 'attempt_done') {
    const lastAttempt = attempts[attempts.length - 1];
    const cancelled  = lastAttempt?.cancelled;
    const canRetry   = tok && attempts.length < tok.maxAttempts;
    const passed     = attemptScore >= (tok?.passingScore ?? 60);

    return (
      <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
        <div className={`${NAVY.card} p-8 max-w-sm w-full text-center space-y-6`}>
          <div className="text-5xl">{cancelled ? '🚫' : passed ? '🎉' : '😔'}</div>
          <div>
            <h2 className="text-2xl font-black text-white">
              {cancelled ? 'انتهت المحاولة بسبب المخالفات' : passed ? 'مبروك! اجتزت الاختبار' : 'لم تجتز الاختبار'}
            </h2>
            {!cancelled && (
              <div className={`text-4xl font-black mt-2 ${passed ? 'text-teal-400' : 'text-rose-400'}`}>
                {attemptScore}%
              </div>
            )}
            <p className="text-white/50 text-sm mt-1">
              المحاولة {attempts.length} من {tok?.maxAttempts}
            </p>
          </div>

          {canRetry ? (
            <div className="space-y-3">
              <button className={`${NAVY.btn} w-full`} onClick={retry}>
                إعادة المحاولة ({tok!.maxAttempts - attempts.length} متبقية)
              </button>
              <button className={`${NAVY.btnGhost} w-full`} onClick={() => setStage('all_done')}>
                إنهاء
              </button>
            </div>
          ) : (
            <button className={`${NAVY.btn} w-full`} onClick={() => setStage('all_done')}>
              عرض النتيجة النهائية
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── STAGE: all_done ──────────────────────────────────────────────────
  if (stage === 'all_done') {
    const best   = Math.max(...attempts.map(a => a.score), 0);
    const passed = best >= (tok?.passingScore ?? 60);

    return (
      <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
        <div className={`${NAVY.card} p-8 max-w-sm w-full text-center space-y-6`}>
          <Logo />
          <div className="text-5xl">{passed ? '✅' : '❌'}</div>
          <div>
            <h2 className="text-2xl font-black text-white">انتهى الاختبار</h2>
            <div className={`text-5xl font-black mt-3 ${passed ? 'text-teal-400' : 'text-rose-400'}`}>{best}%</div>
            <p className={`font-bold mt-1 ${passed ? 'text-teal-400' : 'text-rose-400'}`}>
              {passed ? 'ناجح ✓' : 'لم يتجاوز الحد الأدنى'}
            </p>
          </div>
          <div className="text-sm text-white/50 space-y-1">
            <div>{name}</div>
            <div>{jobTitle}</div>
            <div>{attempts.length} محاولة</div>
          </div>
          <p className="text-white/40 text-xs">
            شكراً. ستُراجَع نتيجتك من قِبل الإدارة.
          </p>
        </div>
      </div>
    );
  }

  return null;
}
