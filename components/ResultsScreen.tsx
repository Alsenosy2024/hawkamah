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
  proctorSummary?: import('../services/proctorCore').ProctorSummary;   // B3 — in-app survey live-proctoring integrity summary
  employeeView?: boolean;        // when true, employee sees thank-you card only; report saved to Firestore for admin
}

const CompetencyChart = ({ scores, language }: { scores: ExtendedReport['competencyScores'], language: Language }) => {
  if (!scores || scores.length === 0) return null;
  const T = TRANSLATIONS[language];

  const barColor = (sc: number) => sc >= 80 ? 'bg-green-500' : sc >= 50 ? 'bg-amber-400' : 'bg-rose-500';

  return (
    <div className="bg-white p-5 rounded-lg border border-slate-200">
      <h3 className="font-bold text-slate-800 mb-4 text-start text-sm">{T.competencyBreakdown}</h3>
      <div className="space-y-3 text-start">
        {scores.map(({ competency, score }) => (
          <div key={competency}>
            <div className="flex justify-between mb-1">
              <span className="text-xs font-semibold text-slate-700">{competency}</span>
              <span className={`text-xs font-bold tabular-nums ${score >= 80 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-rose-500'}`}>
                {localizeNum(score, language)}{language === 'ar' ? '٪' : '%'}
              </span>
            </div>
            <div className="w-full bg-slate-100 rounded-sm h-1.5">
              <div className={`${barColor(score)} h-1.5 rounded-sm`} style={{ width: `${score}%`, transition: 'width 1s ease-out' }}></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ReportSection = ({ title, content, icon, colorClass }: { title: string, content: string, icon: React.ReactNode, colorClass: string }) => (
    <div className="bg-white p-5 rounded-lg border border-slate-200 text-start">
        <div className="flex items-center gap-2 mb-3 pb-2.5 border-b border-slate-100">
            <span className="text-base leading-none">{icon}</span>
            <h3 className={`text-sm font-bold ${colorClass}`}>{title}</h3>
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
  proctorSummary,
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
            affectSignal: affectSignal || null,   // voice/facial affect (verbal interview); null when unavailable
            proctorSummary: proctorSummary || null   // B3 — live proctoring integrity summary from the in-app survey
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
        <div className="bg-white rounded-xl border border-slate-200 px-8 py-10 max-w-md w-full text-center space-y-5">
          {/* Submission confirmed marker */}
          <div className="flex justify-center">
            <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
              <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-bold text-slate-800">
              {language === 'ar' ? `شكراً، ${user.name}` : `Thank you, ${user.name}`}
            </h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              {language === 'ar'
                ? `لقد تم تعبئة ${typeLabel}${includedSurvey ? ` ${surveyLabel}` : ''} بنجاح`
                : `Your ${typeLabel}${includedSurvey ? ` ${surveyLabel}` : ''} has been submitted successfully`}
            </p>
          </div>

          {/* Submission meta */}
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-50 border border-slate-200 rounded-md text-slate-700 text-xs font-semibold">
              {language === 'ar' ? `${answeredCount} من ${totalCount} سؤال` : `${answeredCount} / ${totalCount} answered`}
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-50 border border-slate-200 rounded-md text-slate-700 text-xs font-semibold">
              {assessmentConfig.jobTitle}
            </span>
            {includedSurvey && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-green-50 border border-green-200 rounded-md text-green-800 text-xs font-semibold">
                {language === 'ar' ? 'استبيان بيئة العمل مُضمَّن' : 'Workplace survey included'}
              </span>
            )}
          </div>

          <p className="text-xs text-slate-400 leading-relaxed pt-1">
            {language === 'ar'
              ? 'سيتم مراجعة نتائجك من قِبل الفريق المختص. شكراً لوقتك.'
              : 'Your results will be reviewed by the relevant team. Thank you for your time.'}
          </p>

          <button
            onClick={onRestart}
            className="w-full bg-emerald-600 text-white font-bold py-2.5 px-6 rounded-md hover:bg-emerald-700 transition-colors duration-150 text-sm"
          >
            {language === 'ar' ? 'العودة للرئيسية' : 'Return to Home'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full animate-fade-in space-y-6" dir={language === 'ar' ? 'rtl' : 'ltr'}>
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <svg className="animate-spin h-8 w-8 text-emerald-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-slate-500 text-sm font-medium">{T.generatingReport}</p>
        </div>
      )}

      {error && (
        <div className="text-start text-rose-700 bg-rose-50 p-5 rounded-lg border border-rose-200 flex flex-col gap-4">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 mt-0.5 shrink-0 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span className="text-sm leading-relaxed">{error}</span>
          </div>
          <button onClick={onRestart} className="self-start bg-rose-600 text-white font-bold py-2 px-5 rounded-md hover:bg-rose-700 transition-colors duration-150 text-sm">
            {T.restart}
          </button>
        </div>
      )}

      {(report || envReport) && !isLoading && (
        <>
          {/* Tab Selector — underline style */}
          <div className="flex border-b border-slate-200 gap-0">
            {report && (
            <button
              onClick={() => setActiveTab('competencies')}
              className={`py-2.5 px-5 text-sm font-semibold transition-all duration-150 border-b-2 -mb-px ${
                activeTab === 'competencies'
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              {language === 'ar' ? 'الجدارات والفجوات' : 'Competency & Gaps'}
            </button>
            )}
            {envReport && (
              <button
                onClick={() => setActiveTab('environment')}
                className={`py-2.5 px-5 text-sm font-semibold transition-all duration-150 border-b-2 -mb-px ${
                  activeTab === 'environment'
                    ? 'border-emerald-600 text-emerald-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}
              >
                {language === 'ar' ? 'بيئة العمل (ISO & EFQM)' : 'Work Environment'}
              </button>
            )}
          </div>

          {/* TAB 1 CONTENT: Competencies & Gap report */}
          {activeTab === 'competencies' && report && (
            <div className="space-y-5 pt-4">
              <div ref={compReportRef} className="space-y-5">

                {/* ── VERDICT BAND ─────────────────────────────────────────── */}
                {(() => {
                  const sc = report.totalScore;
                  const passing = sc >= 80;
                  const marginal = sc >= 50;
                  const bandBg = passing ? 'bg-green-50 border-green-200' : marginal ? 'bg-amber-50 border-amber-200' : 'bg-rose-50 border-rose-200';
                  const bandScore = passing ? 'text-green-700' : marginal ? 'text-amber-700' : 'text-rose-600';
                  const verdictLabel = language === 'ar'
                    ? (passing ? 'مؤهَّل: يستوفي المعيار' : marginal ? 'مؤهَّل جزئياً: فجوات محددة' : 'غير مستوفٍ للمعيار')
                    : (passing ? 'Qualified: benchmark met' : marginal ? 'Marginal: specific gaps identified' : 'Below benchmark');
                  return (
                    <div className={`rounded-lg border px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${bandBg}`}>
                      <div className="text-start">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">
                          {language === 'ar' ? 'الحكم الإجمالي' : 'Overall verdict'}
                        </p>
                        <p className={`text-base font-bold ${bandScore}`}>{verdictLabel}</p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {user.name} · {assessmentConfig.jobTitle} · {new Date().toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-GB')}
                        </p>
                      </div>
                      <div className="flex gap-5 shrink-0">
                        {[
                          { label: T.totalScore, val: report.totalScore },
                          { label: language === 'ar' ? 'فني' : 'Technical', val: report.technicalScore },
                          { label: language === 'ar' ? 'سلوكي' : 'Behavioral', val: report.behavioralScore },
                        ].map(({ label, val }) => {
                          const cls = val >= 80 ? 'text-green-700' : val >= 50 ? 'text-amber-700' : 'text-rose-600';
                          return (
                            <div key={label} className="text-center">
                              <p className={`text-2xl font-extrabold tabular-nums leading-none ${cls}`}>
                                {localizeNum(Math.round(val), language)}<span className="text-sm">{language === 'ar' ? '٪' : '%'}</span>
                              </p>
                              <p className="text-[10px] text-slate-500 font-semibold mt-0.5 uppercase tracking-wide">{label}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* ── CANDIDATE IDENTITY ROW ───────────────────────────────── */}
                <div className="bg-white rounded-lg border border-slate-200 px-5 py-3.5 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between text-start">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold shrink-0">
                      {user.name.charAt(0)}
                    </div>
                    <div>
                      <p className="font-bold text-slate-800 text-sm leading-snug">{user.name}</p>
                      <p className="text-xs text-slate-400">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <span className="hw-badge-brand text-[10px]">{assessmentConfig.jobTitle}</span>
                    {assessmentConfig.assessmentType === 'verbal' && (
                      <span className="hw-badge-info text-[10px]">{language === 'ar' ? 'مقابلة صوتية' : 'Voice Interview'}</span>
                    )}
                  </div>
                </div>

                {/* ── TWO-COLUMN BODY ──────────────────────────────────────── */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

                  {/* Left column: competency bars + gap table */}
                  <div className="lg:col-span-2 space-y-5">

                    {/* Competency breakdown bars */}
                    <CompetencyChart scores={report.competencyScores} language={language} />

                    {/* Birkman & Holland */}
                    {report.birkmanHollandSummary && (
                      <ReportSection
                        title={language === 'ar' ? 'تحليل السمات وعلم النفس المهني (بريكمان وهولاند)' : 'Psychometric Profile (Birkman & Holland)'}
                        content={report.birkmanHollandSummary}
                        colorClass="text-slate-800"
                        icon={<svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>}
                      />
                    )}

                    {/* Dual-kind sections */}
                    {(report.competencySection || report.behavioralSection) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {report.competencySection && (
                          <ReportSection
                            title={language === 'ar' ? 'تحليل الجدارات (الفني والمهني)' : 'Competency Analysis'}
                            content={report.competencySection}
                            colorClass="text-slate-800"
                            icon={<svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" /></svg>}
                          />
                        )}
                        {report.behavioralSection && (
                          <ReportSection
                            title={language === 'ar' ? 'التحليل السلوكي' : 'Behavioral Analysis'}
                            content={report.behavioralSection}
                            colorClass="text-slate-800"
                            icon={<svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}
                          />
                        )}
                      </div>
                    )}

                    {/* GAP ANALYSIS TABLE */}
                    <div className="bg-white rounded-lg border border-slate-200 text-start overflow-hidden">
                      <div className="px-5 py-3.5 border-b border-slate-100">
                        <h3 className="text-sm font-bold text-slate-800">{T.gapAnalysisTitle}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{T.gapExplanation}</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left rtl:text-right border-collapse">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-wide">{T.positionStandard}</th>
                              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-wide text-center">{language === 'ar' ? 'المعيار' : 'Benchmark'}</th>
                              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-wide text-center">{language === 'ar' ? 'المستوى الملاحظ' : 'Assessed'}</th>
                              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-wide">{T.gapStatus}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.gapReport?.competencyGaps?.map((gap, idx) => {
                              const gapVal = gap.required - gap.actual;
                              return (
                                <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50/70 transition-colors duration-100">
                                  <td className="px-4 py-3 text-sm font-semibold text-slate-800">{gap.skill}</td>
                                  <td className="px-4 py-3 text-center text-xs font-bold text-slate-400 tabular-nums">{gap.required}%</td>
                                  <td className={`px-4 py-3 text-center text-xs font-bold tabular-nums ${gap.actual >= gap.required ? 'text-green-600' : 'text-rose-500'}`}>{gap.actual}%</td>
                                  <td className="px-4 py-3">
                                    <div className="space-y-1">
                                      <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold inline-block ${gapVal <= 0 ? 'bg-green-100 text-green-800' : 'bg-rose-100 text-rose-700'}`}>
                                        {gapVal <= 0
                                          ? (language === 'ar' ? 'مستوفى' : 'Met')
                                          : (language === 'ar' ? `فجوة ${gapVal}%` : `Gap ${gapVal}%`)}
                                      </span>
                                      <p className="text-slate-500 text-[11px] leading-relaxed">{gap.gapDescription}</p>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {/* Gap synthesis footer */}
                      <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 space-y-3">
                        <div>
                          <span className="text-xs font-bold text-slate-700 block mb-0.5">{language === 'ar' ? 'خلاصة الفجوات' : 'Gaps Summary'}</span>
                          <p className="text-xs text-slate-600 leading-relaxed">{report.gapReport?.overallGapSummary}</p>
                        </div>
                        <div>
                          <span className="text-xs font-bold text-slate-700 block mb-0.5">{language === 'ar' ? 'خطة التطوير المستهدفة' : 'Development Plan'}</span>
                          <p className="text-xs text-slate-600 leading-relaxed">{report.gapReport?.developmentPlan}</p>
                        </div>
                      </div>
                    </div>

                  </div>

                  {/* Right column: strengths, weaknesses, recommendations, eligible roles */}
                  <div className="lg:col-span-1 space-y-4">
                    <ReportSection
                      title={T.strengths}
                      content={report.strengths}
                      colorClass="text-green-800"
                      icon={<svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                    />
                    <ReportSection
                      title={T.weaknesses}
                      content={report.weaknesses}
                      colorClass="text-rose-700"
                      icon={<svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>}
                    />
                    <ReportSection
                      title={T.recommendations}
                      content={report.recommendations}
                      colorClass="text-slate-800"
                      icon={<svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>}
                    />

                    {/* Eligible roles */}
                    {report.jobFitRatings && report.jobFitRatings.length > 0 && (
                      <div className="bg-white rounded-lg border border-slate-200 text-start overflow-hidden">
                        <div className="px-4 py-3 border-b border-slate-100">
                          <h3 className="text-sm font-bold text-slate-800">{T.eligibleRolesTitle}</h3>
                          <p className="text-[11px] text-slate-400 mt-0.5">{T.eligibleRolesExplain}</p>
                        </div>
                        <div className="divide-y divide-slate-100">
                          {report.jobFitRatings?.map((fit, idx) => (
                            <div key={idx} className="px-4 py-3 flex items-start gap-3">
                              <span className={`text-sm font-extrabold tabular-nums shrink-0 ${fit.matchPercentage >= 80 ? 'text-green-600' : fit.matchPercentage >= 50 ? 'text-amber-600' : 'text-rose-500'}`}>
                                {fit.matchPercentage}%
                              </span>
                              <div>
                                <p className="text-xs font-bold text-slate-800">{fit.jobTitle}</p>
                                <p className="text-[11px] text-slate-500 leading-relaxed mt-0.5">{fit.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

              </div>

              {/* PDF & Control buttons */}
              <div className="pt-2 flex flex-col sm:flex-row gap-3 justify-end">
                <button onClick={onRestart} className="flex items-center justify-center gap-2 bg-white text-slate-700 font-semibold py-2.5 px-5 rounded-md border border-slate-300 hover:bg-slate-50 transition-colors duration-150 text-sm">
                  {T.restart}
                </button>
                <button onClick={handleDownloadCompPdf} className="flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-md hover:bg-emerald-700 transition-colors duration-150 text-sm">
                  {language === 'ar' ? 'تحميل تقرير الجدارات (PDF)' : 'Download Competency PDF'}
                </button>
              </div>
            </div>
          )}

          {/* TAB 2 CONTENT: Work Environment assessment report */}
          {activeTab === 'environment' && envReport && (
            <div className="space-y-5 animate-fade-in pt-4">
              <div ref={envReportRef} className="space-y-5 text-start">

                {/* ── ENV VERDICT BAND ─────────────────────────────────────── */}
                {(() => {
                  const sc = envReport.overallScore;
                  const passing = sc >= 80;
                  const marginal = sc >= 50;
                  const bandBg = passing ? 'bg-green-50 border-green-200' : marginal ? 'bg-amber-50 border-amber-200' : 'bg-rose-50 border-rose-200';
                  const bandScore = passing ? 'text-green-700' : marginal ? 'text-amber-700' : 'text-rose-600';
                  return (
                    <div className={`rounded-lg border px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${bandBg}`}>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">
                          {T.surveyReportTitle}
                        </p>
                        <p className="text-xs text-slate-500">
                          {language === 'ar' ? 'منظومة تدقيق الممارسات وفق معايير ISO & EFQM' : 'Operational Diagnosis & ISO / EFQM Alignment'}
                        </p>
                      </div>
                      <div className="flex gap-5 shrink-0">
                        {[
                          { label: T.workEnvironmentScore, val: envReport.overallScore },
                          { label: language === 'ar' ? 'ISO 9001' : 'ISO 9001', val: envReport.isoComplianceRate },
                          { label: 'EFQM', val: envReport.efqmExcellenceRate },
                        ].map(({ label, val }) => {
                          const cls = val >= 80 ? 'text-green-700' : val >= 50 ? 'text-amber-700' : 'text-rose-600';
                          return (
                            <div key={label} className="text-center">
                              <p className={`text-2xl font-extrabold tabular-nums leading-none ${cls}`}>
                                {localizeNum(Math.round(val), language)}<span className="text-sm">{language === 'ar' ? '٪' : '%'}</span>
                              </p>
                              <p className="text-[10px] text-slate-500 font-semibold mt-0.5 uppercase tracking-wide">{label}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Infrastructure + Current status */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-1 bg-white rounded-lg border border-slate-200 px-4 py-4">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">{T.infrastructureLevel}</span>
                    <span className={`inline-block px-3 py-1 rounded-md font-bold text-sm border ${
                      /adequate|good|excellent|ملائم|جيد|ممتاز/i.test(envReport.infrastructureRating)
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : /poor|weak|ضعيف|سيء/i.test(envReport.infrastructureRating)
                          ? 'bg-rose-50 border-rose-200 text-rose-800'
                          : /partial|moderate|متوسط|جزئي/i.test(envReport.infrastructureRating)
                            ? 'bg-amber-50 border-amber-200 text-amber-800'
                            : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}>
                      {envReport.infrastructureRating}
                    </span>
                    <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
                      {language === 'ar'
                        ? 'يقيس هذا لمدى ملاءمة البنية التحتية والبرمجيات للقيام بالأعمال والتحليل عن بعد.'
                        : 'Audits if the actual workstations and cloud collaboration interfaces enable operational excellence.'}
                    </p>
                  </div>
                  <div className="md:col-span-2 bg-white rounded-lg border border-slate-200 px-4 py-4">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">{T.currentStatusSurveyLabel}</span>
                    <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">{envReport.currentStatusSummary}</p>
                  </div>
                </div>

                {/* Key challenges */}
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100">
                    <h3 className="text-sm font-bold text-slate-800">{T.challengesTitle}</h3>
                  </div>
                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-2">
                    {envReport.keyChallenges?.map((challenge, index) => (
                      <div key={index} className="flex items-start gap-2 p-3 bg-rose-50 border border-rose-100 text-rose-800 rounded-md text-xs font-semibold leading-relaxed">
                        <span className="mt-px shrink-0 text-rose-400">&#8226;</span>
                        <span>{challenge}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Employee aspirations */}
                <ReportSection
                  title={T.employeeAspirations}
                  content={envReport.operationalAspirations}
                  colorClass="text-slate-800"
                  icon={<svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>}
                />

                {/* Management recommendations */}
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100">
                    <h3 className="text-sm font-bold text-slate-800">{T.managementRecsTitle}</h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {envReport.recommendationsForManagement?.map((rec, index) => (
                      <div key={index} className="px-4 py-3 flex items-start gap-3">
                        <span className="w-5 h-5 rounded-sm bg-emerald-100 text-emerald-700 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                          {localizeNum(index + 1, language)}
                        </span>
                        <p className="text-xs text-slate-600 leading-relaxed">{rec}</p>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              {/* Actions */}
              <div className="pt-2 flex flex-col sm:flex-row gap-3 justify-end">
                <button onClick={onRestart} className="flex items-center justify-center gap-2 bg-white text-slate-700 font-semibold py-2.5 px-5 rounded-md border border-slate-300 hover:bg-slate-50 transition-colors duration-150 text-sm">
                  {T.restart}
                </button>
                <button onClick={handleDownloadEnvPdf} className="flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-md hover:bg-emerald-700 transition-colors duration-150 text-sm">
                  {language === 'ar' ? 'تحميل تقرير بيئة العمل (PDF)' : 'Download Environment PDF'}
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
