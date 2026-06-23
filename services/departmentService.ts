import { GoogleGenAI } from '@google/genai';
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { MODELS } from '../constants/models';
import { getStandardsForDepartment, formatStandardsForPrompt } from '../constants/standards';
import type { DepartmentPackage, DepartmentSection, DeptSectionKey, CompanyGovernanceModel, Language } from '../types';

const C = 'gov_department_packages';

// ---- Firestore CRUD ----

export async function getPackagesForTenant(tenantId: string): Promise<DepartmentPackage[]> {
  const snap = await getDocs(query(collection(db, C), where('tenantId', '==', tenantId)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as DepartmentPackage));
}

export async function savePackage(pkg: Omit<DepartmentPackage, 'id'>): Promise<string> {
  const ref = doc(collection(db, C));
  await setDoc(ref, { ...pkg });
  return ref.id;
}

export async function updatePackageSection(
  pkgId: string,
  section: DepartmentSection,
): Promise<void> {
  const snap = await getDocs(query(collection(db, C), where('__name__', '==', pkgId)));
  if (snap.empty) return;
  const existing = snap.docs[0].data() as DepartmentPackage;
  const sections = existing.sections.map(s => s.key === section.key ? section : s);
  await updateDoc(doc(db, C, pkgId), {
    sections,
    updatedAt: new Date().toISOString(),
    complete: sections.every(s => s.status === 'done'),
  });
}

export async function deletePackage(pkgId: string): Promise<void> {
  await deleteDoc(doc(db, C, pkgId));
}

// ---- Section metadata ----

export const SECTION_META: Record<DeptSectionKey, { arTitle: string; enTitle: string; icon: string }> = {
  goal:             { arTitle: 'الهدف والرسالة',         enTitle: 'Goal & Mission',           icon: '🎯' },
  orgChart:         { arTitle: 'الهيكل التنظيمي',        enTitle: 'Org Chart',                icon: '🏗️' },
  policies:         { arTitle: 'السياسات',               enTitle: 'Policies',                 icon: '📜' },
  procedures:       { arTitle: 'الإجراءات',              enTitle: 'Procedures',               icon: '⚙️' },
  kpis:             { arTitle: 'مؤشرات الأداء (KPIs)',   enTitle: 'KPIs',                    icon: '📈' },
  jobDescriptions:  { arTitle: 'الوصف الوظيفي',          enTitle: 'Job Descriptions',         icon: '👤' },
  raci:             { arTitle: 'مصفوفة RACI',            enTitle: 'RACI Matrix',              icon: '📋' },
  riskRegister:     { arTitle: 'سجل المخاطر',            enTitle: 'Risk Register',            icon: '⚠️' },
};

export const ALL_SECTION_KEYS: DeptSectionKey[] = [
  'goal', 'orgChart', 'policies', 'procedures', 'kpis', 'jobDescriptions', 'raci', 'riskRegister',
];

export function makeEmptyPackage(
  tenantId: string,
  departmentName: string,
  departmentNameAr: string,
): Omit<DepartmentPackage, 'id'> {
  const now = new Date().toISOString();
  return {
    tenantId,
    departmentName,
    departmentNameAr,
    sections: ALL_SECTION_KEYS.map(key => ({
      key,
      titleAr: SECTION_META[key].arTitle,
      content: '',
      status: 'pending',
    })),
    standardsUsed: [],
    createdAt: now,
    updatedAt: now,
    complete: false,
  };
}

// ---- AI generation ----

