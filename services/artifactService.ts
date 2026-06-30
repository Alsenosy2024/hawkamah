// Long-artifact generator: outline → sections (streamed) → self-critique →
// targeted revision → local assembly. Produces a large structured report by
// chaining many bounded Gemini calls (no single-response ceiling). Resilient to
// per-section failure (placeholder + continue) and to user abort (partial result).

import { Type } from '@google/genai';
import { streamChat, generateJson } from './agentOrchestrator';
import { resolveLengthTarget } from './governanceChat';
import type {
  GeneratedArtifact, ArtifactSection, ArtifactSectionPlan, ArtifactProgress, Language,
} from '../types';

export interface LongArtifactParams {
  title: string;
  goal: string;
  systemInstruction: string;   // persona + numbered docs knowledge base
  clientDetails: string;
  language: Language;
  targetPages?: number;        // V4: requested length → bounds section count + per-section depth
  signal?: AbortSignal;
  onProgress?: (p: ArtifactProgress) => void;
  onThought?: (chunk: string) => void;
  onSection?: (sections: ArtifactSection[]) => void;  // partial-progress for "export what's done"
}

// V4: turn a requested page count into per-section budgets so no section runs
// away. Returns null when no target is set (preserves the original behavior).
function sectionBudget(targetPages?: number): {
  pages: number; secMin: number; secMax: number; wordsPerSection: number; maxOutputTokens: number;
} | null {
  if (!targetPages || targetPages <= 0) return null;
  const { pages, sections, wordsPerSection } = resolveLengthTarget(targetPages);
  return {
    pages,
    secMin: Math.max(4, sections - 1),
    secMax: sections + 2,
    wordsPerSection,
    // Per-section ceiling sized to the word budget (+ headroom) so a single
    // section can't balloon past its share of the document.
    maxOutputTokens: Math.max(2048, Math.min(12288, Math.round(wordsPerSection * 3 * 1.4))),
  };
}

const outlineSchema = {
  type: Type.OBJECT,
  properties: {
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          goal: { type: Type.STRING },
        },
        required: ['title', 'goal'],
      },
    },
  },
  required: ['sections'],
};

const critiqueSchema = {
  type: Type.OBJECT,
  properties: {
    issues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sectionIndex: { type: Type.NUMBER },
          issue: { type: Type.STRING },
          fix: { type: Type.STRING },
        },
        required: ['sectionIndex', 'issue', 'fix'],
      },
    },
  },
  required: ['issues'],
};

const isAborted = (s?: AbortSignal) => !!s?.aborted;

