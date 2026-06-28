// A1 — Industry → job-title suggestions.
//
// When a company has no explicit `jobRoles`, the unified-assessment setup modal
// used to open with an EMPTY "المسميات الوظيفية" textarea (placeholder only).
// `GovProject.industry` is FREE TEXT (manual entry "e.g. Energy", or AI-extracted
// in Arabic OR English) — there is no sector enum — so this matcher keyword-maps
// that free text to a curated, bilingual set of 5–8 role titles.
//
// Deterministic by design: a static lookup, offline, zero token cost, fully
// unit-testable. (Gemini generation would add latency, cost and a failure path
// for no real gain here — see PRD A1 "Generation source".) Unknown/blank sectors
// return `[]`, preserving the original empty-textarea behavior (PRD AC #4).

export interface JobTitleSuggestion {
  ar: string;
  en: string;
}

interface SectorDef {
  key: string;
  /** Already-normalized substrings (see `normalize`) matched against industry + specialization. */
  keywords: string[];
  titles: JobTitleSuggestion[];
}

// Arabic free text varies in hamza/alef/yaa forms and tashkeel; normalize both
// the haystack and the stored keywords identically so matching is robust.
//  - lowercase (English)
//  - strip tashkeel (ـًــٌــٍــَــُــِــّــْـ)
//  - أ/إ/آ → ا , ى → ي , ـ (tatweel) removed
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآ]/g, 'ا') // أ إ آ → ا
    .replace(/ى/g, 'ي')               // ى → ي
    .replace(/ـ/g, '')                     // tatweel ـ
    .replace(/\s+/g, ' ')
    .trim();
}

