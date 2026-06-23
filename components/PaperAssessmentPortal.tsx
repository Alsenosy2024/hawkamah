import React, { useState, useEffect, useCallback } from 'react';
import {
  getPaperToken, getPaperProjectRoles, verifyPaperAccess, generatePaperQuestions, buildPaperPdf
} from '../services/paperAssessmentService';
import type { PaperAssessmentToken, PaperQuestion, PaperDifficulty, PaperTheories } from '../types';
import { DEFAULT_PAPER_THEORIES } from '../types';

interface Props { token: string; }

type Screen = 'loading' | 'login' | 'config' | 'generating' | 'preview' | 'error';

const THEORY_OPTIONS: { key: keyof PaperTheories; label: string; desc: string }[] = [
  { key: 'birkman',   label: 'Birkman Method',     desc: 'التوافق البيئي وأنماط الضغط الاجتماعي' },
  { key: 'holland',   label: 'Holland RIASEC',     desc: 'الميول المهنية وتوافقها مع الدور' },
  { key: 'psychTech', label: 'Psych Tech Scale',   desc: 'سيناريوهات سلوكية معيارية' },
  { key: 'bloom',     label: "Bloom's Taxonomy",   desc: 'مستويات معرفية: تطبيق/تحليل/تقييم' },
];

const ABJAD = ['أ', 'ب', 'ج', 'د'];

const DIFFICULTY_OPTIONS: { value: PaperDifficulty; label: string; desc: string }[] = [
  { value: 'easy',   label: 'سهل',    desc: 'أسئلة أساسية للمعرفة العامة' },
  { value: 'medium', label: 'متوسط',  desc: 'يتطلب خبرة عملية ٣–٥ سنوات' },
  { value: 'hard',   label: 'صعب',    desc: 'تحليلي ومتقدم — للقيادات' },
];

const JOB_TITLES_DEFAULT = [
  'مدير مشاريع',
  'مدير مشروع',
  'مدير إنشاءات',
  'مدير مشتريات',
  'مدير تطوير أعمال',
  'مدير مالي',
  'مدير حسابات',
  'مدير موارد بشرية',
];

