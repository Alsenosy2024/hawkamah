// ===========================================================================
//  Survey Reporting — turn a set of (simulated or real) work-environment
//  survey responses into exportable GeneratedArtifacts:
//    • buildAggregateArtifact   — full OR brief report over ALL responses
//    • buildSurveyDefinitionArtifact — the questionnaire itself, standalone
//    • buildSingleResponseArtifact   — one respondent's answers + diagnosis
//  All return GeneratedArtifact so the existing exportDocx / exportPdf* paths
//  (Arabic-hardened) render them with zero new export plumbing.
// ===========================================================================

import { Type } from '@google/genai';
import { generateJson, generateJsonStream } from './agentOrchestrator';
import type {
  Language, GeneratedArtifact, ArtifactSection,
  WorkEnvironmentAnswers, WorkEnvironmentReport, ProjectSurveySettings,
  EmployeeResponse,
} from '../types';

// ---- survey field labels (the 6 questions) -----------------------------------
// Only the string-valued narrative fields are rendered as survey axes (excludes the
// optional `followUps` map, which is an object and surfaced inside the diagnosis instead).
type SurveyStringField = Exclude<keyof WorkEnvironmentAnswers, 'followUps'>;
export const SURVEY_FIELDS: Array<{ key: SurveyStringField; ar: string; en: string; icon: string }> = [
  { key: 'proceduresAndPolicies', ar: 'الإجراءات والسياسات الإدارية', en: 'Procedures & Policies', icon: '📋' },
  { key: 'digitalInfrastructure', ar: 'البنية الرقمية والأدوات', en: 'Digital Infrastructure', icon: '🖥️' },
  { key: 'challengesAndProblems', ar: 'التحديات والمشكلات الحالية', en: 'Challenges & Problems', icon: '⚡' },
  { key: 'employeeRelationships', ar: 'العلاقات والتعاون مع الزملاء', en: 'Relationships & Cooperation', icon: '🤝' },
  { key: 'aspirationsAndDevelopment', ar: 'الطموحات والتطوير الشخصي', en: 'Aspirations & Development', icon: '🎯' },
  { key: 'organizationalReconstructionOpinion', ar: 'رأي إعادة الهيكلة التنظيمية', en: 'Org Restructuring Opinion', icon: '🏗️' },
];

const SECTION_DESC: Record<string, { ar: string; en: string }> = {
  proceduresAndPolicies: { ar: 'تقييم الموظف لوضوح وكفاءة الإجراءات والسياسات الإدارية المعمول بها.', en: 'How clear and efficient the employee finds current admin procedures and policies.' },
  digitalInfrastructure: { ar: 'مدى جاهزية الأنظمة والأدوات الرقمية ودعمها للعمل اليومي.', en: 'Readiness of digital systems and tools supporting daily work.' },
  challengesAndProblems: { ar: 'أبرز العقبات والمشكلات التي يواجهها الموظف فعلياً.', en: 'Key obstacles and problems the employee actually faces.' },
  employeeRelationships: { ar: 'جودة التعاون والعلاقات مع الزملاء والرؤساء.', en: 'Quality of cooperation and relations with peers and supervisors.' },
  aspirationsAndDevelopment: { ar: 'طموحات الموظف وتفضيلاته للنمو والتطوير.', en: 'Employee aspirations and growth preferences.' },
  organizationalReconstructionOpinion: { ar: 'تصور الموظف لو جرت إعادة هيكلة تنظيمية.', en: 'Employee view if an organizational restructuring occurred.' },
};

// ---- the record shape we read (matches assessments docs) ---------------------
export interface SurveyResponseRecord {
  id?: string;
  userName?: string;
  userEmail?: string;
  jobTitle?: string;
  department?: string;
  sentiment?: string;
  simulated?: boolean;
  timestamp?: string;
  workplaceAnswers?: WorkEnvironmentAnswers | null;
  envReportData?: WorkEnvironmentReport | null;
}

// ---- deterministic aggregation -----------------------------------------------
export interface SurveyAggregate {
  count: number;
  analyzedCount: number;
  // [CRITICAL fix] real vs. AI-simulated split — MUST be disclosed on every
  // aggregate artifact so a board-facing export can never read as 100% real
  // employee sentiment when part of the pool was synthetically generated.
  simulatedCount: number;
  realCount: number;
  avgOverall: number;
  avgIso: number;
  avgEfqm: number;
  infraDist: Record<string, number>;
  sentimentDist: Record<string, number>;
  deptDist: Record<string, number>;
  topChallenges: Array<{ text: string; count: number }>;
}

