import React, { useMemo, useState } from 'react';
import type { AdminSettings, Language, GovProject, GeneratedArtifact } from '../types';
import { compileChunkContext, activeProjectSurvey } from '../services/governanceService';
import { runSurveySimulation } from '../services/surveySimulation';
import {
  buildAggregateArtifact, buildSurveyDefinitionArtifact, buildSingleResponseArtifact,
  type SurveyResponseRecord,
} from '../services/surveyReport';
import { exportDocx } from '../services/exportService';
import { artifactToMarkdown } from '../services/canvasDocument';
import DocumentCanvas from './DocumentCanvas';
import { useToast } from './ToastProvider';
import { useArtifactExport } from '../hooks/useArtifactExport';

interface Props {
  language: Language;
  settings: AdminSettings;
  allAssessments: any[];
  onRefreshAssessments?: () => void;
}

const SurveyLab: React.FC<Props> = ({ language, settings, allAssessments, onRefreshAssessments }) => {
  const ar = language === 'ar';
  const toast = useToast();

  const active: GovProject | undefined = settings.clientProfiles?.find(p => p.id === settings.activeClientProfileId);
  const tenantId = settings.activeClientProfileId || 'default';
  const companyName = active?.name || settings.companyName || (ar ? 'الشركة' : 'Company');
  const survey = activeProjectSurvey(settings);

  const orgContext = useMemo(() => {
    const L: string[] = [];
    L.push(`${ar ? 'اسم الشركة' : 'Company'}: ${companyName}`);
    if (active?.industry) L.push(`${ar ? 'القطاع' : 'Sector'}: ${active.industry}`);
    if (active?.specialization) L.push(`${ar ? 'التخصص' : 'Specialization'}: ${active.specialization}`);
    if (active?.description) L.push(`${ar ? 'الوصف' : 'Description'}: ${active.description}`);
    if (active?.vision) L.push(`${ar ? 'الرؤية' : 'Vision'}: ${active.vision}`);
    if (active?.mission) L.push(`${ar ? 'الرسالة' : 'Mission'}: ${active.mission}`);
    return L.join('\n');
  }, [active, companyName, ar]);

  const exportOpts = {
    fontFamily: settings.fontFamily || 'Tajawal',
    companyName: settings.companyName,
    logoUrl: settings.logoUrl,
    language,
  };

  // ---- responses for this tenant (environment surveys) ----
  // [CRITICAL fix] tri-state filter (was a single "simulated only" checkbox) so a
  // consultant can also produce a REAL-only export, not just all-vs-simulated-only.
  // The export itself always discloses the real/simulated split regardless of this
  // filter (see surveyReport.methodologyDisclosure) — this only narrows the pool.
  const [responseFilter, setResponseFilter] = useState<'all' | 'real' | 'simulated'>('all');
  const responses: SurveyResponseRecord[] = useMemo(() => {
    return (allAssessments || []).filter((a: any) => {
      if (!a?.workplaceAnswers) return false;
      if (responseFilter === 'simulated' && !a.simulated) return false;
      if (responseFilter === 'real' && a.simulated) return false;
      // scope to active tenant when tagged; untagged (legacy real) shown too
      if (a.tenantId && a.tenantId !== tenantId) return false;
      return true;
    });
  }, [allAssessments, responseFilter, tenantId]);
  const simulatedInPool = useMemo(() => responses.filter((r: any) => r.simulated).length, [responses]);

  // ---- simulation ----
  const [count, setCount] = useState(20);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
  const acRef = React.useRef<AbortController | null>(null);

  const runSim = async () => {
    if (running) return;
    let chunkContext = '';
    try { chunkContext = await compileChunkContext(tenantId, 8000); } catch { /* optional */ }
    // [MAJOR fix] warn before generating with an empty chunk bank — without it
    // the model invents concrete-sounding company specifics (systems, procedures,
    // challenges) from nothing but the manual company-profile string.
    if (!chunkContext.trim()) {
      const ok = await toast.confirm(
        ar
          ? 'لا توجد مستندات مفهرسة لهذه الشركة — ستكون الشخصيات والإجابات المولَّدة عامة وغير مبنية على واقع شركتك الفعلي (لا سياسات أو أنظمة أو تحديات حقيقية). هل تريد المتابعة؟'
          : 'No indexed documents for this tenant — generated personas and answers will be generic and NOT grounded in your company\'s real specifics (no real policies, systems, or challenges). Continue anyway?',
        { confirmLabel: ar ? 'متابعة' : 'Continue', cancelLabel: ar ? 'إلغاء' : 'Cancel', danger: true },
      );
      if (!ok) return;
    }
    setRunning(true);
    setProgress({ msg: ar ? 'بدء…' : 'Starting…', done: 0, total: count });
    const ac = new AbortController(); acRef.current = ac;
    try {
      const res = await runSurveySimulation(
        { count, tenantId, companyName, orgContext, chunkContext, language, analyze: true, signal: ac.signal },
        (msg, done, total) => setProgress({ msg, done, total }),
      );
      // [MAJOR fix] a total failure now throws (see simulateRespondents), so
      // reaching here with saved < requested means a PARTIAL failure — report
      // it honestly instead of a blanket success toast.
      if (res.saved === 0) {
        toast.error(ar ? 'فشلت المحاكاة: لم يُحفظ أي رد.' : 'Simulation failed: no responses were saved.');
      } else if (res.saved < res.requested) {
        toast.warning(ar
          ? `تم توليد ${res.saved} من ${res.requested} استجابة فقط (${res.analyzed} محلَّلة) — بعض الدفعات فشلت. راجع سجل الأخطاء.`
          : `Only ${res.saved} of ${res.requested} responses were generated (${res.analyzed} analyzed) — some batches failed. Check the console log.`);
      } else {
        toast.success(ar ? `اكتملت المحاكاة: ${res.saved} استجابة محفوظة (${res.analyzed} محلَّلة).`
                         : `Simulation done: ${res.saved} saved (${res.analyzed} analyzed).`);
      }
      onRefreshAssessments?.();
    } catch (e: any) {
      if (e?.message === 'ABORTED') toast.info(ar ? 'تم إلغاء المحاكاة.' : 'Simulation cancelled.');
      else toast.error((ar ? 'فشل المحاكاة: ' : 'Simulation failed: ') + (e?.message || e));
    } finally {
      setRunning(false); setProgress(null); acRef.current = null;
    }
  };
  const cancelSim = () => { acRef.current?.abort(); };

  // ---- exports ----
  const exp = useArtifactExport(language);

  // [MAJOR fix] staged progress + cancel for the (potentially long) aggregate
  // narrative generation — mirrors the AbortController+progress pattern already
  // used above for simulation.
  const [aggProgress, setAggProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
  const aggAcRef = React.useRef<AbortController | null>(null);
  const cancelAggregate = () => { aggAcRef.current?.abort(); };

  const generateAggregate = async (mode: 'full' | 'brief'): Promise<GeneratedArtifact> => {
    const ac = new AbortController(); aggAcRef.current = ac;
    let chunkContext = '';
    try { chunkContext = await compileChunkContext(tenantId, 8000); } catch { /* optional */ }
    try {
      return await buildAggregateArtifact({
        records: responses, companyName, mode, language, orgContext, chunkContext,
        signal: ac.signal,
        onPhase: (msg, done, total) => setAggProgress({ msg, done, total }),
      });
    } finally {
      setAggProgress(null); aggAcRef.current = null;
    }
  };

  const exportAggregate = (mode: 'full' | 'brief') => exp.run(mode, async () => {
    if (!responses.length) { toast.error(ar ? 'لا توجد استجابات للتصدير.' : 'No responses.'); return; }
    const art = await generateAggregate(mode);
    await exportDocx(art, exportOpts);
  }, { exclusive: true, successMessage: ar ? 'تم تصدير التقرير.' : 'Report exported.' });

  // [MAJOR fix] canvas preview/edit affordance — the SAME openArtifactInCanvas
  // pattern GovernanceCenter uses for charter/risk-register/roadmap artifacts,
  // so an AI-authored survey narrative gets an in-app preview/edit step before
  // being finalized as a downloadable file. Direct export (above) stays available.
  const [canvasArt, setCanvasArt] = useState<GeneratedArtifact | null>(null);
  const openAggregateInCanvas = (mode: 'full' | 'brief') => exp.run(`canvas_${mode}`, async () => {
    if (!responses.length) { toast.error(ar ? 'لا توجد استجابات للتصدير.' : 'No responses.'); return; }
    const art = await generateAggregate(mode);
    setCanvasArt(art);
  }, { exclusive: true });
  const canvasMarkdown = useMemo(() => (canvasArt ? artifactToMarkdown(canvasArt) : ''), [canvasArt]);
  const saveCanvasArtHtml = (html: string) => {
    setCanvasArt(prev => (prev ? { ...prev, canvasHtml: html } : prev));
  };

  const exportSurveyDef = () => exp.run('survey', async () => {
    const art = buildSurveyDefinitionArtifact(survey, companyName, language);
    await exportDocx(art, exportOpts);
  }, { exclusive: true, successMessage: ar ? 'تم تصدير نموذج الاستبيان.' : 'Survey exported.' });

  const exportOne = (rec: SurveyResponseRecord) => exp.run(`one_${rec.id}`, async () => {
    const art = buildSingleResponseArtifact(rec, language);
    await exportDocx(art, exportOpts);
  }, { exclusive: true, successMessage: ar ? 'تم تصدير الرد.' : 'Response exported.' });

  const sentBadge = (s?: string) => {
    const map: Record<string, string> = {
      positive: 'hw-badge-success',
      neutral: 'hw-badge-neutral',
      negative: 'hw-badge-danger',
    };
    const lbl: Record<string, string> = ar
      ? { positive: 'راضٍ', neutral: 'محايد', negative: 'ناقد' }
      : { positive: 'positive', neutral: 'neutral', negative: 'negative' };
    const cls = map[s || ''] || 'hw-badge-neutral';
    return <span className={cls}>{lbl[s || ''] || (s || '—')}</span>;
  };

  return (
    <div className="space-y-4" dir={ar ? 'rtl' : 'ltr'}>
      {/* header */}
      <div className="hw-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-slate-900 text-base leading-snug">
              {ar ? 'مختبر الاستبيانات والتقارير' : 'Survey Lab & Reports'}
            </h3>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              {ar
                ? `الشركة النشطة: ${companyName} — حاكِ استبياناً يملؤه عدد من الموظفين الافتراضيين ثم استخرج التقارير.`
                : `Active company: ${companyName} — simulate a survey filled by synthetic employees, then export reports.`}
            </p>
          </div>
          <span className="hw-badge-brand shrink-0">{companyName}</span>
        </div>
      </div>

      {/* simulation controls */}
      <div className="hw-card p-5 space-y-4">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          {ar ? 'محاكاة' : 'Simulation'}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
              {ar ? 'عدد المشاركين' : 'Respondents'}
            </label>
            <div className="flex gap-1.5">
              {[10, 20, 30].map(n => (
                <button key={n} onClick={() => setCount(n)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-colors duration-150 ${
                    count === n
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}>
                  {n}
                </button>
              ))}
              <input type="number" min={1} max={60} value={count}
                onChange={e => setCount(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                className="hw-input w-20 text-xs" />
            </div>
          </div>
          {!running ? (
            <button onClick={runSim}
              className="hw-btn hw-btn-primary hw-btn-sm">
              {ar ? 'تشغيل المحاكاة' : 'Run simulation'}
            </button>
          ) : (
            <button onClick={cancelSim}
              className="hw-btn hw-btn-danger hw-btn-sm">
              {ar ? 'إيقاف' : 'Stop'}
            </button>
          )}
        </div>
        {progress && (
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-[11px] font-semibold text-slate-500">
              <span>{progress.msg}</span>
              <span className="tabular-nums">{progress.done}/{progress.total}</span>
            </div>
            <div className="hw-progress">
              <div className="hw-progress-bar transition-all duration-200"
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* export toolbar */}
      <div className="hw-card p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-slate-400 me-0.5">
            {ar ? 'التصدير' : 'Export'}
          </span>
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button disabled={exp.anyBusy} onClick={() => exportAggregate('full')}
            className="hw-btn hw-btn-subtle hw-btn-sm disabled:opacity-40">
            {exp.isBusy('full') ? (ar ? 'جارٍ...' : 'Exporting...') : (ar ? 'تقرير مفصّل' : 'Detailed report')}
          </button>
          <button disabled={exp.anyBusy} onClick={() => openAggregateInCanvas('full')} title={ar ? 'افتح التقرير المفصّل في الكانفس للتحرير والتصدير (Word / PDF / PowerPoint / Excel)' : 'Open the detailed report in the canvas to edit and export (Word / PDF / PowerPoint / Excel)'}
            className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-40 !px-2">
            {exp.isBusy('canvas_full') ? '...' : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            )}
          </button>
          <button disabled={exp.anyBusy} onClick={() => exportAggregate('brief')}
            className="hw-btn hw-btn-primary hw-btn-sm disabled:opacity-40">
            {exp.isBusy('brief') ? (ar ? 'جارٍ...' : 'Exporting...') : (ar ? 'تقرير موجز' : 'Brief report')}
          </button>
          <button disabled={exp.anyBusy} onClick={() => openAggregateInCanvas('brief')} title={ar ? 'افتح التقرير الموجز في الكانفس للتحرير والتصدير (Word / PDF / PowerPoint / Excel)' : 'Open the brief report in the canvas to edit and export (Word / PDF / PowerPoint / Excel)'}
            className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-40 !px-2">
            {exp.isBusy('canvas_brief') ? '...' : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            )}
          </button>
          <button disabled={exp.anyBusy} onClick={exportSurveyDef}
            className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-40">
            {exp.isBusy('survey') ? (ar ? 'جارٍ...' : 'Exporting...') : (ar ? 'تصدير الاستبيان' : 'Export survey')}
          </button>
          {aggProgress && (
            <button onClick={cancelAggregate} className="hw-btn hw-btn-danger hw-btn-sm">
              {ar ? 'إيقاف' : 'Stop'}
            </button>
          )}
          {/* [CRITICAL fix] tri-state filter (was "simulated only" checkbox) — lets a
              consultant scope the export pool to real-only, not just all-vs-simulated. */}
          <div className="ms-auto flex items-center gap-1 rounded-md border border-slate-200 p-0.5">
            {([
              { key: 'all' as const, ar: 'الكل', en: 'All' },
              { key: 'real' as const, ar: 'حقيقي فقط', en: 'Real only' },
              { key: 'simulated' as const, ar: 'محاكاة فقط', en: 'Simulated only' },
            ]).map(opt => (
              <button key={opt.key} onClick={() => setResponseFilter(opt.key)}
                className={`px-2 py-1 rounded-sm text-[10px] font-bold transition-colors duration-150 ${
                  responseFilter === opt.key ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:bg-slate-50'
                }`}>
                {ar ? opt.ar : opt.en}
              </button>
            ))}
          </div>
        </div>
        {aggProgress && (
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-[11px] font-semibold text-slate-500">
              <span>{aggProgress.msg}</span>
              {aggProgress.total > 0 && <span className="tabular-nums">{aggProgress.done}/{aggProgress.total}</span>}
            </div>
            {aggProgress.total > 0 && (
              <div className="hw-progress">
                <div className="hw-progress-bar transition-all duration-200"
                  style={{ width: `${Math.round((aggProgress.done / aggProgress.total) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {/* [CRITICAL fix] up-front disclosure of the pool the export buttons above
            will actually run over, before the consultant even clicks export. */}
        {simulatedInPool > 0 && (
          <p className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
            {ar
              ? `⚠️ يتضمن نطاق التصدير الحالي ${simulatedInPool} رداً محاكى بالذكاء الاصطناعي من إجمالي ${responses.length}. سيوضّح التقرير المُصدَّر هذه النسبة صراحةً.`
              : `⚠️ The current export scope includes ${simulatedInPool} AI-simulated response(s) out of ${responses.length}. The exported report will disclose this split explicitly.`}
          </p>
        )}
      </div>

      {/* responses table */}
      <div className="hw-card overflow-hidden">
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
            {ar ? 'الاستجابات' : 'Responses'}
          </span>
          <span className="hw-badge-neutral">{responses.length}</span>
        </div>
        {responses.length === 0 ? (
          <div className="text-center py-12 px-4">
            <p className="text-slate-400 text-sm font-semibold">
              {ar ? 'لا توجد استجابات بعد. شغّل المحاكاة.' : 'No responses yet. Run the simulation.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[440px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2.5 text-start text-[10px] font-bold uppercase tracking-wide text-slate-500">{ar ? 'المشارك' : 'Respondent'}</th>
                  <th className="px-3 py-2.5 text-start text-[10px] font-bold uppercase tracking-wide text-slate-500">{ar ? 'الإدارة / المسمى' : 'Dept / Role'}</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">{ar ? 'الاتجاه' : 'Sentiment'}</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">{ar ? 'الرضا' : 'Overall'}</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">ISO</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">EFQM</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">{ar ? 'تصدير' : 'Export'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {responses.map((r: any, idx: number) => (
                  <tr key={r.id || idx} className="hover:bg-slate-50/60 transition-colors duration-100">
                    <td className="px-3 py-2.5 text-start">
                      <div className="font-semibold text-slate-800 text-xs flex items-center gap-1.5">
                        {r.simulated && (
                          <span title={ar ? 'محاكى' : 'simulated'}
                            className="inline-block w-4 h-4 rounded-sm bg-slate-100 text-slate-400 text-[9px] font-bold text-center leading-4">
                            S
                          </span>
                        )}
                        {r.simulated && r.grounded === false && (
                          <span title={ar ? 'شخصية عامة — لم تُبنَ على مستندات الشركة (لم يوجد فهرس مستندات وقت التوليد)' : 'Generic persona — not grounded in company documents (no indexed docs at generation time)'}
                            className="inline-block w-4 h-4 rounded-sm bg-amber-50 text-amber-600 text-[9px] font-bold text-center leading-4">
                            ⚠
                          </span>
                        )}
                        {r.userName || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-start text-xs text-slate-500 font-medium">
                      {r.department ? `${r.department}` : ''}{r.department && r.jobTitle ? ' · ' : ''}{r.jobTitle || ''}
                    </td>
                    <td className="px-3 py-2.5 text-center">{sentBadge(r.sentiment)}</td>
                    <td className="px-3 py-2.5 text-center font-bold text-slate-800 text-xs tabular-nums">
                      {r.envReportData?.overallScore != null ? `${Math.round(r.envReportData.overallScore)}` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center text-xs text-slate-600 tabular-nums">
                      {r.envReportData?.isoComplianceRate != null ? `${Math.round(r.envReportData.isoComplianceRate)}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center text-xs text-slate-600 tabular-nums">
                      {r.envReportData?.efqmExcellenceRate != null ? `${Math.round(r.envReportData.efqmExcellenceRate)}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <button disabled={exp.anyBusy} onClick={() => exportOne(r)}
                        className="hw-btn hw-btn-ghost hw-btn-sm text-[10px] disabled:opacity-40">
                        {exp.isBusy(`one_${r.id}`) ? '...' : (ar ? 'الرد' : 'Resp')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* [MAJOR fix] canvas preview/edit for the aggregate artifact — same
          DocumentCanvas surface GovernanceCenter uses; owns its own Word/PDF/
          PowerPoint/Excel export once open, direct export above stays available. */}
      {canvasArt && (
        <DocumentCanvas
          markdown={canvasMarkdown}
          initialHtml={canvasArt.canvasHtml}
          title={canvasArt.title}
          language={language}
          subtitle={canvasArt.goal || (ar ? 'تقرير استبيان' : 'Survey report')}
          brand={companyName ? `${companyName} · AILIGENT` : 'AILIGENT'}
          date={(ar ? 'بتاريخ ' : 'Dated ') + new Date().toLocaleDateString(ar ? 'ar-EG' : 'en-GB')}
          onClose={() => setCanvasArt(null)}
          onSave={saveCanvasArtHtml}
        />
      )}
    </div>
  );
};

export default SurveyLab;
