// ResponsesPanel — shows all unified assessment results for a project.
// Used inside ProjectsStage (expandable per-project panel).

import React, { useState, useEffect } from 'react';
import type { UnifiedAssessmentResult, Language, PublicSurveyResponse, GeneratedArtifact } from '../types';
import {
  getProjectResults, analyzeResult,
  exportEmployeePdf, exportEmployeeDocx,
  buildEmployeeArtifact, getAttemptQuestions,
} from '../services/unifiedAssessmentService';
// V36 — the «الردود» panel now also records environment-survey replies, which
// live in the separate `survey_responses` collection (surveyTokenService).
import { getProjectResponses, patchResponseAnalysis } from '../services/surveyTokenService';
import { analyzeWorkEnvironment } from '../services/geminiService';
import { buildSingleResponseArtifact, SURVEY_FIELDS } from '../services/surveyReport';
import { exportDocx } from '../services/exportService';
import { artifactToMarkdown } from '../services/canvasDocument';
import DocumentCanvas from './DocumentCanvas';
import { UI, badge } from '../services/designTokens';
import { useToast } from './ToastProvider';
import { useArtifactExport } from '../hooks/useArtifactExport';
import JSZip from 'jszip';

interface Props {
  tenantId: string;
  language: Language;
  onClose: () => void;
}

