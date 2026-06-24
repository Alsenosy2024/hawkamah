import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getExamToken, verifyExamAccess, getExamResult, saveExamResult,
  scoreAttempt, getEffectiveTitles,
  type ExamToken, type ExamAttempt, type ExamResult,
} from '../services/onlineAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
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
    } catch { setLoginErr('خطأ في الاتصال — حاول مجدداً.'); }
    setLoginLoading(false);
  };

  // ── Camera + fullscreen ────────────────────────────────────────────────
  const requestPermissions = async () => {
    const needAudio = (tok?.voiceQuestionCount ?? 0) > 0;
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
    try {
      const qs = await generatePaperQuestions(title, tok.questionCount, tok.difficulty, tok.behavioralPct, tok.theories);
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
    } catch (e: unknown) {
      setErrMsg(`فشل توليد الأسئلة: ${e instanceof Error ? e.message : String(e)}`);
      setScreen('error');
    }
  };

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
      ? `⚠️ تحذير ${n}/${MAX_VIOLATIONS}: ${reason} — تبقى ${remaining} تحذير${remaining === 1 ? '' : 'ات'}`
      : `🚫 ${reason}`;
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
      if (!faceOk) addViolation('وجهك غير مرئي في الكاميرا — لا تبتعد');
    }, 3000);
    return () => clearInterval(iv);
  }, [screen, addViolation]);

  // ── Core logic ─────────────────────────────────────────────────────────
  const doCancel = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    window.speechSynthesis?.cancel();
    recogRef.current?.abort();
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
  }, [attemptNumber, startedAt, result, tokenId, tok, email, empName, selectedTitle]);

  const doFinish = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    window.speechSynthesis?.cancel();
    recogRef.current?.abort();
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
  }, [attemptNumber, startedAt, result, tokenId, tok, email, empName, selectedTitle]);

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
        voiceAnswersRef.current[qIndexRef.current] = '(تسجيل صوتي — بدون نص)';
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
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      window.speechSynthesis?.cancel();
      recogRef.current?.abort();
    }
  }, [screen]);

  // ═══════════════════════════ RENDER ══════════════════════════════════════

  if (screen === 'loading') return (
    <div style={S.wrap}><div style={{ textAlign: 'center' }}><Spinner /><p style={S.hint}>جارٍ التحقق من الرابط...</p></div></div>
  );

  if (screen === 'error') return (
    <div style={S.wrap}><div style={S.errorBox}><span style={{ fontSize: 40 }}>⚠️</span>{errMsg}</div></div>
  );

  // ── Login ────────────────────────────────────────────────────────────
  if (screen === 'login') return (
    <div style={S.wrap}>
      <div style={S.card}>
        {tok?.companyLogoUrl && <img src={tok.companyLogoUrl} alt="logo" style={{ height: 48, objectFit: 'contain', margin: '0 auto 4px' }} />}
        <h2 style={S.title}>تسجيل الدخول</h2>
        <p style={S.sub}>الاختبار الإلكتروني — {tok?.companyName}</p>
        <label style={S.label}>البريد الإلكتروني</label>
        <input style={S.input} type="email" dir="ltr" value={email}
          onChange={e => setEmail(e.target.value)} placeholder="your@email.com"
          onKeyDown={e => e.key === 'Enter' && handleLogin()} />
        <label style={S.label}>كلمة المرور</label>
        <input style={S.input} type="password" dir="ltr" value={password}
          onChange={e => setPassword(e.target.value)} placeholder="••••••••"
          onKeyDown={e => e.key === 'Enter' && handleLogin()} />
        {loginErr && <p style={S.err}>{loginErr}</p>}
        <button style={{ ...S.btnPrimary, marginTop: 8, opacity: loginLoading || !email || !password ? 0.6 : 1 }}
          onClick={handleLogin} disabled={loginLoading || !email || !password}>
          {loginLoading ? 'جارٍ التحقق...' : 'دخول'}
        </button>
      </div>
    </div>
  );

  // ── Title pick ───────────────────────────────────────────────────────
  if (screen === 'title_pick') return (
    <div style={S.wrap}>
      <div style={{ ...S.card, maxWidth: 500 }}>
        {tok?.companyLogoUrl && <img src={tok.companyLogoUrl} alt="logo" style={{ height: 48, objectFit: 'contain', margin: '0 auto 4px' }} />}
        <h2 style={S.title}>بياناتك</h2>
        <p style={S.sub}>{tok?.companyName} — المحاولة {attemptNumber} من {tok?.maxAttempts ?? 3}</p>
        <label style={S.label}>اسمك الكامل</label>
        <input style={S.input} type="text" dir="rtl" value={empName}
          onChange={e => setEmpName(e.target.value)} placeholder="الاسم الكامل" />
        <label style={S.label}>المسمى الوظيفي</label>
        {titles.length > 1 ? (
          <select style={S.select} value={selectedTitle} onChange={e => setSelectedTitle(e.target.value)} dir="rtl">
            {titles.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <div style={{ ...S.infoRow, fontSize: 14, fontWeight: 700 }}>{titles[0] || selectedTitle}</div>
        )}
        <div style={{ ...S.infoRow, marginTop: 4, flexDirection: 'column', gap: 6 }}>
          <span style={{ fontWeight: 700, color: NAVY }}>ملخص الاختبار</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: '#555' }}>
            <span>📝 {tok?.questionCount ?? 20} سؤال</span>
            {(tok?.voiceQuestionCount ?? 0) > 0 && <span>🎤 {tok?.voiceQuestionCount} صوتي</span>}
            <span>⏱ {tok?.secondsPerQuestion ?? 90}ث / سؤال</span>
            <span>🎯 نجاح ≥ {tok?.passingScore ?? 60}٪</span>
            <span>🔄 {tok?.maxAttempts ?? 3} محاولات</span>
          </div>
        </div>
        <button style={{ ...S.btnPrimary, marginTop: 4, opacity: !empName.trim() || !selectedTitle ? 0.6 : 1 }}
          onClick={() => setScreen('permission')}
          disabled={!empName.trim() || !selectedTitle}>
          متابعة →
        </button>
      </div>
    </div>
  );

  // ── Permission ───────────────────────────────────────────────────────
  if (screen === 'permission') {
    const needAudio = (tok?.voiceQuestionCount ?? 0) > 0;
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, maxWidth: 520 }}>
          <h2 style={S.title}>📷 متطلبات الاختبار</h2>
          <p style={S.sub}>{tok?.companyName} — {selectedTitle}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0' }}>
            {([
              ['✓', '#27AE60', 'سيُطلب إذن الكاميرا — ابقَ مرئياً طوال الاختبار ولا تبتعد'],
              ...(needAudio ? [['✓', '#27AE60', 'سيُطلب إذن الميكروفون — للإجابة على الأسئلة الصوتية'] as [string,string,string]] : []),
              ['✓', '#27AE60', 'سيعمل الاختبار في وضع ملء الشاشة — لا تغادره'],
              ['⚠', '#E67E22', `التبديل بين التبويبات أو إخفاء الوجه يُحتسب مخالفة (${MAX_VIOLATIONS} مخالفات = إلغاء المحاولة)`],
              ['ℹ', BLUE,      `لديك ${tok?.maxAttempts ?? 3} محاولات — المحاولة الملغاة بالمخالفات لا تُحتسب في نتيجتك`],
              ['ℹ', BLUE,      `${tok?.questionCount ?? 20} سؤال · ${tok?.secondsPerQuestion ?? 90} ثانية للسؤال المكتوب`],
            ] as [string, string, string][]).map(([icon, color, text], i) => (
              <div key={i} style={S.infoRow}>
                <span style={{ flexShrink: 0, color, fontWeight: 700 }}>{icon}</span>
                <span style={{ color: '#444' }}>{text}</span>
              </div>
            ))}
          </div>
          <button style={{ ...S.btnPrimary, marginTop: 4 }} onClick={requestPermissions}>
            أوافق وأبدأ الاختبار
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'generating') return (
    <div style={S.wrap}>
      <div style={{ ...S.card, textAlign: 'center' }}>
        <Spinner />
        <h2 style={S.title}>جارٍ الإعداد...</h2>
        <p style={S.sub}>{genMsg || 'توليد أسئلة مخصصة بالذكاء الاصطناعي...'}</p>
        <p style={S.hint}>المحاولة {attemptNumber} — {selectedTitle} — قد يستغرق ٣٠–٦٠ ثانية</p>
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
      <div style={{ minHeight: '100vh', background: '#F0F3F7', fontFamily: FONT, direction: 'rtl' }}>

        {/* Camera corner */}
        <div style={{ position: 'fixed', top: 12, left: 12, zIndex: 9999, width: 120, height: 88, borderRadius: 10, overflow: 'hidden', border: `2px solid ${BLUE}`, boxShadow: '0 2px 12px rgba(27,79,114,.25)', background: '#000' }}>
          <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <div style={{ position: 'absolute', bottom: 0, inset: 'auto 0 0', background: `rgba(27,79,114,.7)`, color: '#fff', fontSize: 10, textAlign: 'center', padding: '2px 0' }}>مراقبة مباشرة</div>
        </div>

        {/* Violation banner */}
        {violationMsg && (
          <div style={{ position: 'fixed', top: 12, left: 148, right: 12, zIndex: 9999, background: '#FDEDEC', border: '1px solid #E74C3C', borderRadius: 10, padding: '10px 16px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#C0392B', fontFamily: FONT }}>
            {violationMsg}
          </div>
        )}

        {/* Sticky header */}
        <div style={{ position: 'sticky', top: 0, zIndex: 100, background: '#fff', borderBottom: '1px solid #E0E6ED', boxShadow: '0 2px 12px rgba(27,79,114,.08)', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', fontFamily: FONT }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: NAVY }}>{tok?.companyName} — {selectedTitle}</div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: '#777' }}>المحاولة <strong style={{ color: NAVY }}>{attemptNumber}</strong>/{tok?.maxAttempts ?? 3}</span>
            <span style={{ color: '#777' }}>سؤال <strong style={{ color: NAVY }}>{qIndex + 1}</strong>/{totalQ}</span>
            {!q.isVoice && (
              <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 15, color: timerColor }}>
                ⏱ {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
              </span>
            )}
            {q.isVoice && <span style={{ color: '#8E44AD', fontWeight: 700 }}>🎤 صوتي</span>}
          </div>
        </div>

        {/* Progress bars */}
        <div style={{ height: 4, background: '#E0E6ED' }}>
          <div style={{ height: '100%', width: `${progPct}%`, background: BLUE, transition: 'width .3s' }} />
        </div>
        <div style={{ height: 3, background: '#E0E6ED' }}>
          <div style={{ height: '100%', width: `${timerPct}%`, background: timerColor, transition: q.isVoice ? 'none' : 'width 1s linear' }} />
        </div>

        {/* Question */}
        <div style={{ maxWidth: 740, margin: '0 auto', padding: '28px 16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '3px 10px', background: q.type === 'behavioral' ? '#F5EEF8' : '#EBF5FB', color: q.type === 'behavioral' ? '#8E44AD' : NAVY }}>
              {q.type === 'behavioral' ? 'سلوكي' : 'فني'}
            </span>
            {q.isVoice && <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '3px 10px', background: '#F5EEF8', color: '#6C3483' }}>🎤 إجابة صوتية</span>}
            {q.theory && q.theory !== 'general' && (
              <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 6, padding: '3px 10px', background: '#EAFAF1', color: '#1E8449' }}>{q.theory}</span>
            )}
          </div>

          <div style={{ background: '#fff', borderRadius: 12, padding: '20px 22px', marginBottom: 16, boxShadow: '0 1px 6px rgba(27,79,114,.08)', border: '1px solid #EAEFF4', fontSize: 16, fontWeight: 600, color: '#1a1a2e', lineHeight: 1.7 }}>
            {q.text}
          </div>

          {/* MCQ options */}
          {!q.isVoice && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                {q.options.map((opt, i) => {
                  const letter = ABJAD[i] ?? String(i + 1);
                  const isSelected = chosen === opt || chosen === letter;
                  return (
                    <button key={i} onClick={() => selectAnswer(opt)} style={{ textAlign: 'right', padding: '13px 16px', borderRadius: 10, cursor: 'pointer', border: isSelected ? `2px solid ${NAVY}` : '1.5px solid #D0DCE8', background: isSelected ? '#EBF5FB' : '#fff', color: isSelected ? NAVY : '#333', fontFamily: FONT, fontSize: 14, fontWeight: isSelected ? 700 : 400, transition: 'all .15s' }}>
                      <strong style={{ marginLeft: 8, color: isSelected ? BLUE : '#999' }}>{letter}.</strong>
                      {opt.replace(/^[أبجد]\.\s*/, '')}
                    </button>
                  );
                })}
              </div>
              <button style={{ ...S.btnPrimary, maxWidth: 220 }} onClick={doAdvance}>
                {qIndex + 1 >= totalQ ? `إنهاء الاختبار ✓` : 'السؤال التالي →'}
              </button>
              <p style={{ ...S.hint, marginTop: 12 }}>
                مخالفات: {violations}/{MAX_VIOLATIONS} · نجاح ≥ {passing}٪
              </p>
            </>
          )}

          {/* Voice question UI */}
          {q.isVoice && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {voicePhase === 'idle' && (
                <button style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#6C3483,#8E44AD)' }} onClick={startSpeaking}>
                  🔊 استمع للسؤال وسجّل إجابتك
                </button>
              )}
              {voicePhase === 'playing' && (
                <div style={{ ...S.infoRow, justifyContent: 'center', color: '#6C3483' }}>
                  <Spinner small /> <span style={{ marginRight: 8 }}>يُقرأ السؤال بصوت عالٍ...</span>
                </div>
              )}
              {voicePhase === 'recording' && (
                <>
                  <div style={{ background: '#FDF2F8', border: '2px solid #8E44AD', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 24 }}>🔴</span>
                    <div>
                      <div style={{ fontWeight: 700, color: '#6C3483', fontSize: 14 }}>جارٍ التسجيل — تحدّث الآن</div>
                      {voiceTranscript && <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>{voiceTranscript}</div>}
                    </div>
                  </div>
                  <button style={{ ...S.btnSecondary, borderColor: '#8E44AD', color: '#6C3483' }} onClick={stopRecording}>
                    ⏹ إنهاء التسجيل
                  </button>
                </>
              )}
              {voicePhase === 'done' && (
                <>
                  <div style={{ background: '#EAFAF1', border: '1.5px solid #27AE60', borderRadius: 12, padding: '14px 18px', color: '#1E8449', fontSize: 14 }}>
                    ✅ تم تسجيل إجابتك الصوتية.
                    {voiceTranscript && <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>"{voiceTranscript.slice(0, 120)}{voiceTranscript.length > 120 ? '...' : ''}"</div>}
                  </div>
                  <button style={{ ...S.btnPrimary, maxWidth: 220 }} onClick={doAdvance}>
                    {qIndex + 1 >= totalQ ? 'إنهاء الاختبار ✓' : 'السؤال التالي →'}
                  </button>
                </>
              )}
              <p style={{ ...S.hint }}>مخالفات: {violations}/{MAX_VIOLATIONS}</p>
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
      <div style={S.wrap}>
        <div style={{ ...S.card, textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>{passed ? '🎉' : '📋'}</div>
          <h2 style={S.title}>نتيجة المحاولة {last.attemptNumber}</h2>
          <div style={{ fontSize: 52, fontWeight: 900, color: passed ? '#27AE60' : NAVY, margin: '8px 0' }}>{last.score}٪</div>
          <div style={{ fontSize: 13, color: passed ? '#27AE60' : '#E67E22', fontWeight: 700, marginBottom: 4 }}>
            {passed ? '✅ اجتزت الاختبار' : `❌ لم تصل لدرجة النجاح (${passing}٪)`}
          </div>
          {last.violations > 0 && <p style={{ color: '#E67E22', fontSize: 12 }}>مخالفات مرصودة: {last.violations}</p>}
          <p style={S.hint}>
            {remaining > 0
              ? `لديك ${remaining} محاولة${remaining === 1 ? '' : 'ات'} متبقية — أفضل نتيجة هي المُسجَّلة`
              : 'استُنفدت جميع المحاولات.'}
          </p>
          {remaining > 0 && (
            <button style={S.btnPrimary} onClick={retryExam}>
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
      <div style={S.wrap}>
        <div style={{ ...S.card, textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>🚫</div>
          <h2 style={{ ...S.title, color: '#C0392B' }}>تم إلغاء هذه المحاولة</h2>
          <p style={{ fontSize: 14, color: '#555', textAlign: 'center', margin: 0 }}>
            وصلت إلى الحد الأقصى من التحذيرات ({MAX_VIOLATIONS}) بسبب مخالفات الرقابة.
          </p>
          <div style={{ background: '#FDEDEC', border: '1px solid #E74C3C', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#C0392B', textAlign: 'right' }}>
            ⚠️ لن تُحتسب هذه المحاولة في نتيجتك النهائية.
          </div>
          {remaining > 0 ? (
            <>
              <p style={{ ...S.hint, fontWeight: 600, color: NAVY }}>
                تبقى لك <strong>{remaining}</strong> محاولة{remaining === 1 ? '' : 'ات'}
              </p>
              <button style={S.btnPrimary} onClick={retryExam}>
                ابدأ المحاولة التالية
              </button>
            </>
          ) : (
            <p style={{ ...S.hint, fontWeight: 600, color: '#C0392B' }}>
              استُنفدت جميع المحاولات المتاحة.
            </p>
          )}
          <button style={{ ...S.btnSecondary, marginTop: 4 }} onClick={() => setScreen('all_done')}>
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
      <div style={S.wrap}>
        <div style={{ ...S.card, maxWidth: 520 }}>
          <h2 style={S.title}>اكتمل الاختبار</h2>
          <p style={S.sub}>{tok?.companyName} — {selectedTitle}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0' }}>
            {attempts.map(a => (
              <div key={a.attemptNumber} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 10, padding: '12px 16px', background: a.cancelled ? '#FEF9E7' : (a.score === best && !a.cancelled ? '#EBF5FB' : '#F8F9FA'), border: a.cancelled ? '1.5px solid #F0B27A' : (a.score === best && !a.cancelled ? `1.5px solid ${BLUE}` : '1.5px solid #E0E6ED') }}>
                <div>
                  <span style={{ fontWeight: 700, color: a.cancelled ? '#E67E22' : NAVY }}>المحاولة {a.attemptNumber}</span>
                  {a.cancelled && <span style={{ color: '#E67E22', fontSize: 12, marginRight: 8 }}>— ملغاة (مخالفات)</span>}
                  {!a.cancelled && a.score === best && <span style={{ color: BLUE, fontSize: 12, marginRight: 8 }}>★ أفضل</span>}
                  {a.violations > 0 && !a.cancelled && <span style={{ color: '#E67E22', fontSize: 12, marginRight: 8 }}>({a.violations} مخالفة)</span>}
                </div>
                <span style={{ fontSize: 22, fontWeight: 900, color: a.cancelled ? '#BDC3C7' : (a.score === best ? NAVY : '#777') }}>
                  {a.cancelled ? '—' : `${a.score}٪`}
                </span>
              </div>
            ))}
          </div>
          <div style={{ background: BG, border: `1.5px solid ${BLUE}`, borderRadius: 12, padding: 20, textAlign: 'center' }}>
            <p style={{ margin: '0 0 4px', fontSize: 13, color: '#777' }}>أفضل نتيجة مُسجَّلة</p>
            <div style={{ fontSize: 52, fontWeight: 900, color: best >= passing ? '#27AE60' : NAVY }}>{best}٪</div>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: best >= passing ? '#27AE60' : '#E67E22', fontWeight: 700 }}>
              {best >= passing ? `✅ اجتزت (النجاح ≥ ${passing}٪)` : `❌ لم تصل للنجاح (${passing}٪)`}
            </p>
          </div>
          <p style={S.hint}>تم حفظ نتيجتك. يمكنك إغلاق هذه الصفحة.</p>
        </div>
      </div>
    );
  }

  return null;
}
