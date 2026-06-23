// Project (company) field extraction for the Governance "Projects" stage.
// Manual creation fills fields by hand; upload mode reads one or more files
// (text directly, binary via Gemini multimodal) and auto-extracts the company
// identity into a GovProject draft. Reuses the same @google/genai client +
// JSON-schema pattern as ingestionService / agentOrchestrator.

import { Type, GoogleGenAI } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import { MODELS } from '../constants/models';
import type { GovProject } from '../types';

function getAI(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: process.env.API_KEY! });
}

/** Extracted company identity fields (all optional — UI lets user edit). */
export interface ProjectDraft {
  name: string;
  industry?: string;
  specialization?: string;
  description: string;
  vision?: string;
  mission?: string;
}

const projectSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },           // اسم الجهة
    industry: { type: Type.STRING },        // القطاع
    specialization: { type: Type.STRING },  // التخصص
    description: { type: Type.STRING },     // تفاصيل/هوية
    vision: { type: Type.STRING },
    mission: { type: Type.STRING },
  },
  required: ['name', 'description'],
};

const file2base64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const TEXT_EXTS = ['txt', 'md', 'csv', 'json', 'xml', 'htm', 'html'];

/** Read one file to plain text (text files direct, binary via Gemini multimodal). */
async function fileToText(file: File, signal?: AbortSignal): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (TEXT_EXTS.includes(ext)) {
    try { return await file.text(); } catch { return ''; }
  }
  try {
    const base64 = await file2base64(file);
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.TEXT,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: base64, mimeType: file.type || 'application/octet-stream' } },
          { text: 'استخرج كامل النص والمعلومات التعريفية لهذه الوثيقة (اسم الجهة، القطاع، التخصص، الرؤية، الرسالة، نبذة). أعد النص فقط.' },
        ],
      }],
      config: { temperature: 0 },
    });
    if (signal?.aborted) return '';
    return (res.text || '').trim();
  } catch {
    return '';
  }
}

/** Extract company identity from raw text → ProjectDraft. */
export async function extractProjectFields(text: string, signal?: AbortSignal): Promise<ProjectDraft> {
  const prompt = `استخرج بيانات هوية الجهة/الشركة من النص التالي فقط (لا تخترع — اترك الحقل فارغاً لو غير موجود):
- name: اسم الجهة
- industry: القطاع/الصناعة
- specialization: التخصص
- description: نبذة/تفاصيل تعريفية موجزة
- vision: الرؤية
- mission: الرسالة

النص:
${(text || '').slice(0, 12000)}

أعد JSON فقط.`;
  const res = await generateJson<ProjectDraft>(prompt, projectSchema, { signal, temperature: 0.2 });
  return {
    name: (res.name || '').trim(),
    industry: res.industry?.trim() || undefined,
    specialization: res.specialization?.trim() || undefined,
    description: (res.description || '').trim(),
    vision: res.vision?.trim() || undefined,
    mission: res.mission?.trim() || undefined,
  };
}

/** Read one or more uploaded files and auto-extract a unified ProjectDraft. */
export async function extractProjectFromFiles(files: File[], signal?: AbortSignal): Promise<ProjectDraft> {
  const texts: string[] = [];
  for (const f of files) {
    if (signal?.aborted) break;
    const txt = await fileToText(f, signal);
    if (txt) texts.push(`[ملف: ${f.name}]\n${txt}`);
  }
  const merged = texts.join('\n\n---\n\n');
  if (!merged.trim()) {
    return { name: '', description: '' };
  }
  return extractProjectFields(merged, signal);
}

/** Build a GovProject from a draft (id/createdAt assigned by caller/store). */
export function draftToProject(draft: ProjectDraft, id: string, now: string): GovProject {
  return {
    id,
    name: draft.name || 'جهة بدون اسم',
    description: draft.description || '',
    industry: draft.industry,
    specialization: draft.specialization,
    vision: draft.vision,
    mission: draft.mission,
    createdAt: now,
    uploadedAt: now,
  };
}