export function PaperAssessmentPortal({ token: tokenId }: Props) {
  const [screen, setScreen] = useState<Screen>('loading');
  const [tok, setTok] = useState<PaperAssessmentToken | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [sectorTitles, setSectorTitles] = useState<string[]>(JOB_TITLES_DEFAULT);

  // Login
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Config (can override token defaults)
  const [jobTitle, setJobTitle]       = useState(JOB_TITLES_DEFAULT[0]);
  const [qCount, setQCount]           = useState(30);
  const [difficulty, setDifficulty]   = useState<PaperDifficulty>('medium');
  const [behPct, setBehPct]           = useState(50);
  const [theories, setTheories]       = useState<PaperTheories>(DEFAULT_PAPER_THEORIES);

  // Generate
  const [genProgress, setGenProgress] = useState('');
  const [questions, setQuestions]     = useState<PaperQuestion[]>([]);
  const [showAnswers, setShowAnswers] = useState(false);

  useEffect(() => {
    getPaperToken(tokenId)
      .then(async t => {
        if (!t || !t.active) { setErrMsg('الرابط غير صالح أو منتهي الصلاحية.'); setScreen('error'); return; }
        setTok(t);
        // Load sector-appropriate job titles from the project; fall back to defaults.
        const roles = await getPaperProjectRoles(t);
        if (roles.length > 0) {
          // Merge sector roles with the fixed 8 defaults (deduplicated), fixed list first
          const extra = roles.map(r => r.title_ar).filter(r => !JOB_TITLES_DEFAULT.includes(r));
          setSectorTitles([...JOB_TITLES_DEFAULT, ...extra]);
        }
        setScreen('login');
      })
      .catch(() => { setErrMsg('تعذّر الاتصال بالخادم.'); setScreen('error'); });
  }, [tokenId]);

  const handleLogin = async () => {
    if (!tok) return;
    setLoginErr('');
    setLoginLoading(true);
    try {
      const ok = await verifyPaperAccess(tok, email, password);
      if (ok) setScreen('config');
      else setLoginErr('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    } catch { setLoginErr('حدث خطأ — حاول مجدداً.'); }
    finally { setLoginLoading(false); }
  };

  const handleGenerate = useCallback(async () => {
    const title = jobTitle.trim();
    if (!title) return;
    setScreen('generating');
    setGenProgress('جارٍ توليد الأسئلة...');
    try {
      const qs = await generatePaperQuestions(title, qCount, difficulty, behPct, theories);
      setQuestions(qs);
      setShowAnswers(false);
      setScreen('preview');
    } catch (e: any) {
      setErrMsg(`فشل توليد الأسئلة: ${e?.message || e}`);
      setScreen('error');
    }
  }, [jobTitle, qCount, difficulty, behPct, theories, tok]);

  const activeTitle = jobTitle.trim();

  // ---- Render ----

  if (screen === 'loading') return <FullCenter><Spinner /><p style={styles.hint}>جارٍ التحقق من الرابط...</p></FullCenter>;
  if (screen === 'error')   return <FullCenter><div style={styles.errorBox}><span style={styles.errorIcon}>⚠️</span>{errMsg}</div></FullCenter>;

  if (screen === 'login') return (
    <FullCenter>
      <div style={styles.card}>
        {tok?.companyLogoUrl && <img src={tok.companyLogoUrl} alt="logo" style={styles.logo} />}
        <h2 style={styles.cardTitle}>تسجيل الدخول</h2>
        <p style={styles.cardSub}>بوابة التقييم الوظيفي — {tok?.companyName}</p>
        <label style={styles.label}>البريد الإلكتروني</label>
        <input
          style={styles.input} type="email" dir="ltr"
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleLogin()}
          placeholder="example@company.com"
        />
        <label style={styles.label}>كلمة المرور</label>
        <input
          style={styles.input} type="password" dir="ltr"
          value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleLogin()}
          placeholder="••••••••"
        />
        {loginErr && <p style={styles.err}>{loginErr}</p>}
        <button style={styles.btnPrimary} onClick={handleLogin} disabled={loginLoading}>
          {loginLoading ? <Spinner small /> : 'دخول'}
        </button>
      </div>
    </FullCenter>
  );

  if (screen === 'config') return (
    <FullCenter>
      <div style={{ ...styles.card, maxWidth: 560 }}>
        {tok?.companyLogoUrl && <img src={tok.companyLogoUrl} alt="logo" style={styles.logo} />}
        <h2 style={styles.cardTitle}>إعدادات التقييم الوظيفي</h2>
        <p style={styles.cardSub}>{tok?.companyName} — أنشئ اختباراً بمواصفاتك</p>

        {/* Job title */}
        <label style={styles.label}>المسمى الوظيفي</label>
        <select
          style={styles.select}
          value={sectorTitles.includes(jobTitle) ? jobTitle : '__custom__'}
          onChange={e => { if (e.target.value !== '__custom__') setJobTitle(e.target.value); }}
        >
          {sectorTitles.map(t => <option key={t} value={t}>{t}</option>)}
          <option value="__custom__">✏️ مسمى آخر (اكتب أدناه)</option>
        </select>
        <input
          style={{ ...styles.input, marginTop: 6 }}
          value={sectorTitles.includes(jobTitle) ? '' : jobTitle}
          onChange={e => setJobTitle(e.target.value)}
          placeholder="أو اكتب مسمى وظيفي مختلف هنا…"
        />

        {/* Count */}
        <label style={styles.label}>عدد الأسئلة</label>
        <div style={styles.pillRow}>
          {[20, 30, 40, 50].map(n => (
            <button
              key={n} style={{ ...styles.pill, ...(qCount === n ? styles.pillActive : {}) }}
              onClick={() => setQCount(n)}
            >{n} سؤال</button>
          ))}
        </div>

        {/* Difficulty */}
        <label style={styles.label}>مستوى الصعوبة</label>
        <div style={styles.pillRow}>
          {DIFFICULTY_OPTIONS.map(d => (
            <button
              key={d.value}
              style={{ ...styles.pill, ...(difficulty === d.value ? styles.pillActive : {}), flex: 1 }}
              onClick={() => setDifficulty(d.value)}
              title={d.desc}
            >{d.label}</button>
          ))}
        </div>

        {/* Behavioral % */}
        <label style={styles.label}>
          نسبة الأسئلة السلوكية: <strong style={{ color: '#1B4F72' }}>{behPct}٪</strong>
          &nbsp;|&nbsp; الفنية: <strong style={{ color: '#117A65' }}>{100 - behPct}٪</strong>
        </label>
        <input
          style={styles.range} type="range" min={0} max={100} step={10}
          value={behPct} onChange={e => setBehPct(+e.target.value)}
        />
        <div style={styles.rangeLabels}>
          <span>0٪ سلوكي</span><span>50٪</span><span>100٪ سلوكي</span>
        </div>

        {/* Theories / frameworks */}
        <label style={styles.label}>الأطر والمقاييس (اختياري)</label>
        <p style={{ ...styles.hint, textAlign: 'right', margin: '0 0 4px' }}>
          فعّل أُطر القياس لتُدمج في صياغة الأسئلة ومبرر الإجابة النموذجية.
        </p>
        <div style={styles.theoryGrid}>
          {THEORY_OPTIONS.map(o => {
            const on = theories[o.key];
            return (
              <button
                key={o.key} type="button"
                style={{ ...styles.theoryCard, ...(on ? styles.theoryCardActive : {}) }}
                onClick={() => setTheories(p => ({ ...p, [o.key]: !p[o.key] }))}
              >
                <span style={styles.theoryCheck}>{on ? '☑' : '☐'}</span>
                <span style={styles.theoryLabel}>{o.label}</span>
                <span style={styles.theoryDesc}>{o.desc}</span>
              </button>
            );
          })}
        </div>

        {/* Summary */}
        <div style={styles.summaryBox}>
          <span>📋 {jobTitle || '...'}</span>
          <span>|</span>
          <span>{qCount} سؤال</span>
          <span>|</span>
          <span>{DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label}</span>
          <span>|</span>
          <span>{behPct}٪ سلوكي / {100 - behPct}٪ فني</span>
        </div>

        <button
          style={{ ...styles.btnPrimary, fontSize: 16, padding: '14px 0', marginTop: 8 }}
          onClick={handleGenerate}
          disabled={!jobTitle.trim()}
        >
          🚀 توليد ومعاينة الاختبار
        </button>
        <p style={{ ...styles.hint, marginTop: 8 }}>ستستعرض الأسئلة والنموذج قبل الطباعة — توليد غير محدود لأي مسمى</p>
      </div>
    </FullCenter>
  );

  if (screen === 'generating') return (
    <FullCenter>
      <div style={{ ...styles.card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🤖</div>
        <h2 style={styles.cardTitle}>جارٍ الإعداد...</h2>
        <p style={styles.cardSub}>{genProgress}</p>
        <Spinner />
        <p style={styles.hint}>الذكاء الاصطناعي يُنشئ أسئلة مخصصة — قد يستغرق ٣٠–٦٠ ثانية</p>
      </div>
    </FullCenter>
  );

  if (screen === 'preview') {
    const behN = questions.filter(q => q.type === 'behavioral').length;
    const techN = questions.filter(q => q.type === 'technical').length;
    return (
      <div style={styles.previewWrap}>
        {/* Sticky toolbar */}
        <div style={styles.previewBar}>
          <div style={styles.previewBarInfo}>
            {tok?.companyLogoUrl && <img src={tok.companyLogoUrl} alt="logo" style={styles.previewLogo} />}
            <div>
              <div style={styles.previewTitle}>استعراض الاختبار — {activeTitle}</div>
              <div style={styles.previewMeta}>
                {questions.length} سؤال · {behN} سلوكي · {techN} فني ·{' '}
                {DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label}
              </div>
            </div>
          </div>
          <div style={styles.previewActions}>
            <button
              style={{ ...styles.barBtn, ...(showAnswers ? styles.barBtnOn : {}) }}
              onClick={() => setShowAnswers(s => !s)}
            >{showAnswers ? '🙈 إخفاء النموذج' : '👁️ إظهار النموذج'}</button>
            <button
              style={{ ...styles.barBtn, ...styles.barBtnPrint }}
              onClick={() => buildPaperPdf(questions, activeTitle, tok?.companyName || '', tok?.companyLogoUrl)}
            >🖨️ طباعة / PDF</button>
            <button style={styles.barBtn} onClick={() => setScreen('config')}>⚙️ الإعدادات</button>
            <button style={styles.barBtn} onClick={handleGenerate}>🔄 توليد جديد</button>
          </div>
        </div>

        {/* Questions list */}
        <div style={styles.previewBody}>
          {questions.map((q, i) => {
            const correctIdx = q.options.findIndex(o => o === q.correctAnswer);
            return (
              <div key={i} style={styles.qCard}>
                <div style={styles.qHead}>
                  <span style={styles.qNum}>{i + 1}</span>
                  <span style={{ ...styles.qTag, ...(q.type === 'behavioral' ? styles.qTagBeh : styles.qTagTech) }}>
                    {q.type === 'behavioral' ? 'سلوكي' : 'فني'}
                  </span>
                  {q.theory && <span style={styles.qTheoryTag}>{q.theory}</span>}
                </div>
                <div style={styles.qText}>{q.text}</div>
                <div style={styles.qOpts}>
                  {q.options.map((o, oi) => {
                    const isCorrect = showAnswers && oi === correctIdx;
                    return (
                      <div key={oi} style={{ ...styles.qOpt, ...(isCorrect ? styles.qOptCorrect : {}) }}>
                        <span style={styles.qOptAbjad}>{ABJAD[oi] || oi + 1}</span>
                        <span>{o}</span>
                        {isCorrect && <span style={styles.qOptCheck}>✓ الإجابة النموذجية</span>}
                      </div>
                    );
                  })}
                </div>
                {showAnswers && q.rationale && (
                  <div style={styles.qRationale}><strong>مبرر الإجابة: </strong>{q.rationale}</div>
                )}
              </div>
            );
          })}
          <div style={{ height: 40 }} />
        </div>
      </div>
    );
  }

  return null;
}

// ---- Helpers ----

function FullCenter({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #EBF5FB 0%, #F8F9FA 100%)',
      fontFamily: "'Thmanyah Sans', 'Cairo', 'Tajawal', sans-serif",
      direction: 'rtl', padding: '24px',
    }}>
      {children}
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? 18 : 36;
  return (
    <div style={{
      width: size, height: size, margin: small ? '0 auto' : '16px auto',
      border: `${small ? 2 : 3}px solid #D6EAF8`,
      borderTop: `${small ? 2 : 3}px solid #1B4F72`,
      borderRadius: '50%', animation: 'spin 1s linear infinite',
    }} />
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#fff', borderRadius: 16, boxShadow: '0 4px 32px rgba(27,79,114,0.12)',
    padding: '36px 32px', width: '100%', maxWidth: 480,
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  logo: { height: 56, objectFit: 'contain', alignSelf: 'center', marginBottom: 4 },
  cardTitle: { margin: 0, fontSize: 22, fontWeight: 800, color: '#1B4F72', textAlign: 'center' },
  cardSub: { margin: 0, fontSize: 14, color: '#666', textAlign: 'center' },
  label: { fontSize: 13, fontWeight: 700, color: '#1B4F72', marginTop: 4 },
  input: {
    border: '1.5px solid #D0DCE8', borderRadius: 8, padding: '10px 14px',
    fontSize: 14, outline: 'none', width: '100%',
    fontFamily: 'inherit', color: '#1a1a2e', background: '#FAFCFF',
  },
  select: {
    border: '1.5px solid #D0DCE8', borderRadius: 8, padding: '10px 14px',
    fontSize: 14, outline: 'none', width: '100%',
    fontFamily: 'inherit', color: '#1a1a2e', background: '#FAFCFF', cursor: 'pointer',
  },
  btnPrimary: {
    background: 'linear-gradient(135deg, #1B4F72, #2E86C1)', color: '#fff',
    border: 'none', borderRadius: 10, padding: '13px 0', fontSize: 15,
    fontWeight: 700, cursor: 'pointer', width: '100%',
    fontFamily: 'inherit', transition: 'opacity .15s',
  },
  btnSecondary: {
    background: '#EBF5FB', color: '#1B4F72',
    border: '1.5px solid #AED6F1', borderRadius: 10, padding: '11px 0', fontSize: 14,
    fontWeight: 600, cursor: 'pointer', width: '100%', fontFamily: 'inherit',
  },
  err: { color: '#C0392B', fontSize: 13, margin: 0, textAlign: 'center' },
  hint: { color: '#888', fontSize: 12, textAlign: 'center', margin: 0 },
  errorBox: {
    background: '#FDEDEC', border: '1px solid #E74C3C', borderRadius: 12,
    padding: '24px 28px', color: '#C0392B', fontSize: 15, textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
  },
  errorIcon: { fontSize: 40 },
  pillRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  pill: {
    border: '1.5px solid #D0DCE8', borderRadius: 20, padding: '6px 16px',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', background: '#FAFCFF',
    color: '#555', fontFamily: 'inherit',
  },
  pillActive: { background: '#1B4F72', color: '#fff', borderColor: '#1B4F72' },
  toggleRow: { display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1.5px solid #D0DCE8' },
  toggleBtn: {
    flex: 1, padding: '8px 0', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', background: '#FAFCFF', color: '#555',
    border: 'none', fontFamily: 'inherit',
  },
  toggleBtnActive: { background: '#1B4F72', color: '#fff' },
  range: { width: '100%', cursor: 'pointer', accentColor: '#1B4F72' },
  rangeLabels: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888' },
  summaryBox: {
    background: '#EBF5FB', borderRadius: 8, padding: '10px 14px',
    display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 13,
    color: '#1B4F72', fontWeight: 600, alignItems: 'center',
  },
  theoryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  theoryCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
    border: '1.5px solid #D0DCE8', borderRadius: 10, padding: '10px 12px',
    background: '#FAFCFF', cursor: 'pointer', textAlign: 'right',
    fontFamily: 'inherit', transition: 'all .15s',
  },
  theoryCardActive: { borderColor: '#8E44AD', background: '#F5EEF8' },
  theoryCheck: { fontSize: 16, color: '#8E44AD' },
  theoryLabel: { fontSize: 13, fontWeight: 700, color: '#1B4F72' },
  theoryDesc: { fontSize: 11, color: '#888', lineHeight: 1.4 },
  // preview
  previewWrap: {
    minHeight: '100vh', background: '#F0F3F7', direction: 'rtl',
    fontFamily: "'Thmanyah Sans', 'Cairo', 'Tajawal', sans-serif",
  },
  previewBar: {
    position: 'sticky', top: 0, zIndex: 10, background: '#fff',
    borderBottom: '1px solid #E0E6ED', boxShadow: '0 2px 12px rgba(27,79,114,0.08)',
    padding: '12px 20px', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
  },
  previewBarInfo: { display: 'flex', alignItems: 'center', gap: 12 },
  previewLogo: { height: 38, objectFit: 'contain' },
  previewTitle: { fontSize: 16, fontWeight: 800, color: '#1B4F72' },
  previewMeta: { fontSize: 12, color: '#777', marginTop: 2 },
  previewActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  barBtn: {
    border: '1.5px solid #D0DCE8', borderRadius: 8, padding: '8px 14px',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', background: '#fff',
    color: '#1B4F72', fontFamily: 'inherit',
  },
  barBtnOn: { background: '#F5EEF8', borderColor: '#8E44AD', color: '#8E44AD' },
  barBtnPrint: { background: 'linear-gradient(135deg, #1B4F72, #2E86C1)', color: '#fff', borderColor: 'transparent' },
  previewBody: { maxWidth: 820, margin: '0 auto', padding: '24px 16px' },
  qCard: {
    background: '#fff', borderRadius: 12, padding: '18px 20px', marginBottom: 14,
    boxShadow: '0 1px 6px rgba(27,79,114,0.06)', border: '1px solid #EAEFF4',
  },
  qHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  qNum: {
    width: 28, height: 28, borderRadius: '50%', background: '#1B4F72', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
  },
  qTag: { fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '3px 9px' },
  qTagBeh: { background: '#EBF5FB', color: '#1B4F72' },
  qTagTech: { background: '#E8F8F5', color: '#117A65' },
  qTheoryTag: { fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '3px 9px', background: '#F5EEF8', color: '#8E44AD' },
  qText: { fontSize: 15, fontWeight: 600, color: '#1a1a2e', lineHeight: 1.6, marginBottom: 12 },
  qOpts: { display: 'flex', flexDirection: 'column', gap: 7 },
  qOpt: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
    border: '1.5px solid #EAEFF4', borderRadius: 8, fontSize: 14, color: '#333',
  },
  qOptCorrect: { background: '#EAFAF1', borderColor: '#27AE60', color: '#196F3D', fontWeight: 700 },
  qOptAbjad: {
    width: 24, height: 24, borderRadius: 6, background: '#F0F3F7', color: '#555',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
  },
  qOptCheck: { marginInlineStart: 'auto', fontSize: 11, fontWeight: 700, color: '#27AE60' },
  qRationale: {
    marginTop: 10, background: '#FBF7FD', borderInlineStart: '3px solid #8E44AD',
    borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#5B2C6F', lineHeight: 1.6,
  },
};

// Inject spin keyframes once
if (typeof document !== 'undefined') {
  const styleId = 'paper-portal-spin';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
  }
}