export default function ResponsesPanel({ tenantId, language, onClose }: Props) {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const toast = useToast();

  const [results, setResults]   = useState<UnifiedAssessmentResult[]>([]);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [bulkExporting, setBulkExporting] = useState(false);
  // [MINOR fix] shared busy/toast wrapper for the buildXArtifact→exportDocx
  // export below (was its own `surveyExporting` copy — see hooks/useArtifactExport.ts).
  const exp = useArtifactExport(language);
  // MAJOR fix (canvas preview) — open a generated employee report in the SAME
  // in-app editable canvas GovernanceCenter uses for other generated artifacts
  // (charter / risk register / roadmap), instead of going straight to a blob
  // export with no preview. This panel is rendered outside GovernanceCenter (from
  // ProjectsStage), so it owns its own small overlay state rather than reusing
  // GovernanceCenter's local (unexported) openArtifactInCanvas.
  const [canvasArt, setCanvasArt] = useState<GeneratedArtifact | null>(null);

  // V36 — environment-survey replies (survey_responses collection) shown alongside
  // the employee assessments so every reply type is recorded in one place.
  const [surveys, setSurveys]             = useState<PublicSurveyResponse[]>([]);
  const [surveyExpanded, setSurveyExpanded] = useState<string | null>(null);
  const [surveyAnalyzing, setSurveyAnalyzing] = useState<string | null>(null);

  // Load BOTH record types concurrently. allSettled (not Promise.all's fail-fast)
  // so a failure of one list never blanks the other — we still surface one toast.
  const load = () => {
    setLoading(true);
    Promise.allSettled([getProjectResults(tenantId), getProjectResponses(tenantId)])
      .then(([resR, surR]) => {
        let failed = false;
        if (resR.status === 'fulfilled') {
          setResults(resR.value.slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)));
        } else failed = true;
        if (surR.status === 'fulfilled') {
          setSurveys(surR.value.slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)));
        } else failed = true;
        if (failed) toast.error(t('فشل تحميل الردود', 'Failed to load results'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [tenantId]); // eslint-disable-line

  const refresh = () => load();

  const handleAnalyze = async (r: UnifiedAssessmentResult) => {
    // CRITICAL fix: getAttemptQuestions returns the REAL persisted question set
    // (UnifiedAttempt.questions — see UnifiedAssessmentPortal), never a
    // reconstructed placeholder. A legacy record saved before this fix has none.
    const qs = getAttemptQuestions(r);
    if (!qs.length) {
      toast.error(t(
        'الأسئلة الأصلية غير محفوظة لهذا التقييم (سجل سابق لتفعيل حفظ الأسئلة) — لا يمكن توليد تحليل ذكي دقيق منها.',
        'The original questions were not saved for this assessment (a record from before question persistence) — an accurate AI analysis cannot be generated.',
      ));
      return;
    }
    setAnalyzing(r.id!);
    try {
      const analysis = await analyzeResult(r, qs);
      const updated = { ...r, analysis, analysisGeneratedAt: new Date().toISOString() };
      setResults(prev => prev.map(x => x.id === r.id ? updated : x));
      toast.success(t('تم توليد التحليل', 'Analysis generated'));
    } catch (err: unknown) {
      toast.error(t('فشل توليد التحليل: ', 'Analysis failed: ') + (err as Error).message);
    } finally {
      setAnalyzing(null);
    }
  };

  const handleExportPdf = async (r: UnifiedAssessmentResult) => {
    setExporting(r.id! + ':pdf');
    try {
      await exportEmployeePdf(r, getAttemptQuestions(r));
    } catch (err: unknown) {
      toast.error(t('فشل تصدير PDF: ', 'PDF export failed: ') + (err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const handleExportDocx = async (r: UnifiedAssessmentResult) => {
    setExporting(r.id! + ':docx');
    try {
      await exportEmployeeDocx(r, getAttemptQuestions(r));
    } catch (err: unknown) {
      toast.error(t('فشل تصدير Word: ', 'Word export failed: ') + (err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  // MAJOR fix: open the same report in the editable canvas before exporting,
  // matching the openArtifactInCanvas pattern GovernanceCenter uses for the
  // charter/risk register/roadmap (DocumentCanvas below renders it).
  const handleOpenCanvas = (r: UnifiedAssessmentResult) => {
    setCanvasArt(buildEmployeeArtifact(r, getAttemptQuestions(r)));
  };

  const handleBulkZip = async () => {
    if (!results.length) return;
    setBulkExporting(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder('تقارير_الموظفين')!;

      for (const r of results) {
        // For bulk ZIP, we create a simple text summary
        const lines = [
          `=== تقرير: ${r.employeeName} ===`,
          `المسمى: ${r.jobTitle}`,
          ...(r.employeeId ? [`الرقم الوظيفي: ${r.employeeId}`] : []),
          `أفضل درجة: ${r.bestScore}%`,
          `النتيجة: ${r.passed ? 'ناجح' : 'راسب'}`,
          `المحاولات: ${r.attempts.length}`,
          `التاريخ: ${new Date(r.submittedAt).toLocaleDateString('ar-SA')}`,
          '',
          ...(r.analysis ? [
            'نقاط القوة:',
            ...r.analysis.strengths.map(s => `  - ${s}`),
            '',
            'نقاط الضعف:',
            ...r.analysis.weaknesses.map(w => `  - ${w}`),
            '',
            'التحليل السلوكي:',
            r.analysis.behavioralInsights,
            '',
            'التوصيات:',
            r.analysis.recommendations,
          ] : ['لم يُولَّد تحليل بعد']),
        ];
        const safeName = r.employeeName.replace(/[^a-zA-Z؀-ۿ0-9]/g, '_');
        folder.file(`${safeName}.txt`, lines.join('\n'), { binary: false });
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'تقارير_الموظفين.zip'; a.click();
      URL.revokeObjectURL(url);
      toast.success(t('تم تصدير ZIP', 'ZIP exported'));
    } catch (err: unknown) {
      toast.error(t('فشل تصدير ZIP: ', 'ZIP export failed: ') + (err as Error).message);
    } finally {
      setBulkExporting(false);
    }
  };

  // V36 — analyze one environment-survey reply (reuses the ResponsesCenter flow:
  // analyzeWorkEnvironment + the existing patchResponseAnalysis Firestore write).
  const handleAnalyzeSurvey = async (s: PublicSurveyResponse) => {
    setSurveyAnalyzing(s.id);
    try {
      const report = await analyzeWorkEnvironment(
        s.answers, language, s.respondentJobTitle || t('موظف', 'Employee'),
      );
      setSurveys(prev => prev.map(x => x.id === s.id ? { ...x, analysis: report } : x));
      // Persist for future loads (non-fatal — mirrors ResponsesCenter.analyzeOne).
      patchResponseAnalysis(s.id, s.answers, report).catch(() => {/* non-fatal */});
      toast.success(t('تم توليد التحليل', 'Analysis generated'));
    } catch (err: unknown) {
      toast.error(t('فشل توليد التحليل: ', 'Analysis failed: ') + (err as Error).message);
    } finally {
      setSurveyAnalyzing(null);
    }
  };

  // V36 — export one environment-survey reply (same DOCX artifact ResponsesCenter uses).
  const handleExportSurvey = (s: PublicSurveyResponse) => exp.run(`survey_${s.id}`, async () => {
    const art = buildSingleResponseArtifact({
      userName: s.respondentName,
      jobTitle: s.respondentJobTitle,
      department: s.respondentDepartment,
      workplaceAnswers: s.answers,
      envReportData: s.analysis ?? null,
    }, language);
    await exportDocx(art);
  }, { errorPrefix: { ar: 'فشل تصدير Word: ', en: 'Word export failed: ' } });

  const scoreColor = (s: number) =>
    s >= 80 ? 'text-emerald-600 dark:text-emerald-400'
    : s >= 60 ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400';

  return (
    <>
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-700 bg-[#F7FAFB] dark:bg-slate-800/60">
        <div className="min-w-0">
          <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100 leading-snug">
            {t('مركز الردود — كل الردود', 'Responses — All Replies')}
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {results.length} {t('تقييم', 'assessments')}
            {' · '}
            {surveys.length} {t('استبيان بيئة', 'env. surveys')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="hw-btn hw-btn-ghost text-xs px-2.5 py-1.5 leading-none"
            onClick={refresh}
          >
            {t('تحديث', 'Refresh')}
          </button>
          {results.length > 0 && (
            <button
              className="hw-btn hw-btn-ghost text-xs px-2.5 py-1.5 leading-none disabled:opacity-50"
              disabled={bulkExporting}
              onClick={handleBulkZip}
            >
              {bulkExporting
                ? t('جارٍ التصدير…', 'Exporting…')
                : t('تصدير ZIP', 'Export ZIP')}
            </button>
          )}
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-700 transition-colors duration-150"
            onClick={onClose}
            aria-label={t('إغلاق', 'Close')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">
          {t('جارٍ التحميل…', 'Loading…')}
        </div>
      ) : (results.length === 0 && surveys.length === 0) ? (
        <div className="py-14 px-6 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed max-w-xs mx-auto">
            {t('لا توجد ردود بعد. شارك رابط التقييم أو استبيان البيئة مع الموظفين.', 'No responses yet. Share the assessment or environment-survey link with employees.')}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-700">
          {/* ── Employee assessments (unified_results) ───────────────────── */}
          <section>
            <div className="px-5 py-2.5 flex items-center gap-2 bg-slate-50/70 dark:bg-slate-800/30 border-b border-slate-100 dark:border-slate-700/60">
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
                {t('تقييمات الموظفين', 'Employee assessments')}
              </span>
              <span className={badge('neutral')}>{results.length}</span>
            </div>
            {results.length === 0 ? (
              <p className="px-5 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                {t('لا توجد تقييمات موظفين بعد.', 'No employee assessments yet.')}
              </p>
            ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
          {results.map(r => {
            const isExpanded = expanded === r.id;

            return (
              <li key={r.id}>
                {/* Row summary — clickable */}
                <div
                  className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors duration-150"
                  onClick={() => setExpanded(isExpanded ? null : r.id ?? null)}
                >
                  {/* Avatar initial */}
                  <div className="w-8 h-8 rounded-md bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center text-emerald-700 dark:text-emerald-400 font-bold text-sm shrink-0 select-none border border-emerald-100 dark:border-emerald-800/40">
                    {r.employeeName.slice(0, 1)}
                  </div>

                  {/* Name + title */}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate leading-snug">
                      {r.employeeName}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate leading-snug mt-0.5">
                      {r.jobTitle}{r.employeeId ? ` · ${r.employeeId}` : ''}
                    </div>
                  </div>

                  {/* Score + status + date + chevron */}
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`tabular-nums font-bold text-sm ${scoreColor(r.bestScore)}`}>
                      {r.bestScore}%
                    </span>
                    <span className={`hw-badge ${r.passed ? 'hw-badge-success' : 'hw-badge-danger'}`}>
                      {r.passed ? t('ناجح', 'Passed') : t('راسب', 'Failed')}
                    </span>
                    <span className="hidden sm:inline text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                      {new Date(r.submittedAt).toLocaleDateString(ar ? 'ar-SA' : 'en-US')}
                    </span>
                    <svg
                      width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
                      className={`text-slate-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
                    >
                      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                </div>

                {/* Expanded disclosure zone */}
                {isExpanded && (
                  <div className="bg-[#F7FAFB] dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-700/60 px-5 py-4 space-y-4">

                    {/* Attempts */}
                    <section>
                      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                        {t('المحاولات', 'Attempts')} ({r.attempts.length})
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {r.attempts.map((at, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-sm text-xs font-medium border ${
                              at.cancelled
                                ? 'border-rose-200 dark:border-rose-800/60 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20'
                                : 'border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800'
                            }`}
                          >
                            <span className="text-slate-400 dark:text-slate-500 font-normal">#{at.attemptNumber}</span>
                            <span>{at.cancelled ? t('ملغاة', 'Cancelled') : `${at.score}%`}</span>
                            {at.violations > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-amber-600 font-semibold">
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="shrink-0">
                                  <path d="M5 1L9 9H1L5 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                                </svg>
                                {at.violations}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    </section>

                    {/* AI Analysis */}
                    {r.analysis ? (
                      <section className="space-y-3">
                        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          {t('التحليل الذكي', 'AI Analysis')}
                          {r.analysisGeneratedAt && (
                            <span className="ms-2 font-normal normal-case tracking-normal text-slate-400">
                              {new Date(r.analysisGeneratedAt).toLocaleDateString(ar ? 'ar-SA' : 'en-US')}
                            </span>
                          )}
                        </p>

                        {/* Strengths / Weaknesses */}
                        <div className="grid sm:grid-cols-2 gap-3">
                          <div className="rounded-lg border border-green-100 dark:border-green-900/40 bg-green-50/40 dark:bg-green-900/10 p-3 space-y-1.5">
                            <p className="text-xs font-semibold text-green-700 dark:text-green-400">
                              {t('نقاط القوة', 'Strengths')}
                            </p>
                            <ul className="space-y-1">
                              {r.analysis.strengths.map((s, i) => (
                                <li key={i} className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex gap-1.5">
                                  <span className="text-green-500 shrink-0 mt-px">+</span>
                                  <span>{s}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="rounded-lg border border-rose-100 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-900/10 p-3 space-y-1.5">
                            <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">
                              {t('نقاط الضعف', 'Weaknesses')}
                            </p>
                            <ul className="space-y-1">
                              {r.analysis.weaknesses.map((w, i) => (
                                <li key={i} className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex gap-1.5">
                                  <span className="text-rose-400 shrink-0 mt-px">-</span>
                                  <span>{w}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        {/* Competency score chips */}
                        {r.analysis.competencyScores?.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {r.analysis.competencyScores.map((c, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-sm px-2 py-0.5 text-xs"
                              >
                                <span className="text-slate-600 dark:text-slate-300">{c.name}</span>
                                <span className={`font-semibold tabular-nums ${scoreColor(c.score)}`}>{c.score}%</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Behavioral + Recommendations */}
                        <div className="space-y-2 pt-1 border-t border-slate-200/70 dark:border-slate-700/50">
                          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                            <span className="font-semibold text-slate-700 dark:text-slate-200">
                              {t('التحليل السلوكي: ', 'Behavioral: ')}
                            </span>
                            {r.analysis.behavioralInsights}
                          </p>
                          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                            <span className="font-semibold text-slate-700 dark:text-slate-200">
                              {t('التوصيات: ', 'Recommendations: ')}
                            </span>
                            {r.analysis.recommendations}
                          </p>
                        </div>
                      </section>
                    ) : (
                      <button
                        className="hw-btn hw-btn-ghost text-xs px-3 py-1.5 disabled:opacity-50"
                        disabled={analyzing === r.id || !getAttemptQuestions(r).length}
                        title={!getAttemptQuestions(r).length
                          ? t('الأسئلة الأصلية غير محفوظة لهذا التقييم — سجل سابق لتفعيل حفظ الأسئلة', 'The original questions were not saved for this assessment — a record from before question persistence')
                          : undefined}
                        onClick={() => handleAnalyze(r)}
                      >
                        {analyzing === r.id
                          ? t('جارٍ التحليل…', 'Analyzing…')
                          : t('توليد التحليل الذكي', 'Generate AI Analysis')}
                      </button>
                    )}

                    {/* CRITICAL fix: honest state instead of a silent placeholder-backed
                        analysis/export for legacy records with no persisted questions. */}
                    {!getAttemptQuestions(r).length && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
                        {t('الأسئلة الأصلية غير محفوظة لهذا التقييم.', 'The original questions were not saved for this assessment.')}
                      </p>
                    )}

                    {/* Export actions */}
                    <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-200/70 dark:border-slate-700/50">
                      <span className="text-xs text-slate-400 dark:text-slate-500 me-1">
                        {t('تصدير:', 'Export:')}
                      </span>
                      <button
                        className="hw-btn hw-btn-ghost text-xs px-2.5 py-1.5 disabled:opacity-50"
                        onClick={() => handleOpenCanvas(r)}
                      >
                        {t('افتح في الكانفس', 'Open in canvas')}
                      </button>
                      <button
                        className="hw-btn hw-btn-ghost text-xs px-2.5 py-1.5 disabled:opacity-50"
                        disabled={exporting === r.id + ':pdf'}
                        onClick={() => handleExportPdf(r)}
                      >
                        {exporting === r.id + ':pdf' ? t('جارٍ…', 'Working…') : t('تقرير PDF', 'PDF Report')}
                      </button>
                      <button
                        className="hw-btn hw-btn-ghost text-xs px-2.5 py-1.5 disabled:opacity-50"
                        disabled={exporting === r.id + ':docx'}
                        onClick={() => handleExportDocx(r)}
                      >
                        {exporting === r.id + ':docx' ? t('جارٍ…', 'Working…') : t('تقرير Word', 'Word Report')}
                      </button>
                    </div>

                  </div>
                )}
              </li>
            );
          })}
        </ul>
            )}
          </section>

          {/* ── Work-environment surveys (survey_responses) ──────────────── */}
          <section>
            <div className="px-5 py-2.5 flex items-center gap-2 bg-slate-50/70 dark:bg-slate-800/30 border-y border-slate-100 dark:border-slate-700/60">
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
                {t('استبيانات بيئة العمل', 'Work-environment surveys')}
              </span>
              <span className={badge('info')}>{surveys.length}</span>
            </div>
            {surveys.length === 0 ? (
              <p className="px-5 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                {t('لا توجد ردود استبيان بيئة بعد.', 'No environment-survey responses yet.')}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {surveys.map(s => {
                  const isOpen = surveyExpanded === s.id;
                  const name = s.respondentName || t('مشارك مجهول', 'Anonymous');
                  const meta = [s.respondentJobTitle, s.respondentDepartment].filter(Boolean).join(' · ');
                  const analysis = s.analysis;

                  return (
                    <li key={s.id}>
                      {/* Row summary — clickable */}
                      <div
                        className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors duration-150"
                        onClick={() => setSurveyExpanded(isOpen ? null : s.id)}
                      >
                        {/* Avatar initial */}
                        <div className="w-8 h-8 rounded-md bg-sky-50 dark:bg-sky-900/30 flex items-center justify-center text-sky-700 dark:text-sky-400 font-bold text-sm shrink-0 select-none border border-sky-100 dark:border-sky-800/40">
                          {name.slice(0, 1)}
                        </div>

                        {/* Name + meta + type badge */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate leading-snug">
                              {name}
                            </span>
                            <span className={`${badge('info')} shrink-0`}>{t('استبيان بيئة', 'Env. survey')}</span>
                          </div>
                          {meta && (
                            <div className="text-xs text-slate-500 dark:text-slate-400 truncate leading-snug mt-0.5">
                              {meta}
                            </div>
                          )}
                        </div>

                        {/* Score (if analyzed) + date + chevron */}
                        <div className="flex items-center gap-3 shrink-0">
                          {analysis && (
                            <span className={`tabular-nums font-bold text-sm ${scoreColor(analysis.overallScore)}`}>
                              {analysis.overallScore}<span className="text-xs font-normal text-slate-400">/100</span>
                            </span>
                          )}
                          <span className="hidden sm:inline text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                            {new Date(s.submittedAt).toLocaleDateString(ar ? 'ar-SA' : 'en-US')}
                          </span>
                          <svg
                            width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
                            className={`text-slate-400 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
                          >
                            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      </div>

                      {/* Expanded disclosure zone */}
                      {isOpen && (
                        <div className="bg-[#F7FAFB] dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-700/60 px-5 py-4 space-y-4">

                          {/* Answers */}
                          <section>
                            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                              {t('الإجابات', 'Answers')}
                            </p>
                            <div className="divide-y divide-slate-100 dark:divide-slate-700 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                              {SURVEY_FIELDS.map(f => {
                                const val = (s.answers as any)[f.key];
                                if (!val) return null;
                                return (
                                  <div key={f.key} className="px-3 py-2.5 grid grid-cols-[130px_1fr] gap-x-3 sm:grid-cols-[160px_1fr]">
                                    <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 pt-0.5 uppercase tracking-wide truncate">
                                      {f.icon} {ar ? f.ar : f.en}
                                    </div>
                                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                                      {val}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </section>

                          {/* AI Analysis (lazy — reused from ResponsesCenter) */}
                          {analysis ? (
                            <section className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                              {/* Score strip */}
                              <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center gap-6 flex-wrap">
                                <div className="flex items-baseline gap-1.5">
                                  <span className={`text-xl font-bold tabular-nums ${scoreColor(analysis.overallScore)}`}>{analysis.overallScore}</span>
                                  <span className="text-xs text-slate-400">/100</span>
                                  <span className="text-[10px] text-slate-400 ms-1">{t('الإجمالي', 'Overall')}</span>
                                </div>
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-base font-semibold tabular-nums text-slate-700 dark:text-slate-200">{analysis.isoComplianceRate}%</span>
                                  <span className="text-[10px] text-slate-400">ISO 9001</span>
                                </div>
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-base font-semibold tabular-nums text-slate-700 dark:text-slate-200">{analysis.efqmExcellenceRate}%</span>
                                  <span className="text-[10px] text-slate-400">EFQM</span>
                                </div>
                                <span className={badge('info')}>{analysis.infrastructureRating}</span>
                              </div>
                              <div className="px-4 py-3 space-y-3">
                                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{analysis.currentStatusSummary}</p>
                                {analysis.keyChallenges?.length > 0 && (
                                  <div>
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{t('التحديات الرئيسية', 'Key challenges')}</div>
                                    <ul className="space-y-1">
                                      {analysis.keyChallenges.map((c, ci) => (
                                        <li key={ci} className="text-xs text-slate-600 dark:text-slate-300 flex gap-2">
                                          <span className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true">–</span><span>{c}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {analysis.recommendationsForManagement?.length > 0 && (
                                  <div>
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{t('توصيات للإدارة', 'Recommendations')}</div>
                                    <ul className="space-y-1">
                                      {analysis.recommendationsForManagement.map((rec, ri) => (
                                        <li key={ri} className="text-xs text-slate-600 dark:text-slate-300 flex gap-2">
                                          <span className="text-slate-400 shrink-0 mt-0.5" aria-hidden="true">·</span><span>{rec}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            </section>
                          ) : (
                            <button
                              className="hw-btn hw-btn-ghost text-xs px-3 py-1.5 disabled:opacity-50"
                              disabled={surveyAnalyzing === s.id}
                              onClick={() => handleAnalyzeSurvey(s)}
                            >
                              {surveyAnalyzing === s.id
                                ? t('جارٍ التحليل…', 'Analyzing…')
                                : t('توليد التحليل الذكي', 'Generate AI Analysis')}
                            </button>
                          )}

                          {/* Export action */}
                          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-200/70 dark:border-slate-700/50">
                            <span className="text-xs text-slate-400 dark:text-slate-500 me-1">
                              {t('تصدير:', 'Export:')}
                            </span>
                            <button
                              className="hw-btn hw-btn-ghost text-xs px-2.5 py-1.5 disabled:opacity-50"
                              disabled={exp.isBusy(`survey_${s.id}`)}
                              onClick={() => handleExportSurvey(s)}
                            >
                              {exp.isBusy(`survey_${s.id}`) ? t('جارٍ…', 'Working…') : t('تقرير Word', 'Word Report')}
                            </button>
                          </div>

                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>

    {/* MAJOR fix: canvas preview for the employee report, matching the
        openArtifactInCanvas pattern GovernanceCenter uses for other generated
        artifacts — edit in place before exporting, instead of a blind blob export. */}
    {canvasArt && (
      <DocumentCanvas
        markdown={artifactToMarkdown(canvasArt)}
        initialHtml={canvasArt.canvasHtml}
        title={canvasArt.title}
        language={language}
        subtitle={canvasArt.goal}
        onClose={() => setCanvasArt(null)}
        onSave={html => setCanvasArt(prev => (prev ? { ...prev, canvasHtml: html } : prev))}
      />
    )}
    </>
  );
}
