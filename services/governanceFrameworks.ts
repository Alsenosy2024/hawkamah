// Governance framework alignment — pure, keyword-based mapping of the model
// against well-known governance frameworks. Deterministic (no AI): each control
// is "covered" if the model has matching policies/procedures/units/authorities,
// "partial" if only weakly referenced, "missing" otherwise.

import type {
  CompanyGovernanceModel, GovFramework, FrameworkAlignment, ControlAlignment, AlignState,
} from '../types';

export const FRAMEWORKS: GovFramework[] = [
  {
    id: 'saudi_cg', name: 'مؤشر الحوكمة السعودي', nameEn: 'Saudi Governance Index',
    controls: [
      { code: 'SG-1', title: 'مجلس الإدارة واختصاصاته', keywords: ['مجلس', 'إدارة', 'board', 'اختصاص', 'صلاحيات المجلس'] },
      { code: 'SG-2', title: 'اللجان المنبثقة', keywords: ['لجنة', 'لجان', 'committee', 'مراجعة', 'ترشيحات', 'مكافآت'] },
      { code: 'SG-3', title: 'الهيكل التنظيمي وتوزيع المسؤوليات', keywords: ['هيكل', 'تنظيمي', 'مسؤوليات', 'أدوار', 'org'] },
      { code: 'SG-4', title: 'إدارة المخاطر', keywords: ['مخاطر', 'risk', 'إدارة المخاطر'] },
      { code: 'SG-5', title: 'المراجعة والرقابة الداخلية', keywords: ['مراجعة', 'رقابة', 'تدقيق', 'audit', 'داخلية'] },
      { code: 'SG-6', title: 'الإفصاح والشفافية', keywords: ['إفصاح', 'شفافية', 'disclosure', 'تقارير'] },
      { code: 'SG-7', title: 'الامتثال', keywords: ['امتثال', 'compliance', 'التزام', 'أنظمة'] },
      { code: 'SG-8', title: 'حقوق أصحاب المصلحة', keywords: ['أصحاب المصلحة', 'stakeholder', 'مساهمين', 'حقوق'] },
    ],
  },
  {
    id: 'nazaha', name: 'نزاهة (مكافحة الفساد)', nameEn: 'Nazaha',
    controls: [
      { code: 'NZ-1', title: 'سياسة مكافحة الفساد', keywords: ['فساد', 'نزاهة', 'رشوة', 'تضارب مصالح'] },
      { code: 'NZ-2', title: 'تضارب المصالح', keywords: ['تضارب', 'مصالح', 'conflict'] },
      { code: 'NZ-3', title: 'الإبلاغ عن المخالفات', keywords: ['إبلاغ', 'مخالفات', 'whistle', 'بلاغات'] },
      { code: 'NZ-4', title: 'مدونة السلوك الوظيفي', keywords: ['سلوك', 'مدونة', 'أخلاقيات', 'code of conduct'] },
      { code: 'NZ-5', title: 'الشفافية في التعاقدات', keywords: ['تعاقد', 'مشتريات', 'منافسات', 'procurement'] },
    ],
  },
  {
    id: 'coso', name: 'COSO (الرقابة الداخلية)', nameEn: 'COSO Internal Control',
    controls: [
      { code: 'CS-1', title: 'بيئة الرقابة', keywords: ['بيئة الرقابة', 'control environment', 'نزاهة', 'قيم'] },
      { code: 'CS-2', title: 'تقييم المخاطر', keywords: ['مخاطر', 'risk assessment', 'تقييم'] },
      { code: 'CS-3', title: 'أنشطة الرقابة', keywords: ['ضوابط', 'إجراءات رقابية', 'control activities', 'صلاحيات'] },
      { code: 'CS-4', title: 'المعلومات والتواصل', keywords: ['معلومات', 'تواصل', 'تقارير', 'information'] },
      { code: 'CS-5', title: 'أنشطة المتابعة', keywords: ['متابعة', 'مراقبة', 'monitoring', 'مؤشرات'] },
    ],
  },
  {
    id: 'iso37000', name: 'ISO 37000 (حوكمة المنظمات)', nameEn: 'ISO 37000',
    controls: [
      { code: 'IO-1', title: 'الغرض المؤسسي', keywords: ['غرض', 'رؤية', 'رسالة', 'purpose', 'قيم'] },
      { code: 'IO-2', title: 'الاستراتيجية والرقابة', keywords: ['استراتيجية', 'strategy', 'أهداف'] },
      { code: 'IO-3', title: 'المساءلة', keywords: ['مساءلة', 'accountability', 'صلاحيات', 'تفويض'] },
      { code: 'IO-4', title: 'إشراك أصحاب المصلحة', keywords: ['أصحاب المصلحة', 'stakeholder', 'إشراك'] },
      { code: 'IO-5', title: 'القيادة', keywords: ['قيادة', 'leadership', 'مجلس', 'تنفيذي'] },
      { code: 'IO-6', title: 'إدارة المخاطر والأداء', keywords: ['مخاطر', 'أداء', 'مؤشرات', 'kpi', 'performance'] },
    ],
  },
  {
    id: 'efqm', name: 'EFQM للتميّز', nameEn: 'EFQM Excellence',
    controls: [
      { code: 'EF-1', title: 'التوجيه (الغرض والاستراتيجية)', keywords: ['غرض', 'استراتيجية', 'رؤية', 'قيادة'] },
      { code: 'EF-2', title: 'ثقافة المنظمة والقيادة', keywords: ['ثقافة', 'قيادة', 'قيم', 'سلوك'] },
      { code: 'EF-3', title: 'إشراك أصحاب المصلحة', keywords: ['أصحاب المصلحة', 'عملاء', 'موظفين', 'شركاء'] },
      { code: 'EF-4', title: 'العمليات والإجراءات', keywords: ['عمليات', 'إجراءات', 'process', 'تشغيل'] },
      { code: 'EF-5', title: 'الأداء والنتائج', keywords: ['نتائج', 'أداء', 'مؤشرات', 'kpi', 'results'] },
    ],
  },
];

