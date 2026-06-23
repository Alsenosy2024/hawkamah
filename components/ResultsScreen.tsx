import React, { useState, useEffect, useRef } from 'react';
import { Question, UserResponse, ExtendedReport, Language, User, AssessmentConfig, WorkEnvironmentAnswers, WorkEnvironmentReport, SurveyScope, AffectSignal, toKindArray } from '../types';
import { TRANSLATIONS, localizeNum } from '../constants';
import { analyzeAnswers, analyzeWorkEnvironment } from '../services/geminiService';
import { db, auth } from '../firebase';
import { doc, setDoc } from 'firebase/firestore';

declare const jspdf: any;
declare const html2canvas: any;

interface ResultsScreenProps {
  assessmentConfig: AssessmentConfig;
  questions: Question[];
  responses: UserResponse[];
  onRestart: () => void;
  language: Language;
  user: User;
  orgContext?: string;
  workplaceAnswers?: WorkEnvironmentAnswers;
  surveyScope?: SurveyScope;
  affectSignal?: AffectSignal;   // optional voice/facial affect from the verbal interview
  employeeView?: boolean;        // when true, employee sees thank-you card only; report saved to Firestore for admin
}

const ScoreDonutChart = ({ score, title, scoreColorClass, language }: { score: number, title: string, scoreColorClass: string, language: Language }) => {
    const size = 140;
    const strokeWidth = 10;
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (score / 100) * circumference;

    return (
        <div className="flex flex-col items-center">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 text-center">{title}</span>
            <div className="relative flex items-center justify-center mb-1" style={{ width: size, height: size }}>
                <svg className="absolute top-0 left-0" width={size} height={size}>
                    <circle
                        className="text-slate-100"
                        stroke="currentColor"
                        strokeWidth={strokeWidth}
                        fill="transparent"
                        r={radius}
                        cx={size / 2}
                        cy={size / 2}
                    />
                    <circle
                        className={scoreColorClass}
                        stroke="currentColor"
                        strokeWidth={strokeWidth}
                        strokeLinecap="round"
                        fill="transparent"
                        r={radius}
                        cx={size / 2}
                        cy={size / 2}
                        style={{
                            strokeDasharray: circumference,
                            strokeDashoffset: offset,
                            transition: 'stroke-dashoffset 1s ease-out',
                            transform: 'rotate(-90deg)',
                            transformOrigin: '50% 50%',
                        }}
                    />
                </svg>
                <div className="text-center">
                    <p className={`text-3xl font-extrabold ${scoreColorClass}`}>{localizeNum(Math.round(score), language)}<span className="text-xl">{language === 'ar' ? '٪' : '%'}</span></p>
                </div>
            </div>
        </div>
    );
};

