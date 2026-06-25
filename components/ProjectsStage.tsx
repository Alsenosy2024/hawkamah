// Governance stage 0 — المشاريع (Projects).
// Project-first model: each project = a company entity. Create manually OR by
// uploading files (AI auto-extracts identity). Selecting a project sets the
// active tenant (settings.activeClientProfileId) that scopes all gov_* data.
// Each new project gets default survey settings seeded from defaultSurveyTemplate.

import React, { useRef, useState } from 'react';
import type { Language, AdminSettings, GovProject, PaperDifficulty, PaperTheories } from '../types';
import { seedProjectSurvey } from '../services/governanceService';
import { createSurveyToken } from '../services/surveyTokenService';
import { createEmployeeToken } from '../services/employeePortalService';
import { createUnifiedToken } from '../services/unifiedAssessmentService';
import { extractProjectFromFiles, draftToProject, type ProjectDraft } from '../services/projectExtraction';
import { UI, badge } from '../services/designTokens';
import { useToast } from './ToastProvider';
import ResponsesPanel from './ResponsesPanel';

interface Props {
  settings: AdminSettings;
  language: Language;
  onUpdateSettings: (s: AdminSettings) => void | Promise<void>;
  // P1-2: "Open" a project = set it active AND advance into the Sources stage.
  // GovernanceCenter owns stage navigation, so it passes this callback down.
  onOpenProject?: (id: string) => void;
}

let _pidc = 0;
const pid = () => `proj_${Date.now().toString(36)}_${(_pidc++).toString(36)}`;

const EMPTY: ProjectDraft = { name: '', industry: '', specialization: '', description: '', vision: '', mission: '' };

