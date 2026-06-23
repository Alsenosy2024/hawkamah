// م4 — Assessment Aggregator
// Rolls up many employee/survey assessment outputs into a compact, statistically
// meaningful feedback signal that buildModel can consume — instead of dumping raw
// individual records (which doesn't scale past a handful and biases the model toward
// whoever happens to be first in the list).
//
// Output: a structured digest (counts, average scores, recurring competency gaps,
// recurring strength/weakness themes, survey sentiment) plus a ready-to-inject text
// block. The text block is what flows into buildModel's `assessmentContext`.

export interface AssessmentLike {
  userName?: string;
  jobTitle?: string;
  assessmentType?: string; // 'text' | 'verbal' | 'survey'
  reportData?: any;
  createdAt?: any;
}

export interface AggregatedCompetency {
  competency: string;
  avgScore: number;   // 0–100
  count: number;      // how many assessments scored it
  min: number;
  max: number;
}

export interface AggregatedGap {
  skill: string;
  count: number;          // how many employees show this gap
  avgRequired: number;
  avgActual: number;
  avgDeficit: number;     // required − actual, averaged
}

export interface AssessmentAggregate {
  total: number;
  byType: Record<string, number>;
  avgTotalScore: number | null;        // mean of totalScore across reports
  competencies: AggregatedCompetency[]; // sorted: weakest first
  gaps: AggregatedGap[];                // sorted: largest recurring deficit first
  strengthThemes: { theme: string; count: number }[];
  weaknessThemes: { theme: string; count: number }[];
  coverage: number;                     // distinct people/titles represented
}

const NORM_SPLIT = /[،,؛;\n•·\-–|]+/;

// F13: dedup themes/competencies in an Arabic-aware way. toLowerCase() does nothing
// for Arabic, so "السياسات" and "السِّياسات" (with tashkeel), or "الادارة" vs "الإدارة"
// (alef variants) were counted as DISTINCT themes — fragmenting the recurring-gap
// signal buildModel relies on. Strip tashkeel/tatweel and fold alef/ya/ta-marbuta.
const AR_DIACRITICS = /[ً-ْٰـ]/g; // harakat + superscript alef + tatweel
function normKey(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cheap theme extraction: split a free-text field into short normalized phrases. */
function phrases(text: string): string[] {
  if (!text) return [];
  return text
    .split(NORM_SPLIT)
    .map(s => s.trim().replace(/^[0-9.)\s]+/, ''))
    .filter(s => s.length >= 4 && s.length <= 80);
}

function tallyThemes(items: string[], cap = 8): { theme: string; count: number }[] {
  const map = new Map<string, { theme: string; count: number }>();
  for (const raw of items) {
    const key = normKey(raw);
    if (!key) continue;
    const ex = map.get(key);
    if (ex) ex.count++;
    else map.set(key, { theme: raw, count: 1 });
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || a.theme.length - b.theme.length)
    .slice(0, cap);
}