function avg(nums: number[]): number {
  const v = nums.filter(n => typeof n === 'number' && !isNaN(n));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0;
}

function normInfra(s?: string): string {
  const t = (s || '').toLowerCase();
  if (/advanced|متقدم/.test(t)) return 'Advanced/متقدم';
  if (/intermediate|متوسط/.test(t)) return 'Intermediate/متوسط';
  if (/basic|أساسي|اساسي/.test(t)) return 'Basic/أساسي';
  return s || '—';
}

export function computeAggregate(records: SurveyResponseRecord[]): SurveyAggregate {
  const analyzed = records.filter(r => r.envReportData);
  const infraDist: Record<string, number> = {};
  const sentimentDist: Record<string, number> = {};
  const deptDist: Record<string, number> = {};
  const challengeCount = new Map<string, { text: string; count: number }>();

  for (const r of records) {
    const sent = r.sentiment || 'unknown';
    sentimentDist[sent] = (sentimentDist[sent] || 0) + 1;
    const dept = r.department || (r.jobTitle || '—');
    deptDist[dept] = (deptDist[dept] || 0) + 1;
    if (r.envReportData) {
      const ir = normInfra(r.envReportData.infrastructureRating);
      infraDist[ir] = (infraDist[ir] || 0) + 1;
      for (const c of (r.envReportData.keyChallenges || [])) {
        const norm = c.trim().replace(/\s+/g, ' ');
        const key = norm.toLowerCase().slice(0, 60);
        const cur = challengeCount.get(key);
        if (cur) cur.count++;
        else challengeCount.set(key, { text: norm, count: 1 });
      }
    }
  }

  const topChallenges = Array.from(challengeCount.values())
    .sort((a, b) => b.count - a.count).slice(0, 12);

  const simulatedCount = records.filter(r => r.simulated).length;

  return {
    count: records.length,
    analyzedCount: analyzed.length,
    simulatedCount,
    realCount: records.length - simulatedCount,
    avgOverall: avg(analyzed.map(r => r.envReportData!.overallScore)),
    avgIso: avg(analyzed.map(r => r.envReportData!.isoComplianceRate)),
    avgEfqm: avg(analyzed.map(r => r.envReportData!.efqmExcellenceRate)),
    infraDist, sentimentDist, deptDist, topChallenges,
  };
}

/**
 * [CRITICAL fix] Mandatory, unmissable disclosure of the real/simulated split.
 * Rendered as the FIRST section of every aggregate artifact — never buried in
 * the statistics block — so a reader can never mistake a blended data set for
 * 100% real employee sentiment.
 */
export function methodologyDisclosure(agg: SurveyAggregate, ar: boolean): string {
  if (agg.simulatedCount === 0) {
    return ar
      ? `تستند هذه الإحصاءات إلى ${agg.count} استجابة **حقيقية بالكامل** من موظفين فعليين. لا توجد أي استجابات محاكاة بالذكاء الاصطناعي ضمن هذا التقرير.`
      : `This report is based on ${agg.count} **fully real** responses from actual employees. No AI-simulated respondents are included.`;
  }
  return ar
    ? [
        `⚠️ **تنويه إلزامي حول مصدر البيانات:** يتضمن هذا التقرير **${agg.simulatedCount} رداً محاكى بالذكاء الاصطناعي** (شخصيات افتراضية) من إجمالي ${agg.count} استجابة — أي ${agg.realCount} رد حقيقي فقط من موظفين فعليين.`,
        `الإحصاءات والسرد التحليلي أدناه يمزجان بين البيانات الواقعية والمولَّدة اصطناعياً. **لا يجوز** تقديم هذا التقرير كتمثيل كامل أو دقيق لمشاعر الموظفين الفعليين دون توضيح هذه النسبة صراحةً لأي جهة تطّلع عليه.`,
      ].join('\n\n')
    : [
        `⚠️ **Mandatory data-source disclosure:** this report includes **${agg.simulatedCount} AI-simulated response(s)** (synthetic personas) out of ${agg.count} total — only ${agg.realCount} are real employee responses.`,
        `The statistics and narrative below blend real and synthetically-generated data. This report **must not** be presented as a full or accurate representation of actual employee sentiment without disclosing this split to anyone who reviews it.`,
      ].join('\n\n');
}

