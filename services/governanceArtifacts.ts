// N5 — governance-process artifacts derived from the BUILT model (not invented):
//   • Charter (ميثاق الحوكمة)      — objectives / scope / sponsors / committees, generated from the real model
//   • Risk Register (سجل المخاطر)  — deterministic table from model.gaps (likelihood/impact/mitigation/owner)
//   • Roadmap (خارطة الطريق)        — gaps/recommendations bucketed into time horizons by severity
// All three return GeneratedArtifact so they ride the SAME export pipeline (DOCX/PDF/PPTX/HTML) as everything else.
// Risk + roadmap are fully deterministic (no model call → no fabrication). Charter uses Gemini but is
// grounded ONLY in the passed model summary, and falls back to a deterministic charter on any failure.

import { Type } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import type { CompanyGovernanceModel, GovGap, GeneratedArtifact, ArtifactSection } from '../types';

const RLM = '‏';
const sec = (id: string, title: string, content: string): ArtifactSection =>
  ({ id, title, content, status: 'done' });

// severity → (likelihood, impact, horizon) heuristic for the risk register / roadmap
const SEV: Record<GovGap['severity'], { like: string; impact: string; rank: number }> = {
  critical: { like: 'عالٍ', impact: 'جسيم', rank: 0 },
  high: { like: 'عالٍ', impact: 'كبير', rank: 1 },
  medium: { like: 'متوسط', impact: 'متوسط', rank: 2 },
  low: { like: 'منخفض', impact: 'محدود', rank: 3 },
};
const SEV_AR: Record<GovGap['severity'], string> = {
  critical: 'حرجة', high: 'عالية', medium: 'متوسطة', low: 'منخفضة',
};

/** Deterministic risk register: one row per gap, sorted by severity. */
export function buildRiskRegister(model: CompanyGovernanceModel): GeneratedArtifact {
  const gaps = [...(model.gaps || [])].sort((a, b) => SEV[a.severity].rank - SEV[b.severity].rank);
  const rows = gaps.map((g, i) => {
    const s = SEV[g.severity];
    const mitig = (g.recommendation || '—').replace(/\|/g, '،').replace(/\n+/g, ' ').trim();
    const area = (g.area || '—').replace(/\|/g, '،');
    return `| ${i + 1} | ${area} | ${SEV_AR[g.severity]} | ${s.like} | ${s.impact} | ${mitig} | لجنة الحوكمة |`;
  });
  const table = gaps.length
    ? [
        '| # | مجال الخطر | الشدة | الاحتمال | الأثر | إجراء التخفيف | المالك |',
        '|---|---|---|---|---|---|---|',
        ...rows,
      ].join('\n')
    : 'لا توجد فجوات مسجَّلة في النموذج الحالي — لا مخاطر مشتقّة. يُحدَّث السجل تلقائيًا عند اكتشاف فجوات جديدة.';

  const counts = (['critical', 'high', 'medium', 'low'] as const)
    .map(s => ({ s, n: gaps.filter(g => g.severity === s).length }))
    .filter(x => x.n > 0)
    .map(x => `${RLM}- ${SEV_AR[x.s]}: ${x.n}`)
    .join('\n');

  return {
    title: `سجل المخاطر — ${model.companyName}`,
    goal: 'حصر مخاطر الحوكمة المشتقّة من فجوات النموذج مع تقييم الاحتمال/الأثر وإجراء التخفيف والمالك.',
    language: 'ar',
    sections: [
      sec('summary', 'ملخص المخاطر', `${RLM}إجمالي المخاطر: ${gaps.length}\n${counts}`),
      sec('register', 'سجل المخاطر', table),
      sec('method', 'منهجية التقييم', `${RLM}تُشتق المخاطر مباشرة من فجوات نموذج الحوكمة (model.gaps). تُقيَّم الشدة وفق تصنيف الفجوة، ويُحوَّل ذلك إلى احتمال وأثر وفق سلّم موحّد. إجراء التخفيف = توصية معالجة الفجوة. المالك الافتراضي لجنة الحوكمة ما لم يُسنَد لوحدة محددة.`),
    ],
    createdAt: new Date(),
    complete: true,
  };
}

