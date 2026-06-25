import React from 'react';
import { AssessmentConfig, Language, SurveyScope } from '../types';

interface EmployeeOnboardingProps {
  assessmentConfig: AssessmentConfig;
  questionCount: number;
  language: Language;
  surveyScope: SurveyScope;
  onStart: () => void;
}

// Inline SVG icons — Lucide-style, stroke="currentColor", viewBox 0 0 24 24
const IconDoc = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const IconCamera = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const IconCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const IconMic = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const IconClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const IconBuilding = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <rect x="3" y="3" width="7" height="18" />
    <rect x="14" y="9" width="7" height="12" />
    <path d="M10 3h4" />
    <path d="M10 21h4" />
  </svg>
);

const IconLock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

type StepIconKey = 'doc' | 'camera' | 'check' | 'mic' | 'clock' | 'building' | 'lock';

const STEP_ICONS: Record<StepIconKey, React.ReactElement> = {
  doc: <IconDoc />,
  camera: <IconCamera />,
  check: <IconCheck />,
  mic: <IconMic />,
  clock: <IconClock />,
  building: <IconBuilding />,
  lock: <IconLock />,
};

const EmployeeOnboarding: React.FC<EmployeeOnboardingProps> = ({
  assessmentConfig,
  questionCount,
  language,
  surveyScope,
  onStart,
}) => {
  const isAr = language === 'ar';
  const isVerbal = assessmentConfig.assessmentType === 'verbal';
  const includesSurvey = surveyScope === 'both';

  const formatTimer = (secs?: number) => {
    if (!secs) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${m}`;
  };
  const timerLabel = formatTimer(assessmentConfig.timerInSeconds);

  // ONE merged interview path: most questions are written multiple-choice shown
  // on screen (instant), and a few are interactive voice questions read aloud
  // where you answer by speaking. Camera + mic are requested at the very start.
  const steps: { icon: StepIconKey; title: string; desc: string }[] = isAr ? [
    {
      icon: 'doc',
      title: 'مقابلة تفاعلية واحدة',
      desc: `${questionCount} سؤال مصمّم خصيصاً للوظيفة: ${assessmentConfig.jobTitle}. معظمها أسئلة اختيار من متعدد تظهر أمامك على الشاشة، وفي النص بينها أسئلة صوتية تفاعلية يطرحها عليك المُقيّم بصوته.`,
    },
    {
      icon: 'camera',
      title: 'في البداية: الكاميرا والمايكروفون',
      desc: 'سيطلب منك المتصفح السماح بالكاميرا والمايكروفون قبل أن تبدأ. اسمح بهما حتى تعمل الأسئلة الصوتية. لو رفضت، تكمل بالأسئلة الكتابية فقط.',
    },
    {
      icon: 'check',
      title: 'الأسئلة الكتابية',
      desc: 'اختر الإجابة الأنسب من الخيارات المعروضة — تنتقل للسؤال التالي فوراً. خذ وقتك في كل سؤال.',
    },
    {
      icon: 'mic',
      title: 'الأسئلة الصوتية (في النص)',
      desc: 'بعض الأسئلة يطرحها المُقيّم بصوته. عندها يفتح المايكروفون تلقائياً — تكلّم بطبيعية ويُكتب كلامك حياً أمامك، ثم تنتقل للسؤال التالي. لا توجد إجابة صحيحة واحدة.',
    },
    ...(timerLabel ? [{
      icon: 'clock' as StepIconKey,
      title: 'مؤقّت المقابلة',
      desc: `لديك ${timerLabel} دقيقة لإكمال المقابلة. تنتهي تلقائياً عند انتهاء الوقت.`,
    }] : []),
    ...(includesSurvey ? [{
      icon: 'building' as StepIconKey,
      title: 'استبيان بيئة العمل',
      desc: 'بعد الأسئلة، ستعبّئ استبياناً قصيراً عن بيئة عملك الحالية. هذا يساعد القيادة على تحسين ظروف العمل.',
    }] : []),
    {
      icon: 'lock',
      title: 'السرية',
      desc: 'إجاباتك سرية تماماً. لن تُعرض عليك النتائج مباشرة — سيراجعها الفريق المختص.',
    },
  ] : [
    {
      icon: 'doc',
      title: 'One Interactive Interview',
      desc: `${questionCount} questions tailored to the role: ${assessmentConfig.jobTitle}. Most are multiple-choice shown on screen, with a few interactive voice questions read aloud by the assessor woven in between.`,
    },
    {
      icon: 'camera',
      title: 'First: camera & microphone',
      desc: 'Your browser will ask permission for the camera and microphone before you start. Allow them so the voice questions work. If you decline, you continue with the written questions only.',
    },
    {
      icon: 'check',
      title: 'Written questions',
      desc: 'Pick the most appropriate option — you advance to the next question instantly. Take your time on each one.',
    },
    {
      icon: 'mic',
      title: 'Voice questions (in between)',
      desc: 'Some questions are spoken aloud by the assessor. The microphone then opens automatically — speak naturally and your words are transcribed live, then you move on. There is no single right answer.',
    },
    ...(timerLabel ? [{
      icon: 'clock' as StepIconKey,
      title: 'Timer',
      desc: `You have ${timerLabel} minute${timerLabel !== '1' ? 's' : ''} to complete the interview. It ends automatically when time runs out.`,
    }] : []),
    ...(includesSurvey ? [{
      icon: 'building' as StepIconKey,
      title: 'Workplace Survey',
      desc: 'After the questions, you will fill a short workplace survey. This helps leadership improve working conditions.',
    }] : []),
    {
      icon: 'lock',
      title: 'Confidentiality',
      desc: 'Your answers are fully confidential. Results will not be shown to you directly — they will be reviewed by the relevant team.',
    },
  ];

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[60vh] py-10 animate-fade-in"
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="bg-white rounded-xl border border-slate-200 max-w-xl w-full">

        {/* Header */}
        <div className="px-8 pt-8 pb-6 text-center space-y-3">
          <div className="w-14 h-14 bg-emerald-50 rounded-lg flex items-center justify-center mx-auto">
            {isVerbal ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7 text-emerald-600">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7 text-emerald-600">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            )}
          </div>
          <h2 className="text-2xl font-serif font-bold text-slate-900 leading-snug">
            {isAr ? 'مرحباً بك' : 'Welcome'}
          </h2>
          <p className="text-slate-500 text-sm leading-relaxed max-w-sm mx-auto">
            {isAr
              ? 'قبل أن تبدأ، تعرّف على ما ستفعله في هذا التقييم'
              : 'Before you start, here is what this assessment involves'}
          </p>
        </div>

        {/* Steps — flat list with dividers, no per-step backgrounds */}
        <div className="border-t border-slate-100">
          {steps.map((step, i) => (
            <div
              key={i}
              className={`flex items-start gap-4 px-8 py-4 ${i < steps.length - 1 ? 'border-b border-slate-100' : ''}`}
            >
              <span className="flex-shrink-0 mt-0.5 text-slate-500">
                {STEP_ICONS[step.icon]}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{step.title}</p>
                <p className="text-sm text-slate-500 leading-relaxed mt-0.5">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="px-8 py-6 border-t border-slate-100">
          <button
            onClick={onStart}
            className="w-full bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold py-3 px-6 rounded-md transition-colors duration-150 text-base flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
          >
            <span>{isAr ? 'ابدأ التقييم' : 'Start Assessment'}</span>
            <svg className={`w-4 h-4 ${isAr ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </button>
        </div>

      </div>
    </div>
  );
};

export default EmployeeOnboarding;
