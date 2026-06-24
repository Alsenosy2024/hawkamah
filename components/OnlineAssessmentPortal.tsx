import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getExamToken, verifyExamAccess, getExamResult, saveExamResult,
  scoreAttempt, type ExamToken, type ExamAttempt, type ExamResult,
} from '../services/onlineAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
import { createLiveProctor, type LiveProctorHandle } from '../services/proctorService';
import type { ProctorAlert, ProctorState, ProctorSummary } from '../services/proctorCore';
import type { PaperQuestion } from '../types';

interface Props { token: string; }

type Screen =
  | 'loading'
  | 'login'
  | 'permission'
  | 'generating'
  | 'exam'
  | 'attempt_done'
  | 'all_done'
  | 'error';

const ABJAD = ['أ', 'ب', 'ج', 'د'];
const MAX_VIOLATIONS = 5;

// ── Design tokens — matches PaperAssessmentPortal exactly ─────────────────
const FONT  = "'Thmanyah Sans','Cairo','Tajawal',sans-serif";
const NAVY  = '#1B4F72';
const BLUE  = '#2E86C1';
const BG    = 'linear-gradient(135deg,#EBF5FB 0%,#F8F9FA 100%)';

const S: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: BG, fontFamily: FONT, direction: 'rtl', padding: 24,
  },
  card: {
    background: '#fff', borderRadius: 16, boxShadow: '0 4px 32px rgba(27,79,114,.12)',
    padding: '36px 32px', width: '100%', maxWidth: 480,
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  title: { margin: 0, fontSize: 22, fontWeight: 800, color: NAVY, textAlign: 'center' },
  sub:   { margin: 0, fontSize: 14, color: '#666', textAlign: 'center' },
  label: { fontSize: 13, fontWeight: 700, color: NAVY, marginTop: 4 },
  input: {
    border: '1.5px solid #D0DCE8', borderRadius: 8, padding: '10px 14px',
    fontSize: 14, outline: 'none', width: '100%',
    fontFamily: FONT, color: '#1a1a2e', background: '#FAFCFF', boxSizing: 'border-box',
  },
  btnPrimary: {
    background: `linear-gradient(135deg,${NAVY},${BLUE})`, color: '#fff',
    border: 'none', borderRadius: 10, padding: '13px 0', fontSize: 15,
    fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: FONT,
  },
  err:  { color: '#C0392B', fontSize: 13, margin: 0, textAlign: 'center' },
  hint: { color: '#888', fontSize: 12, textAlign: 'center', margin: 0 },
  errorBox: {
    background: '#FDEDEC', border: '1px solid #E74C3C', borderRadius: 12,
    padding: '24px 28px', color: '#C0392B', fontSize: 15, textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
  },
  infoRow: {
    background: '#EBF5FB', borderRadius: 8, padding: '10px 14px',
    fontSize: 13, color: NAVY, fontWeight: 500, display: 'flex', gap: 8, alignItems: 'flex-start',
  },
};

function Spinner({ small }: { small?: boolean }) {
  const sz = small ? 18 : 36;
  return (
    <div style={{
      width: sz, height: sz, margin: small ? '0 auto' : '16px auto',
      border: `${small ? 2 : 3}px solid #D6EAF8`,
      borderTop: `${small ? 2 : 3}px solid ${NAVY}`,
      borderRadius: '50%', animation: 'spin 1s linear infinite',
    }} />
  );
}

