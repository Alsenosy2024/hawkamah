import React from 'react';
import { AssessmentConfig, Language, SurveyScope } from '../types';

interface EmployeeOnboardingProps {
  assessmentConfig: AssessmentConfig;
  questionCount: number;
  language: Language;
  surveyScope: SurveyScope;
  onStart: () => void;
}

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
  const steps = isAr ? [
    {
      icon: '📋',
      title: 'مقابلة تفاعلية واحدة',
      desc: `${questionCount} سؤال مصمّم خصيصاً للوظيفة: ${assessmentConfig.jobTitle}. معظمها أسئلة اختيار من متعدد تظهر أمامك على الشاشة، وفي النص بينها أسئلة صوتية تفاعلية يطرحها عليك المُقيّم بصوته.`,
    },
    {
      icon: '🎥',
      title: 'في البداية: الكاميرا والمايكروفون',
      desc: 'سيطلب منك المتصفح السماح بالكاميرا والمايكروفون قبل أن تبدأ. اسمح بهما حتى تعمل الأسئلة الصوتية. لو رفضت، تكمل بالأسئلة الكتابية فقط.',
    },
    {
      icon: '✅',
      title: 'الأسئلة الكتابية',
      desc: 'اختر الإجابة الأنسب من الخيارات المعروضة — تنتقل للسؤال التالي فوراً. خذ وقتك في كل سؤال.',
    },
    {
      icon: '🎙️',
      title: 'الأسئلة الصوتية (في النص)',
      desc: 'بعض الأسئلة يطرحها المُقيّم بصوته. عندها يفتح المايكروفون تلقائياً — تكلّم بطبيعية ويُكتب كلامك حياً أمامك، ثم تنتقل للسؤال التالي. لا توجد إجابة صحيحة واحدة.',
    },
    ...(timerLabel ? [{
      icon: '⏱️',
      title: 'مؤقّت المقابلة',
      desc: `لديك ${timerLabel} دقيقة لإكمال المقابلة. تنتهي تلقائياً عند انتهاء الوقت.`,
    }] : []),
    ...(includesSurvey ? [{
      icon: '🏢',
      title: 'استبيان بيئة العمل',
      desc: 'بعد الأسئلة، ستعبّئ استبياناً قصيراً عن بيئة عملك الحالية. هذا يساعد القيادة على تحسين ظروف العمل.',
    }] : []),
    {
      icon: '🔒',
      title: 'السرية',
      desc: 'إجاباتك سرية تماماً. لن تُعرض عليك النتائج مباشرة — سيراجعها الفريق المختص.',
    },
  ] : [
    {
      icon: '📋',
      title: 'One Interactive Interview',
      desc: `${questionCount} questions tailored to the role: ${assessmentConfig.jobTitle}. Most are multiple-choice shown on screen, with a few interactive voice questions read aloud by the assessor woven in between.`,
    },
    {
      icon: '🎥',
      title: 'First: camera & microphone',
      desc: 'Your browser will ask permission for the camera and microphone before you start. Allow them so the voice questions work. If you decline, you continue with the written questions only.',
    },
    {
      icon: '✅',
      title: 'Written questions',
      desc: 'Pick the most appropriate option — you advance to the next question instantly. Take your time on each one.',
    },
    {
      icon: '🎙️',
      title: 'Voice questions (in between)',
      desc: 'Some questions are spoken aloud by the assessor. The microphone then opens automatically — speak naturally and your words are transcribed live, then you move on. There is no single right answer.',
    },
    ...(timerLabel ? [{
      icon: '⏱️',
      title: 'Timer',
      desc: `You have ${timerLabel} minute${timerLabel !== '1' ? 's' : ''} to complete the interview. It ends automatically when time runs out.`,
    }] : []),
    ...(includesSurvey ? [{
      icon: '🏢',
      title: 'Workplace Survey',
      desc: 'After the questions, you will fill a short workplace survey. This helps leadership improve working conditions.',
    }] : []),
    {
      icon: '🔒',
      title: 'Confidentiality',
      desc: 'Your answers are fully confidential. Results will not be shown to you directly — they will be reviewed by the relevant team.',
    },
  ];

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[60vh] py-10 animate-fade-in"
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="bg-white rounded-3xl border border-slate-100 shadow-xl px-8 py-10 max-w-xl w-full space-y-8">

        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-emerald-50 border-2 border-emerald-200 rounded-2xl flex items-center justify-center mx-auto text-3xl">
            {isVerbal ? '🎙️' : '📝'}
          </div>
          <h2 className="text-2xl font-black text-slate-800">
            {isAr ? 'مرحباً بك' : 'Welcome'}
          </h2>
          <p className="text-slate-500 text-sm font-medium">
            {isAr
              ? 'قبل أن تبدأ، تعرّف على ما ستفعله في هذا التقييم'
              : 'Before you start, here is what this assessment involves'}
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-4">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-xl flex-shrink-0 shadow-sm">
                {step.icon}
              </div>
              <div className="space-y-0.5 text-start">
                <p className="text-sm font-extrabold text-slate-800">{step.title}</p>
                <p className="text-xs text-slate-500 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <button
          onClick={onStart}
          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-4 px-6 rounded-2xl transition-colors text-base shadow-lg shadow-emerald-200 flex items-center justify-center gap-2"
        >
          <span>{isAr ? 'ابدأ التقييم' : 'Start Assessment'}</span>
          <svg className={`w-5 h-5 ${isAr ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </button>

      </div>
    </div>
  );
};

export default EmployeeOnboarding;
