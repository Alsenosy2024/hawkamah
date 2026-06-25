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
  { value: 'hard',   label: 'صعب',    desc: 'تحليلي ومتقدم، للقيادات' },
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
    } catch { setLoginErr('حدث خطأ، حاول مجدداً.'); }
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

  if (screen === 'loading') return (
    <FullCenter>
      <Spinner />
      <p className="mt-3 text-sm text-slate-500">جارٍ التحقق من الرابط...</p>
    </FullCenter>
  );

  if (screen === 'error') return (
    <FullCenter>
      <div className="flex flex-col items-center gap-3 bg-rose-50 border border-rose-200 rounded-xl px-8 py-7 text-rose-700 text-sm text-center max-w-sm">
        <svg className="w-8 h-8 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
        <span className="font-semibold leading-relaxed">{errMsg}</span>
      </div>
    </FullCenter>
  );

  if (screen === 'login') return (
    <FullCenter>
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm flex flex-col gap-5 px-8 py-9">
        {tok?.companyLogoUrl && (
          <img src={tok.companyLogoUrl} alt="logo" className="h-12 object-contain self-center" />
        )}
        <div className="text-center">
          <h2 className="text-xl font-bold text-slate-900">تسجيل الدخول</h2>
          <p className="mt-1 text-sm text-slate-500">بوابة التقييم الوظيفي · {tok?.companyName}</p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-600 tracking-wide">البريد الإلكتروني</label>
            <input
              className="hw-input text-sm"
              type="email"
              dir="ltr"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="example@company.com"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-600 tracking-wide">كلمة المرور</label>
            <input
              className="hw-input text-sm"
              type="password"
              dir="ltr"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="••••••••"
            />
          </div>
        </div>

        {loginErr && (
          <p className="text-xs text-rose-600 text-center">{loginErr}</p>
        )}

        <button
          className="hw-btn hw-btn-primary w-full flex items-center justify-center gap-2"
          onClick={handleLogin}
          disabled={loginLoading}
        >
          {loginLoading ? <Spinner small /> : 'دخول'}
        </button>
      </div>
    </FullCenter>
  );

  if (screen === 'config') return (
    <FullCenter>
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg flex flex-col gap-6 px-8 py-8">
        {tok?.companyLogoUrl && (
          <img src={tok.companyLogoUrl} alt="logo" className="h-11 object-contain self-center" />
        )}

        <div className="text-center">
          <h2 className="text-xl font-bold text-slate-900">إعدادات التقييم الوظيفي</h2>
          <p className="mt-1 text-sm text-slate-500">{tok?.companyName}: أنشئ اختباراً بمواصفاتك</p>
        </div>

        {/* Job title */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-600 tracking-wide">المسمى الوظيفي</label>
          <select
            className="hw-input text-sm cursor-pointer"
            value={sectorTitles.includes(jobTitle) ? jobTitle : '__custom__'}
            onChange={e => { if (e.target.value !== '__custom__') setJobTitle(e.target.value); }}
          >
            {sectorTitles.map(t => <option key={t} value={t}>{t}</option>)}
            <option value="__custom__">مسمى آخر (اكتب أدناه)</option>
          </select>
          <input
            className="hw-input text-sm mt-1"
            value={sectorTitles.includes(jobTitle) ? '' : jobTitle}
            onChange={e => setJobTitle(e.target.value)}
            placeholder="أو اكتب مسمى وظيفي مختلف هنا…"
          />
        </div>

        {/* Count */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-slate-600 tracking-wide">عدد الأسئلة</label>
          <div className="flex gap-2 flex-wrap">
            {[20, 30, 40, 50].map(n => (
              <button
                key={n}
                className={`px-4 py-1.5 text-sm font-semibold rounded-md border transition-colors duration-150
                  ${qCount === n
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-400 hover:text-emerald-700'
                  }`}
                onClick={() => setQCount(n)}
              >{n} سؤال</button>
            ))}
          </div>
        </div>

        {/* Difficulty */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-slate-600 tracking-wide">مستوى الصعوبة</label>
          <div className="flex gap-2">
            {DIFFICULTY_OPTIONS.map(d => (
              <button
                key={d.value}
                title={d.desc}
                className={`flex-1 py-1.5 text-sm font-semibold rounded-md border transition-colors duration-150
                  ${difficulty === d.value
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-400 hover:text-emerald-700'
                  }`}
                onClick={() => setDifficulty(d.value)}
              >{d.label}</button>
            ))}
          </div>
        </div>

        {/* Behavioral % */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-slate-600 tracking-wide">
            نسبة الأسئلة السلوكية:{' '}
            <span className="text-emerald-700 font-bold">{behPct}٪</span>
            <span className="text-slate-400 mx-1">|</span>
            الفنية: <span className="text-slate-700 font-bold">{100 - behPct}٪</span>
          </label>
          <input
            className="w-full cursor-pointer accent-emerald-600"
            type="range" min={0} max={100} step={10}
            value={behPct}
            onChange={e => setBehPct(+e.target.value)}
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>0٪ سلوكي</span><span>50٪</span><span>100٪ سلوكي</span>
          </div>
        </div>

        {/* Theories / frameworks */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-slate-600 tracking-wide">الأطر والمقاييس (اختياري)</label>
          <p className="text-xs text-slate-400 leading-relaxed">
            فعّل أُطر القياس لتُدمج في صياغة الأسئلة ومبرر الإجابة النموذجية.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {THEORY_OPTIONS.map(o => {
              const on = theories[o.key];
              return (
                <button
                  key={o.key}
                  type="button"
                  className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-right transition-colors duration-150
                    ${on
                      ? 'bg-emerald-50 border-emerald-400 text-emerald-800'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                  onClick={() => setTheories(p => ({ ...p, [o.key]: !p[o.key] }))}
                >
                  <div className="flex items-center gap-1.5 w-full">
                    {on ? (
                      <svg className="w-3.5 h-3.5 text-emerald-600 shrink-0" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                        <rect x="0.5" y="0.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
                        <path d="M3 7l2.5 2.5L11 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-slate-300 shrink-0" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <rect x="0.5" y="0.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1"/>
                      </svg>
                    )}
                    <span className="text-xs font-bold">{o.label}</span>
                  </div>
                  <span className="text-xs text-slate-400 leading-relaxed mt-0.5">{o.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Summary strip */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 font-medium">
          <span>{jobTitle || '...'}</span>
          <span className="text-slate-300">·</span>
          <span>{qCount} سؤال</span>
          <span className="text-slate-300">·</span>
          <span>{DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label}</span>
          <span className="text-slate-300">·</span>
          <span>{behPct}٪ سلوكي / {100 - behPct}٪ فني</span>
        </div>

        <div className="flex flex-col gap-2">
          <button
            className="hw-btn hw-btn-primary w-full text-sm py-3"
            onClick={handleGenerate}
            disabled={!jobTitle.trim()}
          >
            توليد ومعاينة الاختبار
          </button>
          <p className="text-xs text-slate-400 text-center">
            ستستعرض الأسئلة والنموذج قبل الطباعة، توليد غير محدود لأي مسمى
          </p>
        </div>
      </div>
    </FullCenter>
  );

  if (screen === 'generating') return (
    <FullCenter>
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm flex flex-col items-center gap-4 px-8 py-10 text-center">
        <Spinner />
        <div>
          <h2 className="text-lg font-bold text-slate-900">جارٍ الإعداد...</h2>
          <p className="mt-1 text-sm text-slate-500">{genProgress}</p>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed max-w-xs">
          الذكاء الاصطناعي يُنشئ أسئلة مخصصة، قد يستغرق ٣٠–٦٠ ثانية
        </p>
      </div>
    </FullCenter>
  );

  if (screen === 'preview') {
    const behN = questions.filter(q => q.type === 'behavioral').length;
    const techN = questions.filter(q => q.type === 'technical').length;
    return (
      <div className="min-h-screen bg-[#F7FAFB]" style={{ fontFamily: "'Thmanyah Sans', 'Cairo', 'Tajawal', sans-serif", direction: 'rtl' }}>
        {/* Sticky toolbar */}
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {tok?.companyLogoUrl && (
              <img src={tok.companyLogoUrl} alt="logo" className="h-8 object-contain" />
            )}
            <div>
              <div className="text-sm font-bold text-slate-900">استعراض الاختبار: {activeTitle}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {questions.length} سؤال · {behN} سلوكي · {techN} فني ·{' '}
                {DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label}
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors duration-150
                ${showAnswers
                  ? 'bg-amber-50 border-amber-300 text-amber-700'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              onClick={() => setShowAnswers(s => !s)}
            >
              {showAnswers ? 'إخفاء النموذج' : 'إظهار النموذج'}
            </button>
            <button
              className="hw-btn hw-btn-primary hw-btn-sm"
              onClick={() => buildPaperPdf(questions, activeTitle, tok?.companyName || '', tok?.companyLogoUrl)}
            >
              طباعة / PDF
            </button>
            <button
              className="px-3 py-1.5 text-xs font-semibold rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 transition-colors duration-150"
              onClick={() => setScreen('config')}
            >
              الإعدادات
            </button>
            <button
              className="px-3 py-1.5 text-xs font-semibold rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 transition-colors duration-150"
              onClick={handleGenerate}
            >
              توليد جديد
            </button>
          </div>
        </div>

        {/* Questions list */}
        <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-3">
          {questions.map((q, i) => {
            const correctIdx = q.options.findIndex(o => o === q.correctAnswer);
            return (
              <div key={i} className="bg-white border border-slate-200 rounded-xl px-5 py-4">
                {/* Question header */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                    {i + 1}
                  </span>
                  <span className={`text-xs font-semibold rounded-sm px-2 py-0.5
                    ${q.type === 'behavioral'
                      ? 'bg-slate-100 text-slate-600'
                      : 'bg-blue-50 text-blue-700'
                    }`}>
                    {q.type === 'behavioral' ? 'سلوكي' : 'فني'}
                  </span>
                  {q.theory && (
                    <span className="text-xs font-semibold rounded-sm px-2 py-0.5 bg-slate-50 text-slate-500 border border-slate-200">
                      {q.theory}
                    </span>
                  )}
                </div>

                {/* Question text */}
                <p className="text-sm font-semibold text-slate-900 leading-relaxed mb-3">{q.text}</p>

                {/* Options */}
                <div className="flex flex-col gap-1.5">
                  {q.options.map((o, oi) => {
                    const isCorrect = showAnswers && oi === correctIdx;
                    return (
                      <div
                        key={oi}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-md border text-sm transition-colors
                          ${isCorrect
                            ? 'bg-green-50 border-green-300 text-green-800 font-semibold'
                            : 'bg-white border-slate-200 text-slate-700'
                          }`}
                      >
                        <span className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold shrink-0
                          ${isCorrect ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                          {ABJAD[oi] || oi + 1}
                        </span>
                        <span>{o}</span>
                        {isCorrect && (
                          <span className="ms-auto text-xs font-semibold text-green-600">الإجابة النموذجية</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Rationale */}
                {showAnswers && q.rationale && (
                  <div className="mt-3 bg-slate-50 border border-slate-200 rounded-md px-3 py-2.5 text-xs text-slate-600 leading-relaxed">
                    <span className="font-bold text-slate-700">مبرر الإجابة: </span>
                    {q.rationale}
                  </div>
                )}
              </div>
            );
          })}
          <div className="h-10" />
        </div>
      </div>
    );
  }

  return null;
}

// ---- Helpers ----

function FullCenter({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-[#F7FAFB] px-6"
      style={{ fontFamily: "'Thmanyah Sans', 'Cairo', 'Tajawal', sans-serif", direction: 'rtl' }}
    >
      {children}
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? 18 : 36;
  return (
    <div style={{
      width: size, height: size, margin: small ? '0 auto' : '8px auto',
      border: `${small ? 2 : 3}px solid #E3EAEE`,
      borderTop: `${small ? 2 : 3}px solid #11A8BC`,
      borderRadius: '50%', animation: 'spin 1s linear infinite',
    }} />
  );
}

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
