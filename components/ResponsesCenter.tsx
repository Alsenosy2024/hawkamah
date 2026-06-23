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
        <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">{t('جارٍ تحميل الردود…', 'Loading responses…')}</span>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className={`${UI.sectionFrame} p-6 text-center text-rose-600 dark:text-rose-400`}>
        {t('فشل تحميل الردود.', 'Failed to load responses.')}
      </div>
    );
  }

  return (
    <div className="space-y-6" dir={ar ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">
            {t('مركز الاستجابات', 'Responses Center')}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t(`${responses.length} استبيان بيئة · ${empResponses.length} تقييم موظف`, `${responses.length} env surveys · ${empResponses.length} employee assessments`)}
          </p>
        </div>
        {activeTab === 'env' && responses.length > 0 && (
          <button className={UI.btnPrimary} disabled={exportingAll} onClick={exportAll}>
            {exportingAll ? t('جارٍ التصدير…', 'Exporting…') : `⬇ ${t('تصدير تقرير شامل', 'Export Full Report')}`}
          </button>
        )}
      </div>

      {/* Tab selector */}
      <div className="hw-tabs-pill self-start flex-wrap">
        {([
          { key: 'env' as const, icon: '🌿', arLabel: `استبيانات البيئة (${responses.length})`, enLabel: `Env. Surveys (${responses.length})` },
          { key: 'employee' as const, icon: '🎯', arLabel: `تقييم الموظفين (${empResponses.length})`, enLabel: `Employee Assessments (${empResponses.length})` },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`hw-tab-pill${activeTab === tab.key ? ' hw-tab-active' : ''}`}>
            <span>{tab.icon}</span> {ar ? tab.arLabel : tab.enLabel}
          </button>
        ))}
      </div>

      {/* EMPLOYEE RESPONSES TAB */}
      {activeTab === 'employee' && (
        <div className="space-y-4">
          {empLoadState === 'loading' && (
            <div className="flex items-center justify-center h-32 gap-2 text-slate-500">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t('جارٍ التحميل…', 'Loading…')}</span>
            </div>
          )}
          {empLoadState === 'error' && (
            <div className={`${UI.sectionFrame} p-6 text-center text-rose-600`}>{t('فشل التحميل.', 'Load failed.')}</div>
          )}
          {empLoadState === 'done' && empResponses.length === 0 && (
            <div className={`${UI.sectionFrame} p-8 text-center text-slate-500`}>
              <div className="text-4xl mb-3">🎯</div>
              <p className="font-medium">{t('لا توجد تقييمات موظفين بعد.', 'No employee assessments yet.')}</p>
              <p className="text-xs mt-1">{t('أطلق بوابة تقييم الموظفين من مرحلة المشاريع.', 'Launch an employee assessment portal from the Projects stage.')}</p>
            </div>
          )}
          {empLoadState === 'done' && empResponses.map(emp => (
            <div key={emp.id} className={`${UI.card} rounded-xl overflow-hidden`}>
              <button
                className="w-full flex items-start justify-between p-4 gap-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors text-start"
                onClick={() => setEmpExpanded(prev => prev === emp.id ? null : emp.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800 dark:text-slate-100 text-sm">{emp.employeeName}</span>
                    <span className="text-xs text-slate-400">{emp.employeeEmail}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mt-1">
                    <span className={badge('info')}>{emp.jobTitle}</span>
                    {emp.department && <span className={badge('neutral')}>{emp.department}</span>}
                    <span className="text-xs text-slate-400">{emp.submittedAt.slice(0, 10)}</span>
                    {emp.completedInSeconds && (
                      <span className="text-xs text-slate-400">⏱ {Math.round(emp.completedInSeconds / 60)} {t('دقيقة', 'min')}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={badge(emp.competencyAnswers?.length ? 'success' : 'neutral')}>
                    {emp.competencyAnswers?.length ?? 0} {t('سؤال', 'Qs')}
                  </span>
                  <span className={badge(emp.workplaceAnswers ? 'success' : 'neutral')}>
                    {emp.workplaceAnswers ? t('✓ بيئة', '✓ Env') : t('بدون بيئة', 'No env')}
                  </span>
                  <span className="text-slate-400 text-sm">{empExpanded === emp.id ? '▲' : '▼'}</span>
                </div>
              </button>
              {empExpanded === emp.id && (
                <div className="border-t border-slate-100 dark:border-slate-700 p-4 space-y-4 bg-slate-50/50 dark:bg-slate-800/30">
                  {/* Competency Q&A */}
                  {emp.questions && emp.competencyAnswers && emp.questions.length > 0 && (
                    <div>
                      <h5 className="font-bold text-xs text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
                        {t('إجابات الجدارات', 'Competency Answers')}
                      </h5>
                      <div className="space-y-3">
                        {emp.questions.map((q, i) => {
                          const ans = emp.competencyAnswers?.find(a => a.questionIndex === i);
                          return (
                            <div key={i} className="bg-white dark:bg-slate-800 rounded-xl p-3 border border-slate-100 dark:border-slate-700">
                              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                                {i + 1}. {q.questionText}
                              </p>
                              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                                {ans?.selectedAnswer || t('لم يُجَب', 'Not answered')}
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
                      <h5 className="font-bold text-xs text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
                        {t('استبيان بيئة العمل', 'Work Environment Survey')}
                      </h5>
                      <div className="space-y-2">
                        {Object.entries(emp.workplaceAnswers).filter(([k]) => k !== 'followUps').map(([key, val]) => (
                          <div key={key} className="bg-white dark:bg-slate-800 rounded-xl p-3 border border-slate-100 dark:border-slate-700">
                            <p className="text-xs font-semibold text-slate-500 mb-1 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</p>
                            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{val as string}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* N7 — unified report export (competency + work-environment in ONE file) */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => exportEmp(emp, 'docx')}
                      disabled={empExporting === `${emp.id}:docx`}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
                    >
                      {empExporting === `${emp.id}:docx` ? t('جارٍ…', '…') : t('⬇ تقرير موحّد Word', '⬇ Unified Word')}
                    </button>
                    <button
                      onClick={() => exportEmp(emp, 'pdf')}
                      disabled={empExporting === `${emp.id}:pdf`}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50 transition"
                    >
                      {empExporting === `${emp.id}:pdf` ? t('جارٍ…', '…') : t('⬇ تقرير موحّد PDF', '⬇ Unified PDF')}
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
        <div className="space-y-3">
          {responses.map((r, i) => {
            const expanded = expandedId === r.id;
            const aState = analysisState[r.id] ?? (r.analysis ? 'done' : 'idle');
            const analysis = analyses[r.id];

            return (
              <div key={r.id} className={`${UI.card} rounded-xl overflow-hidden`}>
                {/* Card header */}
                <button
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-start hover:bg-slate-50 dark:hover:bg-slate-800/40 transition"
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 flex items-center justify-center text-sm font-bold shrink-0">
                      {i + 1}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 dark:text-slate-100 text-sm">
                        {r.respondentName || t(`مشارك ${i + 1}`, `Respondent ${i + 1}`)}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {new Date(r.submittedAt).toLocaleDateString(ar ? 'ar-SA' : 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {analysis && (
                      <span className={`text-sm font-bold ${scoreColor(analysis.overallScore)}`}>
                        {analysis.overallScore}/100
                      </span>
                    )}
                    <span className="text-slate-400 text-xs">{expanded ? '▲' : '▼'}</span>
                  </div>
                </button>

                {/* Expanded body */}
                {expanded && (
                  <div className="px-4 pb-4 space-y-4 border-t border-slate-100 dark:border-slate-700/50 pt-4">
                    {/* Answers summary */}
                    <div className="grid sm:grid-cols-2 gap-3">
                      {SURVEY_FIELDS.map(f => {
                        const val = (r.answers as any)[f.key];
                        if (!val) return null;
                        return (
                          <div key={f.key} className="space-y-1">
                            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                              {f.icon} {ar ? f.ar : f.en}
                            </div>
                            <p className="text-xs text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 rounded p-2 line-clamp-3">
                              {val}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    {/* AI Analysis */}
                    {aState === 'idle' && (
                      <button className={`${UI.btnSubtle} text-xs`} onClick={() => analyzeOne(r)}>
                        🔍 {t('حلّل هذا الرد بالذكاء الاصطناعي', 'Analyze this response with AI')}
                      </button>
                    )}
                    {aState === 'loading' && (
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <div className="w-4 h-4 border border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        {t('جارٍ التحليل…', 'Analyzing…')}
                      </div>
                    )}
                    {aState === 'error' && (
                      <div className="text-xs text-rose-500">
                        {t('فشل التحليل.', 'Analysis failed.')}
                        <button className="ms-2 underline" onClick={() => analyzeOne(r)}>
                          {t('إعادة المحاولة', 'Retry')}
                        </button>
                      </div>
                    )}
                    {aState === 'done' && analysis && (
                      <div className={`${UI.sectionFrame} p-4 space-y-3`}>
                        <div className="flex items-center gap-4 flex-wrap">
                          <div className="text-center">
                            <div className={`text-2xl font-black ${scoreColor(analysis.overallScore)}`}>
                              {analysis.overallScore}
                            </div>
                            <div className="text-xs text-slate-500">{t('النتيجة الإجمالية', 'Overall score')}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{analysis.isoComplianceRate}%</div>
                            <div className="text-xs text-slate-500">ISO 9001</div>
                          </div>
                          <div className="text-center">
                            <div className="text-lg font-bold text-purple-600 dark:text-purple-400">{analysis.efqmExcellenceRate}%</div>
                            <div className="text-xs text-slate-500">EFQM</div>
                          </div>
                          <span className={badge('info')}>{analysis.infrastructureRating}</span>
                        </div>
                        <p className="text-sm text-slate-700 dark:text-slate-300">{analysis.currentStatusSummary}</p>
                        {analysis.keyChallenges?.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-slate-500 mb-1">{t('التحديات الرئيسية', 'Key challenges')}</div>
                            <ul className="space-y-1">
                              {analysis.keyChallenges.map((c, ci) => (
                                <li key={ci} className="text-xs text-slate-600 dark:text-slate-300 flex gap-1.5">
                                  <span className="text-rose-400 shrink-0">•</span>{c}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {analysis.recommendationsForManagement?.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-slate-500 mb-1">{t('توصيات للإدارة', 'Recommendations')}</div>
                            <ul className="space-y-1">
                              {analysis.recommendationsForManagement.map((rec, ri) => (
                                <li key={ri} className="text-xs text-slate-600 dark:text-slate-300 flex gap-1.5">
                                  <span className="text-emerald-400 shrink-0">✓</span>{rec}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Per-response export */}
                    <div className="flex gap-2">
                      <button
                        className={`${UI.btnGhost} text-xs`}
                        disabled={exportingId === r.id}
                        onClick={() => exportOne(r)}
                      >
                        {exportingId === r.id ? t('جارٍ التصدير…', 'Exporting…') : `⬇ ${t('تصدير هذا الرد (DOCX)', 'Export this response (DOCX)')}`}
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
        <div className={`${UI.sectionFrame} p-5 space-y-4`}>
          <div className="flex items-center gap-2">
            <span className="text-lg">🤖</span>
            <h4 className="font-bold text-slate-800 dark:text-slate-100 text-sm">
              {t('كوبايلوت الاستبيانات', 'Survey Copilot')}
            </h4>
            <span className={badge('info')}>{t(`${responses.length} رد`, `${responses.length} responses`)}</span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
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
              className={UI.btnPrimary}
              disabled={copilotBusy || !copilotQ.trim()}
              onClick={askCopilot}
            >
              {copilotBusy ? '…' : t('إرسال', 'Send')}
            </button>
          </div>
          {copilotA && (
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4">
              <pre className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200 font-sans">{copilotA}</pre>
            </div>
          )}
        </div>
      )}
      </React.Fragment>
      )}
    </div>
  );
};

export default ResponsesCenter;