export function OnlineAssessmentPortal({ token: tokenId }: Props) {
  const [screen, setScreen]     = useState<Screen>('loading');
  const [tok, setTok]           = useState<ExamToken | null>(null);
  const [errMsg, setErrMsg]     = useState('');
  const [result, setResult]     = useState<ExamResult | null>(null);

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [questions, setQuestions] = useState<PaperQuestion[]>([]);
  const [genMsg, setGenMsg]       = useState('');

  const [attemptNumber, setAttemptNumber] = useState(1);
  const [qIndex, setQIndex]               = useState(0);
  const [chosen, setChosen]               = useState('');
  const [secondsLeft, setSecondsLeft]     = useState(0);
  const [violations, setViolations]       = useState(0);
  const [violationMsg, setViolationMsg]   = useState('');
  const [startedAt, setStartedAt]         = useState('');
  const [attempts, setAttempts]           = useState<ExamAttempt[]>([]);

  // ── Proctor state ──────────────────────────────────────────────────────────
  const [proctorStatus, setProctorStatus] = useState<'connecting' | 'live' | 'unavailable' | 'closed' | null>(null);
  const [proctorState,  setProctorState]  = useState<ProctorState | null>(null);
  const [latestAlert,   setLatestAlert]   = useState<ProctorAlert | null>(null);
  const [showConsent,   setShowConsent]   = useState(false);

  const videoRef        = useRef<HTMLVideoElement>(null);
  const screenVideoRef  = useRef<HTMLVideoElement>(null);
  const streamRef       = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const timerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const violationRef    = useRef(0);
  const answersRef      = useRef<Record<number, string>>({});
  const chosenRef       = useRef('');
  const qIndexRef       = useRef(0);
  const questionsRef    = useRef<PaperQuestion[]>([]);
  const proctorRef      = useRef<LiveProctorHandle | null>(null);
  const proctorSummaryRef = useRef<ProctorSummary | null>(null);

  // ── Load token ─────────────────────────────────────────────────────────
  useEffect(() => {
    getExamToken(tokenId)
      .then(t => {
        if (!t || !t.active) { setErrMsg('الرابط غير صالح أو منتهي الصلاحية.'); setScreen('error'); return; }
        setTok(t);
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
        if (existing.attempts.length >= tok.maxAttempts) {
          setAttempts(existing.attempts); setScreen('all_done'); return;
        }
        setAttempts(existing.attempts);
        setAttemptNumber(existing.attempts.length + 1);
      }
      setScreen('permission');
    } catch { setLoginErr('خطأ في الاتصال — حاول مجدداً.'); }
    setLoginLoading(false);
  };

  // ── Proctor stream + handle teardown ─────────────────────────────────────
  const stopProctor = useCallback(() => {
    if (proctorRef.current) {
      proctorSummaryRef.current = proctorRef.current.stop();
      proctorRef.current = null;
    }
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
  }, []);

  // ── Camera + fullscreen + proctor init ────────────────────────────────────
  const requestPermissions = async () => {
    // Show Arabic consent line; proceed regardless (non-blocking UI state)
    setShowConsent(true);

    // 1. Acquire camera (required — abort on denial)
    let cameraStream: MediaStream | null = null;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = cameraStream;
      if (videoRef.current) {
        videoRef.current.srcObject = cameraStream;
        videoRef.current.play().catch(() => {});
      }
    } catch {
      // Camera-only denial → events-only mode (no cameraStream, no PiP)
      // We still proceed; proctor will run without video frames.
    }

    // 2. Acquire screen (optional — if denied → camera-only or events-only)
    let screenStream: MediaStream | null = null;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = screenStream;
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = screenStream;
        screenVideoRef.current.play().catch(() => {});
      }
    } catch {
      // Screen denied → camera-only (or events-only if camera also denied)
    }

    // 3. Enforce camera requirement after graceful tries
    if (!cameraStream && !screenStream) {
      // Events-only mode — allowed; proctor will work without frames.
      // (No hard block; exam continues with degraded monitoring.)
    }

    setShowConsent(false);
    try { await document.documentElement.requestFullscreen(); } catch { /* optional */ }
    setScreen('generating');
    generateQuestionsNow();
  };

  const generateQuestionsNow = async () => {
    if (!tok) return;
    setGenMsg('جارٍ توليد الأسئلة...');
    try {
      const qs = await generatePaperQuestions(tok.jobTitle, tok.questionCount, tok.difficulty, tok.behavioralPct, tok.theories);
      questionsRef.current = qs;
      setQuestions(qs);
      setQIndex(0); qIndexRef.current = 0;
      answersRef.current = {}; chosenRef.current = '';
      setChosen('');
      setViolations(0); violationRef.current = 0;
      setStartedAt(new Date().toISOString());
      setSecondsLeft(tok.secondsPerQuestion);

      // Stop any existing proctor before starting a fresh one for this attempt.
      if (proctorRef.current) { proctorRef.current.stop(); proctorRef.current = null; }
      proctorSummaryRef.current = null;
      setProctorStatus(null);
      setProctorState(null);
      setLatestAlert(null);

      // Build proctor handle.  cameraEl / screenEl may have no srcObject if
      // permissions were denied; createLiveProctor / compositeFrame handle that.
      const cameraEl = videoRef.current ?? document.createElement('video');
      const screenEl = screenVideoRef.current;
      const handle = createLiveProctor({
        cameraEl,
        screenEl,
        onAlert: (alert) => {
          setLatestAlert(alert);
          setTimeout(() => setLatestAlert(a => (a === alert ? null : a)), 6000);
        },
        onState: (s) => setProctorState(s),
        onStatus: (st) => setProctorStatus(st),
      });
      proctorRef.current = handle;

      setScreen('exam');

      // Start async — never blocks rendering.
      handle.start().catch(() => {});
    } catch (e: unknown) {
      setErrMsg(`فشل توليد الأسئلة: ${e instanceof Error ? e.message : String(e)}`);
      setScreen('error');
    }
  };

  // ── Timer ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (screen !== 'exam') { if (timerRef.current) clearInterval(timerRef.current); return; }
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
    setViolations(violationRef.current);
    setViolationMsg(`⚠️ تحذير ${violationRef.current}/${MAX_VIOLATIONS}: ${reason}`);
    setTimeout(() => setViolationMsg(''), 4000);
    if (violationRef.current >= MAX_VIOLATIONS) doFinish(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (screen !== 'exam') return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        proctorRef.current?.pushEvent('tab_switch', 'مغادرة التبويب محظورة');
        addViolation('مغادرة التبويب محظورة');
      }
    };
    const onBlur = () => {
      proctorRef.current?.pushEvent('window_blur', 'التبديل لنافذة أخرى محظور');
      addViolation('التبديل لنافذة أخرى محظور');
    };
    const onFS = () => {
      if (!document.fullscreenElement) {
        proctorRef.current?.pushEvent('fullscreen_exit', 'الخروج من ملء الشاشة');
        addViolation('الخروج من ملء الشاشة');
      }
    };
    const onKey  = (e: KeyboardEvent) => {
      const b = e.key === 'F12' || (e.ctrlKey && 'uUsScCpPiIaA'.includes(e.key)) || (e.altKey && e.key === 'Tab');
      if (b) { e.preventDefault(); e.stopPropagation(); }
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    const noCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      // Feed the unified integrity score (don't escalate to a hard violation —
      // a stray copy shouldn't trip the MAX_VIOLATIONS auto-finish).
      proctorRef.current?.pushEvent('copy_paste', 'محاولة نسخ المحتوى محظورة');
    };
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

  // Camera blackout detection
  useEffect(() => {
    if (screen !== 'exam') return;
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 60;
    const ctx = cv.getContext('2d');
    const iv = setInterval(() => {
      if (!ctx || !videoRef.current || videoRef.current.readyState < 2) return;
      ctx.drawImage(videoRef.current, 0, 0, 80, 60);
      const d = ctx.getImageData(0, 0, 80, 60).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i+1] + d[i+2];
      if (sum / (d.length / 4 * 3) < 8) {
        proctorRef.current?.pushEvent('no_face', 'الكاميرا مغطّاة أو الوجه غير ظاهر');
        addViolation('الكاميرا مغطّاة');
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [screen, addViolation]);

  // ── Core exam logic ────────────────────────────────────────────────────
  const doFinish = useCallback((forced: boolean) => {
    void forced;
    if (timerRef.current) clearInterval(timerRef.current);

    // Stop proctor and collect summary before building the attempt record.
    stopProctor();
    const summary = proctorSummaryRef.current;

    const finalAnswers = { ...answersRef.current };
    if (chosenRef.current) finalAnswers[qIndexRef.current] = chosenRef.current;
    const score = scoreAttempt(questionsRef.current, finalAnswers);

    const attempt: ExamAttempt & {
      integrity?: number;
      verdict?: 'clear' | 'review' | 'fail';
      topSignals?: Array<{ type: string; count: number }>;
      alerts?: unknown[];
    } = {
      attemptNumber,
      answers: finalAnswers,
      score,
      // Keep old `violations` for back-compat; use summary.totalAlerts when available.
      violations: summary ? summary.totalAlerts : violationRef.current,
      startedAt,
      finishedAt: new Date().toISOString(),
      // Merge proctor integrity data when available.
      ...(summary ? {
        integrity:  summary.integrity,
        verdict:    summary.verdict,
        topSignals: summary.topSignals,
        alerts:     [],   // individual alerts not stored here (summary sufficient)
      } : {}),
    };

    setAttempts(prev => {
      const updated = [...prev, attempt];
      const best = Math.max(...updated.map(a => a.score));
      const nr: ExamResult = {
        ...result,
        tokenId, tenantId: tok!.tenantId, projectId: tok!.projectId,
        companyName: tok!.companyName, accessEmail: email, jobTitle: tok!.jobTitle,
        attempts: updated, bestScore: best, submittedAt: new Date().toISOString(),
      };
      setResult(nr);
      saveExamResult(nr).catch(console.error);
      if (updated.length >= (tok?.maxAttempts ?? 3)) setScreen('all_done');
      else setScreen('attempt_done');
      return updated;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptNumber, startedAt, result, tokenId, tok, email, stopProctor]);

  const doAdvance = useCallback(() => {
    const cur = qIndexRef.current;
    if (chosenRef.current) { answersRef.current = { ...answersRef.current, [cur]: chosenRef.current }; }
    chosenRef.current = ''; setChosen('');
    if (cur + 1 >= questionsRef.current.length) { doFinish(false); }
    else { const next = cur + 1; setQIndex(next); qIndexRef.current = next; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doFinish]);

  const selectAnswer = (opt: string) => { setChosen(opt); chosenRef.current = opt; };

  const retryExam = () => {
    setAttemptNumber(n => n + 1);
    setQIndex(0); qIndexRef.current = 0;
    answersRef.current = {}; chosenRef.current = '';
    setChosen(''); setViolations(0); violationRef.current = 0;
    setStartedAt(new Date().toISOString());
    setScreen('generating');
    generateQuestionsNow();
  };

  // Cleanup on exam end / error
  useEffect(() => {
    if (screen === 'all_done' || screen === 'error') {
      stopProctor();
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }, [screen, stopProctor]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      stopProctor();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ═══════════════════════════ RENDER ══════════════════════════════════════

  if (screen === 'loading') return (
    <div style={S.wrap}><div style={{ textAlign: 'center' }}><Spinner /><p style={S.hint}>جارٍ التحقق من الرابط...</p></div></div>
  );

  if (screen === 'error') return (
    <div style={S.wrap}><div style={S.errorBox}><span style={{ fontSize: 40 }}>⚠️</span>{errMsg}</div></div>
  );

  if (screen === 'login') return (
    <div style={S.wrap}>
      <div style={S.card}>
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

  if (screen === 'permission') return (
    <div style={S.wrap}>
      <div style={{ ...S.card, maxWidth: 520 }}>
        <h2 style={S.title}>📷 متطلبات الاختبار</h2>
        <p style={S.sub}>{tok?.companyName} — {tok?.jobTitle}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0' }}>
          {([
            ['✓', '#27AE60', 'سيُطلب إذن الكاميرا لمراقبة الجلسة — اجعلها مفتوحة طوال الاختبار'],
            ['✓', '#27AE60', 'سيعمل الاختبار في وضع ملء الشاشة — لا تغادره'],
            ['⚠', '#E67E22', `التبديل بين التبويبات يُحتسب مخالفة (${MAX_VIOLATIONS} مخالفات = إنهاء تلقائي)`],
            ['ℹ', BLUE,      `لديك ${tok?.maxAttempts ?? 3} محاولات — أفضل نتيجة هي المُسجَّلة`],
            ['ℹ', BLUE,      `${tok?.questionCount ?? 20} سؤال — ${tok?.secondsPerQuestion ?? 90} ثانية لكل سؤال`],
          ] as [string, string, string][]).map(([icon, color, text], i) => (
            <div key={i} style={S.infoRow}>
              <span style={{ flexShrink: 0, color, fontWeight: 700 }}>{icon}</span>
              <span style={{ color: '#444' }}>{text}</span>
            </div>
          ))}
        </div>
        {/* Arabic consent line for media permissions */}
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#888', textAlign: 'center', lineHeight: 1.6 }}>
          بالمتابعة، توافق على تسجيل الكاميرا والميكروفون وبث الشاشة خلال جلسة الاختبار لأغراض المراقبة الحية.
        </p>
        <button style={{ ...S.btnPrimary, marginTop: 4 }}
          onClick={requestPermissions} disabled={showConsent}>
          {showConsent ? 'جارٍ طلب الأذونات...' : 'أوافق وأبدأ الاختبار'}
        </button>
      </div>
    </div>
  );

  if (screen === 'generating') return (
    <div style={S.wrap}>
      <div style={{ ...S.card, textAlign: 'center' }}>
        <Spinner />
        <h2 style={S.title}>جارٍ الإعداد...</h2>
        <p style={S.sub}>{genMsg || 'توليد الأسئلة بالذكاء الاصطناعي...'}</p>
        <p style={S.hint}>المحاولة {attemptNumber} من {tok?.maxAttempts ?? 3} — قد يستغرق ٣٠–٦٠ ثانية</p>
      </div>
    </div>
  );

  if (screen === 'exam') {
    const q = questions[qIndex];
    const totalQ  = questions.length;
    const progPct = (qIndex / totalQ) * 100;
    const secMax  = tok?.secondsPerQuestion ?? 90;
    const timerPct = (secondsLeft / secMax) * 100;
    const timerColor = secondsLeft > 30 ? '#27AE60' : secondsLeft > 10 ? '#E67E22' : '#C0392B';

    return (
      <div style={{ minHeight: '100vh', background: '#F0F3F7', fontFamily: FONT, direction: 'rtl' }}>

        {/* Hidden screen capture video (feeds compositeFrame in proctorService) */}
        <video ref={screenVideoRef} autoPlay muted playsInline
          style={{ position: 'fixed', width: 1, height: 1, opacity: 0, pointerEvents: 'none', top: 0, left: 0 }} />

        {/* Camera corner */}
        <div style={{
          position: 'fixed', top: 12, left: 12, zIndex: 9999,
          width: 120, height: 88, borderRadius: 10, overflow: 'hidden',
          border: `2px solid ${BLUE}`, boxShadow: '0 2px 12px rgba(27,79,114,.25)', background: '#000',
        }}>
          <video ref={videoRef} autoPlay muted playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <div style={{
            position: 'absolute', bottom: 0, inset: 'auto 0 0',
            background: `rgba(27,79,114,.7)`, color: '#fff', fontSize: 10, textAlign: 'center', padding: '2px 0',
          }}>مراقبة مباشرة</div>
        </div>

        {/* Live proctor status chip (bottom-left, fixed) */}
        {proctorStatus !== null && (
          <div style={{
            position: 'fixed', bottom: 16, left: 16, zIndex: 9999,
            background: proctorStatus === 'live' ? 'rgba(27,79,114,.92)' : 'rgba(60,60,60,.82)',
            color: '#fff', borderRadius: 24, padding: '6px 14px',
            fontSize: 12, fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 8,
            boxShadow: '0 2px 10px rgba(0,0,0,.22)', direction: 'rtl',
            maxWidth: 280,
          }}>
            {/* Connection dot */}
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: proctorStatus === 'live' ? '#2ECC71'
                : proctorStatus === 'connecting' ? '#F39C12'
                : '#95A5A6',
              display: 'inline-block',
            }} />
            <span style={{ fontWeight: 600 }}>
              {proctorStatus === 'live'        ? 'مراقبة مباشرة'
                : proctorStatus === 'connecting' ? 'جارٍ الاتصال…'
                : proctorStatus === 'unavailable' ? 'مراقبة محدودة'
                : 'منتهية'}
            </span>
            {/* Integrity score */}
            {proctorState && (
              <span style={{
                background: proctorState.integrity >= 85 ? '#1E8449'
                  : proctorState.integrity >= 70 ? '#E67E22' : '#C0392B',
                borderRadius: 12, padding: '1px 8px', fontSize: 11, fontWeight: 700,
              }}>
                {proctorState.integrity}%
              </span>
            )}
            {/* Latest alert */}
            {latestAlert && (
              <span style={{ fontSize: 10, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                ⚠ {latestAlert.message}
              </span>
            )}
          </div>
        )}

        {/* Violation banner */}
        {violationMsg && (
          <div style={{
            position: 'fixed', top: 12, left: 148, right: 12, zIndex: 9999,
            background: '#FDEDEC', border: '1px solid #E74C3C', borderRadius: 10,
            padding: '10px 16px', textAlign: 'center', fontSize: 13,
            fontWeight: 700, color: '#C0392B', fontFamily: FONT,
          }}>{violationMsg}</div>
        )}

        {/* Sticky header */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 100, background: '#fff',
          borderBottom: '1px solid #E0E6ED', boxShadow: '0 2px 12px rgba(27,79,114,.08)',
          padding: '10px 20px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', fontFamily: FONT,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: NAVY }}>
            {tok?.companyName} — {tok?.jobTitle}
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: '#777' }}>
              المحاولة <strong style={{ color: NAVY }}>{attemptNumber}</strong>/{tok?.maxAttempts ?? 3}
            </span>
            <span style={{ color: '#777' }}>
              سؤال <strong style={{ color: NAVY }}>{qIndex + 1}</strong>/{totalQ}
            </span>
            <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 15, color: timerColor }}>
              ⏱ {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
            </span>
          </div>
        </div>

        {/* Progress bars */}
        <div style={{ height: 4, background: '#E0E6ED' }}>
          <div style={{ height: '100%', width: `${progPct}%`, background: BLUE, transition: 'width .3s' }} />
        </div>
        <div style={{ height: 3, background: '#E0E6ED' }}>
          <div style={{ height: '100%', width: `${timerPct}%`, background: timerColor, transition: 'width 1s linear' }} />
        </div>

        {/* Question area */}
        <div style={{ maxWidth: 740, margin: '0 auto', padding: '28px 16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '3px 10px',
              background: q.type === 'behavioral' ? '#F5EEF8' : '#EBF5FB',
              color: q.type === 'behavioral' ? '#8E44AD' : NAVY,
            }}>{q.type === 'behavioral' ? 'سلوكي' : 'فني'}</span>
            {q.theory && q.theory !== 'general' && (
              <span style={{
                fontSize: 11, fontWeight: 600, borderRadius: 6, padding: '3px 10px',
                background: '#EAFAF1', color: '#1E8449',
              }}>{q.theory}</span>
            )}
          </div>

          <div style={{
            background: '#fff', borderRadius: 12, padding: '20px 22px', marginBottom: 16,
            boxShadow: '0 1px 6px rgba(27,79,114,.08)', border: '1px solid #EAEFF4',
            fontSize: 16, fontWeight: 600, color: '#1a1a2e', lineHeight: 1.7,
          }}>{q.text}</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {q.options.map((opt, i) => {
              const letter = ABJAD[i] ?? String(i + 1);
              const isSelected = chosen === opt || chosen === letter;
              return (
                <button key={i} onClick={() => selectAnswer(opt)} style={{
                  textAlign: 'right', padding: '13px 16px', borderRadius: 10, cursor: 'pointer',
                  border: isSelected ? `2px solid ${NAVY}` : '1.5px solid #D0DCE8',
                  background: isSelected ? '#EBF5FB' : '#fff',
                  color: isSelected ? NAVY : '#333',
                  fontFamily: FONT, fontSize: 14, fontWeight: isSelected ? 700 : 400,
                  transition: 'all .15s',
                }}>
                  <strong style={{ marginLeft: 8, color: isSelected ? BLUE : '#999' }}>{letter}.</strong>
                  {opt.replace(/^[أبجد]\.\s*/, '')}
                </button>
              );
            })}
          </div>

          <button style={{ ...S.btnPrimary, maxWidth: 220 }} onClick={doAdvance}>
            {qIndex + 1 >= totalQ ? 'إنهاء الاختبار ✓' : 'السؤال التالي →'}
          </button>
          <p style={{ ...S.hint, marginTop: 16 }}>مخالفات: {violations}/{MAX_VIOLATIONS}</p>
        </div>
      </div>
    );
  }

  if (screen === 'attempt_done') {
    const last = attempts[attempts.length - 1];
    const remaining = (tok?.maxAttempts ?? 3) - attempts.length;
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>{last.score >= 60 ? '🎉' : '📋'}</div>
          <h2 style={S.title}>نتيجة المحاولة {last.attemptNumber}</h2>
          <div style={{ fontSize: 52, fontWeight: 900, color: NAVY, margin: '8px 0' }}>{last.score}%</div>
          {last.violations > 0 && <p style={{ color: '#E67E22', fontSize: 13 }}>مخالفات مرصودة: {last.violations}</p>}
          <p style={{ ...S.hint, marginBottom: 12 }}>
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

  if (screen === 'all_done') {
    const best = result ? result.bestScore : Math.max(...attempts.map(a => a.score));
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, maxWidth: 520 }}>
          <h2 style={S.title}>اكتمل الاختبار</h2>
          <p style={S.sub}>{tok?.companyName} — {tok?.jobTitle}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '8px 0' }}>
            {attempts.map(a => (
              <div key={a.attemptNumber} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderRadius: 10, padding: '12px 16px',
                background: a.score === best ? '#EBF5FB' : '#F8F9FA',
                border: a.score === best ? `1.5px solid ${BLUE}` : '1.5px solid #E0E6ED',
              }}>
                <div>
                  <span style={{ fontWeight: 700, color: NAVY }}>المحاولة {a.attemptNumber}</span>
                  {a.violations > 0 && <span style={{ color: '#E67E22', fontSize: 12, marginRight: 8 }}>({a.violations} مخالفة)</span>}
                  {a.score === best && <span style={{ color: BLUE, fontSize: 12, marginRight: 8 }}>★ أفضل</span>}
                </div>
                <span style={{ fontSize: 24, fontWeight: 900, color: a.score === best ? NAVY : '#777' }}>{a.score}%</span>
              </div>
            ))}
          </div>
          <div style={{
            background: BG, border: `1.5px solid ${BLUE}`,
            borderRadius: 12, padding: 20, textAlign: 'center',
          }}>
            <p style={{ margin: '0 0 4px', fontSize: 13, color: '#777' }}>أفضل نتيجة مُسجَّلة</p>
            <div style={{ fontSize: 52, fontWeight: 900, color: NAVY }}>{best}%</div>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#777' }}>{tok?.jobTitle}</p>
          </div>
          <p style={S.hint}>تم حفظ نتيجتك. يمكنك إغلاق هذه الصفحة.</p>
        </div>
      </div>
    );
  }

  return null;
}