/** Deterministic implementation roadmap: gaps bucketed into 3 time horizons by severity. */
export function buildRoadmap(model: CompanyGovernanceModel): GeneratedArtifact {
  const gaps = model.gaps || [];
  const buckets: { key: string; title: string; sev: GovGap['severity'][] }[] = [
    { key: 'now', title: 'المرحلة الأولى — فوري (0–3 أشهر)', sev: ['critical', 'high'] },
    { key: 'mid', title: 'المرحلة الثانية — متوسط المدى (3–6 أشهر)', sev: ['medium'] },
    { key: 'long', title: 'المرحلة الثالثة — طويل المدى (6–12 شهرًا)', sev: ['low'] },
  ];
  const sections: ArtifactSection[] = buckets.map(b => {
    const items = gaps.filter(g => b.sev.includes(g.severity));
    const body = items.length
      ? items.map(g => `${RLM}- **${g.area}** — ${(g.recommendation || g.description || '').replace(/\n+/g, ' ').trim()}`).join('\n')
      : `${RLM}لا بنود في هذه المرحلة.`;
    return sec(b.key, b.title, body);
  });
  const intro = gaps.length
    ? `${RLM}تُرتَّب معالجة فجوات الحوكمة على ثلاث مراحل زمنية بحسب شدّتها — الأشد أولًا. إجمالي البنود: ${gaps.length}.`
    : `${RLM}لا توجد فجوات في النموذج الحالي؛ خارطة الطريق فارغة وتُحدَّث تلقائيًا عند رصد فجوات.`;
  return {
    title: `خارطة طريق تنفيذ الحوكمة — ${model.companyName}`,
    goal: 'ترتيب معالجة فجوات الحوكمة على مراحل زمنية قابلة للتنفيذ والمتابعة.',
    language: 'ar',
    sections: [sec('intro', 'مدخل', intro), ...sections],
    createdAt: new Date(),
    complete: true,
  };
}

