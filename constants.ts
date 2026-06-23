import { JobRole, Language } from './types';

// Localize Western digits (0-9) and the percent sign to Arabic-Indic when rendering in Arabic.
const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
export const localizeNum = (val: number | string, language: Language): string => {
  const s = String(val);
  if (language !== 'ar') return s;
  return s.replace(/[0-9]/g, d => ARABIC_DIGITS[Number(d)]).replace(/%/g, '٪');
};

export const JOB_ROLES: JobRole[] = [
  { id: 1, title_en: 'Frontend Developer', title_ar: 'مطور واجهات أمامية', category: 'IT' },
  { id: 2, title_en: 'Backend Developer', title_ar: 'مطور خلفية', category: 'IT' },
  { id: 3, title_en: 'Data Scientist', title_ar: 'عالم بيانات', category: 'Data' },
  { id: 4, title_en: 'Project Manager', title_ar: 'مدير مشروع', category: 'Management' },
  { id: 5, title_en: 'UX/UI Designer', title_ar: 'مصمم تجربة المستخدم', category: 'Design' },
  { id: 6, title_en: 'Marketing Specialist', title_ar: 'أخصائي تسويق', category: 'Marketing' },
  { id: 7, title_en: 'Human Resources Manager', title_ar: 'مدير الموارد البشرية', category: 'HR' },
  { id: 8, title_en: 'Operations Manager', title_ar: 'مدير العمليات التشغيلية', category: 'Management' },
];

// Sector → job-titles catalog. A company's `industry` (sector) selects the set of
// roles a candidate sees. Each sector key is matched by Arabic/English keywords
// against the company's `industry` string (see resolveSectorKey). `general` is the
// fallback for unknown/empty sectors.
type SectorKey =
  | 'construction' | 'it' | 'healthcare' | 'finance' | 'retail'
  | 'education' | 'manufacturing' | 'hospitality' | 'logistics'
  | 'realestate' | 'energy' | 'general';

// Keyword → sector. Order matters (first hit wins). Lowercased substring match.
const SECTOR_KEYWORDS: { key: SectorKey; words: string[] }[] = [
  { key: 'construction',  words: ['مقاول', 'إنشاء', 'انشاء', 'بناء', 'تشييد', 'construct', 'contract', 'civil', 'build'] },
  { key: 'it',            words: ['تقنية', 'برمج', 'معلومات', 'تكنولوج', 'software', 'tech', 'it', 'saas', 'digital', 'data'] },
  { key: 'healthcare',    words: ['صح', 'طب', 'مستشف', 'دواء', 'health', 'medic', 'hospital', 'clinic', 'pharma'] },
  { key: 'finance',       words: ['مال', 'بنك', 'مصرف', 'استثمار', 'تأمين', 'محاسب', 'financ', 'bank', 'invest', 'insur', 'account', 'fintech'] },
  { key: 'retail',        words: ['تجزئة', 'بيع', 'تسوق', 'retail', 'commerce', 'store', 'shop', 'fmcg'] },
  { key: 'education',     words: ['تعليم', 'تدريب', 'مدرس', 'جامع', 'educat', 'train', 'school', 'academ', 'learn'] },
  { key: 'manufacturing', words: ['تصنيع', 'صناع', 'مصنع', 'إنتاج', 'manufactur', 'factory', 'industr', 'production'] },
  { key: 'hospitality',   words: ['ضياف', 'فندق', 'مطعم', 'سياح', 'hospitalit', 'hotel', 'restaurant', 'tourism', 'f&b'] },
  { key: 'logistics',     words: ['لوجست', 'نقل', 'شحن', 'توريد', 'إمداد', 'logist', 'transport', 'shipping', 'supply', 'freight'] },
  { key: 'realestate',    words: ['عقار', 'أملاك', 'real estate', 'property', 'realty'] },
  { key: 'energy',        words: ['طاقة', 'نفط', 'بترول', 'غاز', 'كهرب', 'energy', 'oil', 'gas', 'power', 'petro', 'utilit'] },
];

const role = (id: number, en: string, ar: string, cat: string): JobRole => ({ id, title_en: en, title_ar: ar, category: cat });