// Standards lens — the institutional frameworks injected as EVALUATION CRITERIA
// for the current-state diagnostic. The AI must score maturity AGAINST these and
// cite which control each gap maps to, without inventing facts beyond the inputs.
export function standardsLens(): string {
  const body = FRAMEWORKS.map(fw =>
    `• ${fw.name}${fw.nameEn ? ` (${fw.nameEn})` : ''}: ${fw.controls.map(c => c.title).join('، ')}`
  ).join('\n');
  return `
=== المعايير المرجعية (قيّم النضج مقابلها فقط — لا تخترع وقائع غير واردة في المدخلات) ===
${body}`;
}

function modelHaystack(m: CompanyGovernanceModel): string {
  const parts: string[] = [];
  for (const u of m.orgUnits || []) parts.push(u.name, u.mandate);
  for (const r of m.roles || []) { parts.push(r.title, r.purpose, ...(r.responsibilities || [])); }
  for (const p of m.policies || []) parts.push(p.title, p.domain, p.body);
  for (const pr of m.procedures || []) { parts.push(pr.title, pr.purpose, pr.body, ...(pr.steps || [])); }
  for (const a of m.authorities || []) parts.push(a.decision, a.level);
  for (const k of m.kpis || []) parts.push(k.name, k.formula, k.target);
  return parts.join(' ').toLowerCase();
}

export function alignFramework(m: CompanyGovernanceModel, frameworkId: string): FrameworkAlignment | null {
  const fw = FRAMEWORKS.find(f => f.id === frameworkId);
  if (!fw) return null;
  const hay = modelHaystack(m);

  const controls: ControlAlignment[] = fw.controls.map(c => {
    const hits = c.keywords.filter(k => hay.includes(k.toLowerCase()));
    let state: AlignState = 'missing';
    if (hits.length >= 2) state = 'covered';
    else if (hits.length === 1) state = 'partial';
    return {
      code: c.code, title: c.title, state,
      evidence: hits.length ? `مطابقات: ${hits.slice(0, 4).join('، ')}` : 'لا دليل في النموذج',
    };
  });

  const scoreVal = controls.reduce((s, c) => s + (c.state === 'covered' ? 1 : c.state === 'partial' ? 0.5 : 0), 0);
  const score = Math.round((scoreVal / fw.controls.length) * 100);
  return { frameworkId: fw.id, frameworkName: fw.name, score, controls };
}

export function alignAll(m: CompanyGovernanceModel): FrameworkAlignment[] {
  return FRAMEWORKS.map(f => alignFramework(m, f.id)!).filter(Boolean);
}
