// Unified Assessment Service — one link per project, employees self-identify.
// Collections: unified_tokens (token config), unified_results (per-employee results)

import { db } from '../firebase';
import { collection, doc, setDoc, getDoc, addDoc, updateDoc, query, where, getDocs } from 'firebase/firestore';
import type { UnifiedAssessmentToken, UnifiedAssessmentResult, UnifiedEmployeeAnalysis, PaperQuestion } from '../types';
import { generateJson } from './agentOrchestrator';
import { exportDocx, exportPdfDirect } from './exportService';
import type { GeneratedArtifact } from '../types';

const C_TOKEN  = 'unified_tokens';
const C_RESULT = 'unified_results';

function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// Firestore rejects `undefined` field values; strip them (and deep-clone) before
// every write — the project-wide convention (see governanceService `clean`).
// Optional fields that happen to be undefined — e.g. companyLogoUrl on a project
// created via file extraction (no logo), or analysis before it's generated — are
// simply omitted instead of crashing the write.
const clean = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o));

export async function createUnifiedToken(tok: Omit<UnifiedAssessmentToken, 'id' | 'createdAt' | 'active'>): Promise<{ token: string; url: string }> {
  const id = genId();
  const full: UnifiedAssessmentToken = {
    ...tok,
    id,
    createdAt: new Date().toISOString(),
    active: true,
  };
  await setDoc(doc(db, C_TOKEN, id), clean(full));
  const url = `${window.location.origin}/?assess=${id}`;
  return { token: id, url };
}

export async function getUnifiedToken(id: string): Promise<UnifiedAssessmentToken | null> {
  const snap = await getDoc(doc(db, C_TOKEN, id));
  return snap.exists() ? (snap.data() as UnifiedAssessmentToken) : null;
}

export async function getProjectResults(tenantId: string): Promise<UnifiedAssessmentResult[]> {
  const q = query(collection(db, C_RESULT), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<UnifiedAssessmentResult, 'id'>) }));
}

export async function getTokenResults(tokenId: string): Promise<UnifiedAssessmentResult[]> {
  const q = query(collection(db, C_RESULT), where('tokenId', '==', tokenId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<UnifiedAssessmentResult, 'id'>) }));
}

export async function saveUnifiedResult(result: UnifiedAssessmentResult): Promise<string> {
  if (result.id) {
    const { id, ...data } = result;
    await updateDoc(doc(db, C_RESULT, id), clean(data) as Record<string, unknown>);
    return id;
  }
  const ref = await addDoc(collection(db, C_RESULT), clean(result));
  return ref.id;
}

// CRITICAL fix (pure, unit-tested): the ACTUAL generated question set is now
// persisted per-attempt (UnifiedAttempt.questions — a retry regenerates a fresh
// set, so it can't live on the parent result). Selects the same attempt
// scoreAttempt/the review UI treat as authoritative (best score, else the
// first). Returns [] — never a reconstructed placeholder — for a legacy record
// saved before persistence was added, or an attempt awaiting the fix's rollout.
export function getAttemptQuestions(result: UnifiedAssessmentResult): PaperQuestion[] {
  const best = result.attempts.find(a => a.score === result.bestScore) ?? result.attempts[0];
  return best?.questions ?? [];
}

export function scoreAttempt(questions: PaperQuestion[], answers: Record<number, string>): number {
  const mcq = questions.map((q, i) => ({ q, i })).filter(({ q }) => !q.isVoice);
  if (!mcq.length) return 0;
  const correct = mcq.filter(({ q, i }) => {
    const chosen = (answers[i] ?? '').trim();
    // Guard: an empty correctAnswer (degenerate model output) makes startsWith('')
    // true for every chosen value — which would score the question correct for all
    // candidates. No defined answer ⇒ no one can be correct.
    return !!q.correctAnswer && chosen.startsWith(q.correctAnswer);
  }).length;
  return Math.round((correct / mcq.length) * 100);
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    overallScore:       { type: 'number' },
    passed:             { type: 'boolean' },
    strengths:          { type: 'array', items: { type: 'string' } },
    weaknesses:         { type: 'array', items: { type: 'string' } },
    behavioralInsights: { type: 'string' },
    recommendations:    { type: 'string' },
    competencyScores:   {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, score: { type: 'number' } },
        required: ['name', 'score'],
      },
    },
  },
  required: ['overallScore', 'passed', 'strengths', 'weaknesses', 'behavioralInsights', 'recommendations', 'competencyScores'],
};

