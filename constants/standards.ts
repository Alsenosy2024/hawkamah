// Institutional Standards Map — خريطة المعايير المؤسسية الشاملة
// Source: Dr. Ahmed Alsenosy's standards mapping document (June 2026)
// 54 official standards + frameworks mapped to organizational departments

export interface DepartmentStandards {
  department: string;
  departmentAr: string;
  iso: string[];
  frameworks: string[];
  regulations: string[];
  professional: string[];
  priority: 'high' | 'medium';
  useCase: string;
  deliverables: string[];
}

export const STANDARDS_MAP: DepartmentStandards[] = [
  {
    department: 'Governance',
    departmentAr: 'الحوكمة المؤسسية',
    iso: ['ISO 37000', 'ISO 37301', 'ISO 37001'],
    frameworks: ['COSO ERM', 'COSO Internal Control', 'EFQM 2020'],
    regulations: ['SOX', 'UK Corporate Governance Code'],
    professional: [],
    priority: 'high',
    useCase: 'لوائح المجلس، اللجان، التفويضات، تضارب المصالح، الامتثال، مكافحة الرشوة',
    deliverables: ['Governance Manual', 'Board Charters', 'Delegation of Authority Matrix', 'Conflict of Interest Policy', 'Compliance Register'],
  },
  {
    department: 'Strategy',
    departmentAr: 'الاستراتيجية والتميز',
    iso: ['ISO 9001', 'ISO 9004', 'ISO 22316'],
    frameworks: ['EFQM Model 2020', 'Baldrige Excellence Framework', 'CAF'],
    regulations: [],
    professional: [],
    priority: 'high',
    useCase: 'ربط الرؤية بالمؤشرات، تقييم النضج، التحسين المؤسسي، إدارة الأداء الاستراتيجي',
    deliverables: ['Quality Manual', 'Strategic Map', 'KPI Dictionary', 'Balanced Scorecard', 'Management Review Procedure'],
  },
  {
    department: 'HumanResources',
    departmentAr: 'الموارد البشرية',
    iso: ['ISO 30414', 'ISO 30415', 'ISO 30401'],
    frameworks: ['Investors in People'],
    regulations: [],
    professional: ['SHRM BASK', 'CIPD Profession Map'],
    priority: 'high',
    useCase: 'تخطيط القوى العاملة، كفاءات HR، رأس المال البشري، التنوع، إدارة المعرفة',
    deliverables: ['HR Policy', 'Competency Framework', 'Job Descriptions', 'Training Matrix', 'Human Capital Dashboard', 'Succession Plan'],
  },
  {
    department: 'Finance',
    departmentAr: 'المالية والمحاسبة',
    iso: ['IFRS', 'IPSAS'],
    frameworks: ['COSO Internal Control'],
    regulations: ['SOX', 'GAAP'],
    professional: ['IMA/CMA', 'CIMA/CGMA'],
    priority: 'high',
    useCase: 'تقارير مالية، رقابة داخلية، تكلفة، موازنات، أداء مالي، امتثال سوق المال',
    deliverables: ['Financial Policies', 'Budgeting Procedure', 'Cost Control Manual', 'Internal Control Matrix', 'Financial Closing Calendar'],
  },
  {
    department: 'RiskAudit',
    departmentAr: 'المخاطر والتدقيق الداخلي',
    iso: ['ISO 31000', 'ISO 22301', 'ISO 37301'],
    frameworks: ['COSO ERM', 'IIA Standards', 'Three Lines Model'],
    regulations: ['UK Orange Book'],
    professional: ['IIA'],
    priority: 'high',
    useCase: 'سجل المخاطر، شهية المخاطر، خطة التدقيق، متابعة المعالجات، استمرارية الأعمال',
    deliverables: ['ERM Policy', 'Risk Appetite Statement', 'Risk Register', 'Internal Audit Charter', 'Annual Audit Plan', 'Corrective Action Tracker'],
  },
  {
    department: 'PMO',
    departmentAr: 'إدارة المشاريع والـPMO',
    iso: ['ISO 21502', 'ISO 21500'],
    frameworks: ['PMI PMBOK 7th', 'PRINCE2', 'APM BoK', 'MoP', 'MSP', 'P3M3'],
    regulations: [],
    professional: ['PMI', 'APM'],
    priority: 'high',
    useCase: 'منهجية المشاريع، البوابات، الحوكمة، التقارير، إدارة التغيير، محافظ المشاريع',
    deliverables: ['PMO Charter', 'Project Lifecycle', 'Stage Gates', 'Project Templates', 'Portfolio Dashboard', 'Change Control Procedure'],
  },
  {
    department: 'HSE',
    departmentAr: 'الصحة والسلامة والبيئة',
    iso: ['ISO 45001', 'ISO 45003', 'ISO 22320'],
    frameworks: ['IOSH/NEBOSH'],
    regulations: ['OSHA', 'NFPA 101', 'NFPA 70'],
    professional: ['IOSH', 'NEBOSH'],
    priority: 'high',
    useCase: 'سلامة العاملين والمواقع، الحريق، الطوارئ، الصحة النفسية، المقاولين',
    deliverables: ['HSE Policy', 'HSE Plan', 'JSA', 'PTW System', 'Incident Reporting Procedure', 'Emergency Response Plan'],
  },
  {
    department: 'PhysicalSecurity',
    departmentAr: 'الأمن المادي',
    iso: ['ISO 18788', 'ISO 28000'],
    frameworks: ['ASIS SRA'],
    regulations: ['ANSI/ASIS PSC 1'],
    professional: ['ASIS'],
    priority: 'high',
    useCase: 'أمن المنشآت، حراسة، دخول وخروج، أمن سلسلة الإمداد، تقييم مخاطر أمنية',
    deliverables: ['Physical Security Policy', 'Access Control Procedure', 'Security Risk Assessment', 'Guard Post Orders'],
  },
  {
    department: 'Cybersecurity',
    departmentAr: 'الأمن السيبراني',
    iso: ['ISO/IEC 27001', 'ISO/IEC 27002', 'ISO/IEC 27701'],
    frameworks: ['NIST CSF 2.0', 'CIS Controls v8'],
    regulations: ['GDPR', 'NIST SP 800-53'],
    professional: ['ISACA', 'ISC²'],
    priority: 'high',
    useCase: 'سياسات أمن المعلومات، إدارة الثغرات، الهوية، الوصول، الاستجابة للحوادث السيبرانية',
    deliverables: ['ISMS Policy', 'Asset Register', 'Access Control Policy', 'Incident Response Plan', 'Vulnerability Management Procedure'],
  },
  {
    department: 'IT',
    departmentAr: 'تقنية المعلومات',
    iso: ['ISO/IEC 20000-1', 'ISO/IEC 38500'],
    frameworks: ['COBIT 2019', 'ITIL 4', 'TOGAF'],
    regulations: [],
    professional: ['ISACA', 'PeopleCert'],
    priority: 'medium',
    useCase: 'حوكمة IT، إدارة الخدمات، إدارة التغيير التقني، المعمارية، الأداء، القيمة من IT',
    deliverables: ['IT Governance Policy', 'IT Service Catalog', 'Change Management Procedure', 'Architecture Blueprint'],
  },
  {
    department: 'AI',
    departmentAr: 'الذكاء الاصطناعي والبيانات',
    iso: ['ISO/IEC 42001', 'ISO/IEC 27701'],
    frameworks: ['NIST AI RMF', 'NIST Privacy Framework'],
    regulations: ['EU AI Act', 'GDPR'],
    professional: [],
    priority: 'medium',
    useCase: 'حوكمة AI، تقييم أثر النماذج، الخصوصية، المخاطر الأخلاقية، إدارة البيانات',
    deliverables: ['AI Governance Policy', 'AI Impact Assessment', 'Data Privacy Policy', 'Model Risk Register', 'Ethical AI Guidelines'],
  },
  {
    department: 'Procurement',
    departmentAr: 'المشتريات والعقود',
    iso: ['ISO 20400', 'ISO 44001'],
    frameworks: ['FIDIC', 'NEC4'],
    regulations: ['FAR'],
    professional: ['CIPS'],
    priority: 'medium',
    useCase: 'حوكمة الموردين، الاستدامة، تقييم العروض، العقود، المطالبات، العلاقات التعاونية',
    deliverables: ['Procurement Policy', 'Supplier Evaluation Matrix', 'Contract Review Procedure', 'Claims Register', 'Vendor Risk Assessment'],
  },
  {
    department: 'Operations',
    departmentAr: 'العمليات والأصول',
    iso: ['ISO 55001', 'ISO 50001', 'ISO 22301'],
    frameworks: ['CMMI', 'Lean Six Sigma', 'IAM Framework'],
    regulations: [],
    professional: ['IAM'],
    priority: 'medium',
    useCase: 'إدارة الأصول، الصيانة، الطاقة، استمرارية التشغيل، كفاءة العمليات التشغيلية',
    deliverables: ['Asset Management Policy', 'Maintenance Procedure', 'Energy Management Plan', 'Business Continuity Plan', 'Operational KPIs'],
  },
  {
    department: 'ESG',
    departmentAr: 'الاستدامة والمسؤولية',
    iso: ['ISO 14001', 'ISO 26000', 'ISO 50001'],
    frameworks: ['GRI Standards', 'ESRS/CSRD', 'EU taxonomy'],
    regulations: ['SEC Climate Disclosure'],
    professional: ['SASB/ISSB'],
    priority: 'medium',
    useCase: 'الأثر البيئي، المسؤولية الاجتماعية، الطاقة، الإفصاح، مؤشرات ESG',
    deliverables: ['Environmental Policy', 'ESG KPI Dashboard', 'Energy Baseline Report', 'Sustainability Report'],
  },
  {
    department: 'KnowledgeInnovation',
    departmentAr: 'إدارة المعرفة والابتكار',
    iso: ['ISO 30401', 'ISO 56002'],
    frameworks: ['EFQM learning & innovation', 'Baldrige innovation', 'APQC'],
    regulations: [],
    professional: ['APQC'],
    priority: 'medium',
    useCase: 'إدارة المعرفة، الدروس المستفادة، الابتكار، التحسين المستمر، التوثيق المؤسسي',
    deliverables: ['Knowledge Management Policy', 'Lessons Learned Register', 'Innovation Procedure', 'Continuous Improvement Log'],
  },
];

