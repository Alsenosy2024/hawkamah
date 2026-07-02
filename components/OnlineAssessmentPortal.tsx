import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getExamToken, verifyExamAccess, getExamResult, saveExamResult,
  scoreAttempt, getEffectiveTitles,
  type ExamToken, type ExamAttempt, type ExamResult,
} from '../services/onlineAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
import { useProctor } from '../hooks/useProctor';
import GenerationProgress from './GenerationProgress';
import type { PaperQuestion } from '../types';

interface Props { token: string; }

type Screen =
  | 'loading'
  | 'login'
  | 'title_pick'
  | 'permission'
  | 'generating'
  | 'exam'
  | 'attempt_done'
  | 'attempt_cancelled'
  | 'all_done'
  | 'error';

const ABJAD      = ['أ', 'ب', 'ج', 'د'];
const MAX_VIOLATIONS = 5;
const FONT = "'Thmanyah Sans','Cairo','Tajawal',sans-serif";
const NAVY = '#1B4F72';
const BLUE = '#2E86C1';
const BG   = 'linear-gradient(135deg,#EBF5FB 0%,#F8F9FA 100%)';

// ── Design tokens ──────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  wrap:  { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: BG, fontFamily: FONT, direction: 'rtl', padding: 24 },
  card:  { background: '#fff', borderRadius: 16, boxShadow: '0 4px 32px rgba(27,79,114,.12)', padding: '36px 32px', width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 12 },
  title: { margin: 0, fontSize: 22, fontWeight: 800, color: NAVY, textAlign: 'center' },
  sub:   { margin: 0, fontSize: 14, color: '#666', textAlign: 'center' },
  label: { fontSize: 13, fontWeight: 700, color: NAVY, marginTop: 4 },
  input: { border: '1.5px solid #D0DCE8', borderRadius: 8, padding: '10px 14px', fontSize: 14, outline: 'none', width: '100%', fontFamily: FONT, color: '#1a1a2e', background: '#FAFCFF', boxSizing: 'border-box' },
  select:{ border: '1.5px solid #D0DCE8', borderRadius: 8, padding: '10px 14px', fontSize: 14, outline: 'none', width: '100%', fontFamily: FONT, color: '#1a1a2e', background: '#FAFCFF', boxSizing: 'border-box' },
  btnPrimary: { background: `linear-gradient(135deg,${NAVY},${BLUE})`, color: '#fff', border: 'none', borderRadius: 10, padding: '13px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: FONT },
  btnSecondary: { background: '#EBF5FB', color: NAVY, border: `1.5px solid ${BLUE}`, borderRadius: 10, padding: '11px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: FONT },
  err:  { color: '#C0392B', fontSize: 13, margin: 0, textAlign: 'center' },
  hint: { color: '#888', fontSize: 12, textAlign: 'center', margin: 0 },
  errorBox: { background: '#FDEDEC', border: '1px solid #E74C3C', borderRadius: 12, padding: '24px 28px', color: '#C0392B', fontSize: 15, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  infoRow: { background: '#EBF5FB', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: NAVY, fontWeight: 500, display: 'flex', gap: 8, alignItems: 'flex-start' },
};

function Spinner({ small }: { small?: boolean }) {
  const sz = small ? 18 : 36;
  return (
    <div style={{ width: sz, height: sz, margin: small ? '0 auto' : '16px auto', border: `${small ? 2 : 3}px solid #D6EAF8`, borderTop: `${small ? 2 : 3}px solid ${NAVY}`, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
  );
}

// ── TTS helper ──────────────────────────────────────────────────────────────
function speakArabic(text: string) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ar-SA';
  utter.rate = 0.85;
  const voices = window.speechSynthesis.getVoices();
  const ar = voices.find(v => v.lang.startsWith('ar'));
  if (ar) utter.voice = ar;
  window.speechSynthesis.speak(utter);
}

// ── SpeechRecognition helper ────────────────────────────────────────────────
type SRConstructor = new () => SpeechRecognition;
interface SpeechRecognition extends EventTarget {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
interface SpeechRecognitionEvent { results: SpeechRecognitionResultList; }
const w = window as unknown as Record<string, unknown>;
const SR: SRConstructor | null = (w.SpeechRecognition as SRConstructor) || (w.webkitSpeechRecognition as SRConstructor) || null;

// ── Face detection helper ───────────────────────────────────────────────────
type FaceDetectorType = { detect(img: HTMLVideoElement): Promise<unknown[]> };
const FD: FaceDetectorType | null = (() => {
  if (!('FaceDetector' in window)) return null;
  try { return new (w.FaceDetector as new (opts: Record<string, unknown>) => FaceDetectorType)({ fastMode: true, maxDetectedFaces: 1 }); }
  catch { return null; }
})();

async function hasFace(video: HTMLVideoElement): Promise<boolean> {
  if (FD) {
    try {
      const faces = await FD.detect(video);
      return faces.length > 0;
    } catch { /* ignore */ }
  }
  // Canvas fallback: check luminance variance in center-top zone
  const cv = document.createElement('canvas');
  cv.width = 80; cv.height = 60;
  const ctx = cv.getContext('2d');
  if (!ctx || video.readyState < 2) return true; // assume ok if can't check
  ctx.drawImage(video, 0, 0, 80, 60);
  const d = ctx.getImageData(20, 5, 40, 40).data; // center-top region
  let sum = 0; let sumSq = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
    sum += lum; sumSq += lum * lum;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return variance > 60; // low variance = uniform background = no face
}

// ═══════════════════════════════════════════════════════════════════════════
export function OnlineAssessmentPortal({ token: tokenId }: Props) {
  const [screen, setScreen]     = useState<Screen>('loading');
  const [tok, setTok]           = useState<ExamToken | null>(null);
  const [errMsg, setErrMsg]     = useState('');
  const [result, setResult]     = useState<ExamResult | null>(null);
  const [titles, setTitles]     = useState<string[]>([]);

  // Login
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Title pick
  const [empName, setEmpName]         = useState('');
  const [selectedTitle, setSelectedTitle] = useState('');

  // Exam state
  const [questions, setQuestions]   = useState<PaperQuestion[]>([]);
  const [genMsg, setGenMsg]         = useState('');
  const [genErr, setGenErr]         = useState('');
  const [genDone, setGenDone]       = useState(0);
  const [genTotal, setGenTotal]     = useState(0);
  const genAbortRef = useRef<AbortController | null>(null);
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [qIndex, setQIndex]         = useState(0);
  const [chosen, setChosen]         = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [violations, setViolations] = useState(0);
  const [violationMsg, setViolationMsg] = useState('');
  const [startedAt, setStartedAt]   = useState('');
  const [attempts, setAttempts]     = useState<ExamAttempt[]>([]);

  // Voice question state
  const [voicePhase, setVoicePhase] = useState<'idle' | 'playing' | 'recording' | 'done'>('idle');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const voiceAnswersRef = useRef<Record<number, string>>({});
  const recogRef = useRef<InstanceType<SRConstructor> | null>(null);

  // Refs
  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const violationRef  = useRef(0);
  const answersRef    = useRef<Record<number, string>>({});
  const chosenRef     = useRef('');
  const qIndexRef     = useRef(0);
  const questionsRef  = useRef<PaperQuestion[]>([]);

  // ── Live AI proctoring (Gemini Live: camera + shared screen → cheating signals) ──
  const screenPreviewRef  = useRef<HTMLVideoElement>(null);   // VISIBLE screen-share preview tile
  const proctor = useProctor({ language: 'ar', getQuestion: () => qIndexRef.current, intervalMs: 4000 });

  // Bind the visible screen-share preview once the exam view (and its ref) mount.
  useEffect(() => {
    if (screen !== 'exam') return;
    const sp = screenPreviewRef.current;
    const ss = proctor.screenStreamRef.current;
    if (sp && ss && sp.srcObject !== ss) {
      sp.srcObject = ss;
      sp.play().catch(() => { /* autoplay guard */ });
    }
  }, [screen, proctor.status]);

  // ── Load token ─────────────────────────────────────────────────────────
  useEffect(() => {
    getExamToken(tokenId)
      .then(t => {
        if (!t || !t.active) { setErrMsg('الرابط غير صالح أو منتهي الصلاحية.'); setScreen('error'); return; }
        setTok(t);
        const tl = getEffectiveTitles(t);
        setTitles(tl);
        setSelectedTitle(tl[0] ?? '');
        setScreen('login');
      })
      .catch(() => { setErrMsg('تعذّر الاتصال بالخادم.'); setScreen('error'); });
  }, [tokenId]);

  // ── Login ──────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!tok) return;
    setLoginLoading(true); setLoginErr('');
    try {
      const ok = await verifyExamAccess(tok, email, password);
      if (!ok) { setLoginErr('البريد الإلكتروني أو كلمة المرور غير صحيحة.'); setLoginLoading(false); return; }
      const existing = await getExamResult(tokenId, email);
      if (existing) {
        setResult(existing);
        const used = existing.attempts.length;
        if (used >= (tok.maxAttempts ?? 3)) { setAttempts(existing.attempts); setScreen('all_done'); return; }
        setAttempts(existing.attempts);
        setAttemptNumber(used + 1);
        if (existing.employeeName) setEmpName(existing.employeeName);
        if (existing.selectedJobTitle) setSelectedTitle(existing.selectedJobTitle);
      }
      setScreen('title_pick');
    } catch { setLoginErr('خطأ في الاتصال، حاول مجدداً.'); }
    setLoginLoading(false);
  };

  // ── Camera + fullscreen ────────────────────────────────────────────────
  const requestPermissions = async () => {
    const needAudio = (tok?.voiceQuestionCount ?? 0) > 0;
    // Request SCREEN SHARE here, FIRST: getDisplayMedia REQUIRES a user gesture and
    // this click is it — it must run before any `await` consumes the gesture. On
    // success we keep the stream for the proctor; on denial/cancel the proctor will
    // run camera-only. The proctor itself starts once the camera + exam are ready.
    // requestScreen() flips status to 'connecting' and stores the stream; left
    // un-awaited so the camera getUserMedia below is requested concurrently.
    proctor.requestScreen().then(scr => {
      if (scr && screenPreviewRef.current) {
        screenPreviewRef.current.srcObject = scr;
        screenPreviewRef.current.play().catch(() => { /* autoplay guard */ });
      }
    });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: needAudio });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
    } catch {
      setErrMsg('يجب السماح بالكاميرا' + (needAudio ? ' والميكروفون' : '') + ' لإجراء الاختبار.');
      setScreen('error'); return;
    }
    try { await document.documentElement.requestFullscreen(); } catch { /* optional */ }
    setScreen('generating');
    generateQuestionsNow(selectedTitle);
  };

  const generateQuestionsNow = async (title: string) => {
    if (!tok) return;
    setGenMsg('جارٍ توليد الأسئلة...');
    setGenErr('');
    setGenDone(0);
    setGenTotal(tok.questionCount);
    genAbortRef.current?.abort();
    const ctrl = new AbortController();
    genAbortRef.current = ctrl;
    try {
      const { questions: qs } = await generatePaperQuestions(
        title, tok.questionCount, tok.difficulty, tok.behavioralPct, tok.theories,
        ctrl.signal, tok.tenantId,
        (done, total) => { setGenDone(done); setGenTotal(total); },
      );
      // Tag last N as voice questions
      const voiceCount = Math.min(tok.voiceQuestionCount ?? 0, qs.length);
      for (let i = qs.length - voiceCount; i < qs.length; i++) {
        qs[i] = { ...qs[i], isVoice: true, options: [] };
      }
      questionsRef.current = qs;
      setQuestions(qs);
      setQIndex(0); qIndexRef.current = 0;
      answersRef.current = {};
      voiceAnswersRef.current = {};
      chosenRef.current = '';
      setChosen('');
      setViolations(0); violationRef.current = 0;
      setStartedAt(new Date().toISOString());
      setSecondsLeft(tok.secondsPerQuestion);
      setVoicePhase('idle');
      setScreen('exam');
      // Camera + exam are ready → start the live proctor (once per attempt). Uses the
      // screen stream captured during the permission gesture; camera-only if none.
      // startProctor() is internally guarded to start at most once per attempt.
      proctor.startProctor(streamRef.current, proctor.screenStreamRef.current);
    } catch (e: unknown) {
      if (ctrl.signal.aborted) return;   // cancelled — cancelGenerating already reset the screen
      // MAJOR fix: stay on 'generating' with an inline retry instead of the
      // terminal 'error' screen, which was a dead end (reload to try again).
      setGenErr(`فشل توليد الأسئلة: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // MAJOR fix: no cancel affordance previously existed while questions generate.
  // Also releases the camera/screen-share grabbed in requestPermissions() and
  // exits fullscreen, mirroring the cleanup already done for all_done/error.
  const cancelGenerating = useCallback(() => {
    genAbortRef.current?.abort();
    streamRef.current?.getTracks().forEach(t => t.stop());
    proctor.stopProctor();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setScreen('permission');
  }, [proctor.stopProctor]);

  // ── Timer (MCQ only — voice questions manage their own time) ───────────
  useEffect(() => {
    const q = questionsRef.current[qIndexRef.current];
    if (screen !== 'exam' || q?.isVoice) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setSecondsLeft(tok?.secondsPerQuestion ?? 90);
    timerRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { doAdvance(); return tok?.secondsPerQuestion ?? 90; }
        return s - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, qIndex]);

  // ── Anti-cheat ─────────────────────────────────────────────────────────
  const addViolation = useCallback((reason: string) => {
    violationRef.current += 1;
    const n = violationRef.current;
    setViolations(n);
    const remaining = MAX_VIOLATIONS - n;
    const msg = remaining > 0
      ? `تحذير ${n}/${MAX_VIOLATIONS}: ${reason}، تبقى ${remaining} تحذير${remaining === 1 ? '' : 'ات'}`
      : reason;
    setViolationMsg(msg);
    setTimeout(() => setViolationMsg(''), 5000);
    if (n >= MAX_VIOLATIONS) doCancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (screen !== 'exam') return;
    const onVis  = () => { if (document.visibilityState === 'hidden') addViolation('مغادرة التبويب محظورة'); };
    const onBlur = () => addViolation('التبديل لنافذة أخرى محظور');
    const onFS   = () => { if (!document.fullscreenElement) addViolation('الخروج من ملء الشاشة'); };
    const onKey  = (e: KeyboardEvent) => {
      const b = e.key === 'F12' || (e.ctrlKey && 'uUsScCpPiIaA'.includes(e.key)) || (e.altKey && e.key === 'Tab');
      if (b) { e.preventDefault(); e.stopPropagation(); }
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    const noCopy = (e: ClipboardEvent) => e.preventDefault();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFS);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', noMenu);
    document.addEventListener('copy', noCopy);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFS);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('contextmenu', noMenu);
      document.removeEventListener('copy', noCopy);
    };
  }, [screen, addViolation]);

  // Camera blackout + face detection
  useEffect(() => {
    if (screen !== 'exam') return;
    const iv = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;
      // Blackout check
      const cv = document.createElement('canvas'); cv.width = 80; cv.height = 60;
      const ctx = cv.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, 80, 60);
        const d = ctx.getImageData(0, 0, 80, 60).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i+1] + d[i+2];
        if (sum / (d.length / 4 * 3) < 8) { addViolation('الكاميرا مغطّاة'); return; }
      }
      // Face presence check
      const faceOk = await hasFace(videoRef.current);
      if (!faceOk) addViolation('وجهك غير مرئي في الكاميرا، ابقَ قريباً');
    }, 3000);
    return () => clearInterval(iv);
  }, [screen, addViolation]);

  // ── Core logic ─────────────────────────────────────────────────────────
  const doCancel = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    window.speechSynthesis?.cancel();
    recogRef.current?.abort();
    proctor.stopProctor();                  // stop live proctor → proctor.summaryRef
    proctor.startedRef.current = false;     // allow a fresh proctor on the next attempt
    const finalAnswers = { ...answersRef.current };
    if (chosenRef.current) finalAnswers[qIndexRef.current] = chosenRef.current;
    const attempt: ExamAttempt = {
      attemptNumber,
      answers: finalAnswers,
      voiceAnswers: { ...voiceAnswersRef.current },
      score: 0,
      violations: violationRef.current,
      cancelled: true,
      jobTitle: selectedTitle,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(proctor.summaryRef.current ? { proctorSummary: proctor.summaryRef.current } : {}),
    };
    setAttempts(prev => {
      const updated = [...prev, attempt];
      const validScores = updated.filter(a => !a.cancelled).map(a => a.score);
      const best = validScores.length ? Math.max(...validScores) : 0;
      const nr: ExamResult = {
        ...result,
        tokenId, tenantId: tok!.tenantId, projectId: tok!.projectId,
        companyName: tok!.companyName, accessEmail: email,
        employeeName: empName, selectedJobTitle: selectedTitle,
        attempts: updated, bestScore: best, submittedAt: new Date().toISOString(),
      };
      setResult(nr);
      saveExamResult(nr).catch(console.error);
      return updated;
    });
    setScreen('attempt_cancelled');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptNumber, startedAt, result, tokenId, tok, email, empName, selectedTitle, proctor.stopProctor]);

  const doFinish = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    window.speechSynthesis?.cancel();
    recogRef.current?.abort();
    proctor.stopProctor();                  // stop live proctor → proctor.summaryRef
    proctor.startedRef.current = false;     // allow a fresh proctor on the next attempt
    const finalAnswers = { ...answersRef.current };
    if (chosenRef.current) finalAnswers[qIndexRef.current] = chosenRef.current;
    const score = scoreAttempt(questionsRef.current, finalAnswers);
    const attempt: ExamAttempt = {
      attemptNumber,
      answers: finalAnswers,
      voiceAnswers: { ...voiceAnswersRef.current },
      score,
      violations: violationRef.current,
      cancelled: false,
      jobTitle: selectedTitle,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(proctor.summaryRef.current ? { proctorSummary: proctor.summaryRef.current } : {}),
    };
    setAttempts(prev => {
      const updated = [...prev, attempt];
      const validScores = updated.filter(a => !a.cancelled).map(a => a.score);
      const best = validScores.length ? Math.max(...validScores) : 0;
      const nr: ExamResult = {
        ...result,
        tokenId, tenantId: tok!.tenantId, projectId: tok!.projectId,
        companyName: tok!.companyName, accessEmail: email,
        employeeName: empName, selectedJobTitle: selectedTitle,
        attempts: updated, bestScore: best, submittedAt: new Date().toISOString(),
      };
      setResult(nr);
      saveExamResult(nr).catch(console.error);
      if (updated.length >= (tok?.maxAttempts ?? 3)) setScreen('all_done');
      else setScreen('attempt_done');
      return updated;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptNumber, startedAt, result, tokenId, tok, email, empName, selectedTitle, proctor.stopProctor]);

  const doAdvance = useCallback(() => {
    const cur = qIndexRef.current;
    if (chosenRef.current) answersRef.current = { ...answersRef.current, [cur]: chosenRef.current };
    chosenRef.current = ''; setChosen('');
    if (cur + 1 >= questionsRef.current.length) { doFinish(); }
    else { const next = cur + 1; setQIndex(next); qIndexRef.current = next; setVoicePhase('idle'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doFinish]);

  const selectAnswer = (opt: string) => { setChosen(opt); chosenRef.current = opt; };

  const retryExam = () => {
    setAttemptNumber(n => n + 1);
    setQIndex(0); qIndexRef.current = 0;
    answersRef.current = {}; voiceAnswersRef.current = {};
    chosenRef.current = ''; setChosen('');
    setViolations(0); violationRef.current = 0;
    setVoicePhase('idle');
    setStartedAt(new Date().toISOString());
    // Fresh proctor for the new attempt: clear the previous summary + arm restart.
    proctor.stopProctor();
    proctor.resetForAttempt();
    // This retry click is a user gesture → re-request screen share for the new attempt.
    proctor.requestScreen().then(scr => {
      if (scr && screenPreviewRef.current) {
        screenPreviewRef.current.srcObject = scr;
        screenPreviewRef.current.play().catch(() => { /* autoplay guard */ });
      }
    });
    setScreen('generating');
    generateQuestionsNow(selectedTitle);
  };

  // ── Voice question handlers ────────────────────────────────────────────
  const startSpeaking = () => {
    const q = questionsRef.current[qIndexRef.current];
    if (!q) return;
    setVoicePhase('playing');
    setVoiceTranscript('');
    speakArabic(q.text);
    // After TTS finishes, auto-start recording
    const checkDone = setInterval(() => {
      if (!window.speechSynthesis.speaking) {
        clearInterval(checkDone);
        startRecording();
      }
    }, 300);
    // Safety timeout
    setTimeout(() => { clearInterval(checkDone); startRecording(); }, 15000);
  };

  const startRecording = () => {
    setVoicePhase('recording');
    if (!SR) {
      // No speech recognition — just allow them to proceed after 30s
      setTimeout(() => {
        voiceAnswersRef.current[qIndexRef.current] = '(تسجيل صوتي، بدون نص)';
        setVoiceTranscript('تم تسجيل إجابتك الصوتية.');
        setVoicePhase('done');
      }, 30000);
      return;
    }
    const rec = new SR();
    recogRef.current = rec;
    rec.lang = 'ar-SA';
    rec.continuous = true;
    rec.interimResults = true;
    let fullText = '';
    rec.onresult = (e: SpeechRecognitionEvent) => {
      fullText = Array.from(e.results).map(r => r[0].transcript).join(' ');
      setVoiceTranscript(fullText);
    };
    rec.onend = () => {
      voiceAnswersRef.current[qIndexRef.current] = fullText || '(لا يوجد نص)';
      setVoicePhase('done');
    };
    rec.onerror = () => {
      voiceAnswersRef.current[qIndexRef.current] = fullText || '(خطأ في التعرف)';
      setVoicePhase('done');
    };
    rec.start();
  };

  const stopRecording = () => {
    recogRef.current?.stop();
  };

  // Cleanup on done/error
  useEffect(() => {
    if (screen === 'all_done' || screen === 'error') {
      streamRef.current?.getTracks().forEach(t => t.stop());
      proctor.stopProctor();         // release proctor + screen tracks + hidden <video>s
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      window.speechSynthesis?.cancel();
      recogRef.current?.abort();
    }
  }, [screen, proctor.stopProctor]);

  // Backstop: release the proctor + screen stream + hidden <video> els if the
  // component unmounts without reaching a finish/cancel path.
  useEffect(() => () => { proctor.stopProctor(); }, [proctor.stopProctor]);
  useEffect(() => () => { genAbortRef.current?.abort(); }, []);

  // ═══════════════════════════ RENDER ══════════════════════════════════════

  // ── Loading ──────────────────────────────────────────────────────────
  if (screen === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50" style={{ fontFamily: FONT, direction: 'rtl' }}>
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-slate-200 border-t-emerald-600 animate-spin" />
        <p className="text-sm text-slate-500">جارٍ التحقق من الرابط...</p>
      </div>
    </div>
  );

  // ── Error ────────────────────────────────────────────────────────────
  if (screen === 'error') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
      <div className="hw-card p-8 w-full max-w-sm flex flex-col items-center gap-4 text-center">
        <div className="w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center">
          <span className="text-red-600 text-xl">!</span>
        </div>
        <p className="text-sm font-semibold text-red-700">{errMsg}</p>
      </div>
    </div>
  );

  // ── Login ────────────────────────────────────────────────────────────
  if (screen === 'login') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
      <div className="hw-card p-8 w-full max-w-sm flex flex-col gap-5">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 pb-4 border-b border-slate-200">
          {tok?.companyLogoUrl && (
            <img src={tok.companyLogoUrl} alt="logo" className="h-10 object-contain" />
          )}
          <h1 className="text-lg font-bold text-slate-900 m-0">تسجيل الدخول</h1>
          <p className="text-xs text-slate-500 m-0">الاختبار الإلكتروني · {tok?.companyName}</p>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">البريد الإلكتروني</label>
            <input
              className="hw-input"
              type="email"
              dir="ltr"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">كلمة المرور</label>
            <input
              className="hw-input"
              type="password"
              dir="ltr"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
            />
          </div>
        </div>

        {loginErr && (
          <p className="text-xs text-red-600 text-center m-0 py-2 px-3 bg-red-50 rounded-md border border-red-100">{loginErr}</p>
        )}

        <button
          className="hw-btn hw-btn-primary hw-btn-w hw-btn-lg"
          onClick={handleLogin}
          disabled={loginLoading || !email || !password}
        >
          {loginLoading ? (
            <span className="flex items-center gap-2 justify-center">
              <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              جارٍ التحقق...
            </span>
          ) : 'دخول'}
        </button>
      </div>
    </div>
  );

  // ── Title pick ───────────────────────────────────────────────────────
  if (screen === 'title_pick') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
      <div className="hw-card p-8 w-full max-w-md flex flex-col gap-5">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 pb-4 border-b border-slate-200">
          {tok?.companyLogoUrl && (
            <img src={tok.companyLogoUrl} alt="logo" className="h-10 object-contain" />
          )}
          <h1 className="text-lg font-bold text-slate-900 m-0">بياناتك</h1>
          <p className="text-xs text-slate-500 m-0">{tok?.companyName} · المحاولة {attemptNumber} من {tok?.maxAttempts ?? 3}</p>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">اسمك الكامل</label>
            <input
              className="hw-input"
              type="text"
              dir="rtl"
              value={empName}
              onChange={e => setEmpName(e.target.value)}
              placeholder="الاسم الكامل"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">المسمى الوظيفي</label>
            {titles.length > 1 ? (
              <select
                className="hw-input"
                value={selectedTitle}
                onChange={e => setSelectedTitle(e.target.value)}
                dir="rtl"
              >
                {titles.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <div className="text-sm font-semibold text-slate-800 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-md">
                {titles[0] || selectedTitle}
              </div>
            )}
          </div>
        </div>

        {/* Exam summary */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col gap-2">
          <p className="text-xs font-semibold text-slate-600 m-0">ملخص الاختبار</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <span className="text-xs text-slate-600">{tok?.questionCount ?? 20} سؤال</span>
            {(tok?.voiceQuestionCount ?? 0) > 0 && (
              <span className="text-xs text-slate-600">{tok?.voiceQuestionCount} صوتي</span>
            )}
            <span className="text-xs text-slate-600">{tok?.secondsPerQuestion ?? 90}ث / سؤال</span>
            <span className="text-xs text-slate-600">نجاح ≥ {tok?.passingScore ?? 60}٪</span>
            <span className="text-xs text-slate-600">{tok?.maxAttempts ?? 3} محاولات</span>
          </div>
        </div>

        <button
          className="hw-btn hw-btn-primary hw-btn-w hw-btn-lg"
          onClick={() => setScreen('permission')}
          disabled={!empName.trim() || !selectedTitle}
        >
          متابعة
        </button>
      </div>
    </div>
  );

  // ── Permission ───────────────────────────────────────────────────────
  if (screen === 'permission') {
    const needAudio = (tok?.voiceQuestionCount ?? 0) > 0;
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
        <div className="hw-card p-8 w-full max-w-md flex flex-col gap-5">
          {/* Header */}
          <div className="flex flex-col gap-1 pb-4 border-b border-slate-200">
            <h1 className="text-lg font-bold text-slate-900 m-0">متطلبات الاختبار</h1>
            <p className="text-xs text-slate-500 m-0">{tok?.companyName} · {selectedTitle}</p>
          </div>

          {/* Requirements list */}
          <div className="flex flex-col gap-2">
            {/* Camera */}
            <div className="flex gap-3 items-start px-3 py-2.5 bg-green-50 border border-green-200 rounded-md">
              <svg className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              <span className="text-sm text-slate-700">إذن الكاميرا مطلوب؛ ابقَ مرئياً طوال الاختبار</span>
            </div>
            {/* Microphone if needed */}
            {needAudio && (
              <div className="flex gap-3 items-start px-3 py-2.5 bg-green-50 border border-green-200 rounded-md">
                <svg className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                <span className="text-sm text-slate-700">إذن الميكروفون مطلوب للأسئلة الصوتية</span>
              </div>
            )}
            {/* Fullscreen */}
            <div className="flex gap-3 items-start px-3 py-2.5 bg-green-50 border border-green-200 rounded-md">
              <svg className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              <span className="text-sm text-slate-700">الاختبار يعمل في وضع ملء الشاشة، لا تغادره</span>
            </div>
            {/* Violations warning */}
            <div className="flex gap-3 items-start px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md">
              <span className="text-amber-600 font-bold text-sm mt-0.5 flex-shrink-0">!</span>
              <span className="text-sm text-slate-700">
                التبديل بين التبويبات أو إخفاء الوجه يُحتسب مخالفة ({MAX_VIOLATIONS} مخالفات = إلغاء المحاولة)
              </span>
            </div>
            {/* Info rows */}
            <div className="flex gap-3 items-start px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
              <span className="text-slate-400 text-sm mt-0.5 flex-shrink-0">i</span>
              <span className="text-xs text-slate-600">
                {tok?.maxAttempts ?? 3} محاولات · المحاولة الملغاة لا تُحتسب في نتيجتك
              </span>
            </div>
            <div className="flex gap-3 items-start px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
              <span className="text-slate-400 text-sm mt-0.5 flex-shrink-0">i</span>
              <span className="text-xs text-slate-600">
                {tok?.questionCount ?? 20} سؤال · {tok?.secondsPerQuestion ?? 90} ثانية للسؤال المكتوب
              </span>
            </div>
          </div>

          <button className="hw-btn hw-btn-primary hw-btn-w hw-btn-lg" onClick={requestPermissions}>
            أوافق وأبدأ الاختبار
          </button>
        </div>
      </div>
    );
  }

  // ── Generating ───────────────────────────────────────────────────────
  if (screen === 'generating') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50" style={{ fontFamily: FONT, direction: 'rtl' }}>
      <div className="hw-card p-10 w-full max-w-xs flex flex-col items-center gap-4 text-center">
        <GenerationProgress
          language="ar"
          title="جارٍ الإعداد..."
          message={genErr ? undefined : (genMsg || 'توليد أسئلة مخصصة بالذكاء الاصطناعي...')}
          hint={genErr ? undefined : `المحاولة ${attemptNumber} · ${selectedTitle} · قد يستغرق ٣٠–٦٠ ثانية`}
          done={genDone}
          total={genTotal}
          error={genErr || null}
          onCancel={genErr ? undefined : cancelGenerating}
          onRetry={genErr ? () => generateQuestionsNow(selectedTitle) : undefined}
        />
      </div>
    </div>
  );

  // ── Exam ─────────────────────────────────────────────────────────────
  if (screen === 'exam') {
    const q = questions[qIndex];
    if (!q) return null;
    const totalQ   = questions.length;
    const progPct  = (qIndex / totalQ) * 100;
    const secMax   = tok?.secondsPerQuestion ?? 90;
    const timerPct = q.isVoice ? 100 : (secondsLeft / secMax) * 100;
    const timerColor = q.isVoice ? '#8E44AD' : (secondsLeft > 30 ? '#27AE60' : secondsLeft > 10 ? '#E67E22' : '#C0392B');
    const passing  = tok?.passingScore ?? 60;

    return (
      <div className="min-h-screen bg-slate-50" style={{ fontFamily: FONT, direction: 'rtl' }}>

        {/* Camera corner tile */}
        <div style={{ position: 'fixed', top: 12, left: 12, zIndex: 9999, width: 112, height: 80, borderRadius: 8, overflow: 'hidden', border: '1px solid #e3eaee', background: '#000' }}>
          <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <div style={{ position: 'absolute', bottom: 0, inset: 'auto 0 0', background: 'rgba(18,42,51,.75)', color: '#fff', fontSize: 9, textAlign: 'center', padding: '2px 0', letterSpacing: '0.03em' }}>مراقبة مباشرة</div>
        </div>

        {/* Screen-share preview tile */}
        {proctor.screenStreamRef.current && (
          <div style={{ position: 'fixed', top: 100, left: 12, zIndex: 9999, width: 112, height: 68, borderRadius: 8, overflow: 'hidden', border: '1px solid #e3eaee', background: '#000' }}>
            <video ref={screenPreviewRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />
            <div style={{ position: 'absolute', bottom: 0, inset: 'auto 0 0', background: 'rgba(108,52,131,.75)', color: '#fff', fontSize: 9, textAlign: 'center', padding: '2px 0', letterSpacing: '0.03em' }}>مشاركة الشاشة</div>
          </div>
        )}

        {/* Live proctoring status chip */}
        {proctor.status !== 'off' && (() => {
          const live = proctor.status === 'live';
          const chipColor = proctor.integrity >= 85 ? '#27AE60' : proctor.integrity >= 70 ? '#E67E22' : '#C0392B';
          const label =
            proctor.status === 'connecting' ? 'يتصل...'
            : proctor.status === 'unavailable' ? 'المراقبة غير متاحة'
            : proctor.status === 'closed' ? 'انتهت المراقبة'
            : `نزاهة ${proctor.integrity}٪`;
          return (
            <div style={{ position: 'fixed', top: proctor.screenStreamRef.current ? 176 : 100, left: 12, zIndex: 9999, display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fff', border: `1px solid ${live ? chipColor : '#e3eaee'}`, borderRadius: 999, padding: '3px 9px', fontSize: 10, fontWeight: 700, color: live ? chipColor : '#8a9aa3', fontFamily: FONT }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? chipColor : '#cdd8dd', display: 'inline-block', flexShrink: 0 }} />
              {label}
            </div>
          );
        })()}

        {/* Proctor alert banner */}
        {proctor.alert && (
          <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 10000, maxWidth: 'min(92vw,480px)', background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 8, padding: '10px 16px', textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#92400e', boxShadow: '0 4px 16px rgba(245,158,11,.15)', fontFamily: FONT }}>
            سلوك مُريب{proctor.alert.question != null ? ` في السؤال ${proctor.alert.question + 1}` : ''}
            <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: '#b45309', marginTop: 2 }}>
              {proctor.alert.type} · {proctor.alert.severity}
            </span>
          </div>
        )}

        {/* Violation banner */}
        {violationMsg && (
          <div style={{ position: 'fixed', top: 12, left: 136, right: 12, zIndex: 9999, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '9px 14px', textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#b91c1c', fontFamily: FONT }}>
            {violationMsg}
          </div>
        )}

        {/* Sticky instrument header */}
        <div className="sticky top-0 z-50 bg-white border-b border-slate-200" style={{ fontFamily: FONT }}>
          <div className="flex items-center justify-between gap-4 px-5 py-3 flex-wrap">
            <div className="text-sm font-semibold text-slate-800">{tok?.companyName} · {selectedTitle}</div>
            <div className="flex items-center gap-5">
              <span className="text-xs text-slate-500">
                المحاولة <strong className="text-slate-800">{attemptNumber}</strong>/{tok?.maxAttempts ?? 3}
              </span>
              <span className="text-xs text-slate-500">
                سؤال <strong className="text-slate-800">{qIndex + 1}</strong>/{totalQ}
              </span>
              {!q.isVoice && (
                <span className="font-mono font-bold text-sm tabular-nums" style={{ color: timerColor }}>
                  {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
                </span>
              )}
              {q.isVoice && (
                <span className="text-xs font-semibold" style={{ color: '#8E44AD' }}>صوتي</span>
              )}
            </div>
          </div>
          {/* Progress track: question progress */}
          <div className="h-0.5 bg-slate-100">
            <div className="h-full bg-emerald-600 transition-all duration-300" style={{ width: `${progPct}%` }} />
          </div>
          {/* Timer track */}
          <div className="h-0.5 bg-slate-100">
            <div
              className="h-full"
              style={{
                width: `${timerPct}%`,
                background: timerColor,
                transition: q.isVoice ? 'none' : 'width 1s linear',
              }}
            />
          </div>
        </div>

        {/* Question content */}
        <div className="max-w-2xl mx-auto px-4 py-8">

          {/* Type badges */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-sm"
              style={{
                background: q.type === 'behavioral' ? '#f5f3ff' : '#eef8fa',
                color: q.type === 'behavioral' ? '#7c3aed' : '#0a6775',
              }}
            >
              {q.type === 'behavioral' ? 'سلوكي' : 'فني'}
            </span>
            {q.isVoice && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-sm" style={{ background: '#f5f3ff', color: '#6d28d9' }}>
                إجابة صوتية
              </span>
            )}
            {q.theory && q.theory !== 'general' && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-sm" style={{ background: '#f0fdf4', color: '#15803d' }}>
                {q.theory}
              </span>
            )}
          </div>

          {/* Question text */}
          <div className="hw-card p-5 mb-5 text-base font-semibold text-slate-900 leading-relaxed">
            {q.text}
          </div>

          {/* MCQ options */}
          {!q.isVoice && (
            <>
              <div className="flex flex-col gap-2.5 mb-6">
                {q.options.map((opt, i) => {
                  const letter = ABJAD[i] ?? String(i + 1);
                  const isSelected = chosen === opt || chosen === letter;
                  return (
                    <button
                      key={i}
                      onClick={() => selectAnswer(opt)}
                      className="text-right px-4 py-3 rounded-lg border transition-all duration-150 cursor-pointer w-full flex items-start gap-3"
                      style={{
                        background: isSelected ? '#eef8fa' : '#fcfefe',
                        border: isSelected ? '1px solid #11a8bc' : '1px solid #e3eaee',
                        color: isSelected ? '#122a33' : '#374151',
                        fontFamily: FONT,
                        fontSize: 14,
                        fontWeight: isSelected ? 600 : 400,
                        boxShadow: isSelected ? '0 0 0 1px #11a8bc' : 'none',
                      }}
                    >
                      <strong
                        className="flex-shrink-0 text-sm w-5 text-center"
                        style={{ color: isSelected ? '#11a8bc' : '#9ca3af' }}
                      >
                        {letter}
                      </strong>
                      <span>{opt.replace(/^[أبجد]\.\s*/, '')}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between flex-wrap gap-3">
                <button
                  className="hw-btn hw-btn-primary"
                  onClick={doAdvance}
                >
                  {qIndex + 1 >= totalQ ? 'إنهاء الاختبار' : 'السؤال التالي'}
                </button>
                <p className="text-xs text-slate-400 m-0">
                  مخالفات: {violations}/{MAX_VIOLATIONS} · نجاح ≥ {passing}٪
                </p>
              </div>
            </>
          )}

          {/* Voice question UI */}
          {q.isVoice && (
            <div className="flex flex-col gap-3">
              {voicePhase === 'idle' && (
                <button
                  className="hw-btn hw-btn-w"
                  style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '12px 0', fontSize: 14, fontWeight: 600, fontFamily: FONT, cursor: 'pointer' }}
                  onClick={startSpeaking}
                >
                  استمع للسؤال وسجّل إجابتك
                </button>
              )}
              {voicePhase === 'playing' && (
                <div className="flex items-center gap-3 px-4 py-3 bg-violet-50 border border-violet-200 rounded-lg text-sm font-semibold text-violet-700">
                  <div className="w-4 h-4 rounded-full border-2 border-violet-200 border-t-violet-600 animate-spin flex-shrink-0" />
                  يُقرأ السؤال بصوت عالٍ...
                </div>
              )}
              {voicePhase === 'recording' && (
                <>
                  <div className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-lg">
                    <span className="w-2.5 h-2.5 mt-1 rounded-full bg-red-500 flex-shrink-0 animate-pulse" />
                    <div className="flex flex-col gap-1">
                      <div className="text-sm font-semibold text-red-700">جارٍ التسجيل، تحدّث الآن</div>
                      {voiceTranscript && (
                        <div className="text-xs text-slate-500">{voiceTranscript}</div>
                      )}
                    </div>
                  </div>
                  <button
                    className="hw-btn hw-btn-ghost hw-btn-w"
                    onClick={stopRecording}
                  >
                    إنهاء التسجيل
                  </button>
                </>
              )}
              {voicePhase === 'done' && (
                <>
                  <div className="flex items-start gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-lg">
                    <svg className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    <div className="flex flex-col gap-1">
                      <div className="text-sm font-semibold text-green-700">تم تسجيل إجابتك الصوتية.</div>
                      {voiceTranscript && (
                        <div className="text-xs text-slate-500">
                          "{voiceTranscript.slice(0, 120)}{voiceTranscript.length > 120 ? '...' : ''}"
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <button className="hw-btn hw-btn-primary" onClick={doAdvance}>
                      {qIndex + 1 >= totalQ ? 'إنهاء الاختبار' : 'السؤال التالي'}
                    </button>
                    <p className="text-xs text-slate-400 m-0">مخالفات: {violations}/{MAX_VIOLATIONS}</p>
                  </div>
                </>
              )}
              {voicePhase !== 'done' && (
                <p className="text-xs text-slate-400 m-0">مخالفات: {violations}/{MAX_VIOLATIONS}</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Attempt done ─────────────────────────────────────────────────────
  if (screen === 'attempt_done') {
    const last = attempts[attempts.length - 1];
    const remaining = (tok?.maxAttempts ?? 3) - attempts.length;
    const passing = tok?.passingScore ?? 60;
    const passed = last.score >= passing;
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
        <div className="hw-card p-8 w-full max-w-sm flex flex-col items-center gap-5 text-center">
          {/* Score display */}
          <div className="flex flex-col items-center gap-2 w-full pb-5 border-b border-slate-200">
            <p className="text-xs font-semibold text-slate-500 m-0 uppercase tracking-wide">نتيجة المحاولة {last.attemptNumber}</p>
            <div
              className="text-5xl font-black tabular-nums"
              style={{ color: passed ? '#15803d' : '#122a33' }}
            >
              {last.score}٪
            </div>
            <div
              className="text-sm font-semibold px-3 py-1 rounded-md"
              style={{
                background: passed ? '#f0fdf4' : '#fff7ed',
                color: passed ? '#15803d' : '#c2410c',
              }}
            >
              {passed ? 'اجتزت الاختبار' : `لم تصل لدرجة النجاح (${passing}٪)`}
            </div>
          </div>

          {last.violations > 0 && (
            <p className="text-xs text-amber-600 m-0">مخالفات مرصودة: {last.violations}</p>
          )}

          <p className="text-xs text-slate-500 m-0">
            {remaining > 0
              ? `لديك ${remaining} محاولة${remaining === 1 ? '' : 'ات'} متبقية، أفضل نتيجة هي المُسجَّلة`
              : 'استُنفدت جميع المحاولات.'}
          </p>

          {remaining > 0 && (
            <button className="hw-btn hw-btn-primary hw-btn-w" onClick={retryExam}>
              إعادة المحاولة ({remaining} متبقية)
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Attempt cancelled (violations) ───────────────────────────────────
  if (screen === 'attempt_cancelled') {
    const remaining = (tok?.maxAttempts ?? 3) - attempts.length;
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
        <div className="hw-card p-8 w-full max-w-sm flex flex-col gap-5 text-center">
          {/* Header */}
          <div className="flex flex-col items-center gap-2 pb-4 border-b border-slate-200">
            <div className="w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center">
              <span className="text-red-600 font-bold text-lg">!</span>
            </div>
            <h2 className="text-base font-bold text-slate-900 m-0">تم إلغاء هذه المحاولة</h2>
          </div>

          <p className="text-sm text-slate-600 m-0">
            وصلت إلى الحد الأقصى من التحذيرات ({MAX_VIOLATIONS}) بسبب مخالفات الرقابة.
          </p>

          <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-md text-right">
            <span className="text-red-500 text-sm font-bold flex-shrink-0">!</span>
            <p className="text-xs text-red-700 m-0">لن تُحتسب هذه المحاولة في نتيجتك النهائية.</p>
          </div>

          {remaining > 0 ? (
            <>
              <p className="text-xs text-slate-500 m-0">
                تبقى لك <strong className="text-slate-800">{remaining}</strong> محاولة{remaining === 1 ? '' : 'ات'}
              </p>
              <button className="hw-btn hw-btn-primary hw-btn-w" onClick={retryExam}>
                ابدأ المحاولة التالية
              </button>
            </>
          ) : (
            <p className="text-xs font-semibold text-red-600 m-0">استُنفدت جميع المحاولات المتاحة.</p>
          )}

          <button className="hw-btn hw-btn-ghost hw-btn-w" onClick={() => setScreen('all_done')}>
            عرض ملخص النتائج
          </button>
        </div>
      </div>
    );
  }

  // ── All done ─────────────────────────────────────────────────────────
  if (screen === 'all_done') {
    const validAttempts = attempts.filter(a => !a.cancelled);
    const best = validAttempts.length ? Math.max(...validAttempts.map(a => a.score)) : 0;
    const passing = tok?.passingScore ?? 60;
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6" style={{ fontFamily: FONT, direction: 'rtl' }}>
        <div className="hw-card p-8 w-full max-w-md flex flex-col gap-5">
          {/* Header */}
          <div className="flex flex-col gap-1 pb-4 border-b border-slate-200">
            <h1 className="text-lg font-bold text-slate-900 m-0">اكتمل الاختبار</h1>
            <p className="text-xs text-slate-500 m-0">{tok?.companyName} · {selectedTitle}</p>
          </div>

          {/* Attempts list */}
          <div className="flex flex-col gap-2">
            {attempts.map(a => {
              const isBest = !a.cancelled && a.score === best;
              return (
                <div
                  key={a.attemptNumber}
                  className="flex items-center justify-between px-4 py-3 rounded-lg border"
                  style={{
                    background: a.cancelled ? '#fffbeb' : isBest ? '#eef8fa' : '#f7fafb',
                    border: `1px solid ${a.cancelled ? '#fcd34d' : isBest ? '#11a8bc' : '#e3eaee'}`,
                    boxShadow: isBest ? '0 0 0 1px #11a8bc' : 'none',
                  }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold" style={{ color: a.cancelled ? '#b45309' : '#122a33' }}>
                      المحاولة {a.attemptNumber}
                    </span>
                    {a.cancelled && (
                      <span className="text-xs text-amber-600">ملغاة</span>
                    )}
                    {isBest && (
                      <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-sm border border-emerald-200">
                        أفضل
                      </span>
                    )}
                    {a.violations > 0 && !a.cancelled && (
                      <span className="text-xs text-amber-600">{a.violations} مخالفة</span>
                    )}
                  </div>
                  <span
                    className="text-xl font-black tabular-nums"
                    style={{ color: a.cancelled ? '#d1d5db' : isBest ? '#122a33' : '#6b7280' }}
                  >
                    {a.cancelled ? '×' : `${a.score}٪`}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Best score summary */}
          <div
            className="px-5 py-5 rounded-lg border text-center flex flex-col gap-1"
            style={{
              background: '#f7fafb',
              border: '1px solid #e3eaee',
            }}
          >
            <p className="text-xs text-slate-500 m-0">أفضل نتيجة مُسجَّلة</p>
            <div
              className="text-5xl font-black tabular-nums"
              style={{ color: best >= passing ? '#15803d' : '#122a33' }}
            >
              {best}٪
            </div>
            <p
              className="text-sm font-semibold m-0"
              style={{ color: best >= passing ? '#15803d' : '#c2410c' }}
            >
              {best >= passing ? `اجتزت (النجاح ≥ ${passing}٪)` : `لم تصل للنجاح (${passing}٪)`}
            </p>
          </div>

          <p className="text-xs text-slate-400 text-center m-0">تم حفظ نتيجتك. يمكنك إغلاق هذه الصفحة.</p>
        </div>
      </div>
    );
  }

  return null;
}
