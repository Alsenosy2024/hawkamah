import React, { useMemo, useState } from 'react';
import type { AdminSettings, Language, GovProject } from '../types';
import { compileChunkContext, activeProjectSurvey } from '../services/governanceService';
import { runSurveySimulation } from '../services/surveySimulation';
import {
  buildAggregateArtifact, buildSurveyDefinitionArtifact, buildSingleResponseArtifact,
  type SurveyResponseRecord,
} from '../services/surveyReport';
import { exportDocx } from '../services/exportService';
import { useToast } from './ToastProvider';

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
  const [onlySimulated, setOnlySimulated] = useState(false);
  const responses: SurveyResponseRecord[] = useMemo(() => {
    return (allAssessments || []).filter((a: any) => {
      if (!a?.workplaceAnswers) return false;
      if (onlySimulated && !a.simulated) return false;
      // scope to active tenant when tagged; untagged (legacy real) shown too
      if (a.tenantId && a.tenantId !== tenantId) return false;
      return true;
    });
  }, [allAssessments, onlySimulated, tenantId]);

  // ---- simulation ----
  const [count, setCount] = useState(20);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
  const acRef = React.useRef<AbortController | null>(null);

  const runSim = async () => {
    if (running) return;
    setRunning(true);
    setProgress({ msg: ar ? 'بدء…' : 'Starting…', done: 0, total: count });
    const ac = new AbortController(); acRef.current = ac;
    try {
      let chunkContext = '';
      try { chunkContext = await compileChunkContext(tenantId, 8000); } catch { /* optional */ }
      const res = await runSurveySimulation(
        { count, tenantId, companyName, orgContext, chunkContext, language, analyze: true, signal: ac.signal },
        (msg, done, total) => setProgress({ msg, done, total }),
      );
      toast.success(ar ? `اكتملت المحاكاة: ${res.saved} استجابة محفوظة (${res.analyzed} محلَّلة).`
                       : `Simulation done: ${res.saved} saved (${res.analyzed} analyzed).`);
      onRefreshAssessments?.();
    } catch (e: any) {
      toast.error((ar ? 'فشل المحاكاة: ' : 'Simulation failed: ') + (e?.message || e));
    } finally {
      setRunning(false); setProgress(null); acRef.current = null;
    }
  };
  const cancelSim = () => { acRef.current?.abort(); };

  // ---- exports ----
  const [busy, setBusy] = useState<string | null>(null);
  const guard = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); }
    catch (e: any) { toast.error((ar ? 'فشل التصدير: ' : 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(null); }
  };

  const exportAggregate = (mode: 'full' | 'brief') => guard(mode, async () => {
    if (!responses.length) { toast.error(ar ? 'لا توجد استجابات للتصدير.' : 'No responses.'); return; }
    const art = await buildAggregateArtifact({ records: responses, companyName, mode, language, orgContext });
    await exportDocx(art, exportOpts);
    toast.success(ar ? 'تم تصدير التقرير.' : 'Report exported.');
  });

  const exportSurveyDef = () => guard('survey', async () => {
    const art = buildSurveyDefinitionArtifact(survey, companyName, language);
    await exportDocx(art, exportOpts);
    toast.success(ar ? 'تم تصدير نموذج الاستبيان.' : 'Survey exported.');
  });

  const exportOne = (rec: SurveyResponseRecord) => guard(`one_${rec.id}`, async () => {
    const art = buildSingleResponseArtifact(rec, language);
    await exportDocx(art, exportOpts);
    toast.success(ar ? 'تم تصدير الرد.' : 'Response exported.');
  });

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
      <div className="hw-card p-3.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold text-slate-400 me-0.5">
          {ar ? 'التصدير' : 'Export'}
        </span>
        <div className="w-px h-4 bg-slate-200 mx-1" />
        <button disabled={!!busy} onClick={() => exportAggregate('full')}
          className="hw-btn hw-btn-subtle hw-btn-sm disabled:opacity-40">
          {busy === 'full' ? (ar ? 'جارٍ...' : 'Exporting...') : (ar ? 'تقرير مفصّل' : 'Detailed report')}
        </button>
        <button disabled={!!busy} onClick={() => exportAggregate('brief')}
          className="hw-btn hw-btn-primary hw-btn-sm disabled:opacity-40">
          {busy === 'brief' ? (ar ? 'جارٍ...' : 'Exporting...') : (ar ? 'تقرير موجز' : 'Brief report')}
        </button>
        <button disabled={!!busy} onClick={exportSurveyDef}
          className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-40">
          {busy === 'survey' ? (ar ? 'جارٍ...' : 'Exporting...') : (ar ? 'تصدير الاستبيان' : 'Export survey')}
        </button>
        <label className="ms-auto flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 cursor-pointer select-none">
          <input type="checkbox" checked={onlySimulated} onChange={e => setOnlySimulated(e.target.checked)}
            className="rounded-sm border-slate-300 text-emerald-600 focus:ring-emerald-500 focus:ring-offset-0" />
          {ar ? 'المحاكاة فقط' : 'Simulated only'}
        </label>
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
                      <button disabled={!!busy} onClick={() => exportOne(r)}
                        className="hw-btn hw-btn-ghost hw-btn-sm text-[10px] disabled:opacity-40">
                        {busy === `one_${r.id}` ? '...' : (ar ? 'الرد' : 'Resp')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default SurveyLab;