// ---- helpers -----------------------------------------------------------------
function distLines(d: Record<string, number>): string {
  return Object.entries(d).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- —';
}
function sampleAnswers(records: SurveyResponseRecord[], perField = 6): string {
  const lines: string[] = [];
  for (const f of SURVEY_FIELDS) {
    const vals = records.map(r => r.workplaceAnswers?.[f.key]).filter(Boolean).slice(0, perField);
    lines.push(`### ${f.ar}`);
    vals.forEach((v, i) => lines.push(`(${i + 1}) ${v}`));
  }
  return lines.join('\n');
}

const aggregateNarrativeSchema = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: { type: Type.STRING },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING }, body: { type: Type.STRING } },
        required: ['title', 'body'],
      },
    },
  },
  required: ['executiveSummary', 'sections'],
};

function statsBlock(agg: SurveyAggregate, ar: boolean): string {
  return [
    ar ? `عدد المشاركين: ${agg.count} (مُحلَّل: ${agg.analyzedCount})` : `Respondents: ${agg.count} (analyzed: ${agg.analyzedCount})`,
    ar ? `مصدر البيانات: ${agg.realCount} حقيقي / ${agg.simulatedCount} محاكى بالذكاء الاصطناعي`
       : `Data source: ${agg.realCount} real / ${agg.simulatedCount} AI-simulated`,
    ar ? `متوسط الرضا العام: ${agg.avgOverall}/100` : `Avg overall: ${agg.avgOverall}/100`,
    ar ? `متوسط مطابقة ISO 9001: ${agg.avgIso}%` : `Avg ISO 9001: ${agg.avgIso}%`,
    ar ? `متوسط تميّز EFQM: ${agg.avgEfqm}%` : `Avg EFQM: ${agg.avgEfqm}%`,
    ar ? `توزيع تقييم البنية الرقمية:\n${distLines(agg.infraDist)}` : `Infra rating:\n${distLines(agg.infraDist)}`,
    ar ? `توزيع المشاعر:\n${distLines(agg.sentimentDist)}` : `Sentiment:\n${distLines(agg.sentimentDist)}`,
    ar ? `التوزيع حسب الإدارة/المسمى:\n${distLines(agg.deptDist)}` : `By department/role:\n${distLines(agg.deptDist)}`,
    ar ? `أكثر التحديات تكراراً:\n${agg.topChallenges.map(c => `- (${c.count}×) ${c.text}`).join('\n') || '- —'}`
       : `Top challenges:\n${agg.topChallenges.map(c => `- (${c.count}×) ${c.text}`).join('\n') || '- —'}`,
  ].join('\n\n');
}

export interface AggregateParams {
  records: SurveyResponseRecord[];
  companyName: string;
  mode: 'full' | 'brief';
  language: Language;
  orgContext?: string;
  // [MINOR fix] optional ingested-document grounding (same pattern as
  // SimulateParams.chunkContext) — lets the narrative cite the tenant's real
  // policy/procedure documents instead of reasoning from the profile string alone.
  chunkContext?: string;
  signal?: AbortSignal;
  // [MAJOR fix] staged progress for the UI (busy label + section-count bar).
  onPhase?: (msg: string, done: number, total: number) => void;
  // [CRITICAL fix] let a caller produce a report over REAL responses only —
  // the default (false/undefined) still includes simulated responses, but
  // ALWAYS discloses the split via methodologyDisclosure below.
  excludeSimulated?: boolean;
}

// Best-effort, pure section-count estimator for a still-streaming
// `{ executiveSummary, sections:[{title,body}, ...] }` JSON body. Each section
// object starts with a "title" key, so counting occurrences is a reasonable
// live proxy for "sections started so far" — NOT exact (mirrors the same
// best-effort spirit as services/partialJson.ts), only used to drive a
// progress bar, never to parse the authoritative result.
export function countStreamedSections(accumulatedText: string): number {
  const m = accumulatedText.match(/"title"\s*:/g);
  return m ? m.length : 0;
}

