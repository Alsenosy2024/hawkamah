import React, { useState, useEffect, useCallback } from 'react';
import { UI, badge } from '../services/designTokens';
import { useToast } from './ToastProvider';
import type { CompanyGovernanceModel, DepartmentPackage, DeptSectionKey, Language, GovDocumentRecord, ArtifactSection } from '../types';
import {
  getPackagesForTenant, savePackage, updatePackageSection, deletePackage,
  makeEmptyPackage, generateSection, SECTION_META, ALL_SECTION_KEYS,
} from '../services/departmentService';
import { saveGovDocument } from '../services/governanceService';
import { getStandardsForDepartment } from '../constants/standards';

const gdId = () => `govdoc_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

interface Props {
  model: CompanyGovernanceModel;
  tenantId: string;
  language: Language;
}

const t = (ar: string, en: string, lang: Language) => lang === 'ar' ? ar : en;

export default function DepartmentBuilder({ model, tenantId, language }: Props) {
  const toast = useToast();
  const ar = language === 'ar';

  // Departments derived from org units
  const departments = model.orgUnits.filter(u => !u.parentId || model.orgUnits.some(p => p.id === u.parentId && !p.parentId));

  const [packages, setPackages] = useState<DepartmentPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [generating, setGenerating] = useState<Partial<Record<DeptSectionKey, boolean>>>({});
  const [expanded, setExpanded] = useState<DeptSectionKey | null>(null);
  // HWK-B5: progress while building every department in turn (null = not running).
  const [allDeptProgress, setAllDeptProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!tenantId) { setLoading(false); return; }
    getPackagesForTenant(tenantId)
      .then(pkgs => { setPackages(pkgs); setLoading(false); })
      .catch(() => { toast.error(t('فشل تحميل حزم الإدارات.', 'Failed to load department packages.', language)); setLoading(false); });
  }, [tenantId]);

  const getPackageForDept = (deptName: string) =>
    packages.find(p => p.departmentName === deptName);

  const initPackage = useCallback(async (deptName: string, deptNameAr: string) => {
    if (getPackageForDept(deptName)) return; // already exists
    const pkg = makeEmptyPackage(tenantId, deptName, deptNameAr);
    const id = await savePackage(pkg);
    setPackages(prev => [...prev, { id, ...pkg }]);
    toast.success(t(`تم إنشاء حزمة: ${deptNameAr}`, `Package created: ${deptName}`, language));
  }, [packages, tenantId, language]);

  const handleGenerate = useCallback(async (
    deptName: string, deptNameAr: string, sectionKey: DeptSectionKey
  ) => {
    let pkg = getPackageForDept(deptName);
    if (!pkg) {
      const newPkg = makeEmptyPackage(tenantId, deptName, deptNameAr);
      const id = await savePackage(newPkg);
      pkg = { id, ...newPkg };
      setPackages(prev => [...prev, pkg!]);
    }

    setGenerating(prev => ({ ...prev, [sectionKey]: true }));
    // Mark as generating
    const genSection = pkg.sections.find(s => s.key === sectionKey);
    if (genSection) {
      const updated = { ...genSection, status: 'generating' as const };
      setPackages(prev => prev.map(p => p.id === pkg!.id
        ? { ...p, sections: p.sections.map(s => s.key === sectionKey ? updated : s) }
        : p));
    }

    try {
      const content = await generateSection(
        sectionKey, deptName, deptNameAr, model.companyName, language
      );
      const doneSection = {
        key: sectionKey,
        titleAr: SECTION_META[sectionKey].arTitle,
        content,
        status: 'done' as const,
      };
      await updatePackageSection(pkg.id, doneSection);
      setPackages(prev => prev.map(p => p.id === pkg!.id
        ? {
            ...p,
            sections: p.sections.map(s => s.key === sectionKey ? doneSection : s),
            updatedAt: new Date().toISOString(),
          }
        : p));
      setExpanded(sectionKey);
      toast.success(t(
        `تم توليد: ${SECTION_META[sectionKey].arTitle}`,
        `Generated: ${SECTION_META[sectionKey].enTitle}`,
        language,
      ));
    } catch (err: any) {
      const errSection = {
        key: sectionKey,
        titleAr: SECTION_META[sectionKey].arTitle,
        content: '',
        status: 'error' as const,
      };
      setPackages(prev => prev.map(p => p.id === pkg!.id
        ? { ...p, sections: p.sections.map(s => s.key === sectionKey ? errSection : s) }
        : p));
      toast.error(t('فشل التوليد: ', 'Generation failed: ', language) + (err?.message || err));
    } finally {
      setGenerating(prev => ({ ...prev, [sectionKey]: false }));
    }
  }, [packages, tenantId, model, language]);

  const handleGenerateAll = useCallback(async (deptName: string, deptNameAr: string) => {
    for (const key of ALL_SECTION_KEYS) {
      const pkg = getPackageForDept(deptName);
      const sec = pkg?.sections.find(s => s.key === key);
      if (sec?.status === 'done') continue; // skip already done
      await handleGenerate(deptName, deptNameAr, key);
    }
  }, [handleGenerate, packages]);

  // HWK-B5: build EVERY department's package in turn (each dept builds all its sections via
  // handleGenerateAll). Sequential by design — surfaces the dept in progress and a done/total count.
  const handleGenerateAllDepartments = useCallback(async () => {
    if (allDeptProgress) return; // already running
    setAllDeptProgress({ done: 0, total: departments.length });
    try {
      for (let i = 0; i < departments.length; i++) {
        const dept = departments[i];
        setSelectedDept(dept.id);
        await handleGenerateAll(dept.name, (dept as any).nameAr || dept.name);
        setAllDeptProgress({ done: i + 1, total: departments.length });
      }
      toast.success(t('تم بناء كل الإدارات.', 'All departments built.', language));
    } catch (err: any) {
      toast.error(t('فشل بناء كل الإدارات: ', 'Failed to build all departments: ', language) + (err?.message || err));
    } finally {
      setAllDeptProgress(null);
    }
  }, [departments, handleGenerateAll, allDeptProgress, language]);

  const handleDelete = useCallback(async (deptName: string) => {
    const pkg = getPackageForDept(deptName);
    if (!pkg) return;
    await deletePackage(pkg.id);
    setPackages(prev => prev.filter(p => p.id !== pkg.id));
    toast.success(t('تم حذف الحزمة.', 'Package deleted.', language));
  }, [packages, language]);

  // HWK-C2: publish a department's package to the Library as SEPARATE, exportable documents —
  // one gov_document per completed section (policies, procedures, KPIs, job descriptions, objectives,
  // structure, RACI, risk). This bridges the per-department builder to the document library.
  const [publishing, setPublishing] = useState<string | null>(null);
  const publishToLibrary = useCallback(async (deptName: string) => {
    const pkg = getPackageForDept(deptName);
    const done = pkg?.sections.filter(s => s.status === 'done' && s.content.trim()) || [];
    if (!done.length) { toast.error(t('لا أقسام جاهزة للنشر — ولّد الحزمة أولاً.', 'No completed sections to publish — generate the package first.', language)); return; }
    setPublishing(deptName);
    try {
      const now = new Date().toISOString();
      let ok = 0;
      for (const s of done) {
        const enTitle = SECTION_META[s.key]?.enTitle || s.key;
        const sections: ArtifactSection[] = [{ id: `${s.key}_${gdId()}`, title: language === 'ar' ? s.titleAr : enTitle, content: s.content, status: 'done' }];
        // deterministic id per (tenant, dept, section) → re-publishing UPSERTS instead of duplicating.
        const docId = `dept_${tenantId}_${s.key}_${deptName.replace(/[/\s]+/g, '_')}`;
        const rec: GovDocumentRecord = {
          id: docId, tenantId, kind: `dept_${s.key}`,
          title: `${deptName} — ${language === 'ar' ? s.titleAr : enTitle}`,
          scope: `dept:${deptName}`, status: 'draft', version: model.version || 1,
          createdAt: now, updatedAt: now, sections, comments: [],
        };
        try { await saveGovDocument(rec); ok++; } catch { /* keep going */ }
      }
      toast.success(t(`نُشرت ${ok} وثيقة من «${deptName}» إلى المكتبة.`, `Published ${ok} document(s) from "${deptName}" to the library.`, language));
    } finally { setPublishing(null); }
  }, [packages, tenantId, model, language]);

  const selectedUnit = departments.find(d => d.id === selectedDept || d.name === selectedDept);
  const selectedPkg = selectedUnit ? getPackageForDept(selectedUnit.name) : null;
  const standards = selectedUnit ? getStandardsForDepartment(selectedUnit.name) : null;

  if (loading) return (
    <div className="flex items-center justify-center h-48 gap-2 text-slate-500">
      <div className="w-4 h-4 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
      <span className="text-sm">{t('تحميل...', 'Loading…', language)}</span>
    </div>
  );

  if (departments.length === 0) return (
    <div className="hw-card rounded-xl p-10 text-center text-slate-500">
      <svg className="w-10 h-10 mx-auto mb-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
      </svg>
      <p className="font-semibold text-slate-700 dark:text-slate-300">{t('لا توجد وحدات تنظيمية في النموذج.', 'No org units in the model.', language)}</p>
      <p className="text-xs mt-1 text-slate-400">{t('ابنِ نموذج الحوكمة أولاً في مرحلة المصادر والنموذج.', 'Build the governance model in Sources & Model stages first.', language)}</p>
    </div>
  );

  return (
    <div className="flex gap-5 h-full" dir={ar ? 'rtl' : 'ltr'}>
      {/* Sidebar — dept list */}
      <div className="w-52 shrink-0 flex flex-col gap-0 overflow-y-auto">
        <div className="px-1 pb-2 border-b border-slate-200 dark:border-slate-700 mb-1">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
            {t('الإدارات', 'Departments', language)}
            <span className="ms-1.5 font-normal text-slate-400">({departments.length})</span>
          </span>
        </div>
        {departments.length > 1 && (
          <button
            onClick={handleGenerateAllDepartments}
            disabled={!!allDeptProgress || Object.values(generating).some(Boolean)}
            title={t('بناء حزمة كل الإدارات بالتتابع', 'Build every department’s package in turn', language)}
            className="mb-1.5 w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
          >
            {allDeptProgress ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                {t(`بناء ${allDeptProgress.done}/${allDeptProgress.total}…`, `Building ${allDeptProgress.done}/${allDeptProgress.total}…`, language)}
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2z"/></svg>
                {t('بناء كل الإدارات', 'Build all departments', language)}
              </>
            )}
          </button>
        )}
        {departments.map(dept => {
          const pkg = getPackageForDept(dept.name);
          const doneCount = pkg?.sections.filter(s => s.status === 'done').length ?? 0;
          const isSelected = selectedDept === dept.id || selectedDept === dept.name;
          return (
            <button
              key={dept.id}
              className={`w-full text-start px-3 py-2 rounded-md text-sm transition-colors duration-150 ${
                isSelected
                  ? 'bg-emerald-600 text-white font-semibold'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-700/50 text-slate-700 dark:text-slate-300'
              }`}
              onClick={() => setSelectedDept(dept.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate leading-snug">{dept.name}</span>
                {pkg && (
                  <span className={`text-xs shrink-0 tabular-nums ${isSelected ? 'text-emerald-200' : 'text-slate-400'}`}>
                    {doneCount}/{ALL_SECTION_KEYS.length}
                  </span>
                )}
              </div>
              {dept.mandate && (
                <p className={`text-xs truncate mt-0.5 ${isSelected ? 'text-emerald-200' : 'text-slate-400'}`}>
                  {dept.mandate}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {/* Main panel */}
      <div className="flex-1 min-w-0 space-y-4 overflow-y-auto">
        {!selectedUnit ? (
          <div className="hw-card rounded-xl p-10 text-center text-slate-400">
            <svg className="w-8 h-8 mx-auto mb-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75a2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
            </svg>
            <p className="text-sm text-slate-500">{t('اختر إدارة من القائمة لبناء حزمتها.', 'Select a department from the list to build its package.', language)}</p>
          </div>
        ) : (
          <>
            {/* Dept header card */}
            <div className="hw-card rounded-xl overflow-hidden">
              <div className="px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 leading-tight">{selectedUnit.name}</h3>
                  {selectedUnit.mandate && (
                    <p className="text-sm text-slate-500 mt-0.5 leading-relaxed">{selectedUnit.mandate}</p>
                  )}
                  {standards && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {[...standards.iso, ...standards.frameworks].slice(0, 5).map(s => (
                        <span key={s} className={badge('info')}>{s}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap shrink-0">
                  <button
                    className={UI.btnPrimary}
                    onClick={() => handleGenerateAll(selectedUnit.name, (selectedUnit as any).nameAr || selectedUnit.name)}
                    disabled={Object.values(generating).some(Boolean)}
                  >
                    {Object.values(generating).some(Boolean)
                      ? t('جارٍ التوليد...', 'Generating…', language)
                      : t('توليد الكل', 'Generate All', language)}
                  </button>
                  {selectedPkg && selectedPkg.sections.some(s => s.status === 'done') && (
                    <button
                      className={UI.btnGhost}
                      onClick={() => publishToLibrary(selectedUnit.name)}
                      disabled={publishing === selectedUnit.name}
                      title={t('انشر الأقسام الجاهزة كوثائق منفصلة في المكتبة', 'Publish the completed sections as separate documents in the library', language)}
                    >
                      {publishing === selectedUnit.name
                        ? t('جارٍ النشر…', 'Publishing…', language)
                        : t('نشر إلى المكتبة', 'Publish to Library', language)}
                    </button>
                  )}
                  {selectedPkg && (
                    <button
                      className={UI.btnGhost}
                      onClick={() => handleDelete(selectedUnit.name)}
                    >
                      {t('حذف الحزمة', 'Delete Package', language)}
                    </button>
                  )}
                </div>
              </div>
              {selectedPkg && (
                <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-700 bg-[#EEF3F5]/60 dark:bg-slate-800/30">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-sm h-1">
                      <div
                        className="bg-emerald-600 h-1 rounded-sm transition-all duration-300"
                        style={{ width: `${(selectedPkg.sections.filter(s => s.status === 'done').length / ALL_SECTION_KEYS.length) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums shrink-0">
                      {selectedPkg.sections.filter(s => s.status === 'done').length} / {ALL_SECTION_KEYS.length} {t('مكتمل', 'complete', language)}
                    </span>
                    {selectedPkg.complete && <span className={badge('success')}>{t('مكتمل', 'Complete', language)}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Sections — scaffolded instrument rows */}
            <div className="hw-card rounded-xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-700/70">
              {ALL_SECTION_KEYS.map(key => {
                const meta = SECTION_META[key];
                const sec = selectedPkg?.sections.find(s => s.key === key);
                const status = sec?.status ?? 'pending';
                const isGen = generating[key];
                const isExpanded = expanded === key;

                return (
                  <div key={key}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      {/* Icon */}
                      <span className="text-base shrink-0 w-6 text-center opacity-70">{meta.icon}</span>
                      {/* Title + expand toggle */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-800 dark:text-slate-100 text-sm leading-snug">
                          {ar ? meta.arTitle : meta.enTitle}
                        </div>
                        {status === 'done' && sec?.content && (
                          <button
                            className="text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 mt-0.5 transition-colors duration-150"
                            onClick={() => setExpanded(prev => prev === key ? null : key)}
                          >
                            {isExpanded ? t('طي', 'Collapse', language) : t('عرض المحتوى', 'View content', language)}
                          </button>
                        )}
                      </div>
                      {/* Status badge */}
                      <span className={`shrink-0 ${badge(
                        status === 'done' ? 'success' :
                        status === 'generating' ? 'info' :
                        status === 'error' ? 'danger' : 'neutral'
                      )}`}>
                        {status === 'done' ? t('مكتمل', 'Done', language) :
                         status === 'generating' ? t('جارٍ...', 'Generating…', language) :
                         status === 'error' ? t('خطأ', 'Error', language) :
                         t('معلَّق', 'Pending', language)}
                      </span>
                      {/* Action */}
                      <button
                        className={`shrink-0 ${status === 'done' ? UI.btnGhostSm : UI.btnSubtleSm}`}
                        disabled={!!isGen}
                        onClick={() => handleGenerate(selectedUnit.name, (selectedUnit as any).nameAr || selectedUnit.name, key)}
                      >
                        {isGen
                          ? <span className="flex items-center gap-1"><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />{t('...', '…', language)}</span>
                          : status === 'done'
                            ? t('إعادة', 'Redo', language)
                            : t('توليد', 'Generate', language)}
                      </button>
                    </div>
                    {isExpanded && sec?.content && (
                      <div className="border-t border-slate-100 dark:border-slate-700 px-5 py-4 bg-[#EEF3F5]/50 dark:bg-slate-800/30">
                        <div className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                          {sec.content}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
