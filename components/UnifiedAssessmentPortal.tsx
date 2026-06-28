// Unified Assessment Portal — employee-facing exam portal.
// URL param: ?assess=TOKEN
// Flow: identify → job_pick → briefing → generating → exam → attempt_done → all_done
// No per-user credentials — employees self-identify with name+email+job title.
// Voice answers use Gemini transcription (MicRecorder → transcribeAudio); question
// read-aloud uses the male Gemini TTS voice (ttsService).

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getUnifiedToken, saveUnifiedResult, scoreAttempt } from '../services/unifiedAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
import { createLiveProctor, speakProctorAlarm, type LiveProctorHandle } from '../services/proctorService';
import { type ProctorSummary } from '../services/proctorCore';
import { speak as ttsSpeak, cancelSpeech, prefetch as ttsPrefetch } from '../services/ttsService';
import { transcribeAudio } from '../services/geminiService';
import { MicRecorder, MicRecordError } from '../lib/audioRecorder';
import type { UnifiedAssessmentToken, UnifiedAssessmentResult, UnifiedAttempt, PaperQuestion } from '../types';

// ─── FaceDetector type declarations ────────────────────────────────────────
interface FaceDetectorType {
  detect(img: HTMLVideoElement): Promise<unknown[]>;
}

const w = window as unknown as Record<string, unknown>;
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
  bg:       'min-h-screen bg-[#F7FAFB] text-slate-900',
  card:     'bg-white border border-slate-200 rounded-xl',
  btn:      'hw-btn hw-btn-primary',
  btnGhost: 'hw-btn hw-btn-ghost',
  input:    'hw-input',
  label:    'block text-sm font-semibold text-slate-600 mb-1.5',
};