export const SECTOR_ROLES: Record<SectorKey, JobRole[]> = {
  construction: [
    role(101, 'Site Engineer', 'مهندس موقع', 'Engineering'),
    role(102, 'Project Manager', 'مدير مشروع', 'Management'),
    role(103, 'Quantity Surveyor', 'مساح كميات', 'Engineering'),
    role(104, 'Safety Officer (HSE)', 'مسؤول السلامة', 'HSE'),
    role(105, 'Procurement Specialist', 'أخصائي مشتريات', 'Procurement'),
    role(106, 'Construction Foreman', 'مشرف تنفيذ', 'Operations'),
    role(107, 'Civil Engineer', 'مهندس مدني', 'Engineering'),
    role(108, 'Contracts Manager', 'مدير عقود', 'Management'),
    role(109, 'Construction Manager', 'مدير الإنشاءات', 'Management'),
    role(110, 'Construction Engineer', 'مهندس الإنشاءات', 'Engineering'),
    role(111, 'MEP Engineer', 'مهندس ميكانيكا وكهرباء وصرف', 'Engineering'),
    role(112, 'Planning Engineer', 'مهندس تخطيط', 'Engineering'),
    role(113, 'Cost Control Engineer', 'مهندس مراقبة تكاليف', 'Engineering'),
    role(114, 'BIM Engineer', 'مهندس نمذجة معلومات البناء', 'Engineering'),
  ],
  it: [
    role(201, 'Frontend Developer', 'مطور واجهات أمامية', 'IT'),
    role(202, 'Backend Developer', 'مطور خلفية', 'IT'),
    role(203, 'DevOps Engineer', 'مهندس DevOps', 'IT'),
    role(204, 'Data Scientist', 'عالم بيانات', 'Data'),
    role(205, 'Product Manager', 'مدير منتج', 'Management'),
    role(206, 'QA Engineer', 'مهندس جودة برمجيات', 'IT'),
    role(207, 'IT Support Specialist', 'أخصائي دعم تقني', 'IT'),
    role(208, 'Cybersecurity Analyst', 'محلل أمن سيبراني', 'Security'),
  ],
  healthcare: [
    role(301, 'Physician', 'طبيب', 'Clinical'),
    role(302, 'Registered Nurse', 'ممرض', 'Clinical'),
    role(303, 'Pharmacist', 'صيدلي', 'Clinical'),
    role(304, 'Lab Technician', 'فني مختبر', 'Clinical'),
    role(305, 'Hospital Administrator', 'مدير مستشفى', 'Management'),
    role(306, 'Medical Records Officer', 'مسؤول السجلات الطبية', 'Operations'),
  ],
  finance: [
    role(401, 'Accountant', 'محاسب', 'Finance'),
    role(402, 'Financial Analyst', 'محلل مالي', 'Finance'),
    role(403, 'Auditor', 'مدقق حسابات', 'Finance'),
    role(404, 'Relationship Manager', 'مدير علاقات', 'Management'),
    role(405, 'Risk & Compliance Officer', 'مسؤول المخاطر والالتزام', 'Compliance'),
    role(406, 'Treasury Specialist', 'أخصائي خزينة', 'Finance'),
  ],
  retail: [
    role(501, 'Store Manager', 'مدير فرع', 'Management'),
    role(502, 'Sales Associate', 'مندوب مبيعات', 'Sales'),
    role(503, 'Merchandiser', 'منسق عرض بضائع', 'Operations'),
    role(504, 'Category Manager', 'مدير فئة منتجات', 'Management'),
    role(505, 'Cashier Supervisor', 'مشرف صناديق', 'Operations'),
  ],
  education: [
    role(601, 'Teacher / Instructor', 'معلم / مدرب', 'Academic'),
    role(602, 'Academic Coordinator', 'منسق أكاديمي', 'Management'),
    role(603, 'Curriculum Designer', 'مصمم مناهج', 'Academic'),
    role(604, 'Student Affairs Officer', 'مسؤول شؤون الطلاب', 'Operations'),
  ],
  manufacturing: [
    role(701, 'Production Supervisor', 'مشرف إنتاج', 'Operations'),
    role(702, 'Quality Control Inspector', 'مفتش جودة', 'Quality'),
    role(703, 'Maintenance Engineer', 'مهندس صيانة', 'Engineering'),
    role(704, 'Plant Manager', 'مدير مصنع', 'Management'),
    role(705, 'Supply Chain Planner', 'مخطط سلسلة إمداد', 'Operations'),
  ],
  hospitality: [
    role(801, 'Front Office Manager', 'مدير مكتب أمامي', 'Management'),
    role(802, 'Chef / Kitchen Lead', 'شيف / رئيس مطبخ', 'Operations'),
    role(803, 'Guest Relations Officer', 'مسؤول علاقات النزلاء', 'Operations'),
    role(804, 'Housekeeping Supervisor', 'مشرف إشراف داخلي', 'Operations'),
  ],
  logistics: [
    role(901, 'Logistics Coordinator', 'منسق لوجستي', 'Operations'),
    role(902, 'Warehouse Manager', 'مدير مستودع', 'Management'),
    role(903, 'Fleet Supervisor', 'مشرف أسطول', 'Operations'),
    role(904, 'Supply Chain Analyst', 'محلل سلسلة إمداد', 'Operations'),
  ],
  realestate: [
    role(1001, 'Real Estate Consultant', 'مستشار عقاري', 'Sales'),
    role(1002, 'Property Manager', 'مدير أملاك', 'Management'),
    role(1003, 'Leasing Officer', 'مسؤول تأجير', 'Operations'),
    role(1004, 'Facilities Manager', 'مدير مرافق', 'Operations'),
  ],
  energy: [
    role(1101, 'Process Engineer', 'مهندس عمليات', 'Engineering'),
    role(1102, 'Field Operator', 'مشغل ميداني', 'Operations'),
    role(1103, 'HSE Engineer', 'مهندس سلامة وصحة وبيئة', 'HSE'),
    role(1104, 'Maintenance Planner', 'مخطط صيانة', 'Operations'),
  ],
  general: JOB_ROLES,
};

