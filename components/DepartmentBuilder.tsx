import React, { useState, useEffect, useCallback } from 'react';
import { UI, badge } from '../services/designTokens';
import { useToast } from './ToastProvider';
import type { CompanyGovernanceModel, DepartmentPackage, DeptSectionKey, Language } from '../types';
import {
  getPackagesForTenant, savePackage, updatePackageSection, deletePackage,
  makeEmptyPackage, generateSection, SECTION_META, ALL_SECTION_KEYS,
} from '../services/departmentService';
import { getStandardsForDepartment } from '../constants/standards';

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

  const handleDelete = useCallback(async (deptName: string) => {
    const pkg = getPackageForDept(deptName);
    if (!pkg) return;
    await deletePackage(pkg.id);
    setPackages(prev => prev.filter(p => p.id !== pkg.id));
    toast.success(t('تم حذف الحزمة.', 'Package deleted.', language));
  }, [packages, language]);

  const selectedUnit = departments.find(d => d.id === selectedDept || d.name === selectedDept);
  const selectedPkg = selectedUnit ? getPackageForDept(selectedUnit.name) : null;
  const standards = selectedUnit ? getStandardsForDepartment(selectedUnit.name) : null;

  if (loading) return (
    <div className="flex items-center justify-center h-48 gap-2 text-slate-500">
      <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      <span>{t('تحميل...', 'Loading…', language)}</span>
    </div>
  );

  if (departments.length === 0) return (
    <div className={`${UI.sectionFrame} p-8 text-center text-slate-500`}>
      <div className="text-4xl mb-3">🏢</div>
      <p className="font-medium">{t('لا توجد وحدات تنظيمية في النموذج.', 'No org units in the model.', language)}</p>
      <p className="text-xs mt-1">{t('ابنِ نموذج الحوكمة أولاً في مرحلة المصادر والنموذج.', 'Build the governance model in Sources & Model stages first.', language)}</p>
    </div>
  );

  return (
    <div className="flex gap-4 h-full" dir={ar ? 'rtl' : 'ltr'}>
      {/* Sidebar — dept list */}
      <div className="w-56 shrink-0 space-y-1 overflow-y-auto">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide px-2 mb-2">
          {t('الإدارات', 'Departments', language)} ({departments.length})
        </h4>
        {departments.map(dept => {
          const pkg = getPackageForDept(dept.name);
          const doneCount = pkg?.sections.filter(s => s.status === 'done').length ?? 0;
          const isSelected = selectedDept === dept.id || selectedDept === dept.name;
          return (
            <button
              key={dept.id}
              className={`w-full text-start px-3 py-2.5 rounded-xl text-sm transition-colors ${
                isSelected
                  ? 'bg-emerald-600 text-white font-semibold shadow'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-700/50 text-slate-700 dark:text-slate-300'
              }`}
              onClick={() => setSelectedDept(dept.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{dept.name}</span>
                {pkg && (
                  <span className={`text-xs shrink-0 ${isSelected ? 'text-emerald-100' : 'text-slate-400'}`}>
                    {doneCount}/{ALL_SECTION_KEYS.length}
                  </span>
                )}
              </div>
              {dept.mandate && (
                <p className={`text-xs truncate mt-0.5 ${isSelected ? 'text-emerald-100' : 'text-slate-400'}`}>
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
          <div className={`${UI.sectionFrame} p-8 text-center text-slate-500`}>
            <div className="text-3xl mb-3">👈</div>
            <p>{t('اختر إدارة من القائمة لبناء حزمتها.', 'Select a department from the list to build its package.', language)}</p>
          </div>
        ) : (
          <>
            {/* Dept header */}
            <div className={`${UI.card} p-4 rounded-xl`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{selectedUnit.name}</h3>
                  {selectedUnit.mandate && (
                    <p className="text-sm text-slate-500 mt-1">{selectedUnit.mandate}</p>
                  )}
                  {standards && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {[...standards.iso, ...standards.frameworks].slice(0, 5).map(s => (
                        <span key={s} className={badge('info')}>{s}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button
                    className={UI.btnPrimary}
                    onClick={() => handleGenerateAll(selectedUnit.name, selectedUnit.name)}
                    disabled={Object.values(generating).some(Boolean)}
                  >
                    {Object.values(generating).some(Boolean)
                      ? `⏳ ${t('جارٍ التوليد...', 'Generating…', language)}`
                      : `🚀 ${t('توليد الكل', 'Generate All', language)}`}
                  </button>
                  {selectedPkg && (
                    <button
                      className={UI.btnGhost}
                      onClick={() => handleDelete(selectedUnit.name)}
                    >
                      🗑 {t('حذف الحزمة', 'Delete Package', language)}
                    </button>
                  )}
                </div>
              </div>
              {selectedPkg && (
                <div className="mt-3">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="text-xs text-slate-500">
                      {selectedPkg.sections.filter(s => s.status === 'done').length} / {ALL_SECTION_KEYS.length} {t('مكتمل', 'complete', language)}
                    </div>
                    {selectedPkg.complete && <span className={badge('success')}>✅ {t('مكتمل', 'Complete', language)}</span>}
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-1.5">
                    <div
                      className="bg-emerald-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${(selectedPkg.sections.filter(s => s.status === 'done').length / ALL_SECTION_KEYS.length) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Sections */}
            <div className="space-y-3">
              {ALL_SECTION_KEYS.map(key => {
                const meta = SECTION_META[key];
                const sec = selectedPkg?.sections.find(s => s.key === key);
                const status = sec?.status ?? 'pending';
                const isGen = generating[key];
                const isExpanded = expanded === key;

                return (
                  <div key={key} className={`${UI.card} rounded-xl overflow-hidden`}>
                    <div className="flex items-center justify-between p-4 gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xl shrink-0">{meta.icon}</span>
                        <div>
                          <div className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                            {ar ? meta.arTitle : meta.enTitle}
                          </div>
                          {status === 'done' && sec?.content && (
                            <button
                              className="text-xs text-emerald-600 hover:underline mt-0.5"
                              onClick={() => setExpanded(prev => prev === key ? null : key)}
                            >
                              {isExpanded ? t('إخفاء', 'Hide', language) : t('عرض المحتوى', 'View content', language)}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={badge(
                          status === 'done' ? 'success' :
                          status === 'generating' ? 'info' :
                          status === 'error' ? 'danger' : 'neutral'
                        )}>
                          {status === 'done' ? t('✓ مكتمل', '✓ Done', language) :
                           status === 'generating' ? t('⏳ جارٍ...', '⏳ Generating…', language) :
                           status === 'error' ? t('✗ خطأ', '✗ Error', language) :
                           t('لم يُنفَّذ', 'Pending', language)}
                        </span>
                        <button
                          className={status === 'done' ? UI.btnGhost : UI.btnSubtle}
                          disabled={isGen}
                          onClick={() => handleGenerate(selectedUnit.name, selectedUnit.name, key)}
                        >
                          {isGen ? '⏳' : status === 'done' ? t('↺ إعادة', '↺ Redo', language) : t('توليد ↗', 'Generate ↗', language)}
                        </button>
                      </div>
                    </div>
                    {isExpanded && sec?.content && (
                      <div className="border-t border-slate-100 dark:border-slate-700 px-4 py-3 bg-slate-50/50 dark:bg-slate-800/30">
                        <pre className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200 font-sans leading-relaxed">
                          {sec.content}
                        </pre>
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
