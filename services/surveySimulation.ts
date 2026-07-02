// ===========================================================================
//  Survey Simulation — generate N realistic synthetic respondents for a
//  company's work-environment survey, grounded in that company's context
//  (orgContext + ingested chunks). Each respondent gets a persona + filled
//  WorkEnvironmentAnswers; optionally analyzed (analyzeWorkEnvironment) and
//  persisted to the `assessments` collection tagged { simulated:true, tenantId }.
//
//  Lets a consultant pressure-test the whole pipeline ("survey filled by 20
//  people") without waiting for real employees, then export aggregate / single
//  / per-survey reports over the result set.
// ===========================================================================

import { Type } from '@google/genai';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { generateJson } from './agentOrchestrator';
import { analyzeWorkEnvironment } from './geminiService';
import type {
  Language, WorkEnvironmentAnswers, WorkEnvironmentReport,
} from '../types';

export type SimSentiment = 'positive' | 'neutral' | 'negative';

export interface SimPersona {
  name: string;
  jobTitle: string;
  department: string;
  tenureYears: number;
  sentiment: SimSentiment;
}

export interface SimulatedRespondent {
  persona: SimPersona;
  answers: WorkEnvironmentAnswers;
}

// Shape persisted to Firestore `assessments` (superset of the real record).
export interface SimAssessmentRecord {
  id: string;
  tenantId: string;
  simulated: true;
  // [MAJOR fix] whether this respondent was generated WITH the tenant's
  // ingested-document context available. false means the model had nothing but
  // the manual company profile to draw on, so persona/answer specifics are
  // generic rather than grounded in the company's real documents — surfaced to
  // the consultant (badge/tooltip) instead of silently looking authoritative.
  grounded: boolean;
  userId: string;
  userName: string;
  userEmail: string;
  jobTitle: string;
  department?: string;
  sentiment?: SimSentiment;
  numQuestions: number;
  assessmentType: 'text';
  timestamp: string;
  responses: [];
  workplaceAnswers: WorkEnvironmentAnswers;
  reportData: null;
  envReportData: WorkEnvironmentReport | null;
  surveyScope: 'environment';
  assessmentKind: [];
  persona: SimPersona;
}

export interface SimulateParams {
  count: number;
  companyName: string;
  orgContext: string;        // company identity / sector / details
  chunkContext?: string;     // optional ingested-knowledge context
  language: Language;
  signal?: AbortSignal;
  // sentiment mix (defaults: realistic spread). Sum need not be exact; relative.
  mix?: { positive: number; neutral: number; negative: number };
}

const respondentSchema = {
  type: Type.OBJECT,
  properties: {
    respondents: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          persona: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              jobTitle: { type: Type.STRING },
              department: { type: Type.STRING },
              tenureYears: { type: Type.NUMBER },
              sentiment: { type: Type.STRING }, // positive | neutral | negative
            },
            required: ['name', 'jobTitle', 'department', 'tenureYears', 'sentiment'],
          },
          answers: {
            type: Type.OBJECT,
            properties: {
              proceduresAndPolicies: { type: Type.STRING },
              digitalInfrastructure: { type: Type.STRING },
              challengesAndProblems: { type: Type.STRING },
              employeeRelationships: { type: Type.STRING },
              aspirationsAndDevelopment: { type: Type.STRING },
              organizationalReconstructionOpinion: { type: Type.STRING },
            },
            required: [
              'proceduresAndPolicies', 'digitalInfrastructure', 'challengesAndProblems',
              'employeeRelationships', 'aspirationsAndDevelopment', 'organizationalReconstructionOpinion',
            ],
          },
        },
        required: ['persona', 'answers'],
      },
    },
  },
  required: ['respondents'],
};

// Build a sentiment plan array of length `count` from a relative mix.
function sentimentPlan(count: number, mix?: SimulateParams['mix']): SimSentiment[] {
  const m = mix || { positive: 0.4, neutral: 0.35, negative: 0.25 };
  const total = Math.max(0.0001, m.positive + m.neutral + m.negative);
  const nPos = Math.round((m.positive / total) * count);
  const nNeu = Math.round((m.neutral / total) * count);
  const plan: SimSentiment[] = [];
  for (let i = 0; i < nPos; i++) plan.push('positive');
  for (let i = 0; i < nNeu; i++) plan.push('neutral');
  while (plan.length < count) plan.push('negative');
  return plan.slice(0, count);
}