const aggregateNarrativeSchemaWithCitations = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: { type: Type.STRING },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING }, body: { type: Type.STRING } },
        required: ['title', 'body'],
      },
    },
    // [MINOR fix] distinct source-document names actually drawn upon, from the
    // `[docName › heading]` tags in the ingested-chunk context. Optional/not
    // required so a model that omits it never breaks generation.
    citedSources: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['executiveSummary', 'sections'],
};

/** Full or brief aggregate report over ALL responses → GeneratedArtifact. */
export async function buildAggregateArtifact(p: AggregateParams): Promise<GeneratedArtifact> {
  const ar = p.language === 'ar';
  const records = p.excludeSimulated ? p.records.filter(r => !r.simulated) : p.records;
  const agg = computeAggregate(records);
  const stats = statsBlock(agg, ar);
  const disclosure = methodologyDisclosure(agg, ar);

  const full = p.mode === 'full';
  const wantSections = full
    ? (ar
        ? ['ملخص تنفيذي', 'تحليل الإجراءات والسياسات', 'تقييم البنية الرقمية', 'التحديات والمشكلات الجوهرية', 'العلاقات وبيئة العمل', 'الطموحات واتجاهات التطوير', 'قراءة مؤشرات ISO و EFQM', 'توصيات الإدارة التنفيذية', 'خارطة طريق إعادة الهيكلة']
        : ['Executive Summary', 'Procedures & Policies', 'Digital Infrastructure', 'Core Challenges', 'Workplace Relationships', 'Aspirations & Development', 'ISO & EFQM Indicators', 'Management Recommendations', 'Restructuring Roadmap'])
    : (ar ? ['ملخص تنفيذي موجز', 'أبرز 3 تحديات', 'أهم 3 توصيات'] : ['Brief Executive Summary', 'Top 3 Challenges', 'Top 3 Recommendations']);
  const totalSections = wantSections.length;

  p.onPhase?.(ar ? 'إعداد الإحصاءات المجمّعة…' : 'Compiling aggregated statistics…', 0, totalSections);

  const prompt = [
    ar ? `أنت مستشار جودة وحوكمة (ISO 9001 + EFQM). حلّل نتائج "استبيان تقييم بيئة العمل" لشركة «${p.companyName}».`
       : `You are a quality & governance consultant (ISO 9001 + EFQM). Analyze the work-environment survey for "${p.companyName}".`,
    p.orgContext ? (ar ? '=== سياق الشركة ===\n' + p.orgContext.slice(0, 2000) : '=== Company context ===\n' + p.orgContext.slice(0, 2000)) : '',
    p.chunkContext ? (ar ? '=== مقتطفات من مستندات الشركة المفهرسة (استشهد بها عند أي ادّعاء عن سياسات/إجراءات قائمة) ===\n' + p.chunkContext.slice(0, 6000)
                          : '=== Ingested company documents (cite these when claiming an existing policy/procedure) ===\n' + p.chunkContext.slice(0, 6000)) : '',
    ar ? '=== إحصاءات مجمّعة (مصدر الحقيقة — لا تخالفها) ===' : '=== Aggregated statistics (ground truth) ===',
    stats,
    ar ? '=== عينات من إجابات الموظفين ===' : '=== Sample employee answers ===',
    sampleAnswers(records, full ? 6 : 3),
    full
      ? (ar ? `اكتب تقريراً تنفيذياً مفصّلاً. أعد JSON فيه executiveSummary وأقسام بعناوين: ${wantSections.join('، ')}. كل قسم فقرتان على الأقل بنقاط عملية مستندة للإحصاءات والعينات. عربي فصيح.`
            : `Write a detailed executive report. Return JSON with executiveSummary and sections titled: ${wantSections.join(', ')}.`)
      : (ar ? `اكتب تقريراً موجزاً جداً. أعد JSON فيه executiveSummary (فقرة) وأقسام: ${wantSections.join('، ')} (نقاط مختصرة). عربي فصيح.`
            : `Write a very brief report. Return JSON with executiveSummary and sections: ${wantSections.join(', ')} (concise bullets).`),
    p.chunkContext
      ? (ar ? 'عند ذكر أي إجراء أو سياسة إدارية قائمة فعلاً في الشركة، استشهد بالمصدر بذكر اسم المستند بين قوسين كما ورد أعلاه (مثال: (سياسة الموارد البشرية)). إن لم تتوفر أدلة موثقة لادّعاء معيّن فاذكر ذلك صراحةً بدلاً من الافتراض. أعد أيضاً حقل citedSources بأسماء المستندات التي استندت إليها فعلياً.'
             : 'When claiming an existing company procedure/policy, cite the source by naming the document in parentheses as it appears above (e.g. (HR Policy)). If no documented evidence supports a claim, say so explicitly instead of assuming. Also return a citedSources field listing the document names you actually drew upon.')
      : '',
  ].filter(Boolean).join('\n\n');

  const schema = p.chunkContext ? aggregateNarrativeSchemaWithCitations : aggregateNarrativeSchema;
  let narrative: { executiveSummary: string; sections: Array<{ title: string; body: string }>; citedSources?: string[] };
  try {
    if (p.signal?.aborted) throw new Error('ABORTED');
    p.onPhase?.(ar ? 'توليد السرد التحليلي…' : 'Generating narrative…', 0, totalSections);
    try {
      // Stream first so the UI can show real section-by-section progress; the
      // blocking generateJson ladder below is the fallback on any stream failure
      // (mirrors the same stream-first/blocking-fallback pattern used elsewhere
      // in the app for long-report generation).
      const streamed = await generateJsonStream<typeof narrative>(prompt, schema, {
        signal: p.signal,
        temperature: 0.45,
        onText: (acc) => {
          const done = Math.min(countStreamedSections(acc), totalSections);
          p.onPhase?.(ar ? `كتابة الأقسام (${done}/${totalSections})…` : `Writing sections (${done}/${totalSections})…`, done, totalSections);
        },
      });
      if (!streamed || !Array.isArray(streamed.sections) || !streamed.executiveSummary) {
        throw new Error('incomplete streamed narrative');
      }
      narrative = streamed;
    } catch (streamErr) {
      if (p.signal?.aborted) throw new Error('ABORTED');
      narrative = await generateJson(prompt, schema, { signal: p.signal, temperature: 0.45 });
    }
    p.onPhase?.(ar ? 'اكتمل التوليد' : 'Generation complete', totalSections, totalSections);
  } catch (e) {
    // A cancellation must propagate — never fabricate a "successful" artifact
    // out from under a user who explicitly stopped the run.
    if (p.signal?.aborted || (e as Error)?.message === 'ABORTED') throw new Error('ABORTED');
    console.error('aggregate narrative failed', e);
    narrative = { executiveSummary: ar ? 'تعذّر توليد السرد التحليلي؛ التقرير يعرض الإحصاءات المجمّعة فقط.' : 'Narrative generation failed; statistics only.', sections: [] };
  }

  const sections: ArtifactSection[] = [];
  // [CRITICAL fix] the real/simulated disclosure leads EVERY aggregate artifact —
  // ahead of even the statistics — so it can never be missed or scrolled past.
  sections.push({
    id: 'methodology', status: 'done',
    title: ar ? 'منهجية التقرير ومصدر البيانات' : 'Report Methodology & Data Source',
    content: disclosure,
  });
  // lead with a hard statistics section (always present, deterministic)
  sections.push({
    id: 'stats', status: 'done',
    title: ar ? 'لوحة المؤشرات المجمّعة' : 'Aggregated Metrics',
    content: stats,
  });
  (narrative.sections || []).forEach((s, i) => sections.push({
    id: `sec_${i}`, status: 'done', title: s.title, content: s.body,
  }));
  if (narrative.citedSources?.length) {
    sections.push({
      id: 'sources', status: 'done',
      title: ar ? 'المصادر المستشهد بها' : 'Cited Sources',
      content: narrative.citedSources.map(s => `- ${s}`).join('\n'),
    });
  }

  return {
    title: ar
      ? `${full ? 'تقرير مفصّل' : 'تقرير موجز'} — استبيان بيئة العمل: ${p.companyName}`
      : `${full ? 'Detailed' : 'Brief'} Survey Report — ${p.companyName}`,
    goal: ar ? `تحليل ${agg.count} استجابة لاستبيان بيئة العمل وفق ISO 9001 و EFQM.`
             : `Analysis of ${agg.count} work-environment survey responses (ISO 9001 + EFQM).`,
    language: p.language,
    sections,
    executiveSummary: narrative.executiveSummary,
    createdAt: new Date(),
    complete: true,
  };
}

