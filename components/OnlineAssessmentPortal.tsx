import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getExamToken, verifyExamAccess, getExamResult, saveExamResult,
  scoreAttempt, type ExamToken, type ExamAttempt, type ExamResult,
} from '../services/onlineAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
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

  const videoRef     = useRef<HTMLVideoElement>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const violationRef = useRef(0);
  const answersRef   = useRef<Record<number, string>>({});
  const chosenRef    = useRef('');
  const qIndexRef    = useRef(0);
  const questionsRef = useRef<PaperQuestion[]>([]);

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

  // ── Camera + fullscreen ────────────────────────────────────────────────
  const requestPermissions = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
    } catch {
      setErrMsg('يجب السماح بالكاميرا لإجراء الاختبار.'); setScreen('error'); return;
    }
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
      setScreen('exam');
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
      if (sum / (d.length / 4 * 3) < 8) addViolation('الكاميرا مغطّاة');
    }, 4000);
    return () => clearInterval(iv);
  }, [screen, addViolation]);

  // ── Core exam logic ────────────────────────────────────────────────────
  const doFinish = useCallback((forced: boolean) => {
    void forced;
    if (timerRef.current) clearInterval(timerRef.current);
    const finalAnswers = { ...answersRef.current };
    if (chosenRef.current) finalAnswers[qIndexRef.current] = chosenRef.current;
    const score = scoreAttempt(questionsRef.current, finalAnswers);
    const attempt: ExamAttempt = {
      attemptNumber,
      answers: finalAnswers,
      score,
      violations: violationRef.current,
      startedAt,
      finishedAt: new Date().toISOString(),
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
  }, [attemptNumber, startedAt, result, tokenId, tok, email]);

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

  useEffect(() => {
    if (screen === 'all_done' || screen === 'error') {
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }, [screen]);

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
        <button style={{ ...S.btnPrimary, marginTop: 4 }} onClick={requestPermissions}>
          أوافق وأبدأ الاختبار
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
