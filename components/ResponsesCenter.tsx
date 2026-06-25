// ResponsesCenter — مركز الاستبيانات والآراء
// Shows all public survey responses for the active project tenant.
// Each card: answers summary + lazy AI analysis.
// Bottom: copilot that answers questions about the full response set.
// Exports: per-response PDF/DOCX, aggregate report.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Language, PublicSurveyResponse, WorkEnvironmentReport, EmployeeResponse } from '../types';
import { getProjectResponses, patchResponseAnalysis } from '../services/surveyTokenService';
import { getEmployeeResponses } from '../services/employeePortalService';
import { analyzeWorkEnvironment } from '../services/geminiService';
import { streamChat } from '../services/agentOrchestrator';
import { buildSingleResponseArtifact, buildAggregateArtifact, buildEmployeeUnifiedArtifact } from '../services/surveyReport';
import { exportDocx, exportPdfDirect } from '../services/exportService';
import { UI, badge } from '../services/designTokens';
import { useToast } from './ToastProvider';
import { SURVEY_FIELDS } from '../services/surveyReport';

interface Props {
  tenantId: string;
  language: Language;
  companyName?: string;
}

type AnalysisState = 'idle' | 'loading' | 'done' | 'error';

const ResponsesCenter: React.FC<Props> = ({ tenantId, language, companyName }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => ar ? a : e;
  const toast = useToast();

  const [responses, setResponses] = useState<PublicSurveyResponse[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [analysisState, setAnalysisState] = useState<Record<string, AnalysisState>>({});
  const [analyses, setAnalyses] = useState<Record<string, WorkEnvironmentReport>>({});
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportingAll, setExportingAll] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState<'env' | 'employee'>('env');

  // Employee responses
  const [empResponses, setEmpResponses] = useState<EmployeeResponse[]>([]);
  const [empLoadState, setEmpLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [empExpanded, setEmpExpanded] = useState<string | null>(null);
  const [empExporting, setEmpExporting] = useState<string | null>(null); // `${id}:${fmt}` being exported

  // N7 — ONE unified report (competency + work-environment) per employee, DOCX or PDF.
  const exportEmp = async (emp: EmployeeResponse, fmt: 'docx' | 'pdf') => {
    setEmpExporting(`${emp.id}:${fmt}`);
    try {
      const art = buildEmployeeUnifiedArtifact(emp, language);
      const opts = { language, companyName: emp.companyName || companyName };
      if (fmt === 'pdf') await exportPdfDirect(art, opts);
      else await exportDocx(art, opts);
    } catch (e: any) {
      toast.error(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e));
    } finally {
      setEmpExporting(null);
    }
  };

  useEffect(() => {
    if (!tenantId) { setEmpLoadState('done'); return; }
    setEmpLoadState('loading');
    getEmployeeResponses(tenantId)
      .then(rs => { setEmpResponses(rs); setEmpLoadState('done'); })
      .catch(() => setEmpLoadState('error'));
  }, [tenantId]);

  // Copilot
  const [copilotQ, setCopilotQ] = useState('');
  const [copilotA, setCopilotA] = useState('');
  const [copilotBusy, setCopilotBusy] = useState(false);
  const copilotAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!tenantId) { setLoadState('done'); return; }
    setLoadState('loading');
    getProjectResponses(tenantId)
      .then(rs => {
        setResponses(rs);
        // Populate cached analyses from Firestore (if previously generated)
        const cached: Record<string, WorkEnvironmentReport> = {};
        rs.forEach(r => { if (r.analysis) cached[r.id] = r.analysis as WorkEnvironmentReport; });
        setAnalyses(prev => ({ ...prev, ...cached }));
        setLoadState('done');
      })
      .catch(() => setLoadState('error'));
  }, [tenantId]);

  const analyzeOne = useCallback(async (r: PublicSurveyResponse) => {
    setAnalysisState(s => ({ ...s, [r.id]: 'loading' }));
    try {
      const report = await analyzeWorkEnvironment(r.answers, language, t('موظف', 'Employee'), companyName);
      setAnalyses(prev => ({ ...prev, [r.id]: report }));
      setAnalysisState(s => ({ ...s, [r.id]: 'done' }));
      // Persist analysis to Firestore for future loads
      patchResponseAnalysis(r.id, r.answers, report).catch(() => {/* non-fatal */});
    } catch {
      setAnalysisState(s => ({ ...s, [r.id]: 'error' }));
    }
  }, [language, companyName, t]);

  const exportOne = async (r: PublicSurveyResponse) => {
    setExportingId(r.id);
    try {
      const rec = {
        workplaceAnswers: r.answers,
        envReportData: (r.analysis as WorkEnvironmentReport | undefined) ?? null,
      };
      const art = buildSingleResponseArtifact(rec, language);
      await exportDocx(art);
    } catch (e: any) {
      toast.error(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e));
    } finally {
      setExportingId(null);
    }
  };

  const exportAll = async () => {
    if (!responses.length) return;
    setExportingAll(true);
    try {
      const records = responses.map(r => ({
        workplaceAnswers: r.answers,
        envReportData: (r.analysis as WorkEnvironmentReport | undefined) ?? null,
      }));
      const art = await buildAggregateArtifact({
        records,
        companyName: companyName || '',
        mode: 'full',
        language,
      });
      await exportDocx(art);
    } catch (e: any) {
      toast.error(t('فشل تصدير الكل: ', 'Bulk export failed: ') + (e?.message || e));
    } finally {
      setExportingAll(false);
    }
  };

  const askCopilot = async () => {
    if (!copilotQ.trim() || copilotBusy) return;
    copilotAbort.current?.abort();
    copilotAbort.current = new AbortController();
    setCopilotBusy(true);
    setCopilotA('');
    const context = responses.map((r, i) => {
      const base = SURVEY_FIELDS.map(f => `${f[ar ? 'ar' : 'en']}: ${(r.answers as any)[f.key] || '-'}`).join('\n');
      return `== رد #${i + 1} (${r.submittedAt.slice(0, 10)}) ==\n${base}`;
    }).join('\n\n');
    const system = ar
      ? `أنت محلل موارد بشرية خبير. لديك ${responses.length} ردود استبيان بيئة عمل من ${companyName || 'جهة'}. أجب باللغة العربية.\n\nالردود:\n${context}`
      : `You are an HR analytics expert. You have ${responses.length} workplace survey responses from ${companyName || 'an organization'}. Answer in English.\n\nResponses:\n${context}`;
    try {
      await streamChat(
        { message: copilotQ.trim(), history: [], systemInstruction: system, signal: copilotAbort.current.signal },
        {
          onAnswer: t => setCopilotA(prev => prev + t),
          onError: () => setCopilotA(prev => prev + '\n[خطأ]'),
        },
      );
    } finally {
      setCopilotBusy(false);
    }
  };

  const scoreColor = (s: number) =>
    s >= 75 ? 'text-emerald-600 dark:text-emerald-400' :
    s >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';

  if (loadState === 'loading') {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 dark:text-slate-400 gap-2">
        <div className="w-4 h-4 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">{t('جارٍ تحميل الردود…', 'Loading responses…')}</span>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-800 p-5 text-sm text-rose-700 dark:text-rose-400">
        {t('فشل تحميل الردود.', 'Failed to load responses.')}
      </div>
    );
  }

  return (
    <div className="space-y-5" dir={ar ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 tracking-tight">
            {t('مركز الاستجابات', 'Responses Center')}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {t(`${responses.length} استبيان بيئة · ${empResponses.length} تقييم موظف`, `${responses.length} env surveys · ${empResponses.length} employee assessments`)}
          </p>
        </div>
        {activeTab === 'env' && responses.length > 0 && (
          <button className="hw-btn hw-btn-primary hw-btn-sm" disabled={exportingAll} onClick={exportAll}>
            {exportingAll ? t('جارٍ التصدير…', 'Exporting…') : t('تصدير تقرير شامل', 'Export Full Report')}
          </button>
        )}
      </div>

      {/* Tab selector */}
      <div className="hw-tabs-pill self-start">
        {([
          { key: 'env' as const, arLabel: `استبيانات البيئة (${responses.length})`, enLabel: `Env. Surveys (${responses.length})` },
          { key: 'employee' as const, arLabel: `تقييم الموظفين (${empResponses.length})`, enLabel: `Employee Assessments (${empResponses.length})` },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`hw-tab-pill${activeTab === tab.key ? ' hw-tab-active' : ''}`}>
            {ar ? tab.arLabel : tab.enLabel}
          </button>
        ))}
      </div>

      {/* EMPLOYEE RESPONSES TAB */}
      {activeTab === 'employee' && (
        <div className="space-y-2">
          {empLoadState === 'loading' && (
            <div className="flex items-center justify-center h-32 gap-2 text-slate-500 dark:text-slate-400">
              <div className="w-4 h-4 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t('جارٍ التحميل…', 'Loading…')}</span>
            </div>
          )}
          {empLoadState === 'error' && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-800 p-4 text-sm text-rose-700 dark:text-rose-400">
              {t('فشل التحميل.', 'Load failed.')}
            </div>
          )}
          {empLoadState === 'done' && empResponses.length === 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-8 text-center">
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{t('لا توجد تقييمات موظفين بعد.', 'No employee assessments yet.')}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{t('أطلق بوابة تقييم الموظفين من مرحلة المشاريع.', 'Launch an employee assessment portal from the Projects stage.')}</p>
            </div>
          )}
          {empLoadState === 'done' && empResponses.map(emp => (
            <div key={emp.id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
              <button
                className="w-full flex items-start justify-between px-4 py-3 gap-3 hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors duration-150 text-start"
                onClick={() => setEmpExpanded(prev => prev === emp.id ? null : emp.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{emp.employeeName}</span>
                    <span className="text-xs text-slate-400 dark:text-slate-500">{emp.employeeEmail}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mt-1.5">
                    <span className={badge('info')}>{emp.jobTitle}</span>
                    {emp.department && <span className={badge('neutral')}>{emp.department}</span>}
                    <span className="text-xs text-slate-400">{emp.submittedAt.slice(0, 10)}</span>
                    {emp.completedInSeconds && (
                      <span className="text-xs text-slate-400">{Math.round(emp.completedInSeconds / 60)} {t('دقيقة', 'min')}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={badge(emp.competencyAnswers?.length ? 'success' : 'neutral')}>
                    {emp.competencyAnswers?.length ?? 0} {t('سؤال', 'Qs')}
                  </span>
                  <span className={badge(emp.workplaceAnswers ? 'success' : 'neutral')}>
                    {emp.workplaceAnswers ? t('بيئة', 'Env') : t('بدون بيئة', 'No env')}
                  </span>
                  <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-150 ${empExpanded === emp.id ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4l4 4 4-4"/></svg>
                </div>
              </button>
              {empExpanded === emp.id && (
                <div className="border-t border-slate-100 dark:border-slate-700 px-4 pb-4 pt-3 space-y-4 bg-[#F7FAFB] dark:bg-slate-800/30">
                  {/* Competency Q&A */}
                  {emp.questions && emp.competencyAnswers && emp.questions.length > 0 && (
                    <div>
                      <h5 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                        {t('إجابات الجدارات', 'Competency Answers')}
                      </h5>
                      <div className="divide-y divide-slate-100 dark:divide-slate-700 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                        {emp.questions.map((q, i) => {
                          const ans = emp.competencyAnswers?.find(a => a.questionIndex === i);
                          return (
                            <div key={i} className="px-3 py-2.5">
                              <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5">
                                <span className="tabular-nums text-slate-400 me-1">{i + 1}.</span>{q.questionText}
                              </p>
                              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed ps-4">
                                {ans?.selectedAnswer || <span className="italic text-slate-400">{t('لم يُجَب', 'Not answered')}</span>}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {/* Work environment answers */}
                  {emp.workplaceAnswers && (
                    <div>
                      <h5 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                        {t('استبيان بيئة العمل', 'Work Environment Survey')}
                      </h5>
                      <div className="divide-y divide-slate-100 dark:divide-slate-700 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                        {Object.entries(emp.workplaceAnswers).filter(([k]) => k !== 'followUps').map(([key, val]) => (
                          <div key={key} className="px-3 py-2.5 grid grid-cols-[auto_1fr] gap-x-3">
                            <p className="text-[10px] font-semibold text-slate-400 capitalize pt-0.5 whitespace-nowrap">{key.replace(/([A-Z])/g, ' $1').trim()}</p>
                            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{val as string}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* N7 — unified report export */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => exportEmp(emp, 'docx')}
                      disabled={empExporting === `${emp.id}:docx`}
                      className="hw-btn hw-btn-primary hw-btn-sm disabled:opacity-50"
                    >
                      {empExporting === `${emp.id}:docx` ? t('جارٍ…', '…') : t('تقرير موحّد Word', 'Unified Word')}
                    </button>
                    <button
                      onClick={() => exportEmp(emp, 'pdf')}
                      disabled={empExporting === `${emp.id}:pdf`}
                      className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-50"
                    >
                      {empExporting === `${emp.id}:pdf` ? t('جارٍ…', '…') : t('تقرير موحّد PDF', 'Unified PDF')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ENV SURVEY TAB — existing content continues below */}
      {activeTab !== 'employee' && (
      <React.Fragment>

      {/* Response cards */}
      {responses.length > 0 && (
        <div className="space-y-2">
          {responses.map((r, i) => {
            const expanded = expandedId === r.id;
            const aState = analysisState[r.id] ?? (r.analysis ? 'done' : 'idle');
            const analysis = analyses[r.id];

            return (
              <div key={r.id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                {/* Card header */}
                <button
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-start hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors duration-150"
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 h-6 rounded-md bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 flex items-center justify-center text-[10px] font-bold tabular-nums shrink-0">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 dark:text-slate-100 text-sm leading-snug">
                        {r.respondentName || t(`مشارك ${i + 1}`, `Respondent ${i + 1}`)}
                      </div>
                      <div className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                        {new Date(r.submittedAt).toLocaleDateString(ar ? 'ar-SA' : 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {analysis && (
                      <span className={`text-sm font-bold tabular-nums ${scoreColor(analysis.overallScore)}`}>
                        {analysis.overallScore}<span className="text-xs font-normal text-slate-400">/100</span>
                      </span>
                    )}
                    <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4l4 4 4-4"/></svg>
                  </div>
                </button>

                {/* Expanded body */}
                {expanded && (
                  <div className="px-4 pb-4 space-y-4 border-t border-slate-100 dark:border-slate-700/60 pt-3 bg-[#F7FAFB] dark:bg-slate-800/20">
                    {/* Answers summary — hairline table style */}
                    <div className="divide-y divide-slate-100 dark:divide-slate-700 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                      {SURVEY_FIELDS.map(f => {
                        const val = (r.answers as any)[f.key];
                        if (!val) return null;
                        return (
                          <div key={f.key} className="px-3 py-2.5 grid grid-cols-[140px_1fr] gap-x-3 sm:grid-cols-[160px_1fr]">
                            <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 pt-0.5 uppercase tracking-wide truncate">
                              {f.icon} {ar ? f.ar : f.en}
                            </div>
                            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-3">
                              {val}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    {/* AI Analysis */}
                    {aState === 'idle' && (
                      <button className="hw-btn hw-btn-subtle hw-btn-sm" onClick={() => analyzeOne(r)}>
                        {t('تحليل هذا الرد بالذكاء الاصطناعي', 'Analyze with AI')}
                      </button>
                    )}
                    {aState === 'loading' && (
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <div className="w-3.5 h-3.5 border border-emerald-600 border-t-transparent rounded-full animate-spin" />
                        {t('جارٍ التحليل…', 'Analyzing…')}
                      </div>
                    )}
                    {aState === 'error' && (
                      <div className="text-xs text-rose-600 dark:text-rose-400 flex items-center gap-2">
                        <span>{t('فشل التحليل.', 'Analysis failed.')}</span>
                        <button className="underline underline-offset-2 hover:text-rose-700" onClick={() => analyzeOne(r)}>
                          {t('إعادة المحاولة', 'Retry')}
                        </button>
                      </div>
                    )}
                    {aState === 'done' && analysis && (
                      <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
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
                                    <span className="text-rose-400 shrink-0 mt-0.5">–</span><span>{c}</span>
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
                      </div>
                    )}

                    {/* Per-response export */}
                    <div className="flex gap-2">
                      <button
                        className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-50"
                        disabled={exportingId === r.id}
                        onClick={() => exportOne(r)}
                      >
                        {exportingId === r.id ? t('جارٍ التصدير…', 'Exporting…') : t('تصدير هذا الرد (DOCX)', 'Export Response (DOCX)')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Copilot */}
      {responses.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                {t('كوبايلوت الاستبيانات', 'Survey Copilot')}
              </h4>
              <span className={badge('neutral')}>{t(`${responses.length} رد`, `${responses.length} responses`)}</span>
            </div>
          </div>
          <div className="px-5 py-4 space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {t(
                'اسألني عن أي شيء في الردود — مثلاً: "اديني تقرير عن أبرز التحديات" أو "ما أكثر الأسئلة سلبية؟"',
                'Ask me anything about the responses — e.g. "give me a report on the main challenges"',
              )}
            </p>
            <div className="flex gap-2">
              <input
                className={`${UI.input} flex-1 text-sm`}
                placeholder={t('اكتب سؤالك هنا…', 'Type your question here…')}
                value={copilotQ}
                onChange={e => setCopilotQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askCopilot(); } }}
                disabled={copilotBusy}
              />
              <button
                className={`${UI.btnPrimary} disabled:opacity-50`}
                disabled={copilotBusy || !copilotQ.trim()}
                onClick={askCopilot}
              >
                {copilotBusy ? '…' : t('إرسال', 'Send')}
              </button>
            </div>
            {copilotA && (
              <div className="rounded-md border border-slate-100 dark:border-slate-700 bg-[#F7FAFB] dark:bg-slate-800/50 p-4">
                <pre className="whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-200 font-sans leading-relaxed">{copilotA}</pre>
              </div>
            )}
          </div>
        </div>
      )}
      </React.Fragment>
      )}
    </div>
  );
};

export default ResponsesCenter;