/**
 * Generate `count` synthetic respondents in bounded batches (<=8/call to keep
 * each JSON response small + coherent). Personas + answers are grounded in the
 * company context and follow a realistic sentiment spread.
 */
export async function simulateRespondents(
  p: SimulateParams,
  onProgress?: (done: number, total: number) => void,
): Promise<SimulatedRespondent[]> {
  const ar = p.language === 'ar';
  const plan = sentimentPlan(p.count, p.mix);
  const out: SimulatedRespondent[] = [];
  const BATCH = 8;
  // [MAJOR fix] track batch outcomes so a total failure (every batch throws)
  // can be surfaced as an error instead of silently reported as "0 respondents,
  // success". A partial failure still returns whatever succeeded — the caller
  // (runSurveySimulation) reports the honest "N of M" split.
  let batchesAttempted = 0;
  let batchesFailed = 0;

  for (let start = 0; start < p.count; start += BATCH) {
    if (p.signal?.aborted) break;
    batchesAttempted++;
    const slice = plan.slice(start, start + BATCH);
    const langInstr = ar
      ? 'اكتب كل الأسماء والمسميات والإدارات والإجابات بالعربية الفصحى الواقعية (لهجة موظفين سعوديين/خليجيين محترفة).'
      : 'Write all names, titles, departments and answers in natural professional English.';

    const prompt = [
      `أنت محاكي بيانات موارد بشرية. ولّد ${slice.length} موظف افتراضي واقعي يعملون في الشركة التالية، كلٌّ يملأ "استبيان تقييم بيئة العمل".`,
      '=== ملف الشركة ===',
      p.orgContext || `اسم الشركة: ${p.companyName}`,
      p.chunkContext ? '=== مقتطفات من وثائق الشركة (استند إليها) ===\n' + p.chunkContext.slice(0, 6000) : '',
      '=== التعليمات ===',
      `- الأشخاص من إدارات/مسميات متنوعة تناسب قطاع الشركة وحجمها.`,
      `- وزّع المشاعر حسب القائمة بالترتيب: ${slice.join('، ')} (positive=راضٍ، neutral=محايد، negative=ناقد).`,
      `- إجابة كل حقل: 2-4 جُمل واقعية محددة، تذكر تفاصيل ملموسة (أنظمة، إجراءات، تحديات فعلية) متّسقة مع مشاعر الشخص ومع قطاع الشركة. لا تكرار حرفي بين الأشخاص.`,
      `- tenureYears رقم بين 0 و 18.`,
      langInstr,
      'أعد JSON: { respondents: [{ persona:{name,jobTitle,department,tenureYears,sentiment}, answers:{proceduresAndPolicies,digitalInfrastructure,challengesAndProblems,employeeRelationships,aspirationsAndDevelopment,organizationalReconstructionOpinion} }] }',
    ].filter(Boolean).join('\n');

    try {
      const res = await generateJson<{ respondents: SimulatedRespondent[] }>(
        prompt, respondentSchema,
        { signal: p.signal, temperature: 0.95 },
      );
      const got = Array.isArray(res?.respondents) ? res.respondents : [];
      // normalize sentiment to the plan slot when model drifts
      got.forEach((r, i) => {
        const s = r.persona?.sentiment;
        if (s !== 'positive' && s !== 'neutral' && s !== 'negative') {
          r.persona.sentiment = slice[i] || 'neutral';
        }
      });
      out.push(...got);
    } catch (e) {
      batchesFailed++;
      console.error('simulateRespondents batch failed', e);
    }
    onProgress?.(Math.min(out.length, p.count), p.count);
  }

  // Every batch threw (and we weren't cancelled) → this is a hard failure, not
  // a "0 respondents" success. Let it propagate so the caller shows an error
  // instead of a false-positive completion toast.
  if (!p.signal?.aborted && batchesAttempted > 0 && batchesFailed === batchesAttempted) {
    throw new Error(ar
      ? 'فشل توليد جميع دفعات المشاركين الافتراضيين — لم يُنشأ أي رد.'
      : 'All synthetic-respondent batches failed to generate — no respondents were created.');
  }

  return out.slice(0, p.count);
}