export function aggregateAssessments(assessments: AssessmentLike[]): AssessmentAggregate {
  const list = (assessments || []).filter(a => a && a.reportData);
  const byType: Record<string, number> = {};
  const compAcc = new Map<string, { sum: number; n: number; min: number; max: number; label: string }>();
  const gapAcc = new Map<string, { n: number; req: number; act: number; label: string }>();
  const strengthBits: string[] = [];
  const weaknessBits: string[] = [];
  const people = new Set<string>();
  let scoreSum = 0, scoreN = 0;

  for (const a of list) {
    const type = a.assessmentType || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
    const who = (a.userName || a.jobTitle || '').trim();
    if (who) people.add(who.toLowerCase());

    const r = a.reportData || {};
    if (typeof r.totalScore === 'number' && !Number.isNaN(r.totalScore)) {
      scoreSum += r.totalScore; scoreN++;
    }

    for (const c of (r.competencyScores || [])) {
      if (!c || !c.competency || typeof c.score !== 'number') continue;
      const label = String(c.competency).trim();
      const key = normKey(label);  // F13: Arabic-aware merge of variant spellings
      if (!key) continue;
      const ex = compAcc.get(key);
      if (ex) { ex.sum += c.score; ex.n++; ex.min = Math.min(ex.min, c.score); ex.max = Math.max(ex.max, c.score); }
      else compAcc.set(key, { sum: c.score, n: 1, min: c.score, max: c.score, label });
    }

    for (const g of (r.gapReport?.competencyGaps || [])) {
      if (!g || !g.skill) continue;
      const label = String(g.skill).trim();
      const key = normKey(label);  // F13: Arabic-aware merge
      if (!key) continue;
      const req = typeof g.required === 'number' ? g.required : 0;
      const act = typeof g.actual === 'number' ? g.actual : 0;
      const ex = gapAcc.get(key);
      if (ex) { ex.n++; ex.req += req; ex.act += act; }
      else gapAcc.set(key, { n: 1, req, act, label });
    }

    strengthBits.push(...phrases(r.strengths || ''));
    weaknessBits.push(...phrases(r.weaknesses || ''));
    weaknessBits.push(...phrases(r.gapReport?.overallGapSummary || ''));
  }

  const competencies: AggregatedCompetency[] = Array.from(compAcc.values())
    .map(v => ({ competency: v.label, avgScore: Math.round(v.sum / v.n), count: v.n, min: v.min, max: v.max }))
    .sort((a, b) => a.avgScore - b.avgScore); // weakest first — most actionable for governance gaps

  const gaps: AggregatedGap[] = Array.from(gapAcc.values())
    .map(v => {
      const avgRequired = Math.round(v.req / v.n);
      const avgActual = Math.round(v.act / v.n);
      return { skill: v.label, count: v.n, avgRequired, avgActual, avgDeficit: avgRequired - avgActual };
    })
    .sort((a, b) => (b.count - a.count) || (b.avgDeficit - a.avgDeficit)); // recurring + deep first

  return {
    total: list.length,
    byType,
    avgTotalScore: scoreN ? Math.round(scoreSum / scoreN) : null,
    competencies,
    gaps,
    strengthThemes: tallyThemes(strengthBits),
    weaknessThemes: tallyThemes(weaknessBits),
    coverage: people.size,
  };
}

/**
 * Render the aggregate into an injectable Arabic text block for buildModel.
 * Compact and statistical — scales to hundreds of assessments without flooding context.
 * Falls back to an empty string when there's nothing to say.
 */
export function buildAggregatedContext(assessments: AssessmentLike[]): string {
  const agg = aggregateAssessments(assessments);
  if (!agg.total) return '';

  const lines: string[] = [];
  const typeStr = Object.entries(agg.byType).map(([k, v]) => `${k}:${v}`).join('، ');
  lines.push(`إجمالي التقييمات: ${agg.total} (${typeStr}) — أفراد/أدوار مختلفة: ${agg.coverage}.`);
  if (agg.avgTotalScore != null) lines.push(`متوسط الدرجة الكلية: ${agg.avgTotalScore}%.`);

  if (agg.competencies.length) {
    const weak = agg.competencies.slice(0, 6)
      .map(c => `${c.competency} ${c.avgScore}% (ن=${c.count})`).join('، ');
    lines.push(`أضعف الجدارات (متوسط عبر الأفراد): ${weak}.`);
  }

  if (agg.gaps.length) {
    const top = agg.gaps.slice(0, 8)
      .map(g => `${g.skill} (تكرار ${g.count}× — مطلوب ${g.avgRequired}/فعلي ${g.avgActual}، عجز ${g.avgDeficit})`).join('؛ ');
    lines.push(`الفجوات المتكررة عبر الموظفين: ${top}.`);
  }

  if (agg.weaknessThemes.length) {
    const w = agg.weaknessThemes.slice(0, 6).map(x => `${x.theme}${x.count > 1 ? ` (×${x.count})` : ''}`).join('، ');
    lines.push(`مواضع ضعف متكررة: ${w}.`);
  }
  if (agg.strengthThemes.length) {
    const s = agg.strengthThemes.slice(0, 5).map(x => `${x.theme}${x.count > 1 ? ` (×${x.count})` : ''}`).join('، ');
    lines.push(`مواطن قوة متكررة: ${s}.`);
  }

  lines.push('استخدم هذه المؤشرات المجمّعة لترجيح خطورة الفجوات ذات التكرار العالي وربط التوصيات بالجدارات الأضعف فعليًا — لا تخترع خارج هذه الأرقام.');
  return lines.join('\n');
}
