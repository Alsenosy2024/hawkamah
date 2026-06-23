// DEV-ONLY governance seed. Used solely to unlock and visually review the later
// GovernanceCenter stages (الواقع الراهن / الهيكل / البناء / التحقق / المكتبة) when
// Firestore is unreachable in local dev (anonymous auth disabled on the project).
//
// Guarded entirely behind `import.meta.env.DEV` + `?seed=1` at the call site, and
// imported dynamically — so it is tree-shaken out of the production bundle and can
// never run against real data. Never persists anything; pure in-memory model.

import type { CompanyGovernanceModel, DocChunk } from '../types';

const P = (label: string) => [{ kind: 'reality' as const, refId: 'seed', label }];
const now = '2026-06-19T00:00:00.000Z';

export function makeSeedModel(tenantId: string, companyName: string): CompanyGovernanceModel {
  const company = companyName || 'شركة تال الإعمارية للمقاولات';
  return {
    tenantId,
    companyName: company,
    updatedAt: now,
    version: 1,
    orgUnits: [
      { id: 'u-board', name: 'مجلس الإدارة', mandate: 'الإشراف الاستراتيجي وإقرار السياسات العليا', objective: 'حوكمة الشركة', feeds: ['u-ceo'], provenance: P('اللائحة › الباب الأول') },
      { id: 'u-ceo', name: 'الرئيس التنفيذي', parentId: 'u-board', mandate: 'القيادة التنفيذية وتحقيق الأهداف', objective: 'تنفيذ الاستراتيجية', feeds: ['u-projects', 'u-fin', 'u-hr'], dependsOn: ['u-board'], provenance: P('اللائحة › الباب الثاني') },
      { id: 'u-projects', name: 'إدارة المشاريع', parentId: 'u-ceo', mandate: 'تخطيط وتنفيذ مشاريع المقاولات والبنية التحتية', objective: 'تسليم المشاريع في الوقت والتكلفة والجودة', dependsOn: ['u-ceo'],
        workflow: [
          { stage: 'الترسية', description: 'استلام أمر العمل وفتح المشروع', responsible: 'مدير المشاريع' },
          { stage: 'التنفيذ', description: 'إدارة المقاول والموقع والجدول الزمني', responsible: 'مدير الموقع' },
          { stage: 'التسليم', description: 'الفحص النهائي وتسليم الوحدات', responsible: 'مهندس الجودة' },
        ], provenance: P('دليل المشاريع › الفصل 3') },
      { id: 'u-fin', name: 'الإدارة المالية', parentId: 'u-ceo', mandate: 'الرقابة المالية والمشتريات والتدفقات النقدية', objective: 'الانضباط المالي', dependsOn: ['u-ceo'], provenance: P('اللائحة المالية') },
      { id: 'u-hr', name: 'إدارة الموارد البشرية', parentId: 'u-ceo', mandate: 'استقطاب وتطوير الكوادر وإدارة الأداء', objective: 'كفاءة رأس المال البشري', dependsOn: ['u-ceo'], provenance: P('لائحة الموارد البشرية') },
    ],
    roles: [
      { id: 'r-ceo', title: 'الرئيس التنفيذي', unitId: 'u-ceo', purpose: 'القيادة العليا للشركة', responsibilities: ['اعتماد الخطط', 'متابعة الأداء', 'تمثيل الشركة'], managerialLevel: 'تنفيذي', relations: { reportsTo: 'مجلس الإدارة', supervises: ['مدير المشاريع', 'المدير المالي', 'مدير الموارد البشرية'] }, provenance: P('الأوصاف الوظيفية') },
      { id: 'r-pm', title: 'مدير المشاريع', unitId: 'u-projects', purpose: 'إدارة محفظة مشاريع المقاولات', responsibilities: ['تخطيط المشاريع', 'إدارة المقاولين', 'ضبط الجدول والتكلفة'], qualifications: { education: 'بكالوريوس هندسة مدنية', experience: '10 سنوات', certifications: 'PMP' }, skills: { technical: ['إدارة المشاريع', 'العقود'], soft: ['القيادة', 'التفاوض'] }, provenance: P('الأوصاف الوظيفية') },
      { id: 'r-fin', title: 'المدير المالي', unitId: 'u-fin', purpose: 'الرقابة المالية', responsibilities: ['إعداد الموازنة', 'الرقابة على المصروفات', 'التقارير المالية'], provenance: P('الأوصاف الوظيفية') },
    ],
    policies: [
      { id: 'p-proc', title: 'سياسة المشتريات والمناقصات', domain: 'Finance', status: 'approved', body: '## الغرض\nتنظيم عمليات الشراء والترسية بشفافية.\n\n## النطاق\nكل مشتريات الشركة فوق 10,000 ريال.\n\n## المبادئ\n- المنافسة العادلة\n- تعدد العروض\n- فصل الصلاحيات', provenance: P('اللائحة المالية › المادة 12') },
      { id: 'p-hse', title: 'سياسة السلامة في مواقع البناء', domain: 'Operations', status: 'in_review', body: '## الغرض\nحماية العاملين في مواقع الإنشاء.\n\n## الالتزامات\n- معدات الوقاية الشخصية\n- تقييم المخاطر اليومي\n- بلاغات الحوادث', provenance: P('دليل السلامة') },
    ],
    procedures: [
      { id: 'pr-tender', title: 'إجراء ترسية المناقصة', unitId: 'u-fin', policyId: 'p-proc', purpose: 'ضمان شفافية الترسية', status: 'approved',
        steps: ['استلام العروض', 'فتح المظاريف بلجنة', 'التقييم الفني والمالي', 'التوصية والاعتماد', 'إصدار أمر العمل'],
        body: '### الخطوات\n1. استلام العروض في الموعد المحدد.\n2. فتح المظاريف بحضور اللجنة.\n3. التقييم الفني ثم المالي.\n4. رفع التوصية للاعتماد.\n5. إصدار أمر العمل للمقاول الفائز.', provenance: P('دليل الإجراءات › إجراء 4') },
    ],
    authorities: [
      { id: 'a-1', decision: 'اعتماد أمر شراء', roleId: 'r-pm', level: 'approve', threshold: 'حتى 50,000 ريال', limit: 'حتى 50,000 ريال', provenance: P('مصفوفة الصلاحيات') },
      { id: 'a-2', decision: 'اعتماد أمر شراء', roleId: 'r-ceo', level: 'approve', threshold: 'فوق 50,000 ريال', limit: 'بلا سقف', provenance: P('مصفوفة الصلاحيات') },
      { id: 'a-3', decision: 'ترسية مناقصة كبرى', roleId: 'r-ceo', level: 'approve', threshold: 'فوق 1,000,000 ريال', provenance: P('مصفوفة الصلاحيات') },
    ],
    kpis: [
      { id: 'k-1', name: 'نسبة تسليم المشاريع في موعدها', unitId: 'u-projects', roleId: 'r-pm', formula: 'المشاريع المسلّمة في الموعد ÷ إجمالي المشاريع', target: '≥ 90%', weight: 40, frequency: 'ربع سنوي', provenance: P('بطاقة الأداء') },
      { id: 'k-2', name: 'انحراف التكلفة', unitId: 'u-projects', roleId: 'r-pm', formula: '(التكلفة الفعلية − المخططة) ÷ المخططة', target: '≤ 5%', weight: 30, frequency: 'شهري', provenance: P('بطاقة الأداء') },
      { id: 'k-3', name: 'معدل الحوادث في المواقع', unitId: 'u-projects', formula: 'عدد الحوادث ÷ ساعات العمل × 200000', target: '≤ 1.0', weight: 30, frequency: 'شهري', provenance: P('بطاقة الأداء') },
    ],
    gaps: [
      { id: 'g-1', area: 'إدارة المخاطر', description: 'لا يوجد سجل مخاطر مؤسسي موحّد لمشاريع المقاولات.', severity: 'high', recommendation: 'إنشاء سجل مخاطر مركزي ومراجعته شهرياً.', matchedProjectIds: [], provenance: P('تحليل الفجوات') },
      { id: 'g-2', area: 'مصفوفة الصلاحيات', description: 'حدود التفويض المالي غير موثّقة لبعض المستويات الوسطى.', severity: 'medium', recommendation: 'توثيق جدول تفويض مالي متكامل لكل المستويات.', matchedProjectIds: [], provenance: P('تحليل الفجوات') },
    ],
    committees: [
      { id: 'c-1', name: 'لجنة الحوكمة والمخاطر', members: ['الرئيس التنفيذي', 'المدير المالي', 'مدير المشاريع'], mandate: 'مراجعة الالتزام وإدارة المخاطر', cadence: 'ربع سنوي', provenance: P('لائحة اللجان') },
      { id: 'c-2', name: 'لجنة المناقصات', members: ['المدير المالي', 'مدير المشاريع'], mandate: 'فتح وتقييم العروض', cadence: 'عند الحاجة' },
    ],
    meetings: [
      { id: 'm-1', type: 'تنفيذية أسبوعية', purpose: 'متابعة سير المشاريع', frequency: 'أسبوعي', attendees: ['الرئيس التنفيذي', 'مدير المشاريع'] },
      { id: 'm-2', type: 'مراجعة أداء ربعية', purpose: 'مراجعة مؤشرات الأداء', frequency: 'ربع سنوي', attendees: ['الرئيس التنفيذي', 'المدراء'] },
    ],
    assessment: {
      id: 'as-1', tenantId, overall: 58, cmmiLevel: '2-3 مُدار نحو مُعرّف', createdAt: now,
      dimensions: [
        { name: 'التخطيط الاستراتيجي', score: 62, label: 'متوسط' },
        { name: 'إدارة المشاريع', score: 70, label: 'جيد' },
        { name: 'الرقابة المالية', score: 55, label: 'متوسط' },
        { name: 'إدارة المخاطر', score: 40, label: 'منخفض' },
        { name: 'الموارد البشرية', score: 60, label: 'متوسط' },
      ],
      swot: {
        strengths: ['خبرة تنفيذية في المقاولات', 'محفظة مشاريع متنوعة'],
        weaknesses: ['ضعف توثيق المخاطر', 'فجوات في مصفوفة الصلاحيات'],
        opportunities: ['التوسع في مشاريع البنية التحتية', 'التحول الرقمي'],
        threats: ['تذبذب أسعار المواد', 'المنافسة على المناقصات'],
      },
    },
    auditLog: [
      { id: 'au-1', at: now, actor: 'system', action: 'seed_model', detail: 'نموذج حوكمة تجريبي (dev)' },
    ],
  };
}