// ─── TTS helper ────────────────────────────────────────────────────────────
// Read a question aloud with the male Gemini voice (falls back gracefully inside
// ttsService). Never throws out of the UI.
function speakQuestion(text: string): void {
  cancelSpeech();
  void ttsSpeak(text, { gender: 'male', lang: 'ar-SA' }).catch(() => { /* never throw */ });
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
type Stage = 'loading' | 'identify' | 'job_pick' | 'briefing' | 'onboarding' | 'generating' | 'exam' | 'attempt_done' | 'all_done' | 'error';

interface ExamState {
  qIndex: number;
  answers: Record<number, string>;
  voiceAnswers: Record<number, string>;
  violations: number;
  startedAt: string;
  recording: boolean;
  transcribing: boolean;
  transcript: string;
}

// ─── Component ─────────────────────────────────────────────────────────────
export default function UnifiedAssessmentPortal({ token: tokenId }: { token: string }) {
  const [stage, setStage]         = useState<Stage>('loading');
  const [tok, setTok]             = useState<UnifiedAssessmentToken | null>(null);
  const [error, setError]         = useState('');
  const [name, setName]           = useState('');
  const [email, setEmail]         = useState('');
  const [employeeId, setEmployeeId] = useState('');
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
  const [voiceError, setVoiceError] = useState('');
  const [micLevel, setMicLevel]   = useState(0);   // live VU 0..1 — proves the mic is actually capturing
  const [skipConfirm, setSkipConfirm] = useState(false); // A5 — inline two-step guard for the one-way skip
  const [onboardAck, setOnboardAck] = useState(false);   // A2 — explicit «I read & agree» gate before entry
  const [fullscreenBanner, setFullscreenBanner] = useState(false);

  // --- Briefing device checks (mic + camera readiness before the exam) ---
  const [micChecked, setMicChecked] = useState(false);
  const [camChecked, setCamChecked] = useState(false);
  const [deviceMsg, setDeviceMsg]   = useState('');

  // --- Live AI proctoring (Gemini Live: camera + screen → cheating signals) ---
  const [proctorStatus, setProctorStatus]       = useState<'off' | 'connecting' | 'live' | 'unavailable' | 'closed'>('off');
  const [proctorIntegrity, setProctorIntegrity] = useState(100);
  const [proctorAlert, setProctorAlert]         = useState<{ type: string; severity: string; question: number | null } | null>(null);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const micRef      = useRef<MicRecorder | null>(null);
  const violRef     = useRef(0);
  const examRef     = useRef<ExamState | null>(null);
  const faceCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef    = useRef<AbortController | null>(null);

  // --- Proctor refs (off-screen feeds + screen share + integrity summary) ---
  const proctorRef        = useRef<LiveProctorHandle | null>(null);
  const screenStreamRef   = useRef<MediaStream | null>(null);
  const screenPreviewRef  = useRef<HTMLVideoElement>(null);   // VISIBLE screen-share preview tile
  const proctorElsRef     = useRef<HTMLVideoElement[]>([]);   // hidden <video>s feeding the proctor
  const proctorSummaryRef = useRef<ProctorSummary | null>(null);
  const proctorStartedRef = useRef(false);                    // guard: start the proctor only once per attempt

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

  // ─── Live AI proctor ──────────────────────────────────────────────────
  // Spin up the Gemini Live proctor: hidden off-screen <video>s feed the
  // candidate's camera + shared screen to the engine, which streams back scored
  // cheating signals. Graceful: camera-only if screen denied; NEVER throws.
  // Guarded so it only starts once per attempt.
  const startProctor = useCallback(async (screenStream: MediaStream | null) => {
    if (proctorStartedRef.current) return;
    proctorStartedRef.current = true;
    try {
      const camStream = streamRef.current;
      const mkHidden = (s: MediaStream) => {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.srcObject = s;
        v.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
        document.body.appendChild(v);
        v.play().catch(() => { /* autoplay guard */ });
        proctorElsRef.current.push(v);
        return v;
      };
      const camEl = (camStream && camStream.getVideoTracks().length) ? mkHidden(camStream) : document.createElement('video');
      const scrEl = screenStream ? mkHidden(screenStream) : null;
      const handle = createLiveProctor({
        cameraEl: camEl,
        screenEl: scrEl,
        intervalMs: 4000,                               // ~1 frame / 4s — cost-efficient
        getQuestion: () => (examRef.current?.qIndex ?? 0),   // records WHICH question each alert happened on
        onAlert: (a) => {
          setProctorAlert({ type: a.type, severity: a.severity, question: a.questionIndex ?? null });
          window.setTimeout(() => setProctorAlert(null), 6000);
          speakProctorAlarm('ar', { severity: a.severity, questionIndex: a.questionIndex });
        },
        onState: (s) => setProctorIntegrity(s.integrity),
        onStatus: (st) => setProctorStatus(st),
      });
      proctorRef.current = handle;
      await handle.start();
    } catch {
      setProctorStatus('unavailable');
    }
  }, []);

  // Stop the proctor, capture its integrity summary, release the screen stream
  // and remove the hidden off-screen <video>s. Safe to call multiple times.
  const stopProctor = useCallback(() => {
    try { proctorSummaryRef.current = proctorRef.current?.stop() ?? proctorSummaryRef.current; } catch { /* noop */ }
    proctorRef.current = null;
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    proctorElsRef.current.forEach(v => { try { v.pause(); v.srcObject = null; v.remove(); } catch { /* noop */ } });
    proctorElsRef.current = [];
  }, []);

  const stopCamera = useCallback(() => {
    if (faceCheckRef.current) clearInterval(faceCheckRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    stopProctor();
  }, [stopProctor]);

  // ─── Cancel attempt ───────────────────────────────────────────────────
  const handleCancelAttempt = useCallback(async (reason = '') => {
    cancelSpeech();
    micRef.current?.abort(); micRef.current = null;
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
      ...(proctorSummaryRef.current ? { proctorSummary: proctorSummaryRef.current } : {}),
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
      ...(employeeId.trim() ? { employeeId: employeeId.trim() } : {}),
    };
    if (resultId) result.id = resultId;
    const id = await saveUnifiedResult(result).catch(() => null);
    if (id && !resultId) setResultId(id);
  }, [attempts, questions, jobTitle, tok, name, email, employeeId, tokenId, resultId, stopCamera]);

  // ─── Finish attempt ───────────────────────────────────────────────────
  const handleFinishAttempt = useCallback(async (es: ExamState) => {
    cancelSpeech();
    micRef.current?.abort(); micRef.current = null;
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
      ...(proctorSummaryRef.current ? { proctorSummary: proctorSummaryRef.current } : {}),
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
      ...(employeeId.trim() ? { employeeId: employeeId.trim() } : {}),
    };
    if (resultId) result.id = resultId;
    const id = await saveUnifiedResult(result).catch(() => null);
    if (id && !resultId) setResultId(id);
  }, [attempts, questions, jobTitle, tok, name, email, employeeId, tokenId, resultId, stopCamera]);

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

  // ─── Voice recording (MicRecorder → Gemini transcription) ──────────────
  const startRecording = useCallback(async () => {
    setVoiceError('');
    setMicLevel(0);
    try {
      // onLevel drives the live VU meter — it PROVES capture is happening, so a
      // silent failure (mic open but engine not running) is visible immediately
      // instead of only surfacing as an empty transcript after the user stops.
      const rec = new MicRecorder((lvl) => setMicLevel(lvl));
      await rec.start();
      micRef.current = rec;
      setExamState(prev => {
        if (!prev) return prev;
        const next = { ...prev, recording: true, transcribing: false, transcript: '' };
        examRef.current = next;
        return next;
      });
    } catch (e: unknown) {
      const reason = e instanceof MicRecordError ? e.reason : '';
      setVoiceError(
        reason === 'permission' ? 'تعذّر الوصول للميكروفون — تأكد من السماح بالإذن.'
        : reason === 'unsupported' || reason === 'insecure' ? 'تعذّر تشغيل محرّك الصوت — أعد تحميل الصفحة وحاول مجدداً.'
        : 'تعذّر بدء التسجيل.');
      setExamState(prev => prev ? { ...prev, recording: false } : prev);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const rec = micRef.current;
    if (!rec) return;
    micRef.current = null;
    setMicLevel(0);
    setExamState(prev => prev ? { ...prev, recording: false, transcribing: true } : prev);
    try {
      const seg = await rec.stop();
      const text = (await transcribeAudio(seg.base64, seg.mimeType, 'ar')).trim();
      setExamState(prev => {
        if (!prev) return prev;
        const next = { ...prev, transcript: text, transcribing: false };
        examRef.current = next;
        return next;
      });
      if (!text) setVoiceError('لم نتمكن من فهم الصوت — حاول مرة أخرى.');
    } catch (e: unknown) {
      setVoiceError(e instanceof MicRecordError
        ? 'لم يُلتقط صوت — تأكد من ظهور مؤشّر الصوت أثناء التسجيل، ثم حاول مرة أخرى.'
        : 'تعذّر تحويل الصوت إلى نص — حاول مرة أخرى.');
      setExamState(prev => prev ? { ...prev, transcribing: false } : prev);
    }
  }, []);

  const saveVoiceAnswer = useCallback(() => {
    const es = examRef.current;
    if (!es) return;
    const next = {
      ...es,
      voiceAnswers: { ...es.voiceAnswers, [es.qIndex]: es.transcript },
      transcript: '',
      recording: false,
      transcribing: false,
    };
    examRef.current = next;
    setExamState(next);
  }, []);

  // ─── Navigate questions ───────────────────────────────────────────────
  const goNextQ = useCallback((es: ExamState) => {
    const next = es.qIndex + 1;
    if (next >= questions.length) { handleFinishAttempt(es); return; }
    const nextQ = questions[next];
    const nextState = { ...es, qIndex: next, transcript: '', recording: false, transcribing: false };
    examRef.current = nextState;
    setExamState(nextState);
    setVoiceError('');
    startTimer();
    cancelSpeech();
    if (nextQ.isVoice) {
      setTimeout(() => speakQuestion(nextQ.text), 400);
      const after = questions[next + 1];
      if (after?.isVoice) ttsPrefetch(after.text, { gender: 'male' });
    }
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

  // A5 — Skip the current question. One-way: records NO answer, so the question
  // stays absent from `answers`/`voiceAnswers` and scoreAttempt counts it incorrect
  // (denominator unchanged). Advances through the shared goNextQ path — which is
  // forward-only, so a skipped question is never revisitable — and finishes the
  // attempt when it's the last one. Aborts any in-progress recording to free the
  // mic, and stops the timer first so the expiry path can't also fire (no double
  // advance: skip and timer-expiry both converge on goNextQ).
  const goSkipQ = useCallback(() => {
    const es = examRef.current;
    if (!es) return;
    stopTimer();
    if (micRef.current) { micRef.current.abort(); micRef.current = null; setMicLevel(0); }
    setVoiceError('');
    goNextQ(es);
  }, [stopTimer, goNextQ]);

  // Reset the skip-confirm prompt whenever the question changes (via any path:
  // answer, skip, timer-expiry, or the voice "next" button) so it never leaks
  // across questions. This also neutralises an MCQ answer→skip double-tap: the
  // auto-advance changes qIndex, which closes the confirm before it can fire.
  useEffect(() => { setSkipConfirm(false); }, [examState?.qIndex]);

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
        startedAt: new Date().toISOString(), recording: false, transcribing: false, transcript: '',
      };
      examRef.current = init;
      setExamState(init);
      setFullscreenBanner(false);
      setVoiceError('');
      startTimer();
      if (tok.cameraProctoring) { await startCamera(); startProctor(screenStreamRef.current); }
      if (final[0]?.isVoice) {
        setTimeout(() => speakQuestion(final[0].text), 600);
        if (final[1]?.isVoice) ttsPrefetch(final[1].text, { gender: 'male' });
      }
      try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
    } catch (err: unknown) {
      if (ctrl.signal.aborted) return;
      setGenError((err as Error)?.message ?? 'فشل توليد الأسئلة');
      setStage('generating'); // stay on generating screen to show error
    }
  }, [tok, jobTitle, startTimer, startCamera, startProctor]);

  // Request SCREEN SHARE inside a user gesture (getDisplayMedia REQUIRES one and
  // it must be called BEFORE any await consumes the gesture). Resets the per-attempt
  // proctor state, stores the stream in screenStreamRef and binds the preview tile.
  // On denial/cancel → camera-only proctoring (the start path passes null screen).
  const requestScreenForProctor = useCallback(() => {
    if (!tok?.cameraProctoring) return;
    proctorStartedRef.current = false;
    proctorSummaryRef.current = null;
    setProctorStatus('connecting');
    try {
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        .then(scr => {
          screenStreamRef.current = scr;
          if (screenPreviewRef.current) {
            screenPreviewRef.current.srcObject = scr;
            screenPreviewRef.current.play().catch(() => { /* autoplay guard */ });
          }
        })
        .catch(() => { /* denied/cancelled → camera-only (start passes null screen) */ });
    } catch { /* unsupported → camera-only */ }
  }, [tok]);

  // ─── Briefing device checks ───────────────────────────────────────────
  const checkMic = useCallback(async () => {
    setDeviceMsg('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      setMicChecked(true);
    } catch {
      setMicChecked(false);
      setDeviceMsg('تعذّر الوصول للميكروفون — فعّل الإذن من المتصفح.');
    }
  }, []);

  const checkCam = useCallback(async () => {
    setDeviceMsg('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach(t => t.stop());
      setCamChecked(true);
    } catch {
      setCamChecked(false);
      setDeviceMsg('تعذّر الوصول للكاميرا — فعّل الإذن من المتصفح.');
    }
  }, []);

  // ─── Move to briefing (after picking a job title) ─────────────────────
  const proceedToBriefing = useCallback(() => {
    if (!jobTitle.trim()) return;
    setDeviceMsg('');
    setStage('briefing');
  }, [jobTitle]);

  // ─── A2: move to the onboarding/rules step (from briefing) ────────────
  // Validate the access code HERE — on the briefing screen, where the input
  // lives — so a wrong code surfaces its error in context instead of failing
  // silently two screens later. The onboarding gate then calls
  // proceedToGenerate, whose own access-code check is a harmless re-validation.
  const proceedToOnboarding = useCallback(() => {
    if (!tok) return;
    if (tok.accessCode && accessCode.trim() !== tok.accessCode.trim()) {
      setAccessError('رمز الوصول غير صحيح.'); return;
    }
    setOnboardAck(false);
    setStage('onboarding');
  }, [tok, accessCode]);

  // ─── Proceed to generation (from onboarding, after «أوافق وأبدأ») ──────
  const proceedToGenerate = useCallback(() => {
    if (!tok) return;
    if (tok.accessCode && accessCode.trim() !== tok.accessCode.trim()) {
      setAccessError('رمز الوصول غير صحيح.'); return;
    }
    requestScreenForProctor();   // grab the screen on THIS click (gesture), before the async generate
    generateQuestions();
  }, [tok, accessCode, generateQuestions, requestScreenForProctor]);

  // ─── Retry ────────────────────────────────────────────────────────────
  const retry = useCallback(() => {
    setQuestions([]);
    setVoiceError('');
    requestScreenForProctor();   // re-grab the screen on the retry click (gesture)
    generateQuestions();
  }, [generateQuestions, requestScreenForProctor]);

  // Bind the visible screen-share preview once the exam view (and its <video>
  // ref) has mounted — proceedToGenerate/retry grab the stream before this <video>
  // exists, so the binding has to happen after the exam stage renders.
  useEffect(() => {
    if (stage !== 'exam') return;
    const sp = screenPreviewRef.current;
    const ss = screenStreamRef.current;
    if (sp && ss && sp.srcObject !== ss) {
      sp.srcObject = ss;
      sp.play().catch(() => { /* autoplay guard */ });
    }
  }, [stage, proctorStatus]);

  // ─── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => () => {
    // stopCamera() also stops the proctor (releases screen tracks + removes hidden <video>s).
    stopCamera();
    micRef.current?.abort();
    abortRef.current?.abort();
    cancelSpeech();
  }, [stopCamera]);

  // ─── Render helpers ───────────────────────────────────────────────────
  const Logo = () => tok?.companyLogoUrl ? (
    <img src={tok.companyLogoUrl} alt={tok.companyName} className="h-8 max-w-[120px] object-contain mx-auto mb-3 rounded" />
  ) : null;

  const Header = ({ title, sub }: { title: string; sub?: string }) => (
    <div className="text-center mb-8">
      <Logo />
      {tok?.companyName && (
        <div className="text-xs font-semibold text-emerald-600 uppercase tracking-widest mb-3">{tok.companyName}</div>
      )}
      <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
      {sub && <p className="text-slate-500 text-sm mt-1.5 leading-relaxed">{sub}</p>}
    </div>
  );

  // ─── STAGE: loading ───────────────────────────────────────────────────
  if (stage === 'loading') return (
    <div className={`${NAVY.bg} flex items-center justify-center`} dir="rtl">
      <div className="flex items-center gap-3 text-slate-400 text-sm">
        <svg className="animate-spin h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        جارٍ التحميل…
      </div>
    </div>
  );

  // ─── STAGE: error ────────────────────────────────────────────────────
  if (stage === 'error') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-8 max-w-sm w-full text-center space-y-4`}>
        <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center mx-auto">
          <svg className="w-6 h-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-slate-900">تعذّر فتح الاختبار</h2>
        <p className="text-slate-500 text-sm leading-relaxed">{error}</p>
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
          <input className={`${NAVY.input} text-left`} type="email" dir="ltr" placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <label className={NAVY.label}>المسمى الوظيفي</label>
          <input className={NAVY.input} placeholder="مثال: محاسب أول" value={jobTitle} onChange={e => setJobTitle(e.target.value)} />
          {(tok?.allowedJobTitles ?? []).length > 0 && (
            <p className="text-slate-400 text-xs mt-1">أو اختره من القائمة في الخطوة التالية</p>
          )}
        </div>
        <div>
          <label className={NAVY.label}>الرقم الوظيفي <span className="text-slate-400 font-normal">(اختياري)</span></label>
          <input className={`${NAVY.input} text-left`} dir="ltr" placeholder="EMP-1234" value={employeeId} onChange={e => setEmployeeId(e.target.value)} />
        </div>
        {/* Notice */}
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-amber-800 text-xs leading-relaxed">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          <span>هذا الاختبار مُراقَب بالذكاء الاصطناعي (الكاميرا ومشاركة الشاشة). تأكد من جلوسك في مكان هادئ وإضاءة جيدة.</span>
        </div>
        <button
          className={`${NAVY.btn} hw-btn-w`}
          disabled={!name.trim() || !email.trim()}
          onClick={() => setStage('job_pick')}
        >
          التالي
        </button>
      </div>
    </div>
  );

  // ─── STAGE: job_pick ──────────────────────────────────────────────────
  if (stage === 'job_pick') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-8 max-w-md w-full space-y-5`}>
        <Header title="اختر مسماك الوظيفي" sub="ستُولَّد الأسئلة بناءً على وظيفتك" />

        {/* Notice banner */}
        <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 text-emerald-800 text-xs leading-relaxed">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
          <span>اختر المسمى الأقرب لوظيفتك الحالية — ستُبنى الأسئلة عليه. بعدها ستظهر شاشة تجهيز قصيرة قبل البدء.</span>
        </div>

        <div className="space-y-2 max-h-64 overflow-y-auto">
          {(tok?.allowedJobTitles ?? []).map(jt => (
            <button
              key={jt}
              className={`w-full text-start px-4 py-3 rounded-lg border transition-colors duration-150 font-medium text-sm ${
                jobTitle === jt
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
              }`}
              onClick={() => setJobTitle(jt)}
            >
              {jt}
            </button>
          ))}
          {(tok?.allowedJobTitles ?? []).length === 0 && (
            <div className="text-slate-400 text-sm text-center py-2">لا توجد مسميات محددة؛ أدخل مسماك يدوياً</div>
          )}
        </div>
        {(tok?.allowedJobTitles ?? []).length === 0 && (
          <input className={NAVY.input} placeholder="المسمى الوظيفي" value={jobTitle} onChange={e => setJobTitle(e.target.value)} />
        )}

        <div className="pt-2 space-y-3">
          {/* Exam info chips */}
          <div className="flex flex-wrap gap-2">
            {[
              `${tok?.questionCount} سؤال`,
              tok?.difficulty === 'easy' ? 'سهل' : tok?.difficulty === 'hard' ? 'صعب' : 'متوسط',
              `${tok?.secondsPerQuestion}ث/سؤال`,
              `${tok?.maxAttempts} محاولات`,
            ].map(p => (
              <span key={p} className="hw-badge-neutral text-xs">{p}</span>
            ))}
            {tok?.cameraProctoring && (
              <span className="hw-badge-warning text-xs">مراقبة بالكاميرا</span>
            )}
          </div>
          <button
            className={`${NAVY.btn} hw-btn-w`}
            disabled={!jobTitle.trim()}
            onClick={proceedToBriefing}
          >
            التالي
          </button>
          <button className="text-slate-400 text-xs w-full text-center hover:text-slate-600 transition-colors duration-150" onClick={() => setStage('identify')}>
            رجوع
          </button>
        </div>
      </div>
    </div>
  );

  // ─── STAGE: briefing ──────────────────────────────────────────────────
  if (stage === 'briefing') {
    const total     = tok?.questionCount ?? 0;
    const voiceN    = tok?.voiceQuestionCount ?? 0;
    const behavioral = Math.round((total * (tok?.behavioralPct ?? 0)) / 100);
    const technical  = Math.max(0, total - behavioral);
    const micNeeded  = voiceN > 0;
    const camNeeded  = !!tok?.cameraProctoring;
    const ready      = (!micNeeded || micChecked) && (!camNeeded || camChecked)
      && (!tok?.accessCode || accessCode.trim().length > 0);

    return (
      <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
        <div className={`${NAVY.card} p-8 max-w-md w-full space-y-5`}>
          <Header title="تجهيز الاختبار" sub={`اختبار ${jobTitle}`} />

          {/* Exam composition */}
          <div className="bg-[#EEF3F5] border border-slate-200 rounded-lg p-4 space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">إجمالي الأسئلة</span>
              <span className="font-bold text-slate-800 tabular-nums">{total}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">أسئلة فنية</span>
              <span className="font-semibold text-slate-700 tabular-nums">{technical}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">أسئلة سلوكية</span>
              <span className="font-semibold text-slate-700 tabular-nums">{behavioral}</span>
            </div>
            {micNeeded && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500">أسئلة صوتية</span>
                <span className="font-semibold text-slate-700 tabular-nums">{voiceN}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-500">الوقت لكل سؤال</span>
              <span className="font-semibold text-slate-700 tabular-nums">{tok?.secondsPerQuestion}ث</span>
            </div>
          </div>

          {/* Device checks */}
          {(micNeeded || camNeeded) && (
            <div className="space-y-2.5">
              <div className="text-sm font-semibold text-slate-600">فحص الأجهزة</div>
              {micNeeded && (
                <button
                  onClick={checkMic}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-150 ${
                    micChecked ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                  }`}
                >
                  <span>الميكروفون</span>
                  {micChecked ? (
                    <span className="flex items-center gap-1.5"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg> جاهز</span>
                  ) : <span className="text-emerald-600">فحص</span>}
                </button>
              )}
              {camNeeded && (
                <button
                  onClick={checkCam}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-150 ${
                    camChecked ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                  }`}
                >
                  <span>الكاميرا</span>
                  {camChecked ? (
                    <span className="flex items-center gap-1.5"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg> جاهز</span>
                  ) : <span className="text-emerald-600">فحص</span>}
                </button>
              )}
              {deviceMsg && <p className="text-rose-600 text-xs">{deviceMsg}</p>}
              {camNeeded && (
                <p className="text-slate-400 text-xs leading-relaxed">
                  عند بدء الاختبار ستُطلب مشاركة الشاشة للمراقبة. اسمح بها للمتابعة.
                </p>
              )}
            </div>
          )}

          {/* Access code (relocated from job selection) */}
          {tok?.accessCode && (
            <div>
              <label className={NAVY.label}>رمز الوصول</label>
              <input
                className={`${NAVY.input}${accessError ? ' border-rose-400 focus:border-rose-500' : ''}`}
                placeholder="أدخل رمز الوصول"
                value={accessCode}
                onChange={e => { setAccessCode(e.target.value); setAccessError(''); }}
              />
              {accessError && <p className="text-rose-600 text-xs mt-1">{accessError}</p>}
            </div>
          )}

          <div className="pt-1 space-y-3">
            <button
              className={`${NAVY.btn} hw-btn-w`}
              disabled={!ready}
              onClick={proceedToOnboarding}
            >
              التالي: التعليمات
            </button>
            <button className="text-slate-400 text-xs w-full text-center hover:text-slate-600 transition-colors duration-150" onClick={() => setStage('job_pick')}>
              رجوع
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── STAGE: onboarding (A2: rules, prohibitions & attempts) ───────────
  if (stage === 'onboarding') {
    const total  = tok?.questionCount ?? 0;
    const voiceN = tok?.voiceQuestionCount ?? 0;
    const secs   = tok?.secondsPerQuestion ?? 90;
    const camOn  = !!tok?.cameraProctoring;
    const maxA   = tok?.maxAttempts ?? 1;
    const attemptsLabel = maxA === 1 ? 'محاولة واحدة فقط'
      : maxA === 2 ? 'محاولتان فقط'
      : `${maxA} محاولات فقط`;

    // Prohibitions are kept in lock-step with the signals the proctor actually
    // detects (services/proctorCore.ts → ProctorSignalType). DOM-enforced rules
    // run in EVERY exam (tab_switch / window_blur / fullscreen_exit / copy);
    // the vision+audio rules only apply when camera proctoring is on, so we only
    // disclose them then — keeping disclosure and enforcement exactly aligned.
    const domRules = [
      'لا تفتح تبويبات أو نوافذ أخرى أثناء الاختبار.',            // tab_switch
      'لا تغادر نافذة الاختبار أو تنتقل إلى تطبيق آخر.',          // window_blur
      'ابقَ في وضع ملء الشاشة حتى نهاية الاختبار.',               // fullscreen_exit
      'النسخ واللصق والنقر بالزر الأيمن مُعطَّلة.',                // copy_paste / contextmenu
    ];
    const visionRules = [
      'ابقَ وحدك أمام الكاميرا ووجهك ظاهر طوال الوقت.',           // no_face / multiple_faces
      'لا تستخدم الهاتف المحمول.',                               // phone_detected
      'حافظ على النظر إلى الشاشة؛ النظر المتكرّر للخارج يُسجَّل.',  // eye_gaze_off
      'ممنوع فتح أدوات الذكاء الاصطناعي (مثل ChatGPT أو Gemini).', // ai_tool_visible
      'لا تفتح أي تطبيق أو مستند آخر على الشاشة المُشارَكة.',      // screen_other_content
      'تجنّب الضوضاء أو وجود أصوات أخرى في الخلفية.',             // audio_noise
      'أجب بتروٍّ — الإجابات السريعة جداً أو التوقّف الطويل يُسجَّل.', // rapid_answers / idle_too_long
    ];
    const prohibitions = [...domRules, ...(camOn ? visionRules : [])];

    return (
      <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
        <div className={`${NAVY.card} p-8 max-w-md w-full space-y-5`}>
          <Header title="تعليمات الاختبار" sub={`اختبار ${jobTitle}`} />

          {/* How it works */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-slate-700">كيف يعمل الاختبار</h3>
            <ul className="space-y-1.5 text-sm text-slate-600 leading-relaxed list-disc ps-5">
              <li>عدد الأسئلة: <span className="font-semibold text-slate-800">{total}</span>{voiceN > 0 ? <>، منها <span className="font-semibold text-slate-800">{voiceN}</span> صوتية</> : null}.</li>
              <li>لكل سؤال وقت محدّد: <span className="font-semibold text-slate-800">{secs} ثانية</span>، وعند انتهائه ينتقل تلقائياً.</li>
              <li>الأسئلة <span className="font-semibold text-slate-800">للأمام فقط</span> — لا يمكن الرجوع لسؤال سابق.</li>
              <li>يمكنك تجاوز أي سؤال، لكنه يُحتسب بدون إجابة.</li>
            </ul>
          </section>

          {/* Attempts */}
          <div className="bg-[#EEF3F5] border border-slate-200 rounded-lg p-3.5 flex items-center gap-2.5">
            <svg className="w-5 h-5 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <p className="text-sm text-slate-700">لديك <span className="font-bold text-slate-900">{attemptsLabel}</span> لإكمال هذا الاختبار.</p>
          </div>

          {/* Prohibitions — mirror the enforced proctor signals */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-rose-700">الممنوعات</h3>
            <ul className="space-y-1.5 text-sm text-slate-700 leading-relaxed">
              {prohibitions.map(r => (
                <li key={r} className="flex items-start gap-2">
                  <svg className="w-4 h-4 text-rose-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364M5.636 5.636l12.728 12.728" /></svg>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Monitoring notice (only when camera proctoring is active) */}
          {camOn && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 flex items-start gap-2.5">
              <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
              <p className="text-xs text-amber-800 leading-relaxed">هذا الاختبار مُراقَب بالذكاء الاصطناعي عبر الكاميرا ومشاركة الشاشة. أي مخالفة تُسجَّل وتؤثّر في درجة النزاهة.</p>
            </div>
          )}

          {/* Explicit acknowledgement gate */}
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onboardAck}
              onChange={e => setOnboardAck(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-emerald-600 flex-shrink-0"
            />
            <span className="text-sm text-slate-700 leading-relaxed">قرأتُ التعليمات والممنوعات أعلاه وأوافق على الالتزام بها.</span>
          </label>

          <div className="pt-1 space-y-3">
            <button
              className={`${NAVY.btn} hw-btn-w`}
              disabled={!onboardAck}
              onClick={proceedToGenerate}
            >
              أوافق وأبدأ
            </button>
            <button className="text-slate-400 text-xs w-full text-center hover:text-slate-600 transition-colors duration-150" onClick={() => setStage('briefing')}>
              رجوع
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── STAGE: generating ────────────────────────────────────────────────
  if (stage === 'generating') return (
    <div className={`${NAVY.bg} flex items-center justify-center p-6`} dir="rtl">
      <div className={`${NAVY.card} p-10 max-w-sm w-full text-center space-y-6`}>
        <Header title="جارٍ توليد الأسئلة" sub={`اختبار ${jobTitle}`} />
        {!genError ? (
          <>
            <div className="flex justify-center">
              <svg className="animate-spin h-10 w-10 text-emerald-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <p className="text-slate-400 text-sm leading-relaxed">يُولَّد {tok?.questionCount} سؤالاً مخصصاً لـ &quot;{jobTitle}&quot;…</p>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <p className="text-rose-600 text-sm leading-relaxed">{genError}</p>
            <button className={`${NAVY.btn} hw-btn-w`} onClick={retry}>إعادة المحاولة</button>
          </>
        )}
      </div>
    </div>
  );

  // ─── STAGE: exam ──────────────────────────────────────────────────────
  if (stage === 'exam' && examState && questions.length) {
    const q = questions[examState.qIndex];
    const progress = ((examState.qIndex + 1) / questions.length) * 100;
    const timerUrgent = remaining < 10;
    const timerWarning = !timerUrgent && remaining < 20;
    const timerColor = timerUrgent ? 'text-rose-600' : timerWarning ? 'text-amber-600' : 'text-emerald-600';
    const timerBg = timerUrgent ? 'bg-rose-50 border-rose-200' : timerWarning ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200';

    return (
      <div className="min-h-screen bg-[#F7FAFB] p-4 relative" dir="rtl" onContextMenu={e => e.preventDefault()}>
        {/* Camera corner + live proctor chip + shared-screen preview */}
        {tok?.cameraProctoring && (
          <div className="fixed bottom-4 left-4 z-50 flex items-end gap-2">
            {/* Visible preview of the shared screen (what the proctor is monitoring). */}
            {screenStreamRef.current && (
              <div className="relative w-40 h-24 rounded-lg overflow-hidden border border-amber-300 bg-slate-900 shadow-lg">
                <video ref={screenPreviewRef} muted playsInline className="w-full h-full object-contain" />
                <div className="absolute bottom-0.5 right-1 bg-black/70 px-1.5 py-0.5 rounded text-[8px] font-bold text-amber-200 tracking-widest">
                  شاشتك المُراقَبة
                </div>
              </div>
            )}
            <div className="relative">
              <video
                ref={videoRef}
                muted
                playsInline
                className="w-28 h-20 rounded-lg object-cover border border-slate-300 bg-slate-900 shadow-md"
              />
              {/* Live proctor status chip: status + integrity (green ≥85 / amber ≥70 / rose <70). */}
              {proctorStatus !== 'off' && (
                <div className={`absolute bottom-1 left-1 right-1 flex items-center justify-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide ${
                  proctorStatus === 'live'
                    ? (proctorIntegrity >= 85 ? 'bg-green-600 text-white' : proctorIntegrity >= 70 ? 'bg-amber-500 text-slate-900' : 'bg-rose-600 text-white')
                    : proctorStatus === 'unavailable' ? 'bg-slate-600 text-white' : 'bg-slate-700 text-slate-200'
                }`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${proctorStatus === 'live' ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />
                  {proctorStatus === 'live'
                    ? `مراقبة ${proctorIntegrity}`
                    : proctorStatus === 'connecting' ? 'جارٍ التوصيل'
                    : proctorStatus === 'unavailable' ? 'كاميرا فقط'
                    : 'انتهت'}
                </div>
              )}
              {camError && <p className="text-rose-600 text-xs mt-1 w-28 text-center">{camError}</p>}
            </div>
          </div>
        )}

        {/* Live cheating-alert banner — surfaces a real (non-'none') proctor violation. */}
        {proctorAlert && (
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg border bg-rose-600 text-white border-rose-700">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse flex-shrink-0" />
            <span className="text-xs font-bold">
              {proctorAlert.question != null
                ? `سلوك مُريب في السؤال ${proctorAlert.question + 1}`
                : 'رُصد سلوك مُريب'}
            </span>
            <span className="text-[11px] opacity-80">{proctorAlert.type} · {proctorAlert.severity}</span>
            <button onClick={() => setProctorAlert(null)} className="ms-2 text-white/70 hover:text-white leading-none flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        )}

        {/* Fullscreen banner */}
        {fullscreenBanner && (
          <div className="fixed top-0 inset-x-0 z-50 bg-amber-400 text-slate-900 font-semibold text-center py-2 text-sm">
            يُفضَّل الاختبار بوضع ملء الشاشة:{' '}
            <button className="underline font-bold" onClick={() => { document.documentElement.requestFullscreen().catch(() => {}); setFullscreenBanner(false); }}>
              تفعيل
            </button>
          </div>
        )}

        <div className="max-w-2xl mx-auto space-y-5 pt-4">
          {/* Header bar */}
          <div className="flex items-center justify-between gap-4">
            <div className="text-slate-500 text-sm truncate">{name} / {jobTitle}</div>
            <div className={`font-mono font-bold text-xl px-3 py-1 rounded-md border ${timerColor} ${timerBg} flex-shrink-0 tabular-nums`}>{remaining}s</div>
            {examState.violations > 0 && (
              <div className="hw-badge-danger text-xs flex-shrink-0">{examState.violations}/{MAX_VIOLATIONS} مخالفات</div>
            )}
          </div>

          {/* Progress bar */}
          <div>
            <div className="hw-progress">
              <div className="hw-progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-slate-400 text-xs">السؤال {examState.qIndex + 1} من {questions.length}</span>
              {q.isVoice && <span className="hw-badge-info text-xs">سؤال صوتي</span>}
            </div>
          </div>

          {/* Question card */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex items-center gap-2">
              <span className="hw-badge-brand text-xs">
                {q.type === 'behavioral' ? 'سلوكي' : 'فني'}
              </span>
            </div>
            <p className="text-slate-900 text-lg leading-relaxed font-semibold">{q.text}</p>

            {/* Voice question recording */}
            {q.isVoice && (
              <div className="space-y-3">
                {examState.transcribing ? (
                  <div className="flex items-center gap-2 text-slate-500 text-sm">
                    <svg className="animate-spin h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    جارٍ تحويل الصوت إلى نص…
                  </div>
                ) : !examState.recording ? (
                  <button
                    className="flex items-center gap-2 bg-white border border-slate-200 hover:border-rose-300 hover:bg-rose-50 text-slate-700 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150"
                    onClick={startRecording}
                  >
                    <svg className="w-4 h-4 text-rose-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 15.2 14.47 17 12 17s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V21c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>
                    {examState.voiceAnswers[examState.qIndex] !== undefined ? 'إعادة التسجيل' : 'ابدأ التسجيل'}
                  </button>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      className="flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium animate-pulse transition-colors duration-150 flex-shrink-0"
                      onClick={stopRecording}
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
                      إيقاف التسجيل
                    </button>
                    {/* Live VU meter — proves the mic is actually capturing. If this
                        stays flat while speaking, the audio engine didn't start. */}
                    <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden" title="مستوى الصوت" aria-label="مستوى الصوت">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-[width] duration-75 ease-out"
                        style={{ width: `${Math.min(100, Math.round(micLevel * 100))}%` }}
                      />
                    </div>
                  </div>
                )}
                {voiceError && (
                  <p className="text-rose-600 text-xs leading-relaxed">{voiceError}</p>
                )}
                {examState.transcript && !examState.transcribing && (
                  <div className="bg-[#EEF3F5] border border-slate-200 rounded-lg p-3 text-sm text-slate-700 leading-relaxed">
                    <p className="mb-2">{examState.transcript}</p>
                    <button className="text-emerald-600 text-xs font-semibold hover:text-emerald-700 transition-colors duration-150" onClick={saveVoiceAnswer}>حفظ الإجابة</button>
                  </div>
                )}
                {examState.voiceAnswers[examState.qIndex] && (
                  <div className="flex items-center gap-1.5 text-green-600 text-xs font-medium">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    الإجابة محفوظة
                  </div>
                )}
              </div>
            )}

            {/* MCQ options */}
            {!q.isVoice && (
              <div className="space-y-2 pt-1">
                {q.options.map(opt => {
                  const chosen = examState.answers[examState.qIndex];
                  const isChosen = chosen === opt;
                  return (
                    <button
                      key={opt}
                      className={`w-full text-start px-4 py-3 rounded-lg border transition-colors duration-150 font-medium text-sm ${
                        isChosen
                          ? 'bg-emerald-600 border-emerald-600 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
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
              <button className={`${NAVY.btn} hw-btn-w`} onClick={() => goNextQ(examState)}>
                {examState.qIndex < questions.length - 1 ? 'السؤال التالي' : 'إنهاء الاختبار'}
              </button>
            )}

            {/* A5 — Skip (one-way, no return). Two-step inline confirm guards an
                accidental tap; on confirm the question is left unanswered. */}
            <div className="pt-3 border-t border-slate-100">
              {!skipConfirm ? (
                <button
                  type="button"
                  onClick={() => setSkipConfirm(true)}
                  className="flex items-center gap-1.5 text-slate-400 hover:text-slate-600 text-xs font-medium transition-colors duration-150"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M18 19l-7-7 7-7" /></svg>
                  تجاوز السؤال
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-slate-600 text-xs font-medium">تخطّي بدون إجابة؟ لن تعود لهذا السؤال.</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={goSkipQ}
                      className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-semibold transition-colors duration-150"
                    >
                      {examState.qIndex < questions.length - 1 ? 'نعم، تجاوز' : 'تجاوز وإنهاء'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSkipConfirm(false)}
                      className="text-slate-500 hover:text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors duration-150"
                    >
                      إلغاء
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Attempt count */}
          <p className="text-slate-400 text-xs text-center">
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
          {/* Status icon */}
          <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto border-2 ${
            cancelled ? 'bg-rose-50 border-rose-200' : passed ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
          }`}>
            {cancelled ? (
              <svg className="w-8 h-8 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            ) : passed ? (
              <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            ) : (
              <svg className="w-8 h-8 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
            )}
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              {cancelled ? 'انتهت المحاولة بسبب المخالفات' : passed ? 'اجتزت الاختبار' : 'لم تجتز الاختبار'}
            </h2>
            {!cancelled && (
              <div className={`text-4xl font-bold mt-2 tabular-nums ${passed ? 'text-green-600' : 'text-rose-600'}`}>
                {attemptScore}%
              </div>
            )}
            <p className="text-slate-400 text-sm mt-1.5">
              المحاولة {attempts.length} من {tok?.maxAttempts}
            </p>
          </div>

          {canRetry ? (
            <div className="space-y-3">
              <button className={`${NAVY.btn} hw-btn-w`} onClick={retry}>
                إعادة المحاولة ({tok!.maxAttempts - attempts.length} متبقية)
              </button>
              <button className={`${NAVY.btnGhost} hw-btn-w`} onClick={() => setStage('all_done')}>
                إنهاء
              </button>
            </div>
          ) : (
            <button className={`${NAVY.btn} hw-btn-w`} onClick={() => setStage('all_done')}>
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
          {/* Status icon */}
          <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto border-2 ${
            passed ? 'bg-green-50 border-green-200' : 'bg-rose-50 border-rose-200'
          }`}>
            {passed ? (
              <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            ) : (
              <svg className="w-8 h-8 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            )}
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900">انتهى الاختبار</h2>
            <div className={`text-5xl font-bold mt-3 tabular-nums ${passed ? 'text-green-600' : 'text-rose-600'}`}>{best}%</div>
            <p className={`text-sm font-semibold mt-1.5 ${passed ? 'text-green-600' : 'text-rose-600'}`}>
              {passed ? 'ناجح' : 'لم يتجاوز الحد الأدنى'}
            </p>
          </div>
          <div className="bg-[#EEF3F5] rounded-lg px-4 py-3 text-sm text-slate-600 space-y-1 text-start">
            <div className="font-medium text-slate-800">{name}</div>
            <div className="text-slate-500">{jobTitle}{employeeId.trim() ? ` · ${employeeId.trim()}` : ''}</div>
            <div className="text-slate-400 text-xs">{attempts.length} محاولة</div>
          </div>
          <p className="text-slate-400 text-xs leading-relaxed">
            شكراً. ستُراجَع نتيجتك من قِبل الإدارة.
          </p>
        </div>
      </div>
    );
  }

  return null;
}