const CompetencyChart = ({ scores, language }: { scores: ExtendedReport['competencyScores'], language: Language }) => {
  if (!scores || scores.length === 0) return null;
  const T = TRANSLATIONS[language];

  return (
    <div className="bg-white p-5 rounded-xl border border-slate-200">
      <h3 className="font-bold text-slate-800 mb-4 text-start">📊 {T.competencyBreakdown}</h3>
      <div className="space-y-4 text-start">
        {scores.map(({ competency, score }) => (
          <div key={competency}>
            <div className="flex justify-between mb-1 text-sm">
              <span className="font-semibold text-slate-700">{competency}</span>
              <span className="font-bold text-emerald-600">{localizeNum(score, language)}{language === 'ar' ? '٪' : '%'}</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2.5">
              <div className="bg-gradient-to-r from-emerald-500 to-emerald-700 h-2.5 rounded-full" style={{ width: `${score}%`, transition: 'width 1s ease-out' }}></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ReportSection = ({ title, content, icon, colorClass }: { title: string, content: string, icon: React.ReactNode, colorClass: string }) => (
    <div className="bg-white p-6 rounded-2xl border border-slate-100/95 shadow-sm text-start">
        <div className="flex items-center gap-3 mb-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${colorClass.replace('text-', 'bg-').replace('700', '50').replace('800', '50')}`}>
                {icon}
            </div>
            <h3 className={`text-md font-extrabold ${colorClass}`}>{title}</h3>
        </div>
        <p className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">{content}</p>
    </div>
);

// Escape values interpolated into the print-iframe HTML string. user.name comes from
// candidate input → without escaping it can inject markup/script into the print frame.
const escapeHtml = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));

const ResultsScreen: React.FC<ResultsScreenProps> = ({
  assessmentConfig,
  questions,
  responses,
  onRestart,
  language,
  user,
  orgContext,
  workplaceAnswers,
  surveyScope = 'both',
  affectSignal,
  employeeView = true,
}) => {
  const [report, setReport] = useState<ExtendedReport | null>(null);
  const [envReport, setEnvReport] = useState<WorkEnvironmentReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'competencies' | 'environment'>(
    surveyScope === 'environment' ? 'environment' : 'competencies'
  );

  const compReportRef = useRef<HTMLDivElement>(null);
  const envReportRef = useRef<HTMLDivElement>(null);
  const ranRef = useRef(false);  // F20: run the report pipeline once (StrictMode-safe)

  const T = TRANSLATIONS[language];

  useEffect(() => {
    // F20: React 18 StrictMode mounts effects twice in dev. Without a guard the
    // whole report pipeline (2 Gemini calls + a Firestore write) fires twice,
    // double-billing and racing two setDoc writes. ranRef makes fetch run-once.
    if (ranRef.current) return;
    ranRef.current = true;

    // Guard every setState behind a mounted flag: the pipeline awaits 2 Gemini calls +
    // a Firestore write; if the user navigates away mid-flight, the late resolutions
    // must not setState on an unmounted component.
    let alive = true;

    const fetchReports = async () => {
      try {
        if (alive) { setIsLoading(true); setError(null); }

        const rawTranscript = (responses.length > 0 && responses[0].selectedAnswer && assessmentConfig.assessmentType === 'verbal')
            ? responses[0].selectedAnswer.trim()
            : undefined;
        // F6: a verbal interview ended with no real answers (candidate hit "End"
        // immediately, or all questions were skipped) yields an empty/near-empty
        // transcript. Feeding that to analyzeAnswers produced a hallucinated report
        // off zero signal. Treat <12 chars as "no usable answers".
        const verbalEmpty = assessmentConfig.assessmentType === 'verbal' && (!rawTranscript || rawTranscript.length < 12);
        const transcript = rawTranscript;

        // 1. Fetch Competency Assessment Reports (skip when only the environment is being evaluated)
        let compResult = null;
        if (surveyScope !== 'environment' && verbalEmpty) {
          if (alive) setError(language === 'ar'
            ? 'لم يتم تسجيل إجابات كافية في المقابلة الصوتية لإنشاء تقرير الجدارات. يُرجى إعادة المقابلة.'
            : 'Not enough verbal answers were recorded to build the competency report. Please retake the interview.');
        } else if (surveyScope !== 'environment') {
          compResult = await analyzeAnswers(
              assessmentConfig.jobTitle,
              questions,
              responses,
              language,
              assessmentConfig.assessmentType,
              transcript,
              assessmentConfig.jobDescription,
              orgContext,
              assessmentConfig.assessmentKind
          );
          if (alive) setReport(compResult);
        }

        // 2. Fetch Work Environment Reports (based on ISO & EFQM)
        let envResult = null;
        if (workplaceAnswers) {
          envResult = await analyzeWorkEnvironment(
            workplaceAnswers,
            language,
            assessmentConfig.jobTitle,
            orgContext
          );
          if (alive) setEnvReport(envResult);
        }

        // Save progress to Centrally stored assessments in Firestore!
        // Skip when there is nothing real to store (e.g. empty verbal run) so the
        // admin dashboard isn't polluted with hollow records.
        if (compResult || envResult) try {
          const assessmentId = String(Date.now());
          await setDoc(doc(db, 'assessments', assessmentId), {
            id: assessmentId,
            userId: auth.currentUser?.uid || 'guest',
            userName: user?.name || 'Guest User',
            userEmail: user?.email || 'guest@example.com',
            jobTitle: assessmentConfig.jobTitle,
            numQuestions: assessmentConfig.numQuestions,
            assessmentType: assessmentConfig.assessmentType,
            timestamp: new Date().toISOString(),
            responses: responses,
            workplaceAnswers: workplaceAnswers || null,
            reportData: compResult || null,
            envReportData: envResult,
            surveyScope,
            assessmentKind: toKindArray(assessmentConfig.assessmentKind),
            affectSignal: affectSignal || null   // voice/facial affect (verbal interview); null when unavailable
          });
        } catch (dbErr) {
          console.error("Failed to sync report to Firestore:", dbErr);
        }

      } catch (err) {
        if (alive) setError(language === 'ar' ? 'فشل إنشاء التحليل والمطابقة الشاملة.' : 'Failed to generate comprehensive reports.');
        console.error(err);
      } finally {
        if (alive) setIsLoading(false);
      }
    };

    fetchReports();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDownloadCompPdf = () => {
    const reportElement = compReportRef.current;
    if (!reportElement || !report) return;

    // Use high-fidelity vector printing engine to guarantee connected Arabic letters and pristine vector quality
    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.width = '0px';
    iframe.style.height = '0px';
    iframe.style.top = '-1000px';
    iframe.style.left = '-1000px';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document || iframe.contentDocument;
    if (!doc) return;

    let stylesHtml = '';
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(el => {
      stylesHtml += el.outerHTML;
    });

    const arabicFontAndPrintStyle = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&family=Cairo:wght@400;600;700;900&display=swap');
        body {
          font-family: 'Tajawal', 'Cairo', sans-serif !important;
          direction: rtl;
          background: white !important;
          color: #1e293b !important;
          padding: 30px;
        }
        svg {
          max-width: 100% !important;
        }
        @media print {
          @page {
            size: A4;
            margin: 15mm;
          }
          body {
            padding: 0;
            background: white !important;
          }
          .bg-white, .rounded-2xl {
            page-break-inside: avoid;
            break-inside: avoid;
          }
        }
      </style>
    `;

    doc.open();
    doc.write(`
      <html dir="rtl" class="rtl">
        <head>
          <title>تقرير حوكمة الجدارات الفني والسلوكي - ${escapeHtml(user.name)}</title>
          ${stylesHtml}
          ${arabicFontAndPrintStyle}
        </head>
        <body class="bg-white">
          <div style="max-width: 800px; margin: 0 auto;">
            ${reportElement.innerHTML}
          </div>
          <script>
            window.addEventListener('load', () => {
              setTimeout(() => {
                window.print();
                setTimeout(() => {
                  window.parent.document.body.removeChild(window.frameElement);
                }, 100);
              }, 600);
            });
          </script>
        </body>
      </html>
    `);
    doc.close();
  };

  const handleDownloadEnvPdf = () => {
    const reportElement = envReportRef.current;
    if (!reportElement || !envReport) return;

    // Use high-fidelity vector printing engine to guarantee connected Arabic letters and pristine vector quality
    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.width = '0px';
    iframe.style.height = '0px';
    iframe.style.top = '-1000px';
    iframe.style.left = '-1000px';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document || iframe.contentDocument;
    if (!doc) return;

    let stylesHtml = '';
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(el => {
      stylesHtml += el.outerHTML;
    });

    const arabicFontAndPrintStyle = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&family=Cairo:wght@400;600;700;900&display=swap');
        body {
          font-family: 'Tajawal', 'Cairo', sans-serif !important;
          direction: rtl;
          background: white !important;
          color: #1e293b !important;
          padding: 30px;
        }
        svg {
          max-width: 100% !important;
        }
        @media print {
          @page {
            size: A4;
            margin: 15mm;
          }
          body {
            padding: 0;
            background: white !important;
          }
          .bg-white, .rounded-2xl {
            page-break-inside: avoid;
            break-inside: avoid;
          }
        }
      </style>
    `;

    doc.open();
    doc.write(`
      <html dir="rtl" class="rtl">
        <head>
          <title>تقرير تشخيص بيئة العمل - ${escapeHtml(user.name)}</title>
          ${stylesHtml}
          ${arabicFontAndPrintStyle}
        </head>
        <body class="bg-white">
          <div style="max-width: 800px; margin: 0 auto;">
            ${reportElement.innerHTML}
          </div>
          <script>
            window.addEventListener('load', () => {
              setTimeout(() => {
                window.print();
                setTimeout(() => {
                  window.parent.document.body.removeChild(window.frameElement);
                }, 100);
              }, 600);
            });
          </script>
        </body>
      </html>
    `);
    doc.close();
  };

  const getScoreColor = (sc: number) => {
    if (sc >= 80) return 'text-emerald-600';
    if (sc >= 50) return 'text-amber-500';
    return 'text-rose-500';
  };

  // Employee thank-you card — shows instead of full report when employeeView=true
  if (employeeView && !isLoading && !error) {
    const answeredCount = responses.filter(r => r.selectedAnswer && r.selectedAnswer.trim().length > 0).length;
    const totalCount = assessmentConfig.assessmentType === 'verbal'
      ? questions.length
      : Math.max(responses.length, questions.length);
    const typeLabel = language === 'ar'
      ? (assessmentConfig.assessmentType === 'verbal' ? 'المقابلة الصوتية' : 'اختبار الجدارات')
      : (assessmentConfig.assessmentType === 'verbal' ? 'verbal interview' : 'competency assessment');
    const surveyLabel = language === 'ar' ? 'واستبيان بيئة العمل' : 'and workplace survey';
    const includedSurvey = surveyScope === 'both' && workplaceAnswers;

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] py-12 animate-fade-in" dir={language === 'ar' ? 'rtl' : 'ltr'}>
        <div className="bg-white rounded-3xl border border-emerald-100 shadow-xl px-10 py-12 max-w-lg w-full text-center space-y-6">
          {/* Success icon */}
          <div className="flex justify-center">
            <div className="w-24 h-24 rounded-full bg-emerald-50 border-4 border-emerald-200 flex items-center justify-center">
              <svg className="w-12 h-12 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-black text-slate-800">
              {language === 'ar' ? `شكراً، ${user.name}!` : `Thank you, ${user.name}!`}
            </h2>
            <p className="text-slate-500 text-sm font-medium leading-relaxed">
              {language === 'ar'
                ? `لقد تم تعبئة ${typeLabel}${includedSurvey ? ` ${surveyLabel}` : ''} بنجاح`
                : `Your ${typeLabel}${includedSurvey ? ` ${surveyLabel}` : ''} has been submitted successfully`}
            </p>
          </div>

          {/* Summary chips */}
          <div className="flex flex-wrap justify-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs font-bold">
              📋 {language === 'ar' ? `${answeredCount} من ${totalCount} سؤال` : `${answeredCount} / ${totalCount} questions`}
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-700 text-xs font-bold">
              💼 {assessmentConfig.jobTitle}
            </span>
            {includedSurvey && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-xl text-blue-800 text-xs font-bold">
                🏢 {language === 'ar' ? 'استبيان بيئة العمل ✓' : 'Workplace survey ✓'}
              </span>
            )}
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            {language === 'ar'
              ? 'سيتم مراجعة نتائجك من قِبل الفريق المختص. شكراً لوقتك.'
              : 'Your results will be reviewed by the relevant team. Thank you for your time.'}
          </p>

          <button
            onClick={onRestart}
            className="w-full bg-emerald-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-emerald-700 transition-colors text-sm"
          >
            {language === 'ar' ? '🔄 العودة للرئيسية' : '🔄 Return to Home'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full animate-fade-in space-y-6">
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-20">
          <svg className="animate-spin h-10 w-10 text-emerald-600 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-slate-600 font-bold">{T.generatingReport}</p>
        </div>
      )}

      {error && (
        <div className="text-center text-rose-600 bg-rose-50 p-5 rounded-2xl border border-rose-200 flex flex-col items-center gap-4">
          <span>⚠️ {error}</span>
          <button onClick={onRestart} className="bg-rose-600 text-white font-bold py-2.5 px-6 rounded-xl hover:bg-rose-700 transition-colors text-sm">
            🔄 {T.restart}
          </button>
        </div>
      )}

      {(report || envReport) && !isLoading && (
        <>
          {/* Tab Selector Buttons */}
          <div className="flex border-b border-slate-200 mb-4 bg-slate-50 p-1.5 rounded-xl">
            {report && (
            <button
              onClick={() => setActiveTab('competencies')}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all text-center ${
                activeTab === 'competencies'
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              💼 {language === 'ar' ? 'تقرير الجدارات والفجوات المهنّية' : 'Competency & Gap Assessment'}
            </button>
            )}
            {envReport && (
              <button
                onClick={() => setActiveTab('environment')}
                className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all text-center ${
                  activeTab === 'environment'
                    ? 'bg-emerald-600 text-white shadow'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800'
                }`}
              >
                🏢 {language === 'ar' ? 'تقرير تقييم بيئة العمل (ISO & EFQM)' : 'Work Environment Report'}
              </button>
            )}
          </div>

          {/* TAB 1 CONTENT: Competencies & Gap report */}
          {activeTab === 'competencies' && report && (
            <div className="space-y-6">
              <div ref={compReportRef} className="p-6 bg-slate-50/50 border border-slate-200/80 rounded-2xl space-y-6">
                
                {/* Header */}
                <div className="text-center pb-4 border-b border-slate-200/60">
                  <h1 className="text-2xl font-black text-slate-800 uppercase tracking-tight">{T.results}</h1>
                  <p className="text-xs font-semibold text-slate-400 mt-1 uppercase tracking-widest">{language === 'ar' ? 'التحليل المتكامل لأبعاد الشخصية والجدارات الفنية والسلوكية' : 'Integrated Competency Alignment & Profile Report'}</p>
                </div>

                {/* Candidate Info profile card */}
                <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm text-start flex flex-col md:flex-row gap-5 items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xl font-bold shadow-md">
                      {user.name.charAt(0)}
                    </div>
                    <div>
                      <p className="font-extrabold text-slate-800 text-lg leading-snug">{user.name}</p>
                      <p className="text-xs text-slate-400 font-medium">{user.email}</p>
                      <div className="flex gap-2 items-center mt-2 flex-wrap">
                        <span className="bg-emerald-50 text-emerald-700 text-[10px] font-black uppercase px-2 py-0.5 rounded-full border border-emerald-100">
                          {assessmentConfig.jobTitle}
                        </span>
                        {assessmentConfig.assessmentType === 'verbal' && (
                          <span className="bg-emerald-50 text-emerald-700 text-[10px] font-black uppercase px-2 py-0.5 rounded-full border border-emerald-100">
                            Live Voice Assessment
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-400/90 text-center md:text-end font-mono">
                    <p>{language === 'ar' ? 'تاريخ التقييم / المعاملة' : 'Evaluation Conducted'}</p>
                    <p className="font-bold text-slate-600 mt-0.5">{new Date().toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-GB')}</p>
                  </div>
                </div>

                {/* Score Indicators Grid */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center">
                    <ScoreDonutChart score={report.totalScore} title={T.totalScore} scoreColorClass={getScoreColor(report.totalScore)} language={language} />
                  </div>
                  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center">
                    <ScoreDonutChart score={report.technicalScore} title={language === 'ar' ? 'الجدارة الفنية التخصصية' : 'Technical score'} scoreColorClass={getScoreColor(report.technicalScore)} language={language} />
                  </div>
                  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center">
                    <ScoreDonutChart score={report.behavioralScore} title={language === 'ar' ? 'الملامح السلوكية والمنهجية' : 'Behavioral score'} scoreColorClass={getScoreColor(report.behavioralScore)} language={language} />
                  </div>
                  <div className="md:col-span-1">
                    <CompetencyChart scores={report.competencyScores} language={language} />
                  </div>
                </div>

                {/* Birkman & Holland Trait Analysis section */}
                {report.birkmanHollandSummary && (
                  <ReportSection
                    title={language === 'ar' ? 'تحليل السمات وعلم النفس المهني (بريكمان وهولاند)' : 'Psychometric Profile Study (Birkman & Holland)'}
                    content={report.birkmanHollandSummary}
                    colorClass="text-emerald-800"
                    icon={<span>🧠</span>}
                  />
                )}

                {/* MERGED DUAL-KIND ANALYSIS: two clearly separated sections, shown only
                    when both competency + behavioral kinds were selected (م3). */}
                {(report.competencySection || report.behavioralSection) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {report.competencySection && (
                      <ReportSection
                        title={language === 'ar' ? 'تحليل الجدارات (الفني والمهني)' : 'Competency Analysis'}
                        content={report.competencySection}
                        colorClass="text-emerald-800"
                        icon={<span>🎓</span>}
                      />
                    )}
                    {report.behavioralSection && (
                      <ReportSection
                        title={language === 'ar' ? 'التحليل السلوكي' : 'Behavioral Analysis'}
                        content={report.behavioralSection}
                        colorClass="text-emerald-800"
                        icon={<span>🧭</span>}
                      />
                    )}
                  </div>
                )}

                {/* GAP ANALYSIS TABLE (تقرير الفجوات) */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm text-start space-y-4">
                  <div className="border-b border-slate-100 pb-3">
                    <h3 className="text-md font-extrabold text-slate-800 flex items-center gap-2">
                      <span>📉</span> {T.gapAnalysisTitle}
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">{T.gapExplanation}</p>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left rtl:text-right border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="p-3 text-xs font-bold text-slate-600 uppercase">{T.positionStandard}</th>
                          <th className="p-3 text-xs font-bold text-slate-600 uppercase text-center">{language === 'ar' ? 'المعيار المستهدف بالوظيفة' : 'Benchmark %'}</th>
                          <th className="p-3 text-xs font-bold text-slate-600 uppercase text-center">{language === 'ar' ? 'مستوى الموظف الملاحظ' : 'Assessed Level %'}</th>
                          <th className="p-3 text-xs font-bold text-slate-600 uppercase">{T.gapStatus}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.gapReport?.competencyGaps?.map((gap, idx) => {
                          const gapVal = gap.required - gap.actual;
                          return (
                            <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50/50">
                              <td className="p-3 font-semibold text-slate-800">{gap.skill}</td>
                              <td className="p-3 text-center font-bold text-slate-400">{gap.required}%</td>
                              <td className={`p-3 text-center font-bold ${gap.actual >= gap.required ? 'text-emerald-600' : 'text-rose-500'}`}>{gap.actual}%</td>
                              <td className="p-3 text-xs">
                                <div className="space-y-1">
                                  <span className={`px-2 py-0.5 rounded-full inline-block font-extrabold ${gapVal <= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                                    {gapVal <= 0 
                                      ? (language === 'ar' ? 'مستوفى بالكامل' : 'Objective met / Fully Aligned') 
                                      : (language === 'ar' ? `فجوة بقيمة -${gapVal}%` : `Gap discovered: -${gapVal}%`)}
                                  </span>
                                  <p className="text-slate-500 text-[11px] leading-relaxed mt-1">{gap.gapDescription}</p>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-sm space-y-2">
                    <span className="font-extrabold text-slate-700 block">📝 {language === 'ar' ? 'خلاصة الفجوات الإدارية والفنية' : 'Gaps Synthesis Summary'}</span>
                    <p className="text-xs text-slate-600 leading-relaxed">{report.gapReport?.overallGapSummary}</p>
                    <span className="font-extrabold text-slate-700 block mt-3">🛠️ {language === 'ar' ? 'خطة تدريب وتطوير الموارد البشرية المستهدفة' : 'Structured Human Resources Training Blueprint'}</span>
                    <p className="text-xs text-slate-600 leading-relaxed">{report.gapReport?.developmentPlan}</p>
                  </div>
                </div>

                {/* ELIGIBLE ROLES SUITE (المناصب المناسبة للمطابقة البديلة) */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm text-start space-y-4">
                  <div className="border-b border-slate-100 pb-3">
                    <h3 className="text-md font-extrabold text-slate-800 flex items-center gap-2">
                      <span>🎯</span> {T.eligibleRolesTitle}
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">{T.eligibleRolesExplain}</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {report.jobFitRatings?.map((fit, idx) => (
                      <div key={idx} className="p-4 bg-slate-50 border border-slate-100 rounded-xl flex items-start gap-3">
                        <div className="p-3 bg-emerald-50 text-emerald-700 font-black rounded-lg text-sm text-center min-w-[55px]">
                          {fit.matchPercentage}%
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 text-sm">{fit.jobTitle}</h4>
                          <p className="text-xs text-slate-500 leading-relaxed">{fit.reason}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Strengths / Weaknesses / Recommendations */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <ReportSection 
                    title={T.strengths}
                    content={report.strengths}
                    colorClass="text-emerald-800"
                    icon={<span>✔️</span>}
                  />
                  <ReportSection 
                    title={T.weaknesses}
                    content={report.weaknesses}
                    colorClass="text-rose-800"
                    icon={<span>⚠️</span>}
                  />
                  <ReportSection 
                    title={T.recommendations}
                    content={report.recommendations}
                    colorClass="text-emerald-800"
                    icon={<span>🚀</span>}
                  />
                </div>

              </div>

              {/* PDF & Control buttons */}
              <div className="mt-6 flex flex-col sm:flex-row gap-4 justify-center">
                <button onClick={onRestart} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-slate-800 text-white font-bold py-3.5 px-8 rounded-xl hover:bg-slate-900 transition-colors">
                  🔄 {T.restart}
                </button>
                <button onClick={handleDownloadCompPdf} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-emerald-600 text-white font-black py-3.5 px-8 rounded-xl hover:bg-emerald-700 transition-colors shadow">
                  📥 {language === 'ar' ? 'تحميل ملف تقرير الجدارات الفني والسلوكي (PDF)' : 'Download Competency PDF'}
                </button>
              </div>
            </div>
          )}

          {/* TAB 2 CONTENT: Work Environment assessment report */}
          {activeTab === 'environment' && envReport && (
            <div className="space-y-6 animate-fade-in">
              <div ref={envReportRef} className="p-6 bg-slate-50/50 border border-slate-200/80 rounded-2xl space-y-6 text-start">
                
                {/* Header */}
                <div className="text-center pb-4 border-b border-slate-200/60">
                  <h1 className="text-2xl font-black text-slate-800 uppercase tracking-tight">{T.surveyReportTitle}</h1>
                  <p className="text-xs font-semibold text-slate-400 mt-1 uppercase tracking-widest">{language === 'ar' ? 'منظومة تدقيق الممارسات والواقع العملي الفعلي وفق الجودة والتميز طاقة الـ EFQM' : 'Actual Operational Diagnosis & ISO / EFQM Alignment Assessment'}</p>
                </div>

                {/* Core Indexes Scores */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* KPI 1 : Overall index */}
                  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center">
                    <ScoreDonutChart score={envReport.overallScore} title={T.workEnvironmentScore} scoreColorClass={getScoreColor(envReport.overallScore)} language={language} />
                  </div>

                  {/* KPI 2 : ISO 9001 estimated */}
                  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center">
                    <ScoreDonutChart score={envReport.isoComplianceRate} title={language === 'ar' ? 'مؤشر امتثال ممارسات الآيزو ISO 9001' : 'ISO 9001 Compliance'} scoreColorClass={getScoreColor(envReport.isoComplianceRate)} language={language} />
                  </div>

                  {/* KPI 3 : EFQM Excellence estimated */}
                  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center">
                    <ScoreDonutChart score={envReport.efqmExcellenceRate} title={language === 'ar' ? 'مؤشر التميز المؤسسي طاقة الـ EFQM' : 'EFQM Excellence Rate'} scoreColorClass={getScoreColor(envReport.efqmExcellenceRate)} language={language} />
                  </div>
                </div>

                {/* Sub components diagnostics */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Digital preparedness levels badge */}
                  <div className="md:col-span-1 bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">{T.infrastructureLevel}</span>
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 font-black text-sm">
                      💻 {envReport.infrastructureRating}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
                      {language === 'ar' 
                      ? 'يقيس هذا لمدى ملاءمة البنية التحتية والبرمجيات للقيام بالأعمال والتحليل عن بعد.' 
                      : 'Audits if the actual workstations and cloud collaboration interfaces enable operational excellence.'}
                    </p>
                  </div>

                  {/* Operational status diagnosis text */}
                  <div className="md:col-span-2 bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1">{T.currentStatusSurveyLabel}</span>
                    <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">{envReport.currentStatusSummary}</p>
                  </div>
                </div>

                {/* Key challenges faced (العوائق المرصودة) */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-3">
                  <h3 className="text-sm font-extrabold text-slate-800 flex items-center gap-1.5">
                    <span>🛑</span> {T.challengesTitle}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {envReport.keyChallenges?.map((challenge, index) => (
                      <div key={index} className="flex items-start gap-2 p-3 bg-rose-50 border border-rose-100 text-rose-800 rounded-xl text-xs font-semibold">
                        <span>•</span> {challenge}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Dreams & aspirations alignment */}
                <ReportSection
                  title={T.employeeAspirations}
                  content={envReport.operationalAspirations}
                  colorClass="text-emerald-800 text-emerald-700"
                  icon={<span>💬</span>}
                />

                {/* Recommendations for Quality Management / Board (التوصيات لتبسيط الهيكل والحل لبيئة العمل) */}
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-3">
                  <h3 className="text-sm font-extrabold text-slate-800 flex items-center gap-1.5">
                    <span>🛠️</span> {T.managementRecsTitle}
                  </h3>
                  <div className="space-y-2">
                    {envReport.recommendationsForManagement?.map((rec, index) => (
                      <div key={index} className="p-3 bg-slate-50 border border-slate-150 rounded-xl text-xs text-slate-650 flex items-start gap-2 font-medium">
                        <span className="p-1 bg-emerald-100 text-emerald-700 text-[10px] font-black rounded-md">{index + 1}</span>
                        <div className="leading-relaxed">{rec}</div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              {/* Actions */}
              <div className="mt-6 flex flex-col sm:flex-row gap-4 justify-center">
                <button onClick={onRestart} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-slate-800 text-white font-bold py-3.5 px-8 rounded-xl hover:bg-slate-900 transition-colors">
                  🔄 {T.restart}
                </button>
                <button onClick={handleDownloadEnvPdf} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-emerald-600 text-white font-black py-3.5 px-8 rounded-xl hover:bg-emerald-700 transition-colors shadow">
                  📥 {language === 'ar' ? 'تحميل تقرير تشخيص بيئة العمل (PDF)' : 'Download Environment Diagnostic PDF'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ResultsScreen;