// Map a free-text sector string to a SectorKey via keyword match.
export const resolveSectorKey = (industry?: string): SectorKey => {
  const s = (industry || '').toLowerCase();
  if (!s.trim()) return 'general';
  for (const { key, words } of SECTOR_KEYWORDS) {
    if (words.some(w => s.includes(w))) return key;
  }
  return 'general';
};

// Resolve the job titles a candidate should see for a given company:
// explicit per-company override wins, else sector-derived, else general.
export const getRolesForCompany = (company?: { jobRoles?: JobRole[]; industry?: string } | null): JobRole[] => {
  if (company?.jobRoles && company.jobRoles.length) return company.jobRoles;
  return SECTOR_ROLES[resolveSectorKey(company?.industry)] || JOB_ROLES;
};

export const QUESTION_COUNTS: number[] = [10, 20, 30, 40, 50];

export const TRANSLATIONS = {
  en: {
    appName: 'Axiom AI Corporate Evaluator',
    welcome: 'Welcome to AI Corporate Interviewer',
    welcomeSub: 'Integrated Organizational Readiness, Competency Benchmarking, and ISO/EFQM Work Environment Assessment.',
    name: 'Full Name',
    email: 'Email Address',
    start: 'Start Candidate Gate',
    signInWithGoogle: 'Sign in with Google',
    selectJob: 'Select Corporate Job Role',
    selectNumQuestions: 'Number of Questions (Set by Admin)',
    generate: 'Start Technical & Behavioral Assessment',
    assessment: 'Assessment',
    question: 'Question',
    of: 'of',
    next: 'Next',
    finish: 'Finish Assessment',
    results: 'Comprehensive Assessment Reports',
    totalScore: 'Overall Competency Score',
    strengths: 'Identified Core Strengths',
    weaknesses: 'Identified Areas for Development',
    recommendations: 'Strategic Training Recommendations',
    restart: 'Start New Journey',
    generatingReport: 'Conducting Deep Competency & Gap Analysis with AI...',
    verbalInterview: 'Start Live Verbal Assessment',
    competencyBreakdown: 'Competency Analysis (Birkman, Holland & Bloom)',
    downloadPdf: 'Download Extended PDF Reports',
    aiIsSpeaking: 'AI Interviewer speaking...',
    listening: 'Listening to response...',
    submitAnswer: 'Submit Answer',
    custom: 'Custom Count',
    enterNumQuestions: 'Enter question count',
    endExam: 'End Exam & Save',
    timeLeft: 'Time Remaining',
    candidateDetails: 'Candidate / Employee Profile',
    jobDescription: 'Strategic Context (Optional)',
    jobDescriptionPlaceholder: 'Add internal department protocols or details to align assessment...',
    
    // Admin & Work environment translations
    adminGate: 'Admin Control Center',
    candidateGate: 'Employee/Candidate Gate',
    orgKnowledgeGraph: 'Organization Knowledge Graph & Repository',
    orgKnowledgeExplain: 'Upload and organize organization identity files (vision, mission, current state assessments, policies) to contextualize the interview questions generated by AI.',
    documentList: 'Managed Organization Identity Files',
    addDoc: 'Add Document',
    docName: 'Document Name',
    docCategory: 'Document Category',
    docContent: 'Document Content (Text or Pasted PDF content)',
    pastedPlaceholder: 'Paste the company vision, actual status, infrastructure reports, or current practices here...',
    adminSettings: 'Assessment Methodology Controls',
    methodsExplain: 'Activate the specific psychological and scientific methods to use for Scenario-Based Assessment.',
    birkmanText: 'Birkman Method (Environmental Prefs & Behaviors)',
    hollandText: 'Holland Codes RIASEC (Occupational Personality)',
    psychTechText: 'Psych Tech Standard (Behavioral Metrics)',
    bloomText: 'Bloom’s Cognitive Taxonomy (Applying, Evaluating, Creating)',
    saveSettings: 'Save Configurations',
    workplaceSurveyTitle: 'Work Environment Assessment (ISO & EFQM)',
    workplaceSurveyExplain: 'Evaluate organization procedures, digital infrastructure, challenges, and coworker relations based on quality standards.',
    surveyIntro: 'This section captures your direct assessment of the actual organization practices, tools, and developmental opportunities. Your responses directly generate the Workplace Environment feedback report.',
    proceduresLabel: 'Procedures and Administrative Policies',
    proceduresDesc: 'Describe the efficiency of internal procedures, policies, and administrative workflows.',
    digitalLabel: 'Digital Infrastructure and Systems',
    digitalDesc: 'Evaluate available digital tools, remote access readiness, and IT infrastructure.',
    challengesLabel: 'Pressing Challenges and Bottlenecks',
    challengesDesc: 'What major day-to-day work obstacles, operational delays, or challenges do you face?',
    employeeRelationsLabel: 'Relations and Cooperation with Coworkers',
    employeeRelationsDesc: 'Assess cooperation and teamwork across different departments.',
    aspirationsLabel: 'Aspirations and Desired Workplace Growth',
    aspirationsDesc: 'What is your vision for your development, and what dreams do you have for the company?',
    reconstructionLabel: 'Organizational Redesign & Restructuring Opinions',
    reconstructionDesc: 'If reorganizing the institution, what recommendations do you have for restructuring?',
    startSurvey: 'Proceed to Workplace Environment Assessment',
    generatingSurveyReport: 'Analyzing responses based on ISO 9001 and EFQM Excellence framework...',
    surveyReportTitle: 'Organizational Context & Work Environment Report',
    technicalScoreText: 'Technical Competency Rating',
    behavioralScoreText: 'Behavioral Traits Rating',
    gapAnalysisTitle: 'Competency Gap Analysis & Fit Report',
    gapExplanation: 'Analysis comparing the current position standard against the candidate/employee\'s shown competence rates, identifying training requirements.',
    positionStandard: 'Core Competency',
    actualPerformance: 'Assessed Level',
    gapStatus: 'Deviation / Training Need',
    eligibleRolesTitle: 'Alternate Role Eligibility & Direct Matching',
    eligibleRolesExplain: 'Alternate positions within the organization that the candidate is qualified for based on their cognitive levels (Bloom) and personality (Holland).',
    noGapsMsg: 'No critical competency gaps found. Outstanding match.',
    workEnvironmentScore: 'Work Environment Index / Readiness',
    isoEfqmTitle: 'ISO 9001 & EFQM Model Quality Breakdown',
    infrastructureLevel: 'Digital Preparedness Level',
    currentStatusSurveyLabel: 'Organizational Realities & Environmental Analysis',
    managementRecsTitle: 'Strategic Management Recommendations',
    employeeAspirations: 'Operational Aspirations',
    challengesTitle: 'Key Identified Obstacles & Operations Blockers'
  },
  ar: {
    appName: 'منصة حوكمة لتقييم الجدارات والتميز المؤسسي',
    welcome: 'مرحباً بك في منصة حوكمة الذكية',
    welcomeSub: 'منصة متكاملة لقياس جدارات الموظفين والتطوير الهيكلي والتحليل التخصصي لبيئة العمل وفق متطلبات الجودة والتميز الأوروبي EFQM.',
    name: 'الاسم الكامل للموظف/المرشح',
    email: 'البريد الإلكتروني',
    start: 'دخول بوابة الموظف',
    signInWithGoogle: 'تسجيل الدخول مع جوجل',
    selectJob: 'اختر المسمى الوظيفي المراد تقييمه',
    selectNumQuestions: 'عدد أسئلة الامتحان (يحدده المسؤول)',
    generate: 'بدء التقييم الفني والسلوكي المشترك',
    assessment: 'جلسة التقييم',
    question: 'سؤال',
    of: 'من',
    next: 'التالي',
    finish: 'إنهاء جلسة الأسئلة',
    results: 'تقارير الأداء الفني والسلوكي وتحليل بيئة العمل',
    totalScore: 'الدرجة الكلية للجدارات والذكاء الوظيفي',
    strengths: 'نقاط القوة الأساسية المرصودة',
    weaknesses: 'الفجوات ونقاط التطوير المقترحة',
    recommendations: 'خطة التدريب والتوصيات الاستراتيجية والمستقبلية',
    restart: 'بدء تقييم جديد لموظف آخر',
    generatingReport: 'جاري إجراء نموذج فحص الجدارات وتحليل الفجوات...',
    verbalInterview: 'بدء المقابلة الشفهية التفاعلية',
    competencyBreakdown: 'تحليل أبعاد الجدارات (بريكمان، هولاند، هرم بلوم المعرفي)',
    downloadPdf: 'تحميل التقارير الموسعة PDF لملف الموظف',
    aiIsSpeaking: 'المحاور الذكي يتحدث الآن...',
    listening: 'جاري الاستماع لتسجيل الموظف...',
    submitAnswer: 'تأكيد وإرسال الإجابة',
    custom: 'تحديد عدد مخصص',
    enterNumQuestions: 'أدخل عدد الأسئلة المطلوبة',
    endExam: 'إنهاء الاختبار وحفظ الإجابات الحالية',
    timeLeft: 'الوقت المتبقي',
    candidateDetails: 'بيانات الموظف / المرشح الخاضع للتقييم',
    jobDescription: 'السياق التنظيمي أو الوصف (اختياري)',
    jobDescriptionPlaceholder: 'الصق هنا متطلبات الإدارة أو الوصف الوظيفي تفصيلياً لربط الجدارات...',
    
    // Admin & Work environment translations
    adminGate: 'بوابة الإدارة والمسؤول (التحكم بالواقع الراهن والمعرفة)',
    candidateGate: 'بوابة الموظف / المرشح للتقييم',
    orgKnowledgeGraph: 'قاعدة المعرفة وهوية المؤسسة (Organization Knowledge Graph)',
    orgKnowledgeExplain: 'قم برفع/كتابة وثائق الهوية، تقييم الواقع الراهن، السياسات، وأي معلومات تنظيمية للشركة. سيفهمها النظام بالكامل ويقوم بصناعة الأسئلة لتطابق بيئة ومشاريع الشركة الحقيقية.',
    documentList: 'وثائق الهوية والواقع الراهن المدخلة حالياً للمؤسسة',
    addDoc: 'إضافة وثيقة جديدة للواقع الراهن',
    docName: 'اسم الوثيقة / الملف المعرفي',
    docCategory: 'نوع الوثيقة التنظيمية',
    docContent: 'محتوى ونصوص الملف (أو الصق مخرجات الوثيقة)',
    pastedPlaceholder: 'اكتب أو الصق مسببات الواقع الراهن، أو رؤية ومشاريع الشركة، أو وثائق البنية التحتية والسياسات المتبعة...',
    adminSettings: 'إدارة أطر الجدارات والأسئلة (للأدمن)',
    methodsExplain: 'تفعل الأطر التحليلية للذكاء السلوكي والفني والسياريوهات المعتمدة (Scenario-Based):',
    birkmanText: 'منهجية بريكمان (Birkman) - السلوك البيئي والدوافع والاحتياجات',
    hollandText: 'منهجية هولاند RIASEC - الأنماط المهنية والشخصية الوظيفية',
    psychTechText: 'معايير سايك تيك (Psych Tech) للتقييم النفسي والمهني وسلوكيات العمل',
    bloomText: 'معايير هرم بلوم المعرفي (Bloom’s Taxonomy) لقياس مستويات الفهم والتطبيق والتحليل والمحاكاة',
    saveSettings: 'حفظ إعدادات الامتحان والجدارات المعتمدة',
    workplaceSurveyTitle: 'استبيان تقييم بيئة العمل والواقع التشغيلي (ISO & EFQM)',
    workplaceSurveyExplain: 'تقييم الواقع الراهن من منظور الموظف: الإجراءات، السياسات، البنية الرقمية، العلاقات الثنائية، ومستهدفات التطوير المؤسسي.',
    surveyIntro: 'يهدف هذا الجزء لاستشراف الواقع العملي الفعلي داخل المؤسسة استناداً إلى معايير التميز المؤسسي والجودة. يرجى الإجابة بموضوعية وستنعكس إجاباتك في تقرير تقييم بيئة العمل الخاص بك.',
    proceduresLabel: 'السياسات والإجراءات الإدارية المتبعة',
    proceduresDesc: 'صف مدى وضوح وسهولة الإجراءات الإدارية بالشركة وسرعة تدفق المعاملات ودقة السياسات القانونية والتنظيمية.',
    digitalLabel: 'البنية التحتية والأنظمة الرقمية بالشركة',
    digitalDesc: 'ما رأيك في كفاءة الأجهزة، البرمجيات، شبكة الاتصالات الداخلية، وجاهزيتها لدعم دورك الوظيفي؟',
    challengesLabel: 'التحديات والمشاكل التشغيلية اليومية التي تواجهك',
    challengesDesc: 'ما هي أهم العقبات أو المشاكل الفنية أو الإدارية التي تعوق إنتاجيتك وصلاحيات العمل الفعلي؟',
    employeeRelationsLabel: 'العلاقة المهنية والتعاون مع الزملاء والرؤساء',
    employeeRelationsDesc: 'قيم مستوى التعاون والانسجام، والعمل الجماعي بين الإدارات لإنجاز الأهداف المشتركة.',
    aspirationsLabel: 'الطموحات الشخصية والمستهدفات التطويرية داخلياً',
    aspirationsDesc: 'ما هي طموحاتك المهنية داخل الشركة؟ وما هو تصورك لما يحقق الطموح المؤسسي المشترك؟',
    reconstructionLabel: 'التطوير والتعديل الهيكلي والتنطيمي المقترح للمؤسسة',
    reconstructionDesc: 'إذا تم عمل تغيير أو تعديل هيكلي، ما هي مقترحاتك لتبسيط الهيكل الإداري وتحسين الخدمات والمهام؟',
    startSurvey: 'الانتقال إلى تقييم بيئة العمل والممارسات الإدارية',
    generatingSurveyReport: 'جاري صياغة تقرير تقييم بيئة العمل والتميز المؤسسي...',
    surveyReportTitle: 'تقرير تقييم بيئة العمل والواقع التشغيلي والتميز للمؤسسة',
    technicalScoreText: 'التقييم الفني التخصصي للجدارات والخبرة',
    behavioralScoreText: 'تقييم السلوكيات والسمات والتعامل الوظيفي',
    gapAnalysisTitle: 'تقرير تحليل الفجوات الوظيفية وملاءمة الموارد البشرية',
    gapExplanation: 'تحليل يقارن بين جدارات المعايير والوظائف المستهدفة وبين مهارات الموظف الفعلية لتتبع الفجوة والاحتياج التدريبي بدقة:',
    positionStandard: 'الجدارة والمهارات المستهدفة بالشركة',
    actualPerformance: 'مستوى الموظف المرصود بالامتحان',
    gapStatus: 'نسبة الفجوة / تصنيف الملاءمة وخطة التدريب الموصى بها',
    eligibleRolesTitle: 'الوظائف المؤهل لشغلها وملاءمتها بالشركة ونسبتها',
    eligibleRolesExplain: 'بناءً على الأنماط السلوكية والمهنية المقاسة (هولاند وبريكمان ومستويات بلوم)، يوضح الآتي البدائل الوظيفية المقترحة للمشارك:',
    noGapsMsg: 'تهانينا، لم يتم رصد أي فجوات حرجة في جدارات الموظف الحالية لملء هذا الدور.',
    workEnvironmentScore: 'مؤشر تقييم بيئة العمل والواقع التشغيلي الكلي',
    isoEfqmTitle: 'تفصيل الامتثال لممارسات الجودة والكفاءة المؤسسية (ISO 9001 & EFQM)',
    infrastructureLevel: 'مستوى البنية التحتية التقنية والجاهزية الرقمية',
    currentStatusSurveyLabel: 'تشخيص الواقع الراهن والبيئة العامة للمؤسسة',
    managementRecsTitle: 'التوصيات والخطوات التطويرية المقترحة للإدارة التنفيذية ورؤساء القطاعات',
    employeeAspirations: 'الطموحات المهنية والتشغيلية المعتمدة للموظف',
    challengesTitle: 'أهم التحديات والعوائق التشغيلية المرصودة'
  }
};