export function makeSeedChunks(tenantId: string): DocChunk[] {
  const base = (i: number, docName: string, headingPath: string, text: string): DocChunk => ({
    id: `seed-chunk-${i}`, tenantId, docId: `seed-doc-${i % 2}`, docName, docKind: 'reality' as any,
    headingPath, text, charStart: 0, ordinal: i, sentiment: { label: 'neutral', score: 0.1 }, createdAt: now,
  });
  return [
    base(1, 'استبيان تقييم الوضع الراهن TAL - SALMAN', 'الاستبيان › المحور الأول', 'يُقيّم المحور الأول مستوى نضج إدارة المشاريع في الشركة من حيث التخطيط والمتابعة.'),
    base(2, 'استبيان تقييم الوضع الراهن TAL - SALMAN', 'الاستبيان › المحور الثاني', 'يتناول المحور الثاني الرقابة المالية وآليات اعتماد المصروفات والمشتريات.'),
    base(3, 'عقد الحوكمة مع شركة مسار الرواد', 'العقد › نطاق العمل', 'يشمل نطاق العمل بناء الهيكل التنظيمي وإعداد دليل السياسات والإجراءات ومصفوفة الصلاحيات.'),
    base(4, 'عقد الحوكمة مع شركة مسار الرواد', 'العقد › المخرجات', 'تتضمن المخرجات دليل الحوكمة ووصفاً وظيفياً لكل وحدة تنظيمية مع مؤشرات الأداء.'),
  ];
}