let _seq = 0;
function simId(): string {
  // Date.now is fine in the app (browser); add seq to avoid collisions in a tight loop.
  return `sim_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

function emailFor(name: string, idx: number): string {
  const slug = (name || `user${idx}`).trim().replace(/\s+/g, '.').replace(/[^\w.؀-ۿ]/g, '').toLowerCase();
  return `${slug || 'respondent'}.${idx}@sim.local`;
}

/** Build a persistable record from a respondent (+ optional analyzed report). */
export function toAssessmentRecord(
  tenantId: string,
  respondent: SimulatedRespondent,
  envReport: WorkEnvironmentReport | null,
  idx: number,
  grounded: boolean,
): SimAssessmentRecord {
  const { persona, answers } = respondent;
  return {
    id: simId(),
    tenantId,
    simulated: true,
    grounded,
    userId: 'sim',
    userName: persona.name,
    userEmail: emailFor(persona.name, idx),
    jobTitle: persona.jobTitle,
    department: persona.department,
    sentiment: persona.sentiment,
    numQuestions: 0,
    assessmentType: 'text',
    timestamp: new Date().toISOString(),
    responses: [],
    workplaceAnswers: answers,
    reportData: null,
    envReportData: envReport,
    surveyScope: 'environment',
    assessmentKind: [],
    persona,
  };
}

const clean = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o));

export async function saveAssessmentRecord(rec: SimAssessmentRecord): Promise<void> {
  await setDoc(doc(db, 'assessments', rec.id), clean(rec));
}

export interface RunSimulationParams extends SimulateParams {
  tenantId: string;
  analyze?: boolean;          // run analyzeWorkEnvironment per respondent (default true)
  analyzeConcurrency?: number; // bounded pool (default 4)
}

export interface SimulationResult {
  records: SimAssessmentRecord[];
  saved: number;
  analyzed: number;
  // [MAJOR fix] how many respondents were requested, so the caller can tell a
  // full success (saved === requested) from a partial one and report "N of M".
  requested: number;
}

/**
 * Full pipeline: generate → (analyze in bounded pool) → persist.
 * onPhase reports human-readable progress for the UI.
 */
export async function runSurveySimulation(
  p: RunSimulationParams,
  onPhase?: (msg: string, done: number, total: number) => void,
): Promise<SimulationResult> {
  const ar = p.language === 'ar';
  // [MAJOR fix] whether this run had ingested-document context to ground on —
  // stamped onto every produced record (see SimAssessmentRecord.grounded).
  const grounded = !!(p.chunkContext && p.chunkContext.trim().length > 0);
  onPhase?.(ar ? 'توليد المشاركين الافتراضيين…' : 'Generating synthetic respondents…', 0, p.count);
  const respondents = await simulateRespondents(p, (d, t) =>
    onPhase?.(ar ? `توليد المشاركين (${d}/${t})…` : `Generating (${d}/${t})…`, d, t));

  if (p.signal?.aborted) return { records: [], saved: 0, analyzed: 0, requested: p.count };

  const analyze = p.analyze !== false;
  const records: SimAssessmentRecord[] = new Array(respondents.length);
  let analyzed = 0;

  if (analyze) {
    const CONC = Math.max(1, Math.min(p.analyzeConcurrency || 4, 6));
    let cursor = 0;
    const total = respondents.length;
    onPhase?.(ar ? 'تحليل الردود (ISO/EFQM)…' : 'Analyzing responses (ISO/EFQM)…', 0, total);
    const worker = async () => {
      while (cursor < respondents.length) {
        if (p.signal?.aborted) return;
        const i = cursor++;
        const r = respondents[i];
        let env: WorkEnvironmentReport | null = null;
        try {
          env = await analyzeWorkEnvironment(r.answers, p.language, r.persona.jobTitle, p.orgContext);
        } catch (e) {
          console.error('analyze respondent failed', e);
        }
        records[i] = toAssessmentRecord(p.tenantId, r, env, i, grounded);
        analyzed += env ? 1 : 0;
        onPhase?.(ar ? `تحليل الردود (${analyzed}/${total})…` : `Analyzing (${analyzed}/${total})…`, analyzed, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, respondents.length) }, () => worker()));
  } else {
    respondents.forEach((r, i) => { records[i] = toAssessmentRecord(p.tenantId, r, null, i, grounded); });
  }

  // persist
  let saved = 0;
  onPhase?.(ar ? 'حفظ السجلات…' : 'Saving records…', 0, records.length);
  for (const rec of records) {
    if (!rec) continue;
    if (p.signal?.aborted) break;
    try { await saveAssessmentRecord(rec); saved++; } catch (e) { console.error('save sim record failed', e); }
    onPhase?.(ar ? `حفظ السجلات (${saved}/${records.length})…` : `Saving (${saved}/${records.length})…`, saved, records.length);
  }

  return { records: records.filter(Boolean), saved, analyzed, requested: p.count };
}