// First match wins, so order specific sectors before broad ones (e.g. telecom
// before technology, real-estate before construction). All Arabic keywords are
// written in their NORMALIZED form (bare alef, ي, no tashkeel).
const SECTORS: SectorDef[] = [
  {
    key: 'real_estate',
    keywords: ['عقار', 'املاك', 'اسكان', 'real estate', 'property', 'realty', 'housing'],
    titles: [
      { ar: 'مدير مشاريع', en: 'Project Manager' },
      { ar: 'مهندس موقع', en: 'Site Engineer' },
      { ar: 'مدير تطوير عقاري', en: 'Real Estate Development Manager' },
      { ar: 'أخصائي مبيعات عقارية', en: 'Real Estate Sales Specialist' },
      { ar: 'محاسب', en: 'Accountant' },
      { ar: 'منسق مشاريع', en: 'Project Coordinator' },
      { ar: 'مدير الأملاك', en: 'Property Manager' },
      { ar: 'مدير تسويق', en: 'Marketing Manager' },
    ],
  },
  {
    key: 'construction',
    keywords: ['مقاول', 'انشا', 'بناء', 'تشييد', 'اعمار', 'construction', 'contracting', 'civil works', 'building'],
    titles: [
      { ar: 'مدير مشروع إنشائي', en: 'Construction Project Manager' },
      { ar: 'مهندس مدني', en: 'Civil Engineer' },
      { ar: 'مهندس موقع', en: 'Site Engineer' },
      { ar: 'مساح كميات', en: 'Quantity Surveyor' },
      { ar: 'مراقب جودة', en: 'QA/QC Inspector' },
      { ar: 'مهندس سلامة وصحة مهنية', en: 'HSE Engineer' },
      { ar: 'مشرف موقع', en: 'Site Supervisor' },
      { ar: 'مدير مشتريات', en: 'Procurement Manager' },
    ],
  },
  {
    key: 'energy',
    keywords: ['طاقة', 'نفط', 'غاز', 'كهرب', 'بترول', 'energy', 'oil', 'gas', 'power', 'petroleum', 'utilit', 'renewable', 'electric'],
    titles: [
      { ar: 'مهندس عمليات', en: 'Operations Engineer' },
      { ar: 'مهندس كهرباء', en: 'Electrical Engineer' },
      { ar: 'مهندس ميكانيكا', en: 'Mechanical Engineer' },
      { ar: 'مهندس سلامة وصحة مهنية', en: 'HSE Engineer' },
      { ar: 'مدير مشاريع', en: 'Project Manager' },
      { ar: 'فني صيانة', en: 'Maintenance Technician' },
      { ar: 'مهندس طاقة متجددة', en: 'Renewable Energy Engineer' },
      { ar: 'محلل بيانات', en: 'Data Analyst' },
    ],
  },
  {
    key: 'telecom',
    keywords: ['اتصالات', 'اتصال', 'telecom', 'telecommunication'],
    titles: [
      { ar: 'مهندس شبكات', en: 'Network Engineer' },
      { ar: 'فني اتصالات', en: 'Telecom Technician' },
      { ar: 'مهندس ترددات لاسلكية', en: 'RF Engineer' },
      { ar: 'مدير منتج', en: 'Product Manager' },
      { ar: 'أخصائي دعم فني', en: 'Technical Support Specialist' },
      { ar: 'محلل أعمال', en: 'Business Analyst' },
      { ar: 'مسؤول خدمة عملاء', en: 'Customer Service Officer' },
      { ar: 'مدير مبيعات', en: 'Sales Manager' },
    ],
  },
  {
    key: 'technology',
    keywords: ['تقني', 'تكنولوج', 'برمج', 'معلومات', 'رقمي', 'حاسب', 'سيبران', 'software', 'tech', 'digital', 'cyber', 'saas', 'information technology'],
    titles: [
      { ar: 'مهندس برمجيات', en: 'Software Engineer' },
      { ar: 'مدير منتج', en: 'Product Manager' },
      { ar: 'مصمم تجربة المستخدم', en: 'UX Designer' },
      { ar: 'محلل نظم', en: 'Systems Analyst' },
      { ar: 'أخصائي دعم فني', en: 'IT Support Specialist' },
      { ar: 'مهندس أمن سيبراني', en: 'Cybersecurity Engineer' },
      { ar: 'عالم بيانات', en: 'Data Scientist' },
      { ar: 'مدير مشاريع تقنية', en: 'Technical Project Manager' },
    ],
  },
  {
    key: 'healthcare',
    keywords: ['صحة', 'صحي', 'مستشفي', 'طبي', 'عياد', 'صيدل', 'دواء', 'تمريض', 'health', 'hospital', 'medical', 'clinic', 'pharma'],
    titles: [
      { ar: 'طبيب', en: 'Physician' },
      { ar: 'ممرض', en: 'Nurse' },
      { ar: 'صيدلي', en: 'Pharmacist' },
      { ar: 'فني مختبر', en: 'Lab Technician' },
      { ar: 'أخصائي أشعة', en: 'Radiology Specialist' },
      { ar: 'مدير مستشفى', en: 'Hospital Administrator' },
      { ar: 'منسق رعاية مرضى', en: 'Patient Care Coordinator' },
      { ar: 'أخصائي جودة صحية', en: 'Healthcare Quality Specialist' },
    ],
  },
  {
    key: 'education',
    keywords: ['تعليم', 'تربية', 'مدرس', 'مدارس', 'جامع', 'اكاديم', 'معهد', 'مناهج', 'education', 'school', 'universit', 'academ', 'training', 'teach'],
    titles: [
      { ar: 'معلم', en: 'Teacher' },
      { ar: 'منسق أكاديمي', en: 'Academic Coordinator' },
      { ar: 'مدير مدرسة', en: 'School Principal' },
      { ar: 'أخصائي مناهج', en: 'Curriculum Specialist' },
      { ar: 'مرشد طلابي', en: 'Student Counselor' },
      { ar: 'مسؤول قبول وتسجيل', en: 'Admissions Officer' },
      { ar: 'مدرب', en: 'Trainer' },
      { ar: 'مصمم تعليمي', en: 'Instructional Designer' },
    ],
  },
  {
    key: 'finance',
    keywords: ['بنك', 'مصرف', 'مالي', 'تمويل', 'استثمار', 'محاسب', 'تامين', 'ائتمان', 'bank', 'financ', 'investment', 'accounting', 'insurance', 'capital'],
    titles: [
      { ar: 'محاسب', en: 'Accountant' },
      { ar: 'محلل مالي', en: 'Financial Analyst' },
      { ar: 'مدير مالي', en: 'Finance Manager' },
      { ar: 'مدقق داخلي', en: 'Internal Auditor' },
      { ar: 'مسؤول الالتزام', en: 'Compliance Officer' },
      { ar: 'مسؤول ائتمان', en: 'Credit Officer' },
      { ar: 'أمين خزينة', en: 'Treasury Officer' },
      { ar: 'مدير علاقات عملاء', en: 'Relationship Manager' },
    ],
  },
  {
    key: 'hospitality',
    keywords: ['فندق', 'فنادق', 'سياح', 'مطعم', 'مطاعم', 'ضياف', 'ترفيه', 'hospitality', 'hotel', 'tourism', 'restaurant', 'catering', 'leisure'],
    titles: [
      { ar: 'مدير فندق', en: 'Hotel Manager' },
      { ar: 'موظف استقبال', en: 'Front Desk Agent' },
      { ar: 'مشرف التدبير الفندقي', en: 'Housekeeping Supervisor' },
      { ar: 'مدير أغذية ومشروبات', en: 'F&B Manager' },
      { ar: 'طاهٍ', en: 'Chef' },
      { ar: 'منسق فعاليات', en: 'Events Coordinator' },
      { ar: 'مسؤول علاقات ضيوف', en: 'Guest Relations Officer' },
      { ar: 'مسؤول حجوزات', en: 'Reservations Officer' },
    ],
  },
  {
    key: 'logistics',
    keywords: ['لوجست', 'شحن', 'نقل', 'امداد', 'توريد', 'مخازن', 'توزيع', 'logistic', 'transport', 'shipping', 'supply chain', 'freight', 'warehous', 'distribution'],
    titles: [
      { ar: 'مدير لوجستيات', en: 'Logistics Manager' },
      { ar: 'منسق شحن', en: 'Shipping Coordinator' },
      { ar: 'مسؤول مستودع', en: 'Warehouse Officer' },
      { ar: 'مخطط سلسلة إمداد', en: 'Supply Chain Planner' },
      { ar: 'مسؤول أسطول', en: 'Fleet Officer' },
      { ar: 'أخصائي تخليص جمركي', en: 'Customs Clearance Specialist' },
      { ar: 'مشرف توزيع', en: 'Distribution Supervisor' },
      { ar: 'مسؤول مشتريات', en: 'Procurement Officer' },
    ],
  },
  {
    key: 'manufacturing',
    keywords: ['تصنيع', 'صناع', 'مصنع', 'مصانع', 'انتاج', 'معامل', 'manufactur', 'factory', 'industrial', 'production', 'fabrication'],
    titles: [
      { ar: 'مدير إنتاج', en: 'Production Manager' },
      { ar: 'مهندس صناعي', en: 'Industrial Engineer' },
      { ar: 'مراقب جودة', en: 'Quality Control Inspector' },
      { ar: 'مشرف خط إنتاج', en: 'Production Line Supervisor' },
      { ar: 'مهندس صيانة', en: 'Maintenance Engineer' },
      { ar: 'مسؤول سلامة', en: 'Safety Officer' },
      { ar: 'مخطط إنتاج', en: 'Production Planner' },
      { ar: 'مسؤول مستودع', en: 'Warehouse Officer' },
    ],
  },
  {
    key: 'retail',
    keywords: ['تجزئة', 'تجار', 'متاجر', 'تسوق', 'retail', 'commerce', 'trade', 'fmcg', 'consumer goods', 'shopping'],
    titles: [
      { ar: 'مدير فرع', en: 'Branch Manager' },
      { ar: 'مشرف مبيعات', en: 'Sales Supervisor' },
      { ar: 'أمين صندوق', en: 'Cashier' },
      { ar: 'أخصائي تسويق', en: 'Marketing Specialist' },
      { ar: 'مدير مشتريات', en: 'Procurement Manager' },
      { ar: 'منسق سلسلة إمداد', en: 'Supply Chain Coordinator' },
      { ar: 'مسؤول مخزون', en: 'Inventory Officer' },
      { ar: 'ممثل خدمة عملاء', en: 'Customer Service Representative' },
    ],
  },
  {
    key: 'agriculture',
    keywords: ['زراع', 'مزرع', 'نخيل', 'agricultur', 'farming', 'agri', 'livestock'],
    titles: [
      { ar: 'مهندس زراعي', en: 'Agricultural Engineer' },
      { ar: 'مدير مزرعة', en: 'Farm Manager' },
      { ar: 'أخصائي وقاية نبات', en: 'Plant Protection Specialist' },
      { ar: 'فني ري', en: 'Irrigation Technician' },
      { ar: 'أخصائي جودة', en: 'Quality Specialist' },
      { ar: 'مشرف إنتاج', en: 'Production Supervisor' },
      { ar: 'مسؤول مبيعات', en: 'Sales Officer' },
    ],
  },
  {
    key: 'consulting',
    keywords: ['استشار', 'consult', 'advisory'],
    titles: [
      { ar: 'مستشار', en: 'Consultant' },
      { ar: 'محلل أعمال', en: 'Business Analyst' },
      { ar: 'مدير مشروع', en: 'Project Manager' },
      { ar: 'أخصائي تطوير مؤسسي', en: 'Organizational Development Specialist' },
      { ar: 'مستشار حوكمة', en: 'Governance Advisor' },
      { ar: 'محلل أبحاث', en: 'Research Analyst' },
      { ar: 'مدير علاقات عملاء', en: 'Client Relations Manager' },
    ],
  },
  {
    key: 'government',
    keywords: ['حكوم', 'وزار', 'بلدية', 'قطاع عام', 'القطاع العام', 'government', 'ministry', 'municipal', 'public sector'],
    titles: [
      { ar: 'أخصائي موارد بشرية', en: 'HR Specialist' },
      { ar: 'منسق برامج', en: 'Program Coordinator' },
      { ar: 'أخصائي سياسات', en: 'Policy Specialist' },
      { ar: 'مسؤول علاقات عامة', en: 'Public Relations Officer' },
      { ar: 'محلل مالي', en: 'Financial Analyst' },
      { ar: 'مدقق داخلي', en: 'Internal Auditor' },
      { ar: 'مدير مشاريع', en: 'Project Manager' },
      { ar: 'مسؤول خدمات الجمهور', en: 'Public Services Officer' },
    ],
  },
];

/**
 * Suggest industry-appropriate job titles for a company.
 *
 * Matches the (normalized) `industry` — and `specialization` as a fallback hint —
 * against the curated sector map. Returns the first matching sector's 5–8 titles,
 * or `[]` when the sector is blank or unrecognised (so the caller keeps the
 * original empty-textarea + placeholder behavior).
 */
export function suggestJobTitles(industry?: string, specialization?: string): JobTitleSuggestion[] {
  const hay = normalize(`${industry || ''} ${specialization || ''}`);
  if (!hay) return [];
  for (const sector of SECTORS) {
    if (sector.keywords.some(k => hay.includes(k))) return sector.titles;
  }
  return [];
}

/**
 * Convenience: the suggested titles as plain strings in the requested language,
 * ready to seed the newline-separated job-titles textarea.
 */
export function suggestJobTitleLines(industry: string | undefined, specialization: string | undefined, language: 'ar' | 'en'): string[] {
  return suggestJobTitles(industry, specialization).map(s => (language === 'ar' ? s.ar : s.en));
}