export async function generateLongArtifact(p: LongArtifactParams): Promise<GeneratedArtifact> {
  const { signal, onProgress, onThought, onSection, language } = p;
  const budget = sectionBudget(p.targetPages);   // null ⇒ legacy unbounded behavior

  const artifact: GeneratedArtifact = {
    title: p.title,
    goal: p.goal,
    language,
    sections: [],
    createdAt: new Date(),
    complete: false,
  };

  // ---- Phase A: outline ----
  onProgress?.({ phase: 'outline', current: 0, total: 1, label: 'بناء الهيكل العام للتقرير...' });
  let plans: ArtifactSectionPlan[] = [];
  try {
    const sectionRange = budget ? `${budget.secMin} إلى ${budget.secMax}` : '6 إلى 10';
    const lengthNote = budget
      ? `\nالطول المستهدف للتقرير ≈ ${budget.pages} صفحة — اجعل عدد الأقسام مناسباً لهذا الطول ولا تُفرط في التقسيم.`
      : '';
    const outlinePrompt = `أنت تخطّط تقريراً استشارياً ضخماً بعنوان "${p.title}".
الهدف: ${p.goal}
الجهة محل الدراسة: ${p.clientDetails}

صمّم هيكلاً من ${sectionRange} أقسام منطقية متكاملة لتقرير حوكمة وتميّز مؤسسي (مثال: ملخص تنفيذي، الواقع الراهن، مواءمة EFQM/ISO، تحليل الفجوات، مصفوفة الجدارات، التوصيات، خارطة الطريق، الملاحق).${lengthNote}
لكل قسم: عنوان عربي دقيق + هدف يوضّح ما يجب أن يغطّيه. أعد JSON فقط.`;
    const res = await generateJson<{ sections: { title: string; goal: string }[] }>(
      outlinePrompt, outlineSchema, { systemInstruction: p.systemInstruction, signal },
    );
    plans = (res.sections || []).map((s, i) => ({ id: `s${i + 1}`, title: s.title, goal: s.goal }));
  } catch {
    // Minimal safe fallback outline so generation can still proceed.
    plans = [
      { id: 's1', title: 'الملخص التنفيذي', goal: 'نظرة شاملة على النتائج والتوصيات' },
      { id: 's2', title: 'الواقع الراهن', goal: 'تشخيص الوضع الحالي بناءً على الوثائق' },
      { id: 's3', title: 'مواءمة معايير EFQM و ISO', goal: 'تقييم التوافق مع المعايير' },
      { id: 's4', title: 'تحليل الفجوات', goal: 'الفجوات بين الواقع والمعايير' },
      { id: 's5', title: 'مصفوفة الجدارات', goal: 'الجدارات المستهدفة ومستوياتها' },
      { id: 's6', title: 'التوصيات وخارطة الطريق', goal: 'خطة عملية بمراحل زمنية' },
    ];
  }

  if (isAborted(signal)) return artifact;

  artifact.sections = plans.map(pl => ({ id: pl.id, title: pl.title, content: '', status: 'pending' as const }));
  onSection?.(artifact.sections);

  const outlineText = plans.map((pl, i) => `${i + 1}. ${pl.title} — ${pl.goal}`).join('\n');

  // ---- Phase B: sections (streamed, sequential) ----
  const writeSection = async (idx: number): Promise<void> => {
    const pl = plans[idx];
    const sectionPrompt = `أنت تكتب القسم رقم ${idx + 1} بعنوان "${pl.title}" ضمن تقرير "${p.title}".
هدف القسم: ${pl.goal}

الهيكل الكامل للتقرير (لتفادي التكرار مع الأقسام الأخرى — اكتب محتوى هذا القسم فقط):
${outlineText}

التزم بما يلي:
- ابدأ بعنوان فرعي مناسب بصيغة Markdown (## للعناوين الرئيسية، ### للفرعية).
- استند للوثائق المرقّمة واذكر [وثيقة N] عند كل رقم أو ادعاء مأخوذ منها. لا تختلق أرقاماً.
- استخدم تعداداً وجداول Markdown عند الحاجة. اكتب بعمق استشاري واف (عدة فقرات).${
  budget
    ? `\n- الطول المستهدف لهذا القسم ≈ ${budget.wordsPerSection} كلمة — لا تتجاوزه ولا تُضِف حشواً؛ امنح القسم عمقاً مناسباً لطوله فقط.`
    : ''}
- اللغة: العربية الفصحى الرصينة.`;
    artifact.sections[idx].status = 'writing';
    onSection?.([...artifact.sections]);
    onProgress?.({ phase: 'section', current: idx + 1, total: plans.length, label: `كتابة القسم ${idx + 1} من ${plans.length}: ${pl.title}` });

    let content = '';
    const run = () => streamChat(
      // V4: cap section output to its word budget so a single section can't run
      // away. Without a target, leave maxOutputTokens at the model default.
      { systemInstruction: p.systemInstruction, history: [], message: sectionPrompt, signal,
        ...(budget ? { maxOutputTokens: budget.maxOutputTokens } : {}) },
      {
        onThought: t => onThought?.(t),
        onAnswer: a => {
          content += a;
          artifact.sections[idx].content = content;
          onSection?.([...artifact.sections]);
        },
      },
    );
    try {
      await run();
      if (!content.trim() && !isAborted(signal)) {
        await new Promise(r => setTimeout(r, 800)); // backoff + retry once
        content = '';
        await run();
      }
      artifact.sections[idx].content = content || `*(تعذّر توليد محتوى هذا القسم — يلزم إعادة المحاولة لاحقاً.)*`;
      artifact.sections[idx].status = content.trim() ? 'done' : 'failed';
    } catch {
      artifact.sections[idx].content = `*(تعذّر توليد محتوى هذا القسم بسبب خطأ في الاتصال.)*`;
      artifact.sections[idx].status = 'failed';
    }
    onSection?.([...artifact.sections]);
  };

  for (let i = 0; i < plans.length; i++) {
    if (isAborted(signal)) return artifact;
    await writeSection(i);
  }

  if (isAborted(signal)) return artifact;

  // ---- Phase C: one global self-critique ----
  onProgress?.({ phase: 'critique', current: 0, total: 1, label: 'تقييم ذاتي وفحص التناقضات والاستشهادات...' });
  let issues: { sectionIndex: number; issue: string; fix: string }[] = [];
  try {
    const digest = artifact.sections
      .map((s, i) => `### قسم ${i + 1}: ${s.title}\n${s.content.slice(0, 1500)}`)
      .join('\n\n');
    const critiquePrompt = `راجع مسودة التقرير التالية بعين ناقدة. حدّد فقط المشكلات الجوهرية: التناقضات بين الأقسام، الأرقام بلا سند [وثيقة N]، الاستشهادات الناقصة، أو الفجوات المنطقية.
لكل مشكلة أعد: sectionIndex (رقم القسم من 1)، issue (وصف المشكلة)، fix (التصحيح المطلوب). إن لم توجد مشكلات أعد قائمة فارغة. JSON فقط.

${digest}`;
    const res = await generateJson<{ issues: typeof issues }>(critiquePrompt, critiqueSchema, { systemInstruction: p.systemInstruction, signal });
    issues = (res.issues || []).filter(it => it.sectionIndex >= 1 && it.sectionIndex <= plans.length);
  } catch {
    issues = [];
  }

  // ---- Phase D: targeted revisions (only flagged sections) ----
  if (issues.length && !isAborted(signal)) {
    const byIdx = new Map<number, string[]>();
    issues.forEach(it => {
      const k = it.sectionIndex - 1;
      if (!byIdx.has(k)) byIdx.set(k, []);
      byIdx.get(k)!.push(`- ${it.issue} ← ${it.fix}`);
    });
    let done = 0;
    for (const [idx, fixes] of byIdx) {
      if (isAborted(signal)) break;
      done++;
      onProgress?.({ phase: 'revise', current: done, total: byIdx.size, label: `تنقيح القسم ${idx + 1}: ${plans[idx]?.title || ''}` });
      const revisePrompt = `أعد كتابة القسم التالي بعد معالجة الملاحظات المذكورة، مع الحفاظ على العمق والأسلوب وإضافة الاستشهادات [وثيقة N] الناقصة. أعد المحتوى الكامل المنقّح بصيغة Markdown فقط.

الملاحظات:
${fixes.join('\n')}

النص الحالي:
${artifact.sections[idx].content}`;
      let revised = '';
      try {
        await streamChat(
          { systemInstruction: p.systemInstruction, history: [], message: revisePrompt, signal },
          { onThought: t => onThought?.(t), onAnswer: a => { revised += a; } },
        );
        if (revised.trim()) {
          artifact.sections[idx].content = revised;
          onSection?.([...artifact.sections]);
        }
      } catch { /* keep original on failure */ }
    }
  }

  if (isAborted(signal)) return artifact;

  // ---- Phase E: assemble (executive summary linking the whole) ----
  onProgress?.({ phase: 'assemble', current: 0, total: 1, label: 'صياغة الملخص التنفيذي الرابط...' });
  try {
    const digest = artifact.sections.map((s, i) => `${i + 1}. ${s.title}: ${s.content.slice(0, 600)}`).join('\n');
    const sumPrompt = `بناءً على الأقسام التالية، اكتب ملخصاً تنفيذياً موجزاً ومترابطاً (٣ إلى ٥ فقرات) يبرز أهم النتائج والتوصيات الكبرى. Markdown عربي فقط.\n\n${digest}`;
    let summary = '';
    await streamChat(
      { systemInstruction: p.systemInstruction, history: [], message: sumPrompt, signal, maxOutputTokens: 2048 },
      { onThought: t => onThought?.(t), onAnswer: a => { summary += a; } },
    );
    if (summary.trim()) artifact.executiveSummary = summary;
  } catch { /* summary optional */ }

  artifact.complete = !isAborted(signal);
  onProgress?.({ phase: 'done', current: plans.length, total: plans.length, label: 'اكتمل توليد التقرير الشامل ✅' });
  onSection?.([...artifact.sections]);
  return artifact;
}