export function getStandardsForDepartment(deptName: string): DepartmentStandards | undefined {
  if (!deptName) return undefined;
  const lower = deptName.toLowerCase().trim();
  return STANDARDS_MAP.find(s => {
    if (s.department.toLowerCase() === lower) return true;
    if (s.departmentAr === deptName) return true;
    if (lower.includes(s.department.toLowerCase())) return true;
    return s.departmentAr.split(/\s+/).some(w => w.length > 3 && deptName.includes(w));
  });
}

export function formatStandardsForPrompt(std: DepartmentStandards): string {
  const lines: string[] = [`الإدارة: ${std.departmentAr}`];
  if (std.iso.length) lines.push(`معايير ISO: ${std.iso.join('، ')}`);
  if (std.frameworks.length) lines.push(`أطر الحوكمة: ${std.frameworks.join('، ')}`);
  if (std.regulations.length) lines.push(`التنظيمات: ${std.regulations.join('، ')}`);
  if (std.professional.length) lines.push(`المعايير المهنية: ${std.professional.join('، ')}`);
  lines.push(`حالة الاستخدام: ${std.useCase}`);
  return lines.join('\n');
}

export function formatAllStandardsForPrompt(): string {
  return STANDARDS_MAP.map(s => {
    const all = [...s.iso, ...s.frameworks].slice(0, 4);
    return `• ${s.departmentAr}: ${all.join('، ')}`;
  }).join('\n');
}