/** The questionnaire itself, standalone → GeneratedArtifact. */
export function buildSurveyDefinitionArtifact(
  survey: ProjectSurveySettings | undefined,
  companyName: string,
  language: Language,
): GeneratedArtifact {
  const ar = language === 'ar';
  const wl = survey?.surveyWordLimits || {};
  const sections: ArtifactSection[] = SURVEY_FIELDS.map((f, i) => {
    const min = wl[f.key as string];
    const desc = SECTION_DESC[f.key as string];
    const body = [
      `${f.icon} ${ar ? desc.ar : desc.en}`,
      ar ? `**النوع:** سؤال مفتوح (نصي).` : `**Type:** open-ended (text).`,
      min ? (ar ? `**الحد الأدنى للكلمات:** ${min}` : `**Min words:** ${min}`) : (ar ? `**الحد الأدنى للكلمات:** يُشتق تلقائياً حسب تعقيد الشركة.` : `**Min words:** auto-derived.`),
    ].join('\n\n');
    return { id: `q_${i}`, status: 'done', title: `${i + 1}. ${ar ? f.ar : f.en}`, content: body };
  });

  const scope = survey?.surveyScopeDefault || 'both';
  return {
    title: ar ? `نموذج استبيان تقييم بيئة العمل — ${companyName}` : `Work-Environment Survey — ${companyName}`,
    goal: ar ? `الاستبيان الكامل (${SURVEY_FIELDS.length} محاور) المستخدم لتقييم بيئة العمل والوضع الراهن.`
             : `The full ${SURVEY_FIELDS.length}-axis questionnaire used to assess the work environment.`,
    language,
    executiveSummary: ar
      ? `نطاق الإطلاق الافتراضي: ${scope === 'both' ? 'الموظف + بيئة العمل' : scope === 'environment' ? 'بيئة العمل' : 'الموظف'}. عدد الأسئلة المعرفية المرافقة: ${survey?.questionCount ?? '—'}.`
      : `Default launch scope: ${scope}. Companion competency questions: ${survey?.questionCount ?? '—'}.`,
    sections,
    createdAt: new Date(),
    complete: true,
  };
}

