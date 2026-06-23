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
      positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      neutral: 'bg-slate-100 text-slate-600 border-slate-200',
      negative: 'bg-rose-50 text-rose-700 border-rose-200',
    };
    const lbl: Record<string, string> = ar
      ? { positive: 'راضٍ', neutral: 'محايد', negative: 'ناقد' }
      : { positive: 'positive', neutral: 'neutral', negative: 'negative' };
    const cls = map[s || ''] || 'bg-slate-100 text-slate-500 border-slate-200';
    return <span className={`inline-block px-2 py-0.5 text-[9px] font-black rounded-full border ${cls}`}>{lbl[s || ''] || (s || '—')}</span>;
  };

  return (
    <div className="space-y-5" dir={ar ? 'rtl' : 'ltr'}>
      {/* header */}
      <div className="bg-gradient-to-l from-emerald-50 to-white border border-emerald-100 rounded-2xl p-5">
        <h3 className="font-black text-emerald-900 text-base flex items-center gap-2">
          🧪 {ar ? 'مختبر الاستبيانات والتقارير' : 'Survey Lab & Reports'}
        </h3>
        <p className="text-xs text-slate-500 mt-1 font-semibold">
          {ar ? `الشركة النشطة: ${companyName} — حاكِ استبياناً يملؤه عدد من الموظفين الافتراضيين ثم استخرج التقارير.`
              : `Active company: ${companyName} — simulate a survey filled by synthetic employees, then export reports.`}
        </p>
      </div>

      {/* simulation controls */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">{ar ? 'عدد المشاركين' : 'Respondents'}</label>
            <div className="flex gap-1.5">
              {[10, 20, 30].map(n => (
                <button key={n} onClick={() => setCount(n)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-black border transition ${count === n ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>
                  {n}
                </button>
              ))}
              <input type="number" min={1} max={60} value={count}
                onChange={e => setCount(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                className="w-20 px-2 py-1.5 rounded-lg text-xs font-bold border border-slate-200" />
            </div>
          </div>
          {!running ? (
            <button onClick={runSim}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs rounded-xl shadow-sm">
              ▶️ {ar ? 'تشغيل المحاكاة' : 'Run simulation'}
            </button>
          ) : (
            <button onClick={cancelSim}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-black text-xs rounded-xl shadow-sm">
              ⏹️ {ar ? 'إيقاف' : 'Stop'}
            </button>
          )}
        </div>
        {progress && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] font-bold text-slate-500">
              <span>{progress.msg}</span><span>{progress.done}/{progress.total}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* export toolbar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-black text-slate-500 me-1">{ar ? 'التصدير:' : 'Export:'}</span>
        <button disabled={!!busy} onClick={() => exportAggregate('full')}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white font-black text-[11px] rounded-lg disabled:opacity-50">
          📊 {busy === 'full' ? (ar ? 'جارٍ…' : '…') : (ar ? 'تقرير مفصّل' : 'Detailed report')}
        </button>
        <button disabled={!!busy} onClick={() => exportAggregate('brief')}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white font-black text-[11px] rounded-lg disabled:opacity-50">
          📝 {busy === 'brief' ? (ar ? 'جارٍ…' : '…') : (ar ? 'تقرير موجز' : 'Brief report')}
        </button>
        <button disabled={!!busy} onClick={exportSurveyDef}
          className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-black text-[11px] rounded-lg disabled:opacity-50">
          📋 {busy === 'survey' ? (ar ? 'جارٍ…' : '…') : (ar ? 'تصدير الاستبيان' : 'Export survey')}
        </button>
        <label className="ms-auto flex items-center gap-1.5 text-[11px] font-bold text-slate-500 cursor-pointer">
          <input type="checkbox" checked={onlySimulated} onChange={e => setOnlySimulated(e.target.checked)} />
          {ar ? 'المحاكاة فقط' : 'Simulated only'}
        </label>
      </div>

      {/* responses table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-[11px] font-black text-slate-500">
          {ar ? `الاستجابات (${responses.length})` : `Responses (${responses.length})`}
        </div>
        {responses.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm font-semibold">
            {ar ? 'لا توجد استجابات بعد — شغّل المحاكاة.' : 'No responses yet — run the simulation.'}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[440px]">
            <table className="w-full text-sm">
              <thead className="text-[10px] font-black uppercase bg-slate-100 text-slate-500 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-start">{ar ? 'المشارك' : 'Respondent'}</th>
                  <th className="px-3 py-2 text-start">{ar ? 'الإدارة/المسمى' : 'Dept/Role'}</th>
                  <th className="px-3 py-2 text-center">{ar ? 'الاتجاه' : 'Sentiment'}</th>
                  <th className="px-3 py-2 text-center">{ar ? 'الرضا' : 'Overall'}</th>
                  <th className="px-3 py-2 text-center">ISO</th>
                  <th className="px-3 py-2 text-center">EFQM</th>
                  <th className="px-3 py-2 text-center">{ar ? 'تصدير' : 'Export'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {responses.map((r: any, idx: number) => (
                  <tr key={r.id || idx} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2 text-start">
                      <div className="font-bold text-slate-800 text-xs flex items-center gap-1.5">
                        {r.simulated && <span title="simulated">🤖</span>}{r.userName || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-start text-xs text-slate-600 font-semibold">
                      {r.department ? `${r.department}` : ''}{r.department && r.jobTitle ? ' · ' : ''}{r.jobTitle || ''}
                    </td>
                    <td className="px-3 py-2 text-center">{sentBadge(r.sentiment)}</td>
                    <td className="px-3 py-2 text-center font-black text-emerald-600 text-xs">
                      {r.envReportData?.overallScore != null ? `${Math.round(r.envReportData.overallScore)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-xs text-slate-600">{r.envReportData?.isoComplianceRate != null ? `${Math.round(r.envReportData.isoComplianceRate)}%` : '—'}</td>
                    <td className="px-3 py-2 text-center text-xs text-slate-600">{r.envReportData?.efqmExcellenceRate != null ? `${Math.round(r.envReportData.efqmExcellenceRate)}%` : '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <button disabled={!!busy} onClick={() => exportOne(r)}
                        className="px-2 py-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-black text-[10px] rounded-lg disabled:opacity-50">
                        📄 {busy === `one_${r.id}` ? '…' : (ar ? 'الرد' : 'Resp')}
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