const SECTION_PROMPTS: Record<DeptSectionKey, (deptAr: string, deptEn: string, companyName: string, std: string, lang: Language) => string> = {
  goal: (da, de, co, std, l) => l === 'ar'
    ? `أنت خبير حوكمة مؤسسية. اكتب قسم "الهدف والرسالة" لإدارة "${da}" في شركة "${co}". يجب أن يشمل: الهدف الاستراتيجي، الرسالة، دور الإدارة في المنظومة. المعايير المرجعية: ${std}. اكتب بالعربية بشكل احترافي، 300-400 كلمة.`
    : `Write a "Goal & Mission" section for the "${de}" department at "${co}". Include: strategic goal, mission statement, role in the organization. Standards: ${std}. Professional English, 300-400 words.`,

  orgChart: (da, de, co, std, l) => l === 'ar'
    ? `اكتب وصفاً هيكلياً وظيفياً للتسلسل التنظيمي لإدارة "${da}" في شركة "${co}". يشمل: الإدارة العليا، الأقسام الفرعية، المناصب الرئيسية، خطوط التقارير. المعايير: ${std}. 250-350 كلمة.`
    : `Write a structural description of the org chart for the "${de}" department at "${co}". Include: hierarchy, sub-units, key positions, reporting lines. Standards: ${std}. 250-350 words.`,

  policies: (da, de, co, std, l) => l === 'ar'
    ? `اكتب 3 سياسات رئيسية لإدارة "${da}" في شركة "${co}" وفق المعايير: ${std}. لكل سياسة: العنوان، الهدف، النطاق، المبادئ الأساسية، المسؤوليات. 500-700 كلمة.`
    : `Write 3 key policies for the "${de}" department at "${co}" aligned to: ${std}. Each policy: title, objective, scope, principles, responsibilities. 500-700 words.`,

  procedures: (da, de, co, std, l) => l === 'ar'
    ? `اكتب 2 إجراء تشغيلي تفصيلي لإدارة "${da}" في شركة "${co}" وفق: ${std}. لكل إجراء: الهدف، النطاق، الخطوات (مرقّمة)، المسؤول، المستندات المرفقة. 500-700 كلمة.`
    : `Write 2 detailed operational procedures for the "${de}" department at "${co}" per: ${std}. Each: objective, scope, numbered steps, responsible party, attached documents. 500-700 words.`,

  kpis: (da, de, co, std, l) => l === 'ar'
    ? `اكتب 8 مؤشرات أداء رئيسية (KPIs) لإدارة "${da}" في شركة "${co}" وفق: ${std}. لكل مؤشر: الاسم، الصيغة الحسابية، الهدف، التكرار، المصدر، الجهة المسؤولة. بصيغة جدولية سردية. 400-600 كلمة.`
    : `Write 8 KPIs for the "${de}" department at "${co}" per: ${std}. Each: name, formula, target, frequency, source, owner. Tabular narrative format. 400-600 words.`,

  jobDescriptions: (da, de, co, std, l) => l === 'ar'
    ? `اكتب وصفاً وظيفياً تفصيلياً لمنصب مدير إدارة "${da}" في شركة "${co}" وفق: ${std}. يشمل: الملخص، المهام والمسؤوليات، المتطلبات، الكفاءات، التسلسل الوظيفي، علاقات العمل. 500-700 كلمة.`
    : `Write a detailed job description for the Head of "${de}" at "${co}" per: ${std}. Include: summary, duties, requirements, competencies, reporting, work relations. 500-700 words.`,

  raci: (da, de, co, std, l) => l === 'ar'
    ? `اكتب مصفوفة RACI لإدارة "${da}" في شركة "${co}". حدد 8 مهام/قرارات رئيسية، و4 أدوار، وعيّن R/A/C/I لكل خلية. اشرحها سردياً مع جدول نصي واضح. المعايير: ${std}. 400-500 كلمة.`
    : `Write a RACI matrix for the "${de}" department at "${co}". Define 8 key tasks/decisions and 4 roles, assign R/A/C/I to each cell. Explain with a clear text table. Standards: ${std}. 400-500 words.`,

  riskRegister: (da, de, co, std, l) => l === 'ar'
    ? `اكتب سجل مخاطر لإدارة "${da}" في شركة "${co}" وفق: ${std}. حدد 6 مخاطر: لكل منها رقم، الوصف، الفئة، الاحتمالية (1-5)، الأثر (1-5)، تقييم المخاطر، الاستجابة، المالك. 500-600 كلمة.`
    : `Write a risk register for the "${de}" department at "${co}" per: ${std}. Define 6 risks: each with ID, description, category, likelihood (1-5), impact (1-5), rating, response, owner. 500-600 words.`,
};

export async function generateSection(
  sectionKey: DeptSectionKey,
  departmentName: string,
  departmentNameAr: string,
  companyName: string,
  language: Language,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
  const std = getStandardsForDepartment(departmentName);
  const stdText = std ? formatStandardsForPrompt(std) : 'ISO 9001, EFQM 2020, حوكمة مؤسسية أفضل الممارسات';
  const prompt = SECTION_PROMPTS[sectionKey](departmentNameAr, departmentName, companyName, stdText, language);
  const response = await ai.models.generateContent({
    model: MODELS.TEXT,
    contents: prompt,
    config: { thinkingConfig: { thinkingBudget: 0 } },
  });
  const text: string = (response as any)?.text ?? (response as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Empty response from AI');
  return text.trim();
}