/** One respondent's answers + their diagnosis → GeneratedArtifact. */
export function buildSingleResponseArtifact(
  rec: SurveyResponseRecord,
  language: Language,
): GeneratedArtifact {
  const ar = language === 'ar';
  const a = rec.workplaceAnswers;
  const env = rec.envReportData;
  const sections: ArtifactSection[] = [];

  // identity
  sections.push({
    id: 'who', status: 'done',
    title: ar ? 'بيانات المشارك' : 'Respondent',
    content: [
      `${ar ? 'الاسم' : 'Name'}: ${rec.userName || '—'}`,
      `${ar ? 'المسمى' : 'Job title'}: ${rec.jobTitle || '—'}`,
      rec.department ? `${ar ? 'الإدارة' : 'Department'}: ${rec.department}` : '',
      rec.sentiment ? `${ar ? 'الاتجاه العام' : 'Sentiment'}: ${rec.sentiment}` : '',
      rec.simulated ? (ar ? '_(استجابة محاكاة)_' : '_(simulated response)_') : '',
    ].filter(Boolean).join('\n\n'),
  });

  // answers
  if (a) {
    SURVEY_FIELDS.forEach((f, i) => {
      sections.push({
        id: `a_${i}`, status: 'done',
        title: `${f.icon} ${ar ? f.ar : f.en}`,
        content: a[f.key] || (ar ? '— لا إجابة —' : '— no answer —'),
      });
    });
  }

  // diagnosis
  if (env) {
    sections.push({
      id: 'diag', status: 'done',
      title: ar ? 'التشخيص (ISO 9001 / EFQM)' : 'Diagnosis (ISO 9001 / EFQM)',
      content: [
        `${ar ? 'الرضا العام' : 'Overall'}: ${env.overallScore}/100`,
        `ISO 9001: ${env.isoComplianceRate}%`,
        `EFQM: ${env.efqmExcellenceRate}%`,
        `${ar ? 'البنية الرقمية' : 'Infrastructure'}: ${env.infrastructureRating}`,
        '',
        `**${ar ? 'الملخص' : 'Summary'}:** ${env.currentStatusSummary || '—'}`,
        '',
        `**${ar ? 'أبرز التحديات' : 'Key challenges'}:**`,
        ...(env.keyChallenges || []).map(c => `- ${c}`),
        '',
        `**${ar ? 'توصيات للإدارة' : 'Recommendations'}:**`,
        ...(env.recommendationsForManagement || []).map(c => `- ${c}`),
      ].join('\n'),
    });
  }

  return {
    title: ar ? `استجابة فردية — ${rec.userName || 'مشارك'}` : `Single Response — ${rec.userName || 'respondent'}`,
    goal: ar ? 'استخراج رد فردي كامل من الاستبيان مع التشخيص.' : 'Single full survey response with diagnosis.',
    language,
    sections,
    createdAt: new Date(),
    complete: true,
  };
}

