// ResponsesPanel — shows all unified assessment results for a project.
// Used inside ProjectsStage (expandable per-project panel).

import React, { useState, useEffect } from 'react';
import type { UnifiedAssessmentResult, PaperQuestion, Language } from '../types';
import {
  getProjectResults, analyzeResult,
  exportEmployeePdf, exportEmployeeDocx,
  buildEmployeeArtifact,
} from '../services/unifiedAssessmentService';
import { generatePaperQuestions } from '../services/paperAssessmentService';
import { UI } from '../services/designTokens';
import { useToast } from './ToastProvider';
import JSZip from 'jszip';
import { exportPdfDirect } from '../services/exportService';

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

  useEffect(() => {
    setLoading(true);
    getProjectResults(tenantId)
      .then(r => setResults(r.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))))
      .catch(() => toast.error(t('فشل تحميل الردود', 'Failed to load results')))
      .finally(() => setLoading(false));
  }, [tenantId]); // eslint-disable-line

  const refresh = () => {
    setLoading(true);
    getProjectResults(tenantId)
      .then(r => setResults(r.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))))
      .finally(() => setLoading(false));
  };

  // Generate a placeholder questions array for export (reuse last attempt job title)
  // We can't re-fetch real questions, so we reconstruct from stored answers only
  const placeholderQuestions = (r: UnifiedAssessmentResult): PaperQuestion[] => {
    const best = r.attempts.find(a => a.score === r.bestScore) ?? r.attempts[0];
    if (!best) return [];
    return Object.keys(best.answers).map((k, i) => ({
      type: 'technical',
      text: `سؤال ${i + 1}`,
      options: ['أ. —', 'ب. —', 'ج. —', 'د. —'],
      correctAnswer: '—',
      isVoice: false,
    }));
  };

  const handleAnalyze = async (r: UnifiedAssessmentResult) => {
    setAnalyzing(r.id!);
    try {
      const qs = placeholderQuestions(r);
      const analysis = await analyzeResult(r, qs);
      const updated = { ...r, analysis, analysisGeneratedAt: new Date().toISOString() };
      setResults(prev => prev.map(x => x.id === r.id ? updated : x));
      toast.success(t('تم توليد التحليل ✓', 'Analysis generated ✓'));
    } catch (err: unknown) {
      toast.error(t('فشل توليد التحليل: ', 'Analysis failed: ') + (err as Error).message);
    } finally {
      setAnalyzing(null);
    }
  };

  const handleExportPdf = async (r: UnifiedAssessmentResult) => {
    setExporting(r.id!);
    try {
      const qs = placeholderQuestions(r);
      await exportEmployeePdf(r, qs);
    } catch (err: unknown) {
      toast.error(t('فشل تصدير PDF: ', 'PDF export failed: ') + (err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const handleExportDocx = async (r: UnifiedAssessmentResult) => {
    setExporting(r.id!);
    try {
      const qs = placeholderQuestions(r);
      await exportEmployeeDocx(r, qs);
    } catch (err: unknown) {
      toast.error(t('فشل تصدير Word: ', 'Word export failed: ') + (err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const handleBulkZip = async () => {
    if (!results.length) return;
    setBulkExporting(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder('تقارير_الموظفين')!;

      for (const r of results) {
        const qs = placeholderQuestions(r);
        const artifact = buildEmployeeArtifact(r, qs);
        // For bulk ZIP, we create a simple text summary
        const lines = [
          `=== تقرير: ${r.employeeName} ===`,
          `المسمى: ${r.jobTitle}`,
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
        artifact; // used above for structure reference
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'تقارير_الموظفين.zip'; a.click();
      URL.revokeObjectURL(url);
      toast.success(t('تم تصدير ZIP ✓', 'ZIP exported ✓'));
    } catch (err: unknown) {
      toast.error(t('فشل تصدير ZIP: ', 'ZIP export failed: ') + (err as Error).message);
    } finally {
      setBulkExporting(false);
    }
  };

  const scoreColor = (s: number) =>
    s >= 80 ? 'text-emerald-600 dark:text-emerald-400'
    : s >= 60 ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400';

  return (
    <div className={`${UI.sectionFrame} p-5 space-y-4`}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h4 className="font-bold text-slate-800 dark:text-slate-100">
            📊 {t('مركز الردود — التقييمات الموحدة', 'Responses Center — Unified Assessments')}
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {results.length} {t('موظف أجاب', 'employees responded')}
          </p>
        </div>
        <div className="flex gap-2">
          <button className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`} onClick={refresh}>
            🔄 {t('تحديث', 'Refresh')}
          </button>
          {results.length > 0 && (
            <button
              className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
              disabled={bulkExporting}
              onClick={handleBulkZip}
            >
              {bulkExporting ? '⏳' : '📦'} {t('تصدير ZIP الكل', 'Export all ZIP')}
            </button>
          )}
          <button className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-xl leading-none" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-8 text-slate-400 dark:text-slate-500">
          {t('جارٍ التحميل…', 'Loading…')}
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-8 text-slate-500 dark:text-slate-400">
          {t('لا توجد ردود بعد. شارك الرابط الموحد مع الموظفين.', 'No responses yet. Share the unified link with employees.')}
        </div>
      ) : (
        <div className="space-y-3">
          {results.map(r => {
            const isExpanded = expanded === r.id;
            const lastAttempt = r.attempts[r.attempts.length - 1];

            return (
              <div key={r.id} className={`${UI.card} rounded-xl overflow-hidden`}>
                {/* Card header */}
                <div
                  className="flex items-center justify-between gap-3 p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition"
                  onClick={() => setExpanded(isExpanded ? null : r.id ?? null)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center text-teal-700 dark:text-teal-300 font-bold text-sm shrink-0">
                      {r.employeeName.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 dark:text-slate-100 truncate">{r.employeeName}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{r.jobTitle}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className={`font-black text-xl ${scoreColor(r.bestScore)}`}>{r.bestScore}%</div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${r.passed ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300'}`}>
                      {r.passed ? t('ناجح', 'Passed') : t('راسب', 'Failed')}
                    </span>
                    <span className="text-slate-400 text-xs">
                      {new Date(r.submittedAt).toLocaleDateString(ar ? 'ar-SA' : 'en-US')}
                    </span>
                    <span className="text-slate-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded section */}
                {isExpanded && (
                  <div className="border-t border-slate-100 dark:border-slate-700/60 p-4 space-y-4">
                    {/* Attempts summary */}
                    <div>
                      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
                        {t('المحاولات', 'Attempts')} ({r.attempts.length})
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {r.attempts.map((at, i) => (
                          <div key={i} className={`px-3 py-1 rounded-lg text-xs font-bold border ${
                            at.cancelled
                              ? 'border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20'
                              : 'border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800'
                          }`}>
                            #{at.attemptNumber} — {at.cancelled ? t('ملغاة', 'Cancelled') : `${at.score}%`}
                            {at.violations > 0 && <span className="ms-1 text-amber-500">⚠️{at.violations}</span>}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* AI analysis */}
                    {r.analysis ? (
                      <div className="space-y-3">
                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                          {t('التحليل الذكي', 'AI Analysis')}
                          {r.analysisGeneratedAt && (
                            <span className="ms-2 font-normal">({new Date(r.analysisGeneratedAt).toLocaleDateString(ar ? 'ar-SA' : 'en-US')})</span>
                          )}
                        </div>
                        <div className="grid sm:grid-cols-2 gap-3">
                          <div className={`${UI.card} p-3 space-y-1`}>
                            <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                              ✅ {t('نقاط القوة', 'Strengths')}
                            </div>
                            <ul className="space-y-0.5">
                              {r.analysis.strengths.map((s, i) => (
                                <li key={i} className="text-xs text-slate-600 dark:text-slate-300">• {s}</li>
                              ))}
                            </ul>
                          </div>
                          <div className={`${UI.card} p-3 space-y-1`}>
                            <div className="text-xs font-semibold text-rose-600 dark:text-rose-400">
                              ⚠️ {t('نقاط الضعف', 'Weaknesses')}
                            </div>
                            <ul className="space-y-0.5">
                              {r.analysis.weaknesses.map((w, i) => (
                                <li key={i} className="text-xs text-slate-600 dark:text-slate-300">• {w}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                        {r.analysis.competencyScores?.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {r.analysis.competencyScores.map((c, i) => (
                              <div key={i} className="bg-slate-100 dark:bg-slate-700/50 rounded-lg px-2 py-1 text-xs">
                                <span className="text-slate-600 dark:text-slate-300">{c.name}</span>
                                <span className={`ms-1 font-bold ${scoreColor(c.score)}`}>{c.score}%</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          <span className="font-semibold text-slate-700 dark:text-slate-200">{t('التحليل السلوكي: ', 'Behavioral: ')}</span>
                          {r.analysis.behavioralInsights}
                        </div>
                        <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          <span className="font-semibold text-teal-700 dark:text-teal-400">{t('التوصيات: ', 'Recommendations: ')}</span>
                          {r.analysis.recommendations}
                        </div>
                      </div>
                    ) : (
                      <button
                        className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
                        disabled={analyzing === r.id}
                        onClick={() => handleAnalyze(r)}
                      >
                        {analyzing === r.id ? '⏳ جارٍ التحليل…' : `🤖 ${t('توليد التحليل الذكي', 'Generate AI Analysis')}`}
                      </button>
                    )}

                    {/* Export buttons */}
                    <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100 dark:border-slate-700/60">
                      <button
                        className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
                        disabled={exporting === r.id}
                        onClick={() => handleExportPdf(r)}
                      >
                        {exporting === r.id ? '⏳' : '📄'} {t('تقرير PDF', 'PDF Report')}
                      </button>
                      <button
                        className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
                        disabled={exporting === r.id}
                        onClick={() => handleExportDocx(r)}
                      >
                        {exporting === r.id ? '⏳' : '📝'} {t('تقرير Word', 'Word Report')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
