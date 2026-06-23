// Headless E2E for the survey simulation + report pipeline.
// Exercises the REAL new code paths (analyze + aggregate narrative + deterministic
// builders) against the real تال company context, using the live Gemini key.
// Skips Firebase persistence + DOM export (validated separately in-app).
import { Type } from '@google/genai';
import { generateJson } from '../services/agentOrchestrator';
import { analyzeWorkEnvironment } from '../services/geminiService';
import {
  computeAggregate, buildAggregateArtifact,
  buildSurveyDefinitionArtifact, buildSingleResponseArtifact,
  type SurveyResponseRecord,
} from '../services/surveyReport';
import type { WorkEnvironmentAnswers } from '../types';

const COMPANY = 'شركة تال للمقاولات الهندسية الدولية';
const ORG = [
  'اسم الشركة: شركة تال للمقاولات الهندسية الدولية',
  'القطاع: المقاولات والإنشاءات الهندسية',
  'الوصف: شركة سعودية تعمل في إدارة وتنفيذ مشاريع المقاولات الهندسية الدولية، بصدد تطوير نظام إدارة مشاريع وأتمتة ذكية وحوكمة مؤسسية.',
  'الرؤية: التميز في تنفيذ المشاريع الهندسية ومواكبة رؤية 2030.',
].join('\n');

const COUNT = 4;
const ok = (c: boolean, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) process.exitCode = 1; };

const respSchema = {
  type: Type.OBJECT,
  properties: {
    respondents: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING }, jobTitle: { type: Type.STRING },
          department: { type: Type.STRING }, sentiment: { type: Type.STRING },
          answers: {
            type: Type.OBJECT,
            properties: {
              proceduresAndPolicies: { type: Type.STRING }, digitalInfrastructure: { type: Type.STRING },
              challengesAndProblems: { type: Type.STRING }, employeeRelationships: { type: Type.STRING },
              aspirationsAndDevelopment: { type: Type.STRING }, organizationalReconstructionOpinion: { type: Type.STRING },
            },
            required: ['proceduresAndPolicies', 'digitalInfrastructure', 'challengesAndProblems', 'employeeRelationships', 'aspirationsAndDevelopment', 'organizationalReconstructionOpinion'],
          },
        },
        required: ['name', 'jobTitle', 'department', 'sentiment', 'answers'],
      },
    },
  },
  required: ['respondents'],
};

async function main() {
  console.log('=== E2E: تال survey simulation + reports ===');

  // 1) generate respondents (real LLM)
  const gen = await generateJson<{ respondents: any[] }>(
    [
      `ولّد ${COUNT} موظف افتراضي واقعي في الشركة التالية، كلٌّ يملأ استبيان بيئة العمل (6 حقول، 2-3 جمل واقعية لكل حقل).`,
      ORG,
      'وزّع المشاعر: positive, neutral, negative, positive. أعد JSON {respondents:[{name,jobTitle,department,sentiment,answers:{...}}]}',
    ].join('\n'),
    respSchema, { temperature: 0.9 },
  );
  const reps = gen?.respondents || [];
  ok(reps.length >= 3, `generated respondents = ${reps.length}`);
  ok(reps.every(r => r.answers?.proceduresAndPolicies?.length > 5), 'all answers populated');

  // 2) analyze each (real LLM ISO/EFQM)
  const records: SurveyResponseRecord[] = [];
  for (let i = 0; i < reps.length; i++) {
    const r = reps[i];
    const answers = r.answers as WorkEnvironmentAnswers;
    let env: any = null;
    try { env = await analyzeWorkEnvironment(answers, 'ar', r.jobTitle, ORG); }
    catch (e: any) { console.log('  analyze fail', e?.message); }
    records.push({
      id: `e2e_${i}`, userName: r.name, jobTitle: r.jobTitle, department: r.department,
      sentiment: r.sentiment, simulated: true, workplaceAnswers: answers, envReportData: env,
    } as SurveyResponseRecord);
    console.log(`  analyzed ${i + 1}/${reps.length}: ${r.name} overall=${env?.overallScore ?? '—'}`);
  }
  const analyzed = records.filter(r => r.envReportData).length;
  ok(analyzed >= 1, `analyzed records = ${analyzed}/${records.length}`);

  // 3) deterministic aggregate
  const agg = computeAggregate(records);
  ok(agg.count === records.length, `aggregate count = ${agg.count}`);
  ok(Array.isArray(agg.topChallenges), `topChallenges computed (${agg.topChallenges.length})`);
  ok(!!agg.sentimentDist, `sentiment distribution computed`);

  // 4) aggregate artifact — full + brief (real LLM narrative)
  const full = await buildAggregateArtifact({ records, companyName: COMPANY, mode: 'full', language: 'ar', orgContext: ORG });
  ok(full.sections.length >= 4, `FULL report sections = ${full.sections.length}`);
  ok(!!full.executiveSummary, 'FULL has executive summary');
  const brief = await buildAggregateArtifact({ records, companyName: COMPANY, mode: 'brief', language: 'ar', orgContext: ORG });
  ok(brief.sections.length >= 2 && brief.sections.length <= full.sections.length, `BRIEF sections = ${brief.sections.length}`);

  // 5) survey definition (no-LLM)
  const def = buildSurveyDefinitionArtifact(undefined, COMPANY, 'ar');
  ok(def.sections.length === 6, `survey definition sections = ${def.sections.length} (expect 6)`);

  // 6) single response (no-LLM)
  const one = buildSingleResponseArtifact(records[0], 'ar');
  ok(one.sections.length >= 6, `single-response sections = ${one.sections.length}`);
  ok(one.title.includes(records[0].userName), 'single-response titled with respondent');

  console.log('=== done; exitCode=', process.exitCode || 0, '===');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
