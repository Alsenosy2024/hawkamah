
export interface DocCatalogEntry {
  key: string;
  ar: string;
  en: string;
  icon: string;
  category: string;
  frameworks: string[];
  title: string;
  goal: string;
  defaultPages: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface CatalogCategory {
  key: string;
  ar: string;
  en: string;
  icon: string;
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { key: 'governance', ar: 'الحوكمة والاستراتيجية', en: 'Governance & Strategy', icon: '🏛️' },
  { key: 'hr', ar: 'الموارد البشرية', en: 'Human Resources', icon: '👥' },
  { key: 'finance', ar: 'الشؤون المالية', en: 'Finance', icon: '💰' },
  { key: 'operations', ar: 'العمليات التشغيلية', en: 'Operations', icon: '⚙️' },
  { key: 'quality', ar: 'الجودة والتميز', en: 'Quality & Excellence', icon: '✅' },
  { key: 'risk', ar: 'المخاطر والتدقيق', en: 'Risk & Audit', icon: '⚠️' },
  { key: 'legal', ar: 'القانوني والامتثال', en: 'Legal & Compliance', icon: '⚖️' },
  { key: 'it', ar: 'تقنية المعلومات', en: 'Information Technology', icon: '💻' },
  { key: 'projects', ar: 'إدارة المشاريع', en: 'Project Management', icon: '📁' },
];

/** المكتبة المرجعية للمعايير الدولية وأفضل الممارسات — تُحقن في prompts التوليد
 *  حتى يستشهد كل مستند صراحةً بالمعايير المعتمدة وبنودها ذات الصلة. */
export const STANDARDS_LIB: Record<string, string> = {
  'ISO 9001': 'ISO 9001:2015 — نظام إدارة الجودة: نهج العمليات، دورة PDCA، التفكير المبني على المخاطر، البنود 4–10',
  'ISO 9001:2015': 'ISO 9001:2015 — نظام إدارة الجودة: سياق المنظمة (بند 4)، القيادة (5)، التخطيط (6)، الدعم (7)، التشغيل (8)، تقييم الأداء (9)، التحسين (10)',
  'EFQM': 'نموذج التميز الأوروبي EFQM 2020 — التوجه (الغاية/الرؤية/الاستراتيجية)، التنفيذ (إشراك أصحاب المصلحة، خلق القيمة المستدامة)، النتائج (إدراك أصحاب المصلحة، الأداء الاستراتيجي والتشغيلي)',
  'EFQM 2020': 'نموذج التميز EFQM 2020 — منطق RADAR للتقييم: النتائج، المنهجيات، التطبيق، التقييم والتحسين',
  'KAQA': 'جائزة الملك عبدالعزيز للجودة — معاييرها الثمانية: القيادة الإدارية، التخطيط الاستراتيجي، الموارد البشرية، الموردون والشركاء، العمليات، المستفيدون، أثر المنظمة على المجتمع، نتائج الأعمال',
  'McKinsey 7S': 'إطار ماكنزي 7S — مواءمة: الاستراتيجية، الهيكل، الأنظمة، القيم المشتركة، المهارات، الأسلوب، الكوادر',
  'PwC Governance': 'منهجية PwC للحوكمة — وضوح الأدوار بين المجلس والإدارة التنفيذية، أجندة المجلس السنوية، تقييم فاعلية المجلس، ثقافة المخاطر',
  'BSC': 'بطاقة الأداء المتوازن (Harvard/Kaplan & Norton) — المنظورات الأربعة: المالي، العملاء، العمليات الداخلية، التعلم والنمو، مع خرائط الاستراتيجية',
  'OKR': 'منهجية OKR — أهداف طموحة + 3-5 نتائج رئيسية قابلة للقياس لكل هدف، إيقاع ربع سنوي، فصل التقييم عن المكافآت',
  'PESTLE': 'تحليل PESTLE — العوامل السياسية، الاقتصادية، الاجتماعية، التقنية، القانونية، البيئية',
  'SHRM': 'إطار SHRM للموارد البشرية — نموذج الكفاءات SHRM BoCK، دورة حياة الموظف، ربط ممارسات HR بالاستراتيجية',
  'CIPD': 'إطار مهنة الأفراد CIPD — المبادئ الأساسية: العمل المبني على الأدلة، خلق القيمة، نماذج التطوير المهني',
  'ISO 30401': 'ISO 30401 — نظام إدارة المعرفة: تطوير وتداول وحفظ المعرفة المؤسسية',
  'ISO 38500': 'ISO/IEC 38500 — حوكمة التقنية: مبادئ المسؤولية، الاستراتيجية، الاقتناء، الأداء، المطابقة، السلوك الإنساني',
  'OECD': 'مبادئ الحوكمة OECD/G20 — حقوق المساهمين، المعاملة العادلة، دور أصحاب المصلحة، الإفصاح والشفافية، مسؤوليات مجلس الإدارة',
  'COSO': 'إطار COSO للرقابة الداخلية — المكونات الخمسة: بيئة الرقابة، تقييم المخاطر، أنشطة الرقابة، المعلومات والاتصال، المتابعة',
  'COSO ERM': 'COSO ERM 2017 — إدارة المخاطر المؤسسية: الحوكمة والثقافة، الاستراتيجية ووضع الأهداف، الأداء، المراجعة، المعلومات',
  'ISO 31000:2018': 'ISO 31000:2018 — إدارة المخاطر: المبادئ، الإطار (القيادة والالتزام)، العملية (تحديد السياق، تقييم، معالجة، متابعة)',
  'IIA': 'معايير IIA الدولية للتدقيق الداخلي (IPPF) — الاستقلالية والموضوعية، التدقيق المبني على المخاطر',
  'IIA IPPF': 'الإطار المهني الدولي IPPF — معايير الصفات (1000s) ومعايير الأداء (2000s) للتدقيق الداخلي',
  'IFRS': 'المعايير الدولية للتقرير المالي IFRS — أساس الإعداد والعرض والإفصاح في القوائم المالية',
  'ISO 20400': 'ISO 20400 — المشتريات المستدامة: دمج الاستدامة في سياسة واستراتيجية وعمليات الشراء',
  'CIPS': 'دورة المشتريات CIPS — 13 مرحلة من تحديد الحاجة حتى إدارة علاقة المورّد وإغلاق العقد',
  'LEAN': 'منهجية Lean — إزالة الهدر (Muda) السبعة، تدفق القيمة، التحسين المستمر Kaizen',
  'Six Sigma': 'منهجية Six Sigma — DMAIC: تعريف، قياس، تحليل، تحسين، ضبط — لخفض التباين في العمليات',
  'BPMN 2.0': 'معيار BPMN 2.0 — ترميز نمذجة العمليات: الأحداث، الأنشطة، البوابات، مسارات السباحة',
  'ISO 22301': 'ISO 22301 — استمرارية الأعمال: تحليل تأثير الأعمال BIA، استراتيجيات الاستمرارية، أهداف RTO/RPO',
  'NIST': 'إطار NIST للأمن السيبراني — تحديد، حماية، اكتشاف، استجابة، تعافٍ',
  'ISO 37301': 'ISO 37301 — نظام إدارة الامتثال: تحديد الالتزامات، تقييم مخاطر الامتثال، ثقافة الالتزام',
  'ISO 37001': 'ISO 37001 — نظام مكافحة الرشوة: العناية الواجبة، الضوابط المالية وغير المالية، قنوات الإبلاغ',
  'ISO 26000': 'ISO 26000 — المسؤولية المجتمعية: الحوكمة، حقوق الإنسان، ممارسات العمل، البيئة، الممارسات العادلة',
  'UN Global Compact': 'الميثاق العالمي للأمم المتحدة — 10 مبادئ في حقوق الإنسان والعمل والبيئة ومكافحة الفساد',
  'ISO 37500': 'ISO 37500 — التعهيد الخارجي: حوكمة الاتفاقيات، إدارة دورة حياة العلاقة التعاقدية',
  'FIDIC': 'عقود FIDIC — توزيع المخاطر بين الأطراف، إدارة التغييرات والمطالبات في العقود',
  'COBIT 2019': 'COBIT 2019 — حوكمة المعلومات والتقنية: أهداف الحوكمة EDM وأهداف الإدارة APO/BAI/DSS/MEA',
  'ITIL': 'ITIL 4 — إدارة خدمات التقنية: سلسلة قيمة الخدمة، الممارسات الـ34، مبادئ التوجيه السبعة',
  'DAMA DMBOK': 'إطار DAMA DMBOK — مجالات معرفة إدارة البيانات الـ11: الحوكمة، الجودة، الأمن، النمذجة، التكامل',
  'ISO 27001': 'ISO/IEC 27001 — أمن المعلومات: تقييم مخاطر الأمن، ضوابط الملحق A، بيان قابلية التطبيق SoA',
  'GDPR': 'اللائحة الأوروبية GDPR — مبادئ معالجة البيانات الشخصية: المشروعية، تقليل البيانات، حقوق أصحاب البيانات',
  'CX': 'أفضل ممارسات تجربة العميل — خريطة رحلة العميل، مؤشرات NPS/CSAT/CES، إغلاق حلقة الملاحظات',
  'PMI PMBOK 7': 'دليل PMBOK الإصدار 7 (PMI) — مبادئ الأداء الـ12 ومجالات الأداء الثمانية: أصحاب المصلحة، الفريق، النهج، التخطيط، العمل، التسليم، القياس، عدم اليقين',
  'PRINCE2': 'منهجية PRINCE2 (AXELOS) — المبادئ السبعة، الثيمات السبع، العمليات السبع، مبررات العمل المستمرة',
  'ISO 21502': 'ISO 21502 — إرشادات إدارة المشاريع: الحوكمة، الممارسات المتكاملة، إدارة المنافع',
  'AXELOS P3O': 'إطار P3O (AXELOS) — هيكلة مكاتب المحافظ والبرامج والمشاريع: الأدوار والوظائف والأدوات',
  'PMI PMO': 'معيار PMI لمكاتب إدارة المشاريع — نماذج PMO (داعم/ضابط/موجِّه)، قياس قيمة المكتب',
};

/** Build a prompt directive from framework keys — every generated document must
 *  embed and cite these standards explicitly. Unknown keys pass through as-is. */
export function frameworksDirective(keys: string[]): string {
  if (!keys?.length) return '';
  const lines = keys.map(k => `- ${STANDARDS_LIB[k] || k}`).join('\n');
  // N10: standards are cited in ONE consolidated section at the END of the document
  // only — NOT inline after every clause. Inline citations (the old «وفق ISO 9001 بند 8.5»
  // sprinkled per policy) cluttered the body and read like a checklist. The body stays
  // clean and professional; the standards basis lives in a final reference section.
  return `المعايير الدولية وأفضل الممارسات التي يستند إليها هذا المستند:
${lines}
متطلبات إلزامية بخصوص الاستناد المعياري:
1) اكتب متن المستند (السياسات/الإجراءات/المصفوفات) بلغة قرار احترافية **دون** حشو إشارات معيارية داخل كل بند. لا تكتب «وفق ISO 9001 بند ...» بعد كل فقرة.
2) اجمع كل الاستناد المعياري في قسم واحد فقط بعنوان «الاستناد المعياري» يوضع في **نهاية المستند**، يسرد المعايير أعلاه وعلاقة كل منها بالمستند، ويتضمن جدول مواءمة (Compliance Mapping) يربط أقسام المستند بالمعايير.
3) طبّق أفضل ممارسات ماكنزي وPwC في الصياغة (لغة قرار، جداول RACI، مؤشرات قابلة للقياس) دون ذكر أسماء المعايير في المتن.`;
}

export const GOV_DOC_CATALOG: DocCatalogEntry[] = [

  // ─── GOVERNANCE & STRATEGY ───────────────────────────────────────────────
  {
    key: 'governance_manual',
    ar: 'دليل الحوكمة المؤسسية', en: 'Corporate Governance Manual',
    icon: '🏛️', category: 'governance', frameworks: ['ISO 38500', 'EFQM', 'OECD', 'PwC Governance', 'KAQA'],
    title: 'دليل الحوكمة المؤسسية الشامل',
    goal: 'الإطار الكامل للحوكمة: مبادئ الحوكمة، هيكل مجلس الإدارة ولجانه، الأدوار والمسؤوليات، ضوابط الرقابة والإشراف، متطلبات الإفصاح والشفافية، حقوق أصحاب المصلحة.',
    defaultPages: 40, priority: 'critical',
  },
  {
    key: 'strategy_doc',
    ar: 'الوثيقة الاستراتيجية', en: 'Strategic Plan',
    icon: '🎯', category: 'governance', frameworks: ['EFQM', 'BSC', 'OKR', 'McKinsey 7S', 'PESTLE'],
    title: 'الوثيقة الاستراتيجية للمنظمة',
    goal: 'الرؤية والرسالة والقيم المؤسسية، التحليل الاستراتيجي (SWOT/PESTLE)، الأهداف الاستراتيجية 3-5 سنوات، المبادرات الاستراتيجية، خارطة الطريق التنفيذية، مؤشرات الأداء الاستراتيجية.',
    defaultPages: 35, priority: 'critical',
  },
  {
    key: 'current_state',
    ar: 'تقرير الواقع الراهن', en: 'Current State Assessment',
    icon: '📊', category: 'governance', frameworks: ['EFQM', 'COSO', 'McKinsey 7S', 'KAQA'],
    title: 'تقرير تشخيص وتقييم الواقع الراهن',
    goal: 'التشخيص الشامل للوضع الحالي: الهيكل التنظيمي، الأدوار والمسؤوليات، العمليات الجوهرية، الفجوات التنظيمية والتشغيلية، المخاطر القائمة، المقارنة بالمعايير الدولية وتحديد فرص التحسين.',
    defaultPages: 25, priority: 'critical',
  },
  {
    key: 'authority_matrix',
    ar: 'مصفوفة الصلاحيات والتفويضات', en: 'Delegation of Authority',
    icon: '⚖️', category: 'governance', frameworks: ['ISO 38500', 'COSO', 'IIA'],
    title: 'دليل الصلاحيات والتفويضات المؤسسية',
    goal: 'مصفوفة الصلاحيات التفصيلية لجميع المستويات الإدارية والتنفيذية: صلاحيات الاعتماد، التفويض والتفويض المُنقلب، الحدود المالية والإدارية والتشغيلية، إجراءات الاستثناءات، مراجعة الصلاحيات.',
    defaultPages: 20, priority: 'critical',
  },

  // ─── HUMAN RESOURCES ─────────────────────────────────────────────────────
  {
    key: 'hr_policy',
    ar: 'دليل سياسات الموارد البشرية', en: 'HR Policy Manual',
    icon: '👥', category: 'hr', frameworks: ['ISO 30401', 'SHRM', 'CIPD'],
    title: 'دليل سياسات وإجراءات الموارد البشرية',
    goal: 'سياسات شاملة: الاستقطاب والتعيين، الإعداد والتهيئة، التدريب والتطوير، إدارة الأداء، الحوافز والمكافآت، الانضباط والتظلمات، إنهاء الخدمة، بيئة العمل، الصحة والسلامة المهنية، المساواة والتنوع والشمول.',
    defaultPages: 40, priority: 'high',
  },
  {
    key: 'org_structure',
    ar: 'الهيكل التنظيمي والأوصاف الوظيفية', en: 'Org Structure & Job Descriptions',
    icon: '🏢', category: 'hr', frameworks: ['ISO 38500', 'SHRM'],
    title: 'وثيقة الهيكل التنظيمي والوصف الوظيفي الشامل',
    goal: 'الهيكل التنظيمي المقترح بجميع مستوياته، خرائط التبعية والإبلاغ، الوصف الوظيفي التفصيلي لكل منصب (المهام، المتطلبات، الكفاءات)، مسارات الترقي، نقاط التنسيق الوظيفي.',
    defaultPages: 45, priority: 'high',
  },
  {
    key: 'performance_mgmt',
    ar: 'نظام إدارة الأداء', en: 'Performance Management System',
    icon: '📈', category: 'hr', frameworks: ['ISO 30401', 'EFQM', 'OKR', 'BSC', 'SHRM'],
    title: 'نظام إدارة الأداء المؤسسي المتكامل',
    goal: 'إطار قياس الأداء الفردي والمؤسسي: بطاقة الأهداف والنتائج (OKRs)، مؤشرات الأداء لكل مستوى وظيفي، دورات التقييم الدورية، ربط الأداء بالحوافز والترقي، خطط التطوير الفردي، آليات التغذية الراجعة.',
    defaultPages: 30, priority: 'high',
  },
  {
    key: 'competency_framework',
    ar: 'إطار الكفاءات والمهارات', en: 'Competency Framework',
    icon: '🎓', category: 'hr', frameworks: ['ISO 30401', 'SHRM'],
    title: 'إطار الكفاءات والمهارات المؤسسية',
    goal: 'الكفاءات الجوهرية (Core Competencies) والوظيفية (Functional) والقيادية لكل مسار وظيفي، مستويات الإتقان وعلاماتها السلوكية، خرائط التطوير المهني، أدوات قياس الكفاءات، برامج تنمية المواهب.',
    defaultPages: 30, priority: 'medium',
  },

  // ─── FINANCE ─────────────────────────────────────────────────────────────
  {
    key: 'finance_policy',
    ar: 'دليل السياسات والإجراءات المالية', en: 'Financial Policies & Procedures',
    icon: '💰', category: 'finance', frameworks: ['COSO', 'IFRS', 'ISO 38500'],
    title: 'دليل السياسات والإجراءات المالية الشامل',
    goal: 'السياسات المالية الكاملة: الميزانية والتخطيط المالي، المحاسبة وإعداد القوائم، المدفوعات والتحصيل، إدارة الخزينة، الرقابة الداخلية المالية، التقارير المالية الدورية، التدقيق الداخلي وضمان الجودة المالية.',
    defaultPages: 35, priority: 'high',
  },
  {
    key: 'procurement_policy',
    ar: 'دليل المشتريات والتعاقدات', en: 'Procurement Policy Manual',
    icon: '🛒', category: 'finance', frameworks: ['ISO 20400', 'CIPS'],
    title: 'دليل سياسات وإجراءات المشتريات والتعاقدات',
    goal: 'دورة المشتريات الكاملة: التخطيط وتحديد الاحتياجات، تأهيل الموردين ومسجّل الموافقين، طرق التسعير (مناقصة/عروض/اتفاقية إطارية)، التفاوض وإبرام العقود، الاستلام والمراجعة، تقييم الموردين وإدارة العلاقة.',
    defaultPages: 30, priority: 'high',
  },

  // ─── OPERATIONS ──────────────────────────────────────────────────────────
  {
    key: 'operations_manual',
    ar: 'دليل العمليات والإجراءات التشغيلية', en: 'Operations Manual',
    icon: '⚙️', category: 'operations', frameworks: ['ISO 9001', 'LEAN', 'Six Sigma'],
    title: 'دليل العمليات والإجراءات التشغيلية',
    goal: 'خريطة العمليات الكاملة للمنظمة، الإجراءات التفصيلية لكل عملية رئيسية (المدخلات، الخطوات، المخرجات، نقاط التحقق)، مؤشرات الكفاءة التشغيلية KPIs، نماذج وسجلات العمل الرسمية، إجراءات التعامل مع الانحرافات.',
    defaultPages: 50, priority: 'high',
  },
  {
    key: 'process_maps',
    ar: 'موسوعة خرائط العمليات', en: 'Process Maps & SOPs',
    icon: '🗺️', category: 'operations', frameworks: ['ISO 9001', 'BPMN 2.0'],
    title: 'موسوعة خرائط العمليات والإجراءات التشغيلية القياسية',
    goal: 'رسم تدفق العمليات الرئيسية والداعمة بمنهجية BPMN 2.0، خرائط مسار السباحة (Swimlane) للعمليات المشتركة، نقاط البوابة والقرار، المدخلات والمخرجات والمسؤوليات لكل عملية، إجراءات التحسين المستمر.',
    defaultPages: 45, priority: 'medium',
  },
  {
    key: 'business_continuity',
    ar: 'خطة استمرارية الأعمال', en: 'Business Continuity Plan',
    icon: '🔄', category: 'operations', frameworks: ['ISO 22301', 'NIST'],
    title: 'خطة استمرارية الأعمال والتعافي من الكوارث',
    goal: 'تحليل تأثير الأعمال (BIA)، تقييم المخاطر وسيناريوهات التهديد، استراتيجيات الاستمرارية والمرونة، إجراءات الاستجابة للطوارئ، خطة التعافي وأهداف وقت الاسترداد (RTO/RPO)، اختبار الخطة ومراجعتها الدورية.',
    defaultPages: 30, priority: 'medium',
  },

  // ─── QUALITY & EXCELLENCE ─────────────────────────────────────────────────
  {
    key: 'quality_manual',
    ar: 'دليل نظام إدارة الجودة', en: 'Quality Management Manual',
    icon: '✅', category: 'quality', frameworks: ['ISO 9001:2015', 'KAQA', 'EFQM 2020'],
    title: 'دليل نظام إدارة الجودة ISO 9001:2015',
    goal: 'سياسة الجودة وأهدافها القابلة للقياس، سياق المنظمة وأصحاب المصلحة، متطلبات التوثيق والسجلات، ضبط العمليات ومراقبة الجودة، رضا العميل وإدارة الشكاوى، التحسين المستمر وإجراءات التصحيح الوقائي.',
    defaultPages: 45, priority: 'high',
  },
  {
    key: 'efqm_self_assessment',
    ar: 'التقييم الذاتي EFQM', en: 'EFQM Self-Assessment Report',
    icon: '🏆', category: 'quality', frameworks: ['EFQM 2020', 'KAQA'],
    title: 'تقرير التقييم الذاتي وفق نموذج التميز EFQM',
    goal: 'تقييم المنظمة عبر معايير EFQM التسعة: القيادة، الاستراتيجية، الأفراد، الشراكات والموارد، العمليات، نتائج العملاء، الأفراد، المجتمع، نتائج الأعمال الرئيسية — مع نقاط القوة وفرص التحسين.',
    defaultPages: 40, priority: 'medium',
  },
  {
    key: 'customer_experience',
    ar: 'دليل إدارة تجربة العميل', en: 'Customer Experience Manual',
    icon: '🤝', category: 'quality', frameworks: ['EFQM', 'ISO 9001', 'CX'],
    title: 'دليل إدارة وتحسين تجربة العميل',
    goal: 'رحلة العميل الكاملة (Customer Journey Map)، نقاط التماس ومعايير الخدمة لكل نقطة، مؤشرات رضا العميل (NPS/CSAT/CES)، إجراءات الشكاوى والمقترحات، خطط تحسين الخدمة، قياس أثر التحسينات.',
    defaultPages: 25, priority: 'medium',
  },

  // ─── RISK & AUDIT ─────────────────────────────────────────────────────────
  {
    key: 'risk_management',
    ar: 'إطار ودليل إدارة المخاطر', en: 'Risk Management Framework',
    icon: '⚠️', category: 'risk', frameworks: ['ISO 31000:2018', 'COSO ERM'],
    title: 'إطار ودليل إدارة المخاطر المؤسسية',
    goal: 'منهجية تحديد وتقييم وترتيب المخاطر، خريطة المخاطر الحرارية، سجل المخاطر التفصيلي لكل قطاع، خطط الاستجابة (تجنب/نقل/تخفيف/قبول)، مؤشرات الإنذار المبكر (KRIs)، حوكمة المخاطر ومتابعتها.',
    defaultPages: 40, priority: 'high',
  },
  {
    key: 'internal_audit',
    ar: 'ميثاق وأدلة التدقيق الداخلي', en: 'Internal Audit Charter & Manual',
    icon: '🔍', category: 'risk', frameworks: ['IIA IPPF', 'COSO'],
    title: 'ميثاق التدقيق الداخلي ودليل الممارسات',
    goal: 'ميثاق التدقيق الداخلي (استقلالية/نطاق/صلاحيات)، منهجية التدقيق القائم على المخاطر، خطة التدقيق السنوية، إجراءات التدقيق الميداني، إعداد تقارير التدقيق ومتابعة التوصيات، قياس جودة التدقيق.',
    defaultPages: 30, priority: 'medium',
  },

  // ─── LEGAL & COMPLIANCE ──────────────────────────────────────────────────
  {
    key: 'compliance_manual',
    ar: 'دليل الامتثال والالتزام المؤسسي', en: 'Compliance Manual',
    icon: '⚖️', category: 'legal', frameworks: ['ISO 37301', 'ISO 37001'],
    title: 'دليل الامتثال المؤسسي والالتزام التنظيمي',
    goal: 'إطار الامتثال الشامل: المتطلبات القانونية والتنظيمية المحلية والدولية، سياسات الامتثال لكل قطاع، آليات الرقابة والتحقق، نظام الإبلاغ عن المخالفات، برامج التوعية والتدريب، تقارير الامتثال الدورية.',
    defaultPages: 35, priority: 'high',
  },
  {
    key: 'ethics_code',
    ar: 'ميثاق الأخلاقيات وقواعد السلوك', en: 'Code of Ethics & Conduct',
    icon: '🌟', category: 'legal', frameworks: ['ISO 26000', 'EFQM', 'UN Global Compact'],
    title: 'ميثاق الأخلاقيات وقواعد السلوك المهني',
    goal: 'مبادئ النزاهة والشفافية والمساءلة، قواعد السلوك المهني لجميع المستويات، تعارض المصالح وإجراءات الإفصاح، الهدايا والترفيه ومكافحة الرشوة، قنوات الإبلاغ عن المخالفات وحماية المُبلِّغين، العقوبات والتبعات.',
    defaultPages: 25, priority: 'high',
  },
  {
    key: 'contract_management',
    ar: 'إدارة العقود', en: 'Contract Management Policy',
    icon: '📄', category: 'legal', frameworks: ['ISO 37500', 'FIDIC'],
    title: 'دليل إدارة العقود والاتفاقيات',
    goal: 'دورة حياة العقود الكاملة: مراجعة مسودات العقود، التفاوض والتوقيع، الصلاحيات المعتمدة، متابعة الالتزامات، إدارة التغييرات والنزاعات، سجل العقود، تجديد وإنهاء العقود، إدارة علاقة الأطراف.',
    defaultPages: 25, priority: 'medium',
  },

  // ─── IT ──────────────────────────────────────────────────────────────────
  {
    key: 'it_governance',
    ar: 'إطار حوكمة تقنية المعلومات', en: 'IT Governance Framework',
    icon: '💻', category: 'it', frameworks: ['COBIT 2019', 'ISO 38500', 'ITIL'],
    title: 'إطار وسياسات حوكمة تقنية المعلومات',
    goal: 'حوكمة التقنية والرقابة الاستراتيجية على الاستثمارات التقنية، سياسات أمن المعلومات وحماية البيانات، إدارة البنية التحتية والاستمرارية، إدارة التغيير والتطوير التقني، مستوى الخدمة (SLA/OLA)، حوكمة المشاريع التقنية.',
    defaultPages: 40, priority: 'medium',
  },
  {
    key: 'data_governance',
    ar: 'سياسة حوكمة وإدارة البيانات', en: 'Data Governance Policy',
    icon: '🗄️', category: 'it', frameworks: ['DAMA DMBOK', 'ISO 27001', 'GDPR'],
    title: 'سياسة حوكمة البيانات وإدارة المعلومات',
    goal: 'ملكية البيانات وحارسوها (Data Stewards)، تصنيف البيانات ومستويات الحماية، جودة البيانات وضوابط دقتها، حماية الخصوصية والامتثال لأنظمة البيانات الشخصية، دورة حياة البيانات (إنشاء/تخزين/حذف)، الاسترداد والنسخ الاحتياطي.',
    defaultPages: 30, priority: 'medium',
  },

  // ─── INTEGRITY, CONFLICT OF INTEREST & WHISTLEBLOWING ───────────────────
  {
    key: 'coi_register',
    ar: 'سجل تعارض المصالح', en: 'Conflict of Interest Register',
    icon: '⚖️', category: 'legal', frameworks: ['ISO 37001', 'ISO 26000', 'OECD'],
    title: 'سياسة وسجل تعارض المصالح',
    goal: 'تعريف تعارض المصالح وأنواعه (مالي/شخصي/عائلي)، إجراء الإفصاح الإلزامي والدوري، سجل حالات التعارض المُبلَّغ عنها وقراراتها، آلية استبعاد المتعارض عن القرار، عقوبات الإخفاء، مراجعة سنوية لإقرارات الذمة المالية.',
    defaultPages: 20, priority: 'high',
  },
  {
    key: 'whistleblowing_policy',
    ar: 'سياسة الإبلاغ عن المخالفات', en: 'Whistleblowing Policy',
    icon: '🔔', category: 'legal', frameworks: ['ISO 37001', 'ISO 37301', 'UN Global Compact'],
    title: 'سياسة الإبلاغ عن المخالفات وحماية المُبلِّغين',
    goal: 'قنوات الإبلاغ السرية (خط ساخن/بريد/منصة)، تعريف المخالفات القابلة للإبلاغ، ضمانات السرية وعدم الانتقام، إجراء التحقيق والتصعيد، آليات الرد على المُبلِّغ، تقرير سنوي عن حالات الإبلاغ، حماية المُبلِّغ بحسن نية قانونياً.',
    defaultPages: 20, priority: 'high',
  },
  {
    key: 'policy_review_calendar',
    ar: 'جدول مراجعة السياسات', en: 'Policy Review Calendar',
    icon: '📅', category: 'governance', frameworks: ['ISO 9001', 'ISO 37301', 'EFQM'],
    title: 'إطار وجدول مراجعة وتحديث السياسات المؤسسية',
    goal: 'سجل كامل بجميع السياسات المعتمدة ومواعيد مراجعتها الدورية (سنوية/نصف سنوية)، مشغّل المراجعة ومسؤول الاعتماد لكل سياسة، سجل تغييرات الإصدارات وأسبابها، إجراءات المراجعة الاستثنائية عند تغيّر القوانين، آلية نشر السياسات المحدَّثة وإشعار المعنيين.',
    defaultPages: 15, priority: 'medium',
  },
  {
    key: 'compliance_register',
    ar: 'سجل الامتثال التنظيمي', en: 'Compliance Register',
    icon: '📋', category: 'legal', frameworks: ['ISO 37301', 'COSO ERM', 'ISO 31000:2018'],
    title: 'سجل الامتثال التنظيمي والقانوني الشامل',
    goal: 'جرد شامل لكل المتطلبات التنظيمية والقانونية والتعاقدية المنطبقة على المنظمة، حالة الامتثال لكل متطلب (ممتثل/قيد التنفيذ/فجوة)، المسؤول عن الامتثال والموعد النهائي، سجل العقوبات والمخالفات السابقة والإجراءات التصحيحية، تقارير الامتثال الربع سنوية للإدارة.',
    defaultPages: 25, priority: 'high',
  },
  {
    key: 'local_regulations',
    ar: 'الاشتراطات التنظيمية المحلية', en: 'Local Regulatory Requirements',
    icon: '🏛️', category: 'legal', frameworks: ['ISO 37301', 'ISO 37001', 'OECD'],
    title: 'دليل الاشتراطات التنظيمية والقانونية المحلية',
    goal: 'رصد شامل للتشريعات والأنظمة المحلية ذات الصلة بنشاط المنظمة (قانون الشركات، نظام العمل، الأنظمة القطاعية، متطلبات الترخيص والسجلات)، التزامات التجديد والإفصاح، التحديثات التنظيمية الجديدة وأثرها، بروتوكول التعامل مع الجهات التنظيمية، جدول مواعيد الالتزامات الدورية.',
    defaultPages: 25, priority: 'high',
  },

  // ─── COMMUNICATION & GOVERNANCE DOCUMENTS ────────────────────────────────
  {
    key: 'communication_policy',
    ar: 'سياسة الاتصال المؤسسي', en: 'Communication Policy',
    icon: '📢', category: 'governance', frameworks: ['EFQM', 'ISO 9001'],
    title: 'سياسة وإجراءات الاتصال المؤسسي الداخلي والخارجي',
    goal: 'استراتيجية الاتصال الداخلي والخارجي، قنوات الاتصال الرسمية وبروتوكولات كل قناة، اجتماعات الحوكمة وضوابط إعداد المحاضر والقرارات، التواصل مع أصحاب المصلحة، إدارة الأزمات الإعلامية، تقارير الأداء الدورية.',
    defaultPages: 20, priority: 'medium',
  },
  {
    key: 'system_procedures',
    ar: 'وثيقة النظام والإجراءات', en: 'System & Procedures Manual',
    icon: '📋', category: 'operations', frameworks: ['ISO 9001', 'ISO 38500'],
    title: 'وثيقة النظام والإجراءات الإدارية والتشغيلية',
    goal: 'السياسات الجوهرية للمنظمة، الإجراءات التشغيلية القياسية (SOPs) لكل قسم، مصفوفة الصلاحيات المختصرة، ضوابط التشغيل الرئيسية، النماذج والسجلات الإدارية الرسمية، إجراءات المراجعة والتحديث الدوري.',
    defaultPages: 45, priority: 'critical',
  },

  // ─── PROJECT MANAGEMENT ──────────────────────────────────────────────────
  {
    key: 'pm_methodology',
    ar: 'منهجية إدارة المشاريع', en: 'Project Management Methodology',
    icon: '📁', category: 'projects', frameworks: ['PMI PMBOK 7', 'PRINCE2', 'ISO 21502'],
    title: 'دليل منهجية إدارة المشاريع المؤسسية',
    goal: 'منهجية موحّدة لإدارة المشاريع: دورة حياة المشروع ومراحله وبواباته، إدارة النطاق والجدول والتكلفة والجودة، إدارة مخاطر المشاريع، إدارة أصحاب المصلحة والتواصل، حوكمة التغيير، قوالب ونماذج المشروع القياسية (ميثاق، خطة، تقارير حالة، سجل دروس مستفادة).',
    defaultPages: 40, priority: 'high',
  },
  {
    key: 'pmo_charter',
    ar: 'ميثاق مكتب إدارة المشاريع', en: 'PMO Charter & Operating Model',
    icon: '🗂️', category: 'projects', frameworks: ['PMI PMO', 'AXELOS P3O', 'PRINCE2'],
    title: 'ميثاق مكتب إدارة المشاريع ونموذج التشغيل',
    goal: 'تأسيس وتشغيل مكتب إدارة المشاريع: نموذج المكتب (داعم/ضابط/موجِّه) ومبررات الاختيار، الأدوار والمسؤوليات، حوكمة المحفظة وترتيب أولويات المشاريع، منهجية اعتماد وإيقاف المشاريع، لوحات متابعة الأداء ومؤشرات نجاح المكتب، خطة نضج المكتب.',
    defaultPages: 25, priority: 'medium',
  },
];

/** Returns recommended document keys based on governance model state */
export function recommendDocuments(
  modelData: {
    departments?: { name: string }[];
    policies?: unknown[];
    procedures?: unknown[];
    roles?: unknown[];
    gaps?: { area: string }[];
    kpis?: unknown[];
  },
  existingDocKinds: string[],
): { key: string; reason: string; priority: 'critical' | 'high' | 'medium' }[] {
  const recs: { key: string; reason: string; priority: 'critical' | 'high' | 'medium' }[] = [];
  const has = (k: string) => existingDocKinds.includes(k);

  if (!has('governance_manual'))
    recs.push({ key: 'governance_manual', reason: 'لم تُصدَر وثيقة حوكمة مؤسسية بعد — أساس كل إجراءات التحويل', priority: 'critical' });

  if (!has('current_state'))
    recs.push({ key: 'current_state', reason: 'تقرير الواقع الراهن ضروري قبل أي خطوات تطويرية', priority: 'critical' });

  if (!has('authority_matrix'))
    recs.push({ key: 'authority_matrix', reason: 'مصفوفة الصلاحيات توقف الازدواجية وتوضح التفويضات', priority: 'critical' });

  if (!has('system_procedures'))
    recs.push({ key: 'system_procedures', reason: 'وثيقة النظام والإجراءات هي العمود الفقري لأي نظام إدارة', priority: 'critical' });

  const deptCount = modelData.departments?.length ?? 0;
  if (deptCount > 0 && !has('org_structure'))
    recs.push({ key: 'org_structure', reason: `${deptCount} إدارة في النموذج بدون هيكل تنظيمي موثّق`, priority: 'high' });

  const gapCount = modelData.gaps?.length ?? 0;
  if (gapCount > 0 && !has('risk_management'))
    recs.push({ key: 'risk_management', reason: `${gapCount} فجوة في النموذج تستدعي إطار إدارة مخاطر`, priority: 'high' });

  const policiesCount = modelData.policies?.length ?? 0;
  if (policiesCount > 3 && !has('compliance_manual'))
    recs.push({ key: 'compliance_manual', reason: `${policiesCount} سياسة تحتاج إطار امتثال يجمعها ويُفعّلها`, priority: 'high' });

  const proceduresCount = modelData.procedures?.length ?? 0;
  if (proceduresCount > 3 && !has('operations_manual'))
    recs.push({ key: 'operations_manual', reason: `${proceduresCount} إجراء بحاجة لدليل عمليات موحّد`, priority: 'high' });

  if (deptCount > 5 && !has('hr_policy'))
    recs.push({ key: 'hr_policy', reason: `${deptCount} إدارة دون سياسات موارد بشرية موثّقة`, priority: 'high' });

  if (modelData.kpis && (modelData.kpis as unknown[]).length > 0 && !has('performance_mgmt'))
    recs.push({ key: 'performance_mgmt', reason: 'توجد مؤشرات أداء في النموذج — وثّق نظام إدارة الأداء', priority: 'medium' });

  if (!has('ethics_code'))
    recs.push({ key: 'ethics_code', reason: 'ميثاق الأخلاقيات إلزامي لأي منظمة تحكّمية', priority: 'high' });

  if (!has('strategy_doc'))
    recs.push({ key: 'strategy_doc', reason: 'الوثيقة الاستراتيجية تُترجم الرؤية إلى أهداف وخطة عمل', priority: 'high' });

  return recs;
}