export async function analyzeResult(
  result: UnifiedAssessmentResult,
  questions: PaperQuestion[],
): Promise<UnifiedEmployeeAnalysis> {
  const answeredPairs = questions.map((q, i) => ({
    q: q.text,
    type: q.type,
    correct: q.correctAnswer,
    chosen: result.attempts[result.attempts.length - 1]?.answers[i] ?? '',
    voice: result.attempts[result.attempts.length - 1]?.voiceAnswers?.[i],
  }));

  const prompt = `أنت خبير تقييم كفاءات موارد بشرية. حلّل نتيجة الموظف التالية وأصدر تقريراً تشخيصياً شاملاً بالعربية.

الموظف: ${result.employeeName}
المسمى الوظيفي: ${result.jobTitle}
الشركة: ${result.companyName}
أفضل درجة: ${result.bestScore}%
عدد المحاولات: ${result.attempts.length}

أسئلة الاختبار وإجابات الموظف:
${answeredPairs.slice(0, 20).map((p, i) => `${i + 1}. [${p.type}] ${p.q}\n   صحيح: ${p.correct} | اختار: ${p.chosen}${p.voice ? ` | صوتي: "${p.voice.slice(0, 80)}"` : ''}`).join('\n')}

أنتج JSON مع:
- overallScore: تقدير شامل من 100
- passed: هل اجتاز (>= 60)?
- strengths: قائمة 3-5 نقاط قوة واضحة
- weaknesses: قائمة 3-5 نقاط ضعف محددة
- behavioralInsights: فقرة تحليل سلوكي ونفسي (150-250 كلمة)
- recommendations: فقرة توصيات تطوير (100-150 كلمة)
- competencyScores: مصفوفة [{name, score}] لأبرز 5 كفاءات`;

  return generateJson<UnifiedEmployeeAnalysis>(prompt, ANALYSIS_SCHEMA, {
    disableThinking: true,
    maxOutputTokens: 4000,
    retries: 2,
  });
}

export function buildEmployeeArtifact(
  result: UnifiedAssessmentResult,
  questions: PaperQuestion[],
): GeneratedArtifact {
  const a = result.analysis;
  const best = result.attempts.find(at => at.score === result.bestScore) ?? result.attempts[0];

  const competencyTable = a?.competencyScores?.length
    ? `| الكفاءة | الدرجة |\n|---------|--------|\n${a.competencyScores.map(c => `| ${c.name} | ${c.score}% |`).join('\n')}`
    : '';

  // CRITICAL fix: `questions` must now be the REAL persisted set (best.questions —
  // see UnifiedAttempt.questions), never a reconstructed placeholder. A legacy
  // record saved before persistence was added has none — say so honestly instead
  // of printing a plausible-looking but fabricated answer key (every ❌, "سؤال 1").
  const answersSection = questions.length
    ? questions.slice(0, 30).map((q, i) => {
        const chosen = best?.answers[i] ?? '—';
        const correct = q.correctAnswer;
        const mark = chosen.startsWith(correct) ? '✅' : '❌';
        return `${mark} **${i + 1}. ${q.text}**\n- الصحيح: ${correct} | اختار: ${chosen}${q.isVoice && best?.voiceAnswers?.[i] ? `\n- صوتي: "${best.voiceAnswers[i]}"` : ''}`;
      }).join('\n\n')
    : 'الأسئلة الأصلية غير محفوظة لهذا التقييم (سجل سابق لتفعيل حفظ الأسئلة) — تعذّر عرض ورقة الإجابات التفصيلية. الدرجة الإجمالية والتحليل أعلاه (إن وُجد) يبقيان صحيحين.';

  return {
    title: `تقرير تقييم موظف — ${result.employeeName}`,
    goal: `تقرير شامل لنتيجة ${result.employeeName} في اختبار ${result.jobTitle}`,
    language: 'ar',
    createdAt: new Date(result.submittedAt),
    complete: true,
    sections: [
      {
        id: 'summary',
        title: 'ملخص النتيجة',
        status: 'done',
        content: `## ${result.employeeName}\n\n**المسمى الوظيفي:** ${result.jobTitle}  \n**الشركة:** ${result.companyName}  \n**أفضل درجة:** ${result.bestScore}%  \n**النتيجة:** ${result.passed ? '✅ ناجح' : '❌ راسب'}  \n**المحاولات:** ${result.attempts.length}  \n**تاريخ التقييم:** ${new Date(result.submittedAt).toLocaleDateString('ar-SA')}`,
      },
      ...(a ? [
        {
          id: 'analysis',
          title: 'التحليل والكفاءات',
          status: 'done' as const,
          content: `## نقاط القوة\n${a.strengths.map(s => `- ${s}`).join('\n')}\n\n## نقاط الضعف\n${a.weaknesses.map(w => `- ${w}`).join('\n')}\n\n${competencyTable ? `## درجات الكفاءات\n${competencyTable}\n\n` : ''}## التحليل السلوكي\n${a.behavioralInsights}`,
        },
        {
          id: 'recommendations',
          title: 'التوصيات',
          status: 'done' as const,
          content: `## توصيات التطوير\n${a.recommendations}`,
        },
      ] : []),
      {
        id: 'answers',
        title: 'تفاصيل الإجابات',
        status: 'done',
        content: answersSection,
      },
    ],
  };
}

export async function exportEmployeePdf(result: UnifiedAssessmentResult, questions: PaperQuestion[]): Promise<void> {
  const artifact = buildEmployeeArtifact(result, questions);
  await exportPdfDirect(artifact, { language: 'ar' });
}

export async function exportEmployeeDocx(result: UnifiedAssessmentResult, questions: PaperQuestion[]): Promise<void> {
  const artifact = buildEmployeeArtifact(result, questions);
  await exportDocx(artifact, { language: 'ar' });
}
