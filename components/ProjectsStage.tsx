// Governance stage 0 — المشاريع (Projects).
// Project-first model: each project = a company entity. Create manually OR by
// uploading files (AI auto-extracts identity). Selecting a project sets the
// active tenant (settings.activeClientProfileId) that scopes all gov_* data.
// Each new project gets default survey settings seeded from defaultSurveyTemplate.

import React, { useRef, useState } from 'react';
import type { Language, AdminSettings, GovProject } from '../types';
import { seedProjectSurvey } from '../services/governanceService';
import { createSurveyToken } from '../services/surveyTokenService';
import { createEmployeeToken } from '../services/employeePortalService';
import { createPaperToken } from '../services/paperAssessmentService';
import { createExamToken } from '../services/onlineAssessmentService';
import { extractProjectFromFiles, draftToProject, type ProjectDraft } from '../services/projectExtraction';
import { UI, badge } from '../services/designTokens';
import { useToast } from './ToastProvider';

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
  const [launchModal, setLaunchModal] = useState<{ url: string; projectName: string; type: 'survey' | 'employee' | 'paper' | 'online' } | null>(null);
  const [launching, setLaunching] = useState<string | null>(null); // projectId being launched
  // W3: employee-portal launch config — pick survey size before minting the token.
  const [empCfg, setEmpCfg] = useState<{ project: GovProject; questionCount: number; voiceCount: number } | null>(null);

  // Paper assessment config — only email+password; all question settings live in the portal
  const [paperCfg, setPaperCfg] = useState<{
    project: GovProject;
    accessEmail: string;
    accessPassword: string;
  } | null>(null);

  // Online proctored exam config
  const [onlineCfg, setOnlineCfg] = useState<{
    project: GovProject;
    accessEmail: string;
    accessPassword: string;
    jobTitle: string;
    secondsPerQuestion: number;
  } | null>(null);

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

  const launchPaperAssessment = (p: GovProject) => {
    setPaperCfg({ project: p, accessEmail: '', accessPassword: '' });
  };

  const launchOnlineAssessment = (p: GovProject) => {
    setOnlineCfg({ project: p, accessEmail: '', accessPassword: '', jobTitle: '', secondsPerQuestion: 90 });
  };

  const confirmOnlineLaunch = async () => {
    if (!onlineCfg) return;
    const { project: p, accessEmail, accessPassword, jobTitle, secondsPerQuestion } = onlineCfg;
    if (!accessEmail.trim() || !accessPassword.trim() || !jobTitle.trim()) {
      toast.error(t('يرجى ملء جميع الحقول.', 'Please fill all fields.'));
      return;
    }
    setLaunching(`online_${p.id}`);
    setOnlineCfg(null);
    try {
      const { url } = await createExamToken(
        p.id, p.id, p.name, accessEmail, accessPassword, jobTitle,
        { secondsPerQuestion },
      );
      setLaunchModal({ url, projectName: p.name, type: 'online' });
    } catch (err: any) {
      toast.error(t('فشل إنشاء رابط الاختبار الإلكتروني: ', 'Failed to create online exam link: ') + (err?.message || err));
    } finally {
      setLaunching(null);
    }
  };

  const confirmPaperLaunch = async () => {
    if (!paperCfg) return;
    const { project: p, accessEmail, accessPassword } = paperCfg;
    if (!accessEmail.trim() || !accessPassword.trim()) {
      toast.error(t('يرجى ملء البريد الإلكتروني وكلمة المرور.', 'Please fill email and password.'));
      return;
    }
    setLaunching(`paper_${p.id}`);
    setPaperCfg(null);
    try {
      const logoUrl = (p as any).logoUrl as string | undefined;
      const { url } = await createPaperToken(
        p.id, p.id, p.name, logoUrl, language, accessEmail, accessPassword,
      );
      setLaunchModal({ url, projectName: p.name, type: 'paper' });
    } catch (err: any) {
      toast.error(t('فشل إنشاء رابط التقييم الورقي: ', 'Failed to create paper assessment link: ') + (err?.message || err));
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
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('المشاريع', 'Projects')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('أنشئ مشروعاً لكل جهة. اختيار المشروع يحدّد سياق الحوكمة بالكامل.',
               'Create a project per company. Selecting one scopes the whole governance flow.')}
          </p>
        </div>
        <div className="flex gap-2">
          <button className={UI.btnSubtle} onClick={() => { setDraft(EMPTY); setMode('manual'); }}>
            ＋ {t('إنشاء يدوي', 'Manual')}
          </button>
          <button className={UI.btnPrimary} disabled={extracting} onClick={() => fileRef.current?.click()}>
            {extracting ? t('جارٍ الاستخلاص…', 'Extracting…') : `⬆ ${t('رفع ملفات (استخلاص تلقائي)', 'Upload (auto-extract)')}`}
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={handleFiles} />
        </div>
      </div>

      {/* Project list */}
      {projects.length === 0 && !mode && (
        <div className={`${UI.sectionFrame} p-8 text-center text-slate-500 dark:text-slate-400`}>
          {t('لا توجد مشاريع بعد. أنشئ أول جهة للبدء.', 'No projects yet. Create the first company to begin.')}
        </div>
      )}
      {projects.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map(p => {
            const active = p.id === activeId;
            return (
              <div key={p.id}
                className={`${UI.card} p-4 rounded-xl transition ring-2 ${active ? 'ring-emerald-500' : 'ring-transparent hover:ring-emerald-200'}`}>
                <div className="flex items-start justify-between gap-2">
                  <button className="min-w-0 text-start" onClick={() => openProject(p.id)} title={t('افتح المشروع', 'Open project')}>
                    <div className="font-bold text-slate-800 dark:text-slate-100 truncate">{p.name}</div>
                    {p.industry && <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{p.industry}{p.specialization ? ` · ${p.specialization}` : ''}</div>}
                  </button>
                  {active && <span className={badge('success')}>{t('نشط', 'Active')}</span>}
                </div>
                {p.description && <p className="text-xs text-slate-600 dark:text-slate-300 mt-2 line-clamp-2">{p.description}</p>}
                <div className="flex items-center flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/60">
                  <button className={`${UI.btnPrimary} !px-3 !py-1.5 text-xs`} onClick={() => openProject(p.id)}>
                    {t('افتح', 'Open')}
                  </button>
                  {!active && (
                    <button className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`} onClick={() => selectProject(p.id)}>
                      {t('تعيين كنشط', 'Set active')}
                    </button>
                  )}
                  <button className={`${UI.btnGhost} !px-3 !py-1.5 text-xs`} onClick={() => startEdit(p)}>
                    {t('تعديل', 'Edit')}
                  </button>
                  <button
                    className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
                    disabled={launching === p.id}
                    onClick={() => launchSurvey(p)}
                    title={t('رابط استبيان بيئة العمل فقط', 'Work environment survey link')}
                  >
                    {launching === p.id ? '…' : `🔗 ${t('استبيان البيئة', 'Env. survey')}`}
                  </button>
                  <button
                    className={`${UI.btnPrimary} !px-3 !py-1.5 text-xs`}
                    disabled={launching === `emp_${p.id}`}
                    onClick={() => launchEmployeePortal(p)}
                    title={t('بوابة التقييم الشامل للموظف (جدارات + بيئة)', 'Full employee assessment portal (competency + environment)')}
                  >
                    {launching === `emp_${p.id}` ? '…' : `🎯 ${t('تقييم الموظفين', 'Employee Assessment')}`}
                  </button>
                  <button
                    className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
                    disabled={launching === `paper_${p.id}`}
                    onClick={() => launchPaperAssessment(p)}
                    title={t('إنشاء رابط تقييم ورقي مع PDF', 'Create paper assessment link with printable PDF')}
                  >
                    {launching === `paper_${p.id}` ? '…' : `📄 ${t('تقييم ورقي', 'Paper Assessment')}`}
                  </button>
                  <button
                    className={`${UI.btnSubtle} !px-3 !py-1.5 text-xs`}
                    disabled={launching === `online_${p.id}`}
                    onClick={() => launchOnlineAssessment(p)}
                    title={t('إنشاء رابط اختبار إلكتروني محمي', 'Create proctored online exam link')}
                  >
                    {launching === `online_${p.id}` ? '…' : `🖥️ ${t('اختبار إلكتروني', 'Online Exam')}`}
                  </button>
                  <button className="ms-auto text-xs text-rose-600 hover:text-rose-700 px-2 py-1.5"
                    onClick={() => deleteProject(p.id)}>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`${UI.card} rounded-2xl p-6 max-w-md w-full space-y-5 shadow-2xl`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                🎯 {t('إعداد تقييم الموظفين', 'Configure Employee Assessment')}
              </h4>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => setEmpCfg(null)}>✕</button>
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
                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition border ${
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
                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition border ${
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

      {/* Paper assessment config modal — email+password only; all question settings in the portal */}
      {paperCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`${UI.card} rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-2xl`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                📄 {t('إنشاء رابط التقييم الورقي', 'Create Paper Assessment Link')}
              </h4>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => setPaperCfg(null)}>✕</button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t(
                `المشروع: "${paperCfg.project.name}". سيختار المدير الوظيفة والأسئلة بعد الدخول للرابط.`,
                `Project: "${paperCfg.project.name}". The manager configures questions after opening the link.`,
              )}
            </p>

            {/* Access credentials */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                {t('البريد الإلكتروني للمدير', 'Manager email')}
              </label>
              <input
                className={UI.input} type="email" dir="ltr"
                value={paperCfg.accessEmail}
                onChange={e => setPaperCfg({ ...paperCfg, accessEmail: e.target.value })}
                placeholder="manager@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                {t('كلمة المرور', 'Password')}
              </label>
              <input
                className={UI.input} type="text" dir="ltr"
                value={paperCfg.accessPassword}
                onChange={e => setPaperCfg({ ...paperCfg, accessPassword: e.target.value })}
                placeholder={t('كلمة مرور للمدير', 'Access password')}
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button className={UI.btnGhost} onClick={() => setPaperCfg(null)}>{t('إلغاء', 'Cancel')}</button>
              <button
                className={UI.btnPrimary}
                disabled={!paperCfg.accessEmail.trim() || !paperCfg.accessPassword.trim()}
                onClick={confirmPaperLaunch}
              >
                {t('إنشاء الرابط', 'Create link')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Online exam config modal */}
      {onlineCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`${UI.card} rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-2xl`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                🖥️ {t('إنشاء رابط الاختبار الإلكتروني', 'Create Online Exam Link')}
              </h4>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => setOnlineCfg(null)}>✕</button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t(`المشروع: "${onlineCfg.project.name}". اختبار محمي بكاميرا + مراقبة التبويبات + 3 محاولات.`,
                 `Project: "${onlineCfg.project.name}". Proctored with camera + tab monitoring + 3 attempts.`)}
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                {t('المسمى الوظيفي للمُختبَر', 'Job title for the candidate')}
              </label>
              <input
                className={UI.input} type="text" dir="rtl"
                value={onlineCfg.jobTitle}
                onChange={e => setOnlineCfg({ ...onlineCfg, jobTitle: e.target.value })}
                placeholder={t('مثال: مدير مشاريع', 'e.g. Project Manager')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                {t('البريد الإلكتروني للمُختبَر', 'Candidate email')}
              </label>
              <input
                className={UI.input} type="email" dir="ltr"
                value={onlineCfg.accessEmail}
                onChange={e => setOnlineCfg({ ...onlineCfg, accessEmail: e.target.value })}
                placeholder="candidate@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                {t('كلمة المرور', 'Password')}
              </label>
              <input
                className={UI.input} type="text" dir="ltr"
                value={onlineCfg.accessPassword}
                onChange={e => setOnlineCfg({ ...onlineCfg, accessPassword: e.target.value })}
                placeholder={t('كلمة مرور للمُختبَر', 'Access password')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                {t('ثواني لكل سؤال', 'Seconds per question')}
              </label>
              <div className="flex gap-2">
                {[60, 90, 120].map(n => (
                  <button key={n}
                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition border ${
                      onlineCfg.secondsPerQuestion === n
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600 hover:border-blue-400'}`}
                    onClick={() => setOnlineCfg({ ...onlineCfg, secondsPerQuestion: n })}>{n}s</button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button className={UI.btnGhost} onClick={() => setOnlineCfg(null)}>{t('إلغاء', 'Cancel')}</button>
              <button
                className={UI.btnPrimary}
                disabled={!onlineCfg.accessEmail.trim() || !onlineCfg.accessPassword.trim() || !onlineCfg.jobTitle.trim()}
                onClick={confirmOnlineLaunch}
              >
                {t('إنشاء الرابط', 'Create link')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Survey launch modal */}
      {launchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`${UI.card} rounded-2xl p-6 max-w-lg w-full space-y-4 shadow-2xl`}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-800 dark:text-slate-100">
                {launchModal.type === 'employee' ? '🎯' : launchModal.type === 'paper' ? '📄' : launchModal.type === 'online' ? '🖥️' : '🔗'}{' '}
                {launchModal.type === 'employee'
                  ? t('رابط بوابة تقييم الموظفين', 'Employee Assessment Portal Link')
                  : launchModal.type === 'paper'
                  ? t('رابط التقييم الورقي', 'Paper Assessment Link')
                  : launchModal.type === 'online'
                  ? t('رابط الاختبار الإلكتروني المحمي', 'Proctored Online Exam Link')
                  : t('رابط استبيان البيئة', 'Environment Survey Link')}
              </h4>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => setLaunchModal(null)}>✕</button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {launchModal.type === 'employee'
                ? t(
                    `شارك هذا الرابط مع موظفي "${launchModal.projectName}". سيمرّون بتقييم الجدارات + استبيان بيئة العمل.`,
                    `Share with "${launchModal.projectName}" employees for full assessment (competency + work environment).`,
                  )
                : launchModal.type === 'paper'
                ? t(
                    `شارك هذا الرابط مع المدير المعيّن. سيتمكن من توليد عدد غير محدود من اختبارات PDF.`,
                    `Share this link with the designated manager. They can generate unlimited PDF exams.`,
                  )
                : launchModal.type === 'online'
                ? t(
                    `شارك هذا الرابط مع المُختبَر. الاختبار محمي بكاميرا + مراقبة التبويبات + 3 محاولات.`,
                    `Share this link with the candidate. Exam is proctored with camera + tab monitoring + 3 attempts.`,
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

      {/* Create / review form */}
      {mode === 'manual' && (
        <div className={`${UI.sectionFrame} p-5 space-y-4`}>
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-slate-800 dark:text-slate-100">{editingId ? t('تعديل بيانات الجهة', 'Edit company details') : t('بيانات الجهة', 'Company details')}</h4>
            <button className="text-xs text-slate-500 hover:text-slate-700" onClick={closeForm}>
              ✕ {t('إلغاء', 'Cancel')}
            </button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {fld(t('اسم الجهة', 'Company name'), 'name', t('مثال: شركة ريمكس', 'e.g. Remix Corp'))}
            {fld(t('القطاع', 'Industry'), 'industry', t('مثال: الطاقة', 'e.g. Energy'))}
            {fld(t('التخصص', 'Specialization'), 'specialization', t('مثال: حلول رقمية', 'e.g. Digital solutions'))}
            {fld(t('الرؤية', 'Vision'), 'vision', t('رؤية الجهة', 'Vision'))}
          </div>
          {fld(t('الرسالة', 'Mission'), 'mission', t('رسالة الجهة', 'Mission'), true)}
          {fld(t('التفاصيل / الهوية', 'Details / identity'), 'description', t('نبذة تعريفية عن الجهة وبيئتها', 'Brief about the company & its environment'), true)}
          <div className="flex justify-end gap-2">
            <button className={UI.btnGhost} onClick={closeForm}>{t('إلغاء', 'Cancel')}</button>
            <button className={UI.btnPrimary} onClick={saveProject}>{editingId ? t('حفظ التعديلات', 'Save changes') : t('حفظ المشروع', 'Save project')}</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectsStage;
