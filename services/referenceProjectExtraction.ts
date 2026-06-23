// Reference-library BATCH extraction for the Governance "Library" stage (Stage 4).
// Drop 10/20/30 files at once → each file is read (text direct, binary via Gemini
// multimodal) and auto-classified into a ReferenceProject draft (sector, size,
// artifactKind, tags, summary). NO manual one-by-one entry. Mirrors the
// @google/genai + JSON-schema pattern of projectExtraction / ingestionService.

import { Type } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import { extractFileText } from './fileExtraction';
import type { ReferenceProject, DocKind } from '../types';

let _idc = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(_idc++).toString(36)}`;

type ArtifactKind = ReferenceProject['artifactKind'];
type CompanySize = ReferenceProject['companySize'];

const VALID_SIZE: CompanySize[] = ['small', 'medium', 'large', 'enterprise'];
const VALID_ARTIFACT: ArtifactKind[] = [
  // DocKind members reused as artifactKind
  'regulation', 'policy', 'contract', 'meeting_minutes', 'org_chart', 'brand',
  'profile', 'survey', 'assessment', 'other',
  // extended library kinds
  'policy_manual', 'org_design', 'authority_matrix', 'kpi_framework',
] as ArtifactKind[];

/** One extracted reference draft (pre-save; id/createdAt/embedding added at save). */
export interface ReferenceDraft {
  fileName: string;
  name: string;
  sector: string;
  companySize: CompanySize;
  artifactKind: ArtifactKind;
  summary: string;
  content: string;
  tags: string[];
  ok: boolean;            // false → extraction failed, needs manual review
  error?: string;
}

const refSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },          // عنوان/اسم المرجع
    sector: { type: Type.STRING },         // القطاع
    companySize: { type: Type.STRING },    // small|medium|large|enterprise
    artifactKind: { type: Type.STRING },   // one of VALID_ARTIFACT
    summary: { type: Type.STRING },        // ملخص موجز للمحتوى
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['name', 'sector', 'artifactKind', 'summary'],
};

/** Read one file to plain text via the shared REAL extractor (text/docx/pptx/xlsx/pdf).
 *  Returns text + an error reason on failure so the batch can report WHY per file. */
async function fileToText(file: File, signal?: AbortSignal): Promise<{ text: string; error?: string }> {
  const res = await extractFileText(file, signal);
  return { text: res.text, error: res.error };
}

const normSize = (s: string): CompanySize =>
  (VALID_SIZE.includes(s as CompanySize) ? s : 'medium') as CompanySize;
const normKind = (s: string): ArtifactKind =>
  (VALID_ARTIFACT.includes(s as ArtifactKind) ? s : 'other') as ArtifactKind;

/** Classify one file's text into a ReferenceDraft (auto sector/size/kind/tags). */
async function classifyOne(fileName: string, text: string, signal?: AbortSignal): Promise<ReferenceDraft> {
  const prompt = `صنّف وثيقة الحوكمة المرجعية التالية تلقائيًا. أعد فقط:
- name: عنوان وصفي مختصر للمرجع
- sector: القطاع/المجال (مثل: تقنية، صحة، تعليم، تجزئة، حكومي...)
- companySize: حجم المنشأة الأنسب، واحدة من [small, medium, large, enterprise]
- artifactKind: نوع الأداة، واحدة من [${VALID_ARTIFACT.join(', ')}]
- summary: ملخص موجز (سطر-سطرين) لما يحتويه ولماذا يفيد كمرجع
- tags: 3-6 وسوم مفتاحية

النص:
${(text || '').slice(0, 12000)}

أعد JSON فقط.`;
  try {
    const res = await generateJson<{ name: string; sector: string; companySize: string; artifactKind: string; summary: string; tags?: string[] }>(
      prompt, refSchema, { signal, temperature: 0.2 },
    );
    return {
      fileName,
      name: (res.name || fileName).trim().slice(0, 140),
      sector: (res.sector || 'عام').trim().slice(0, 60),
      companySize: normSize(res.companySize),
      artifactKind: normKind(res.artifactKind),
      summary: (res.summary || '').trim().slice(0, 600),
      content: text,
      tags: Array.isArray(res.tags) ? res.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 8) : [],
      ok: true,
    };
  } catch (e: any) {
    return {
      fileName, name: fileName, sector: 'عام', companySize: 'medium',
      artifactKind: 'other', summary: '', content: text, tags: [],
      ok: false, error: e?.message || 'classify failed',
    };
  }
}

export interface BatchProgress {
  current: number;
  total: number;
  fileName: string;
  phase: 'read' | 'classify';
}

/**
 * Extract a BATCH of reference files. Each file: read → classify → ReferenceDraft.
 * Bounded concurrency keeps it fast without hammering rate limits.
 */
export async function extractReferenceProjects(
  files: File[],
  onProgress?: (p: BatchProgress) => void,
  signal?: AbortSignal,
  concurrency = 3,
): Promise<ReferenceDraft[]> {
  const total = files.length;
  const out: ReferenceDraft[] = new Array(total);
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (next < total) {
      if (signal?.aborted) return;
      const idx = next++;
      const f = files[idx];
      onProgress?.({ current: done, total, fileName: f.name, phase: 'read' });
      const { text, error } = await fileToText(f, signal);
      if (signal?.aborted) return;
      if (!text.trim()) {
        out[idx] = {
          fileName: f.name, name: f.name, sector: 'عام', companySize: 'medium',
          artifactKind: 'other', summary: '', content: '', tags: [],
          ok: false, error: error || 'no text extracted',
        };
      } else {
        onProgress?.({ current: done, total, fileName: f.name, phase: 'classify' });
        out[idx] = await classifyOne(f.name, text, signal);
      }
      done++;
      onProgress?.({ current: done, total, fileName: f.name, phase: 'classify' });
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker());
  await Promise.all(pool);
  return out.filter(Boolean);
}

/** Turn an (edited) draft into a ReferenceProject ready for saveReferenceProject. */
export function draftToReferenceProject(d: ReferenceDraft): ReferenceProject {
  return {
    id: uid('ref'),
    name: d.name || d.fileName,
    sector: d.sector || 'عام',
    companySize: d.companySize,
    artifactKind: d.artifactKind,
    summary: d.summary,
    content: d.content,
    tags: d.tags,
    createdAt: new Date().toISOString(),
  };
}

/** Human label for an artifactKind (Arabic). */
export function artifactKindLabel(k: ArtifactKind, ar = true): string {
  const map: Record<string, { ar: string; en: string }> = {
    regulation: { ar: 'لائحة', en: 'Regulation' },
    policy: { ar: 'سياسة', en: 'Policy' },
    contract: { ar: 'عقد', en: 'Contract' },
    meeting_minutes: { ar: 'محضر', en: 'Minutes' },
    org_chart: { ar: 'هيكل تنظيمي', en: 'Org chart' },
    brand: { ar: 'هوية', en: 'Brand' },
    profile: { ar: 'بروفايل', en: 'Profile' },
    survey: { ar: 'استبيان', en: 'Survey' },
    assessment: { ar: 'تقييم', en: 'Assessment' },
    policy_manual: { ar: 'دليل سياسات', en: 'Policy manual' },
    org_design: { ar: 'تصميم تنظيمي', en: 'Org design' },
    authority_matrix: { ar: 'مصفوفة صلاحيات', en: 'Authority matrix' },
    kpi_framework: { ar: 'إطار مؤشرات', en: 'KPI framework' },
    other: { ar: 'أخرى', en: 'Other' },
  };
  const e = map[k] || map.other;
  return ar ? e.ar : e.en;
}