/** Charter generated from the REAL model summary (grounded), deterministic fallback on failure. */
export async function buildCharter(
  model: CompanyGovernanceModel,
  signal?: AbortSignal,
): Promise<GeneratedArtifact> {
  const unitNames = (model.orgUnits || []).map(u => u.name).filter(Boolean).slice(0, 30);
  const topGaps = [...(model.gaps || [])]
    .sort((a, b) => SEV[a.severity].rank - SEV[b.severity].rank)
    .slice(0, 8)
    .map(g => `${g.area} (${SEV_AR[g.severity]})`);
  const committees = (model.committees || []).map(c => c.name).filter(Boolean);

  const summary = [
    `المنشأة: ${model.companyName}`,
    unitNames.length ? `الوحدات التنظيمية: ${unitNames.join('، ')}` : '',
    `عدد السياسات: ${(model.policies || []).length} · الإجراءات: ${(model.procedures || []).length} · المؤشرات: ${(model.kpis || []).length}`,
    committees.length ? `اللجان القائمة: ${committees.join('، ')}` : '',
    topGaps.length ? `أبرز الفجوات: ${topGaps.join('، ')}` : '',
  ].filter(Boolean).join('\n');

  const schema = {
    type: Type.OBJECT,
    properties: {
      objectives: { type: Type.ARRAY, items: { type: Type.STRING } },
      scopeIn: { type: Type.ARRAY, items: { type: Type.STRING } },
      scopeOut: { type: Type.ARRAY, items: { type: Type.STRING } },
      sponsors: { type: Type.ARRAY, items: { type: Type.STRING } },
      committees: { type: Type.ARRAY, items: { type: Type.STRING } },
      successMetrics: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['objectives', 'scopeIn', 'sponsors'],
  };

  const fallback = (): GeneratedArtifact => ({
    title: `ميثاق الحوكمة — ${model.companyName}`,
    goal: 'تحديد أهداف مبادرة الحوكمة ونطاقها ورُعاتها واللجان المسؤولة قبل البناء.',
    language: 'ar',
    sections: [
      sec('obj', 'الأهداف', `${RLM}- ترسيخ إطار حوكمة موثّق لدى ${model.companyName}.\n${RLM}- معالجة الفجوات المرصودة في النموذج.\n${RLM}- توضيح الأدوار والصلاحيات والمساءلة.`),
      sec('scope', 'النطاق', `${RLM}يشمل: الوحدات التنظيمية، السياسات، الإجراءات، الصلاحيات، المؤشرات.\n${RLM}لا يشمل: التغييرات التشغيلية اليومية خارج إطار الحوكمة.`),
      sec('sponsors', 'الرعاة والمسؤوليات', `${RLM}الراعي: مجلس الإدارة / الإدارة التنفيذية العليا.\n${RLM}الإشراف: لجنة الحوكمة.`),
    ],
    createdAt: new Date(),
    complete: true,
  });

  try {
    const r = await generateJson<{
      objectives: string[]; scopeIn: string[]; scopeOut?: string[];
      sponsors: string[]; committees?: string[]; successMetrics?: string[];
    }>(
      `أنت مستشار حوكمة. اكتب ميثاق حوكمة (Charter) مبنيًا حصريًا على ملخّص النموذج التالي — لا تخترع وحدات أو أرقامًا غير واردة:\n\n${summary}\n\nأعد JSON بالحقول: objectives (أهداف قابلة للقياس)، scopeIn (داخل النطاق)، scopeOut (خارج النطاق)، sponsors (الرعاة)، committees (اللجان)، successMetrics (مؤشرات نجاح المبادرة).`,
      schema,
      { signal, temperature: 0.3 },
    );
    const li = (arr?: string[]) => (arr && arr.length ? arr.map(x => `${RLM}- ${x}`).join('\n') : `${RLM}—`);
    return {
      title: `ميثاق الحوكمة — ${model.companyName}`,
      goal: 'تحديد أهداف مبادرة الحوكمة ونطاقها ورُعاتها واللجان المسؤولة قبل البناء.',
      language: 'ar',
      sections: [
        sec('obj', 'الأهداف', li(r.objectives)),
        sec('scopeIn', 'داخل النطاق', li(r.scopeIn)),
        sec('scopeOut', 'خارج النطاق', li(r.scopeOut)),
        sec('sponsors', 'الرعاة', li(r.sponsors)),
        sec('committees', 'اللجان المسؤولة', li(r.committees)),
        sec('metrics', 'مؤشرات نجاح المبادرة', li(r.successMetrics)),
      ],
      createdAt: new Date(),
      complete: true,
    };
  } catch (e: any) {
    if (e?.message === 'aborted') throw e;
    return fallback();
  }
}

// D2 — the risk register / roadmap (unlike charter/genDoc) have no backing
// state at all; GovernanceCenter falls back to auto-saving their canvas edits
// into the document library. DocumentCanvas calls onSave after EVERY smart-edit
// action, not just an explicit Save click, so a naive fallback would mint a new
// library record (and re-show the "saved to library" toast) on every keystroke-
// level save. This PURE helper makes that idempotent per open artifact: the
// caller keeps the returned `state` (record id + createdAt) in a ref and passes
// it back in on the next save, so repeat saves overwrite the SAME record and an
// unchanged html is skipped entirely (no redundant write).
export interface CanvasArtLibSaveState {
  id: string;
  createdAt: string;
}
// NOTE: the discriminant is a STRING literal ('skip'/'save'), not a boolean —
// this project's tsconfig has `strict` unset (strictNullChecks off), and under
// that setting `tsc` does not narrow a `{ skip: true } | { skip: false; ... }`
// union on a boolean-literal discriminant (confirmed against this repo's exact
// tsconfig); a string-literal discriminant narrows correctly either way.
export function nextCanvasArtLibSave(
  html: string,
  prevState: CanvasArtLibSaveState | null,
  prevHtml: string,
  mintId: () => string,
): { status: 'skip' } | { status: 'save'; isFirstSave: boolean; state: CanvasArtLibSaveState } {
  if (prevState && html === prevHtml) return { status: 'skip' };
  return {
    status: 'save',
    isFirstSave: !prevState,
    state: prevState || { id: mintId(), createdAt: new Date().toISOString() },
  };
}
