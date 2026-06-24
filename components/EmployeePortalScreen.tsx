// Employee Portal — company-specific assessment portal accessed via /?emp=TOKEN.
// Flow: token validation → employee info → pre-assessment briefing →
//       competency questions → work environment survey → thank-you.
import React, { useState, useEffect, useRef } from 'react';
import { getEmployeeToken, saveEmployeeResponse } from '../services/employeePortalService';
import { notifySurveyComplete } from '../services/notifyService';
import { generateQuestions } from '../services/geminiService';
import { speak, cancelSpeech } from '../services/ttsService';
import WorkplaceSurveyScreen from './WorkplaceSurveyScreen';
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100" dir="rtl">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-600 font-medium">جارٍ التحقق من الرابط…</p>
        </div>
      </div>
    );
  }

  // ── ERROR ──
  if (phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-rose-50 to-slate-100 p-6" dir={ar ? 'rtl' : 'ltr'}>
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center space-y-4">
          <div className="text-5xl">⚠️</div>
          <h2 className="text-xl font-black text-slate-800">{t('رابط غير صالح', 'Invalid Link')}</h2>
          <p className="text-slate-500 text-sm">{errorMsg}</p>
        </div>
      </div>
    );
  }

  const dir = ar ? 'rtl' : 'ltr';
  const companyName = empToken?.companyName || '';
  const logoUrl = empToken?.companyLogoUrl;

  // Shared header
  const header = (
    <div className="flex flex-col items-center gap-2 mb-6">
      {logoUrl ? (
        <img src={logoUrl} alt={companyName} className="h-14 max-w-[200px] object-contain" />
      ) : (
        <div className="w-14 h-14 rounded-2xl bg-emerald-600 text-white flex items-center justify-center text-2xl font-black shadow-lg">
          {companyName.slice(0, 1)}
        </div>
      )}
      <h1 className="text-xl font-black text-slate-800">{companyName}</h1>
      <p className="text-sm text-slate-500">{t('بوابة تقييم الموظفين', 'Employee Assessment Portal')}</p>
    </div>
  );

  // ── INFO FORM ──
  if (phase === 'info_form') {
    const jobRoles = empToken?.jobRoles || [];
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
        <div className="bg-white rounded-2xl shadow-xl p-7 max-w-md w-full space-y-5">
          {header}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t('الاسم الكامل *', 'Full Name *')}</label>
              <input
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder={t('أدخل اسمك الكامل', 'Enter your full name')}
                value={empName} onChange={e => setEmpName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t('البريد الإلكتروني *', 'Email *')}</label>
              <input
                type="email"
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder={t('example@company.com', 'example@company.com')}
                value={empEmail} onChange={e => setEmpEmail(e.target.value)}
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t('المسمى الوظيفي *', 'Job Title *')}</label>
              {jobRoles.length > 0 ? (
                <select
                  className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
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
                  className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder={t('مثال: مدير موارد بشرية', 'e.g. HR Manager')}
                  value={jobTitle} onChange={e => setJobTitle(e.target.value)}
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t('الإدارة / القسم', 'Department')}</label>
              <input
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder={t('اختياري', 'Optional')}
                value={department} onChange={e => setDepartment(e.target.value)}
              />
            </div>
            {formErr && <p className="text-sm text-rose-600 font-medium">{formErr}</p>}
            <button
              onClick={handleInfoSubmit}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow transition-colors"
            >
              {t('متابعة ←', 'Continue →')}
            </button>
          </div>
          <p className="text-xs text-center text-slate-400">
            {t('بياناتك محمية ولن تُشارك مع أطراف خارجية.', 'Your data is protected and will not be shared with third parties.')}
          </p>
        </div>
      </div>
    );
  }

  // ── GENERATING ──
  if (phase === 'generating') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center space-y-4">
          {header}
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-600 font-medium text-sm">
            {t('يجري إعداد أسئلة التقييم المخصصة لمسماك الوظيفي…', 'Preparing personalized assessment questions for your role…')}
          </p>
        </div>
      </div>
    );
  }

  // ── INSTRUCTIONS ──
  if (phase === 'instructions') {
    const qCount = empToken?.questionCount || DEFAULT_QUESTION_COUNT;
    const steps = ar ? [
      { icon: '📋', title: 'أسئلة الجدارات', desc: `${qCount} أسئلة مخصصة لمسماك الوظيفي (${jobTitle})` },
      { icon: '🌿', title: 'استبيان بيئة العمل', desc: 'تقييم بيئة العمل والمحيط المؤسسي' },
      { icon: '🔒', title: 'السرية التامة', desc: 'إجاباتك آمنة ومحمية — لا يُعرض عليها إلا القيادة المختصة' },
    ] : [
      { icon: '📋', title: 'Competency Questions', desc: `${qCount} questions tailored to your role (${jobTitle})` },
      { icon: '🌿', title: 'Work Environment Survey', desc: 'Assessment of your work environment and organizational context' },
      { icon: '🔒', title: 'Full Confidentiality', desc: 'Your answers are secure — only relevant leadership can view them' },
    ];

    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
        <div className="bg-white rounded-2xl shadow-xl p-7 max-w-lg w-full space-y-5">
          {header}
          <h2 className="text-lg font-black text-slate-800 text-center">
            {t('أهلاً بك في التقييم', `Welcome, ${empName}`)}
          </h2>
          <p className="text-sm text-slate-500 text-center">
            {t(`مرحباً ${empName}، قبل البدء اطّلع على هيكل التقييم.`, `Before we begin, here's what to expect.`)}
          </p>
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-3 bg-slate-50 rounded-xl p-3">
                <span className="text-2xl mt-0.5">{s.icon}</span>
                <div>
                  <div className="font-bold text-slate-800 text-sm">{s.title}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-800">
            {t(
              '⏱ الوقت المتوقع: 15–25 دقيقة. أجب بصدق وشمولية — الإجابات القصيرة تؤثر على دقة التقرير.',
              '⏱ Expected time: 15–25 minutes. Answer honestly and thoroughly — short answers affect report accuracy.',
            )}
          </div>
          <button
            onClick={handleStartAssessment}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow transition-colors text-sm"
          >
            {t('ابدأ التقييم ←', 'Start Assessment →')}
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
        <div className="bg-white rounded-2xl shadow-xl p-7 max-w-2xl w-full space-y-5">
          {/* Progress */}
          <div className="space-y-1">
            <div className="flex justify-between items-center text-xs text-slate-500 font-medium">
              <span>{t(`السؤال ${qIndex + 1} من ${questions.length}`, `Question ${qIndex + 1} of ${questions.length}`)}</span>
              <div className="flex items-center gap-3">
                {/* Per-question elapsed timer */}
                <span className="flex items-center gap-1 tabular-nums text-slate-400">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                  </svg>
                  {`${String(Math.floor(qElapsed / 60)).padStart(2, '0')}:${String(qElapsed % 60).padStart(2, '0')}`}
                </span>
                <span>{progress}%</span>
              </div>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2">
              <div className="bg-emerald-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>

          {/* Company header (small) */}
          <div className="flex items-center gap-2">
            {logoUrl ? (
              <img src={logoUrl} alt={companyName} className="h-6 w-auto object-contain" />
            ) : (
              <div className="w-6 h-6 rounded bg-emerald-600 text-white flex items-center justify-center text-xs font-black">{companyName.slice(0, 1)}</div>
            )}
            <span className="text-xs text-slate-400 font-medium">{companyName}</span>
          </div>

          {/* Question */}
          <div className="bg-slate-50 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${q.type === 'Technical' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                {q.type === 'Technical' ? t('فني', 'Technical') : t('سلوكي', 'Behavioral')}
              </span>
              {q.framework && <span className="text-xs text-slate-400">{q.framework}</span>}
            </div>
            <p className="font-semibold text-slate-800 text-sm leading-relaxed">{q.questionText}</p>
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
                    className={`w-full text-start px-4 py-3 rounded-xl border text-sm font-medium transition-all ${
                      selected
                        ? 'bg-emerald-600 text-white border-emerald-600 shadow'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-emerald-300 hover:bg-emerald-50'
                    }`}
                  >
                    <span className="font-bold me-2">{letter}.</span>{opt}
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <textarea
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                rows={5}
                placeholder={t('اكتب إجابتك هنا بالتفصيل…', 'Write your answer in detail here…')}
                value={currentAnswer}
                onChange={e => setCurrentAnswer(e.target.value)}
              />
              {q.minWords && (
                <p className="text-xs text-slate-400 mt-1">
                  {t(`الحد الأدنى: ${q.minWords} كلمة`, `Minimum: ${q.minWords} words`)}
                </p>
              )}
            </div>
          )}

          <button
            onClick={handleAnswerSubmit}
            disabled={!currentAnswer.trim()}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow transition-colors text-sm"
          >
            {qIndex + 1 < questions.length
              ? t('السؤال التالي ←', 'Next Question →')
              : t('انتقل لاستبيان بيئة العمل ←', 'Go to Work Environment Survey →')}
          </button>
        </div>
      </div>
    );
  }

  // ── SURVEY ──
  if (phase === 'survey') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="bg-white rounded-2xl shadow p-4 flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt={companyName} className="h-8 w-auto object-contain" />
            ) : (
              <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center text-sm font-black">{companyName.slice(0, 1)}</div>
            )}
            <div>
              <div className="font-bold text-slate-800 text-sm">{companyName}</div>
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center space-y-4">
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-600 font-medium text-sm">
            {t('جارٍ حفظ إجاباتك…', 'Saving your responses…')}
          </p>
        </div>
      </div>
    );
  }

  // ── DONE ──
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-slate-100 p-4" dir={dir}>
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center space-y-5">
        {header}
        <div className="text-6xl">🎉</div>
        <h2 className="text-2xl font-black text-slate-800">
          {t('شكراً لك!', 'Thank You!')}
        </h2>
        <p className="text-slate-500 text-sm leading-relaxed">
          {t(
            `تم تسجيل إجاباتك بنجاح يا ${empName}. سيتم مراجعة نتائج التقييم من قِبل الفريق المختص وإعداد تقرير شامل.`,
            `Your responses have been recorded successfully, ${empName}. The assessment results will be reviewed by the relevant team and a comprehensive report will be prepared.`,
          )}
        </p>
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-800 font-medium">
          {t('✅ التقييم مكتمل — يمكنك إغلاق هذه الصفحة.', '✅ Assessment complete — you may close this page.')}
        </div>
        <p className="text-xs text-slate-400">
          {companyName} · {new Date().toLocaleDateString(ar ? 'ar-SA' : 'en-US')}
        </p>
      </div>
    </div>
  );
};

export default EmployeePortalScreen;