/**
 * N7 — ONE unified employee report combining BOTH the competency Q&A AND the
 * work-environment survey for a single EmployeePortal submission, in one DOCX/PDF.
 * Pure data render (no model call) → rides exportDocx / exportPdfDirect unchanged.
 */
export function buildEmployeeUnifiedArtifact(
  emp: EmployeeResponse,
  language: Language,
): GeneratedArtifact {
  const ar = language === 'ar';
  const sections: ArtifactSection[] = [];

  // identity
  sections.push({
    id: 'who', status: 'done',
    title: ar ? 'بيانات الموظف' : 'Employee',
    content: [
      `${ar ? 'الاسم' : 'Name'}: ${emp.employeeName || '—'}`,
      `${ar ? 'البريد' : 'Email'}: ${emp.employeeEmail || '—'}`,
      `${ar ? 'المسمى الوظيفي' : 'Job title'}: ${emp.jobTitle || '—'}`,
      emp.department ? `${ar ? 'الإدارة/القسم' : 'Department'}: ${emp.department}` : '',
      `${ar ? 'تاريخ التقديم' : 'Submitted'}: ${(emp.submittedAt || '').slice(0, 10)}`,
      emp.completedInSeconds ? `${ar ? 'مدة الإنجاز' : 'Duration'}: ${Math.round(emp.completedInSeconds / 60)} ${ar ? 'دقيقة' : 'min'}` : '',
    ].filter(Boolean).join('\n\n'),
  });

  // competency Q&A
  const qs = emp.questions || [];
  const cas = emp.competencyAnswers || [];
  if (qs.length) {
    const body = qs.map((q, i) => {
      const ans = cas.find(a => a.questionIndex === i);
      return [
        `**${i + 1}. ${q.questionText}**`,
        ans?.selectedAnswer || (ar ? '_لم يُجَب_' : '_Not answered_'),
      ].join('\n\n');
    }).join('\n\n');
    sections.push({
      id: 'competency', status: 'done',
      title: ar ? 'إجابات الجدارات' : 'Competency Answers',
      content: body,
    });
  }

  // work-environment answers
  const wa = emp.workplaceAnswers;
  if (wa) {
    SURVEY_FIELDS.forEach((f, i) => {
      const val = wa[f.key];
      if (!val) return;
      sections.push({
        id: `env_${i}`, status: 'done',
        title: `${f.icon} ${ar ? f.ar : f.en}`,
        content: String(val),
      });
    });
  }

  return {
    title: ar ? `تقرير الموظف الموحّد — ${emp.employeeName || 'موظف'}` : `Unified Employee Report — ${emp.employeeName || 'employee'}`,
    goal: ar
      ? 'تقرير موحّد يجمع إجابات الجدارات واستبيان بيئة العمل لموظف واحد في مستند واحد.'
      : 'Unified report combining one employee\'s competency answers and work-environment survey.',
    language,
    executiveSummary: ar
      ? `${emp.companyName || ''} · ${qs.length} سؤال جدارات${wa ? ' · استبيان بيئة عمل مرفق' : ''}.`
      : `${emp.companyName || ''} · ${qs.length} competency questions${wa ? ' · work-environment survey included' : ''}.`,
    sections,
    createdAt: new Date(),
    complete: true,
  };
}