const ProjectsStage: React.FC<Props> = ({ settings, language, onUpdateSettings, onOpenProject }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const projects = settings.clientProfiles || [];
  const activeId = settings.activeClientProfileId;

  const [mode, setMode] = useState<'manual' | 'upload' | null>(null);
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [launchModal, setLaunchModal] = useState<{ url: string; projectName: string; type: 'survey' | 'employee' | 'unified' } | null>(null);
  const [launching, setLaunching] = useState<string | null>(null); // projectId being launched
  // W3: employee-portal launch config — pick survey size before minting the token.
  const [empCfg, setEmpCfg] = useState<{ project: GovProject; questionCount: number; voiceCount: number } | null>(null);

  // Unified assessment (replaces separate paper + online) — 15-field config
  const [unifiedCfg, setUnifiedCfg] = useState<{
    project: GovProject;
    questionCount: number;
    behavioralPct: number;
    difficulty: PaperDifficulty;
    secondsPerQuestion: number;
    maxAttempts: number;
    passingScore: number;
    voiceQuestionCount: number;
    cameraProctoring: boolean;
    theories: PaperTheories;
    allowedJobTitles: string;  // newline-separated in textarea
    accessCode: string;
    expiresAt: string;
  } | null>(null);

  // Responses panel — show per-project unified results
  const [responseProjectId, setResponseProjectId] = useState<string | null>(null);

  const launchSurvey = async (p: GovProject) => {
    setLaunching(p.id);
    try {
      const { url } = await createSurveyToken(p.id, p.id, p.name, language);
      setLaunchModal({ url, projectName: p.name, type: 'survey' });
    } catch (err: any) {
      toast.error(t('فشل إنشاء الرابط: ', 'Failed to create link: ') + (err?.message || err));
    } finally {
      setLaunching(null);
    }
  };

  // Open the size-config dialog (questions + voice) before minting the token.
  const launchEmployeePortal = (p: GovProject) => {
    const def = p.survey?.questionCount || settings.defaultSurveyTemplate?.questionCount || 30;
    setEmpCfg({ project: p, questionCount: def, voiceCount: 4 });
  };

  // Mint the employee token with the chosen size + company context (W3/W4).
  const confirmEmpLaunch = async () => {
    if (!empCfg) return;
    const { project: p, questionCount, voiceCount } = empCfg;
    setLaunching(`emp_${p.id}`);
    setEmpCfg(null);
    try {
      const { url } = await createEmployeeToken(p, language, { questionCount, voiceCount });
      setLaunchModal({ url, projectName: p.name, type: 'employee' });
    } catch (err: any) {
      toast.error(t('فشل إنشاء رابط بوابة الموظف: ', 'Failed to create employee portal link: ') + (err?.message || err));
    } finally {
      setLaunching(null);
    }
  };

  const launchUnifiedAssessment = (p: GovProject) => {
    const jobTitles = (p.jobRoles ?? []).map(r => (language === 'ar' ? r.title_ar : r.title_en)).filter(Boolean);
    setUnifiedCfg({
      project: p,
      questionCount: 20,
      behavioralPct: 40,
      difficulty: 'medium',
      secondsPerQuestion: 90,
      maxAttempts: 2,
      passingScore: 60,
      voiceQuestionCount: 0,
      // AI camera + screen-share proctoring ON by default (same anti-cheat engine
      // as the online proctored exam). Admin can still toggle it off per link.
      cameraProctoring: true,
      theories: { birkman: false, holland: true, psychTech: false, bloom: false },
      allowedJobTitles: jobTitles.join('\n'),
      accessCode: '',
      expiresAt: '',
    });
  };

  const confirmUnifiedLaunch = async () => {
    if (!unifiedCfg) return;
    const { project: p } = unifiedCfg;
    const titles = unifiedCfg.allowedJobTitles.split('\n').map(s => s.trim()).filter(Boolean);
    if (!titles.length) {
      toast.error(t('أضف مسمىً وظيفياً واحداً على الأقل.', 'Add at least one job title.'));
      return;
    }
    setLaunching(`unified_${p.id}`);
    setUnifiedCfg(null);
    try {
      const { url } = await createUnifiedToken({
        tenantId: p.id,
        projectId: p.id,
        companyName: p.name,
        companyLogoUrl: p.logoUrl,
        questionCount: unifiedCfg.questionCount,
        behavioralPct: unifiedCfg.behavioralPct,
        difficulty: unifiedCfg.difficulty,
        secondsPerQuestion: unifiedCfg.secondsPerQuestion,
        maxAttempts: unifiedCfg.maxAttempts,
        passingScore: unifiedCfg.passingScore,
        voiceQuestionCount: unifiedCfg.voiceQuestionCount,
        cameraProctoring: unifiedCfg.cameraProctoring,
        theories: unifiedCfg.theories,
        allowedJobTitles: titles,
        ...(unifiedCfg.accessCode.trim() ? { accessCode: unifiedCfg.accessCode.trim() } : {}),
        ...(unifiedCfg.expiresAt.trim() ? { expiresAt: new Date(unifiedCfg.expiresAt).toISOString() } : {}),
      });
      setLaunchModal({ url, projectName: p.name, type: 'unified' });
    } catch (err: any) {
      toast.error(t('فشل إنشاء الرابط الموحد: ', 'Failed to create unified link: ') + (err?.message || err));
    } finally {
      setLaunching(null);
    }
  };

  // Explicit "set active" (no navigation).
  const selectProject = (id: string) => {
    if (id === activeId) return;
    onUpdateSettings({ ...settings, activeClientProfileId: id });
    toast.success(t('تم تعيين المشروع كنشط.', 'Project set as active.'));
  };

  // "Open" = make active + enter the Sources stage for this tenant.
  const openProject = (id: string) => {
    if (id !== activeId) onUpdateSettings({ ...settings, activeClientProfileId: id });
    onOpenProject?.(id);
  };

  // Edit an existing project's company data (preserves id/survey/createdAt).
  const startEdit = (p: GovProject) => {
    setDraft({
      name: p.name || '', industry: p.industry || '', specialization: p.specialization || '',
      description: p.description || '', vision: p.vision || '', mission: p.mission || '',
    });
    setEditingId(p.id);
    setMode('manual');
  };

  const closeForm = () => { setMode(null); setDraft(EMPTY); setEditingId(null); };

  const saveProject = () => {
    if (!draft.name.trim()) { toast.error(t('اسم الجهة مطلوب.', 'Company name required.')); return; }
    const now = new Date().toISOString();
    if (editingId) {
      const existing = projects.find(p => p.id === editingId);
      const updated: GovProject = {
        ...(existing as GovProject),
        ...draftToProject(draft, editingId, existing?.createdAt || now),
        survey: existing?.survey,
        createdAt: existing?.createdAt || now,
        uploadedAt: now,
      };
      onUpdateSettings({ ...settings, clientProfiles: projects.map(p => p.id === editingId ? updated : p) });
      toast.success(t(`حُدِّث مشروع "${updated.name}".`, `Project "${updated.name}" updated.`));
      closeForm();
      return;
    }
    const id = pid();
    const proj: GovProject = {
      ...draftToProject(draft, id, now),
      survey: seedProjectSurvey(settings.defaultSurveyTemplate),
    };
    const next: AdminSettings = {
      ...settings,
      clientProfiles: [...projects, proj],
      activeClientProfileId: id,
    };
    onUpdateSettings(next);
    toast.success(t(`أُنشئ مشروع "${proj.name}" وفُعِّل.`, `Project "${proj.name}" created & activated.`));
    closeForm();
  };

  const deleteProject = (id: string) => {
    const next: AdminSettings = {
      ...settings,
      clientProfiles: projects.filter(p => p.id !== id),
      activeClientProfileId: activeId === id ? undefined : activeId,
    };
    onUpdateSettings(next);
    toast.success(t('حُذف المشروع.', 'Project deleted.'));
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = e.target.files ? Array.from(e.target.files) : [];
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    setExtracting(true);
    try {
      const d = await extractProjectFromFiles(files);
      setDraft({ ...EMPTY, ...d });
      setMode('manual'); // route to editable review form
      toast.success(t('استُخرجت البيانات — راجِعها قبل الحفظ.', 'Fields extracted — review before saving.'));
    } catch (err: any) {
      toast.error(t('فشل الاستخلاص: ', 'Extraction failed: ') + (err?.message || err));
    } finally { setExtracting(false); }
  };

  const fld = (label: string, key: keyof ProjectDraft, ph: string, area = false) => (
    <div>
      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">{label}</label>
      {area ? (
        <textarea
          className={`${UI.input} w-full text-sm`} rows={3}
          value={draft[key] || ''} placeholder={ph}
          onChange={ev => setDraft({ ...draft, [key]: ev.target.value })}
        />
      ) : (
        <input
          className={`${UI.input} w-full text-sm`}
          value={draft[key] || ''} placeholder={ph}
          onChange={ev => setDraft({ ...draft, [key]: ev.target.value })}
        />
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">{t('المشاريع', 'Projects')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {t('أنشئ مشروعاً لكل جهة. اختيار المشروع يحدّد سياق الحوكمة بالكامل.',
               'Create a project per company. Selecting one scopes the whole governance flow.')}
          </p>
        </div>
        <div className="flex gap-2">
          <button className={UI.btnSubtle} onClick={() => { setDraft(EMPTY); setMode('manual'); }}>
            + {t('إنشاء يدوي', 'New project')}
          </button>
          <button className={UI.btnPrimary} disabled={extracting} onClick={() => fileRef.current?.click()}>
            {extracting ? t('جارٍ الاستخلاص…', 'Extracting…') : t('رفع ملفات', 'Upload files')}
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={handleFiles} />
        </div>
      </div>

      {/* ── Empty state ── */}
      {projects.length === 0 && !mode && (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 p-10 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('لا توجد مشاريع بعد. أنشئ أول جهة للبدء.', 'No projects yet. Create the first company to begin.')}
          </p>
        </div>
      )}

      {/* ── Project list (dense hairline rows) ── */}
      {projects.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden divide-y divide-slate-100 dark:divide-slate-700/60">
          {projects.map(p => {
            const active = p.id === activeId;
            return (
              <div key={p.id}
                className={`group relative flex flex-col gap-0 transition-colors ${
                  active
                    ? 'bg-emerald-50/60 dark:bg-emerald-900/10'
                    : 'bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}>
                {/* Active indicator — thin leading edge */}
                {active && (
                  <span className="absolute start-0 inset-y-0 border-s-2 border-emerald-600 rounded-e-sm" aria-hidden="true" />
                )}

                {/* Row — identity + badge + primary actions */}
                <div className="flex items-center gap-3 px-4 py-3 ps-5">
                  {/* Identity */}
                  <button
                    className="min-w-0 flex-1 text-start"
                    onClick={() => openProject(p.id)}
                    title={t('افتح المشروع', 'Open project')}
                  >
                    <span className={`block font-semibold text-sm truncate ${active ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-100'}`}>
                      {p.name}
                    </span>
                    {(p.industry || p.specialization) && (
                      <span className="block text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {p.industry}{p.specialization ? ` · ${p.specialization}` : ''}
                      </span>
                    )}
                  </button>

                  {/* Status badge */}
                  {active && (
                    <span className={badge('success')}>{t('نشط', 'Active')}</span>
                  )}

                  {/* Primary action */}
                  <button
                    className={`${UI.btnPrimary} !py-1.5 !px-3 text-xs shrink-0`}
                    onClick={() => openProject(p.id)}
                  >
                    {t('افتح', 'Open')}
                  </button>
                </div>

                {/* Optional description */}
                {p.description && (
                  <p className="px-5 pb-2 text-xs text-slate-500 dark:text-slate-400 line-clamp-1">{p.description}</p>
                )}

                {/* Secondary actions row */}
                <div className="flex items-center flex-wrap gap-1 px-5 pb-3 pt-0">
                  {!active && (
                    <button
                      className={`${UI.btnSubtle} !px-2.5 !py-1 text-xs`}
                      onClick={() => selectProject(p.id)}
                    >
                      {t('تعيين كنشط', 'Set active')}
                    </button>
                  )}
                  <button
                    className={`${UI.btnGhost} !px-2.5 !py-1 text-xs`}
                    onClick={() => startEdit(p)}
                  >
                    {t('تعديل', 'Edit')}
                  </button>
                  <button
                    className={`${UI.btnGhost} !px-2.5 !py-1 text-xs`}
                    disabled={launching === p.id}
                    onClick={() => launchSurvey(p)}
                    title={t('رابط استبيان بيئة العمل فقط', 'Work environment survey link')}
                  >
                    {launching === p.id ? '…' : t('استبيان البيئة', 'Env. survey')}
                  </button>
                  <button
                    className={`${UI.btnSubtle} !px-2.5 !py-1 text-xs`}
                    disabled={launching === `emp_${p.id}`}
                    onClick={() => launchEmployeePortal(p)}
                    title={t('بوابة التقييم الشامل للموظف (جدارات + بيئة)', 'Full employee assessment portal (competency + environment)')}
                  >
                    {launching === `emp_${p.id}` ? '…' : t('تقييم الموظفين', 'Employee Assessment')}
                  </button>
                  <button
                    className={`${UI.btnGhost} !px-2.5 !py-1 text-xs`}
                    disabled={launching === `unified_${p.id}`}
                    onClick={() => launchUnifiedAssessment(p)}
                    title={t('اختبار/تقييم موحد — رابط واحد لجميع الموظفين', 'Unified exam — one link for all employees')}
                  >
                    {launching === `unified_${p.id}` ? '…' : t('اختبار موحّد', 'Unified Exam')}
                  </button>
                  <button
                    className={`${UI.btnGhost} !px-2.5 !py-1 text-xs`}
                    onClick={() => setResponseProjectId(responseProjectId === p.id ? null : p.id)}
                    title={t('عرض ردود الموظفين على الاختبار الموحد', 'View employee responses')}
                  >
                    {t('الردود', 'Responses')}
                  </button>
                  <button
                    className="ms-auto text-xs text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 px-2 py-1 transition-colors"
                    onClick={() => deleteProject(p.id)}
                  >
                    {t('حذف', 'Delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Employee-portal size config (W3) — pick total questions + voice count before minting */}
      {empCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className={`${UI.card} rounded-xl p-6 max-w-md w-full space-y-5 shadow-lg`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                {t('إعداد تقييم الموظفين', 'Configure Employee Assessment')}
              </h4>
              <button className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors leading-none" onClick={() => setEmpCfg(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t(`المشروع: "${empCfg.project.name}". اختر حجم الاستبيان قبل إنشاء الرابط.`,
                 `Project: "${empCfg.project.name}". Choose the survey size before creating the link.`)}
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                {t('عدد الأسئلة', 'Number of questions')}
              </label>
              <div className="flex gap-2">
                {[30, 40, 50].map(n => (
                  <button key={n}
                    className={`flex-1 py-2 rounded-md text-sm font-bold transition border ${
                      empCfg.questionCount === n
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                    onClick={() => setEmpCfg({ ...empCfg, questionCount: n })}>{n}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                {t('عدد الأسئلة الصوتية', 'Voice questions')}
              </label>
              <div className="flex gap-2">
                {[3, 4, 5].map(n => (
                  <button key={n}
                    className={`flex-1 py-2 rounded-md text-sm font-bold transition border ${
                      empCfg.voiceCount === n
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                    onClick={() => setEmpCfg({ ...empCfg, voiceCount: n })}>{n}</button>
                ))}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                {t('باقي الأسئلة تُجاب كتابةً.', 'Remaining questions are answered in writing.')}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button className={UI.btnGhost} onClick={() => setEmpCfg(null)}>{t('إلغاء', 'Cancel')}</button>
              <button className={UI.btnPrimary} onClick={confirmEmpLaunch}>
                {t('إنشاء الرابط', 'Create link')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unified assessment 15-field config modal */}
      {unifiedCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <div className={`${UI.card} rounded-xl p-6 max-w-lg w-full space-y-5 shadow-lg my-4`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                {t('إعداد الاختبار الموحد', 'Unified Assessment Setup')}
              </h4>
              <button className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors leading-none" onClick={() => setUnifiedCfg(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t(`المشروع: "${unifiedCfg.project.name}". رابط واحد يُشارَك مع جميع الموظفين.`,
                 `Project: "${unifiedCfg.project.name}". One link shared with all employees.`)}
            </p>

            {/* Row 1 — Questions */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('عدد الأسئلة', 'Questions')}
                </label>
                <div className="flex flex-wrap gap-1">
                  {[10, 15, 20, 25, 30].map(n => (
                    <button key={n}
                      className={`flex-1 py-1.5 rounded-md text-xs font-bold transition border ${
                        unifiedCfg.questionCount === n
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, questionCount: n })}>{n}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('% السلوكي', 'Behavioral %')}
                </label>
                <div className="flex flex-wrap gap-1">
                  {[20, 30, 40, 50, 60].map(n => (
                    <button key={n}
                      className={`flex-1 py-1.5 rounded-md text-xs font-bold transition border ${
                        unifiedCfg.behavioralPct === n
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, behavioralPct: n })}>{n}%</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('الصعوبة', 'Difficulty')}
                </label>
                <div className="flex gap-1">
                  {(['easy', 'medium', 'hard'] as PaperDifficulty[]).map(d => (
                    <button key={d}
                      className={`flex-1 py-1.5 rounded-md text-xs font-bold transition border ${
                        unifiedCfg.difficulty === d
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, difficulty: d })}>
                      {d === 'easy' ? t('سهل', 'Easy') : d === 'medium' ? t('متوسط', 'Med') : t('صعب', 'Hard')}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Row 2 — Exam settings */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('ثواني/سؤال', 'Secs/question')}
                </label>
                <div className="flex gap-1">
                  {[45, 60, 90, 120, 180].map(n => (
                    <button key={n}
                      className={`flex-1 py-1.5 rounded-md text-xs font-bold transition border ${
                        unifiedCfg.secondsPerQuestion === n
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, secondsPerQuestion: n })}>{n}s</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('المحاولات القصوى', 'Max attempts')}
                </label>
                <div className="flex gap-1">
                  {[1, 2, 3].map(n => (
                    <button key={n}
                      className={`flex-1 py-1.5 rounded-md text-sm font-bold transition border ${
                        unifiedCfg.maxAttempts === n
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, maxAttempts: n })}>{n}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('درجة النجاح %', 'Passing score %')}
                </label>
                <div className="flex gap-1">
                  {[50, 60, 70, 80].map(n => (
                    <button key={n}
                      className={`flex-1 py-1.5 rounded-md text-xs font-bold transition border ${
                        unifiedCfg.passingScore === n
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, passingScore: n })}>{n}%</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  {t('أسئلة صوتية', 'Voice questions')}
                </label>
                <div className="flex gap-1">
                  {[0, 1, 2, 3].map(n => (
                    <button key={n}
                      className={`flex-1 py-1.5 rounded-md text-sm font-bold transition border ${
                        unifiedCfg.voiceQuestionCount === n
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                      onClick={() => setUnifiedCfg({ ...unifiedCfg, voiceQuestionCount: n })}>{n}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Row 3 — Camera proctoring */}
            <div className="flex items-center gap-3">
              <button
                className={`relative w-11 h-6 rounded-full transition-colors ${unifiedCfg.cameraProctoring ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                onClick={() => setUnifiedCfg({ ...unifiedCfg, cameraProctoring: !unifiedCfg.cameraProctoring })}
                role="switch" aria-checked={unifiedCfg.cameraProctoring}
              >
                <span className={`absolute top-0.5 start-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${unifiedCfg.cameraProctoring ? 'ltr:translate-x-5 rtl:-translate-x-5' : ''}`} />
              </button>
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {t('مراقبة بالكاميرا', 'Camera proctoring')}
              </span>
            </div>

            {/* Row 4 — Theories */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
                {t('النظريات المعتمدة', 'Frameworks')}
              </label>
              <div className="flex flex-wrap gap-2">
                {([
                  ['birkman', t('بيركمان', 'Birkman')],
                  ['holland', t('هولاند', 'Holland')],
                  ['psychTech', t('سيك-تك', 'PsychTech')],
                  ['bloom', t('بلوم', "Bloom's")],
                ] as [keyof PaperTheories, string][]).map(([key, label]) => (
                  <button key={key}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition border ${
                      unifiedCfg.theories[key]
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-emerald-400'}`}
                    onClick={() => setUnifiedCfg({ ...unifiedCfg, theories: { ...unifiedCfg.theories, [key]: !unifiedCfg.theories[key] } })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Row 5 — Job titles */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                {t('المسميات الوظيفية (سطر لكل مسمى)', 'Job titles (one per line)')}
              </label>
              <textarea
                className={`${UI.input} text-sm font-mono min-h-[80px]`}
                rows={4}
                dir="rtl"
                placeholder={t('مدير مشاريع\nمحاسب\nمهندس برمجيات', 'Project Manager\nAccountant\nSoftware Engineer')}
                value={unifiedCfg.allowedJobTitles}
                onChange={e => setUnifiedCfg({ ...unifiedCfg, allowedJobTitles: e.target.value })}
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                {unifiedCfg.allowedJobTitles.split('\n').filter(s => s.trim()).length} {t('مسمى', 'titles')}
              </p>
            </div>

            {/* Row 6-7 — Optional: access code + expiry */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  {t('رمز وصول (اختياري)', 'Access code (optional)')}
                </label>
                <input
                  className={`${UI.input} text-sm font-mono`}
                  dir="ltr"
                  placeholder="ABC123"
                  value={unifiedCfg.accessCode}
                  onChange={e => setUnifiedCfg({ ...unifiedCfg, accessCode: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  {t('تاريخ انتهاء (اختياري)', 'Expiry date (optional)')}
                </label>
                <input
                  className={`${UI.input} text-sm`}
                  type="date"
                  value={unifiedCfg.expiresAt}
                  onChange={e => setUnifiedCfg({ ...unifiedCfg, expiresAt: e.target.value })}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-700/60">
              <button className={UI.btnGhost} onClick={() => setUnifiedCfg(null)}>{t('إلغاء', 'Cancel')}</button>
              <button
                className={UI.btnPrimary}
                disabled={!unifiedCfg.allowedJobTitles.trim()}
                onClick={confirmUnifiedLaunch}
              >
                {t('إنشاء الرابط الموحد', 'Create unified link')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Survey launch modal */}
      {launchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className={`${UI.card} rounded-xl p-6 max-w-lg w-full space-y-4 shadow-lg`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                {launchModal.type === 'employee'
                  ? t('رابط بوابة تقييم الموظفين', 'Employee Assessment Portal Link')
                  : launchModal.type === 'unified'
                  ? t('رابط الاختبار الموحد', 'Unified Assessment Link')
                  : t('رابط استبيان البيئة', 'Environment Survey Link')}
              </h4>
              <button className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors leading-none" onClick={() => setLaunchModal(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {launchModal.type === 'employee'
                ? t(
                    `شارك هذا الرابط مع موظفي "${launchModal.projectName}". سيمرّون بتقييم الجدارات + استبيان بيئة العمل.`,
                    `Share with "${launchModal.projectName}" employees for full assessment (competency + work environment).`,
                  )
                : launchModal.type === 'unified'
                ? t(
                    `شارك هذا الرابط مع جميع موظفي "${launchModal.projectName}". كل موظف يدخل اسمه ومسماه ويبدأ الاختبار مباشرةً.`,
                    `Share this link with all "${launchModal.projectName}" employees. Each enters their name and job title, then starts the exam.`,
                  )
                : t(
                    `شارك هذا الرابط مع موظفي "${launchModal.projectName}" لاستبيان بيئة العمل فقط.`,
                    `Share this link with "${launchModal.projectName}" employees for the work environment survey only.`,
                  )}
            </p>
            <div className="flex gap-2">
              <input
                className={`${UI.input} flex-1 text-xs font-mono`}
                readOnly
                value={launchModal.url}
                onFocus={e => e.target.select()}
              />
              <button
                className={UI.btnPrimary}
                onClick={() => {
                  navigator.clipboard?.writeText(launchModal.url);
                  toast.success(t('تم النسخ!', 'Copied!'));
                }}
              >
                {t('نسخ', 'Copy')}
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('تستطيع إنشاء روابط متعددة لنفس المشروع — كل رابط مستقل.', 'You can create multiple links per project — each is independent.')}
            </p>
          </div>
        </div>
      )}

      {/* Responses panel — unified assessment results for a project */}
      {responseProjectId && (
        <ResponsesPanel
          tenantId={responseProjectId}
          language={language}
          onClose={() => setResponseProjectId(null)}
        />
      )}

      {/* Create / review form */}
      {mode === 'manual' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-800/40">
            <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              {editingId ? t('تعديل بيانات الجهة', 'Edit company details') : t('بيانات الجهة الجديدة', 'New company details')}
            </h4>
            <button className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors" onClick={closeForm}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block me-1"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>{t('إلغاء', 'Cancel')}
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              {fld(t('اسم الجهة', 'Company name'), 'name', t('مثال: شركة ريمكس', 'e.g. Remix Corp'))}
              {fld(t('القطاع', 'Industry'), 'industry', t('مثال: الطاقة', 'e.g. Energy'))}
              {fld(t('التخصص', 'Specialization'), 'specialization', t('مثال: حلول رقمية', 'e.g. Digital solutions'))}
              {fld(t('الرؤية', 'Vision'), 'vision', t('رؤية الجهة', 'Vision'))}
            </div>
            {fld(t('الرسالة', 'Mission'), 'mission', t('رسالة الجهة', 'Mission'), true)}
            {fld(t('التفاصيل / الهوية', 'Details / identity'), 'description', t('نبذة تعريفية عن الجهة وبيئتها', 'Brief about the company & its environment'), true)}
            <div className="flex justify-end gap-2 pt-1">
              <button className={UI.btnGhost} onClick={closeForm}>{t('إلغاء', 'Cancel')}</button>
              <button className={UI.btnPrimary} onClick={saveProject}>
                {editingId ? t('حفظ التعديلات', 'Save changes') : t('حفظ المشروع', 'Save project')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectsStage;
