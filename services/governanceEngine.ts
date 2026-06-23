// Governance Center engine (Phases 2 & 3).
//
//  Phase 2 — buildModel: from ingested chunks (+ entities) produce a structured
//            CompanyGovernanceModel (org units, roles, policies skeleton, gaps),
//            every item carrying provenance back to its source chunks.
//            Gap analysis matches previous reference projects as a basis.
//
//  Phase 3 — generateGovernanceDoc: long, coherent, CITED document generated
//            FROM the model + retrieved evidence (never free-form from chat):
//            outline → per-section retrieve+draft(with [مصدر N]) → global critique
//            → targeted revise → stitch (cover/TOC/cross-refs). Coherence comes
//            from the shared model + a global fact memory + consistent citations.

import { Type } from '@google/genai';
import { streamChat, generateJson } from './agentOrchestrator';
import { retrieve, chunksToProvenance, matchProjects } from './governanceService';
import { GOV_DOC_CATALOG, frameworksDirective } from './governanceDocCatalog';
import { standardsLens } from './governanceFrameworks';
import type {
  CompanyGovernanceModel, DocChunk, KnowledgeNode, ReferenceProject,
  GovOrgUnit, GovRole, GovPolicy, GovProcedure, GovGap, GovProgress, ProvenanceRef,
  GovKpi, GovAuthority, GovCommittee, GovMeeting,
  GeneratedArtifact, ArtifactSection, Language,
} from '../types';

let _idc = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(_idc++).toString(36)}`;
const isAborted = (s?: AbortSignal) => !!s?.aborted;

// ---------------------------------------------------------------------------
// Concurrency + resilience primitives (used by bulk/parallel generation).
// ---------------------------------------------------------------------------

/** Run `task` over `items` with at most `cap` in flight. Order preserved in result.
 *  Each task receives (item, index). Aborts cleanly when `signal` fires. */
async function mapPool<T, R>(
  items: T[], cap: number, signal: AbortSignal | undefined,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(cap, items.length || 1));
  const worker = async () => {
    while (true) {
      if (isAborted(signal)) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

// HIGH: classify errors so we don't burn retries on a terminal 4xx (bad prompt/schema),
// and so we honor a server-sent Retry-After on 429. Only 429 + 5xx are transient.
function errStatus(e: any): number {
  const s = e?.status ?? e?.code ?? e?.response?.status;
  if (typeof s === 'number') return s;
  const mm = String(e?.message || e).match(/\b(4\d\d|5\d\d)\b/);
  return mm ? parseInt(mm[1], 10) : 0;
}
function isTransient(e: any): boolean {
  if (isAborted0(e)) return false;
  const st = errStatus(e);
  if (st === 429) return true;
  if (st >= 500 && st < 600) return true;
  if (st >= 400 && st < 500) return false;        // terminal client error → don't retry
  return true;                                     // unknown (network/timeout) → treat transient
}
function isAborted0(e: any): boolean {
  return /abort/i.test(String(e?.name || e?.message || ''));
}
function retryAfterMs(e: any): number {
  const ra = e?.response?.headers?.['retry-after'] ?? e?.headers?.['retry-after'];
  const n = Number(ra);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 20000) : 0;
}

/** Retry an async op with exponential backoff. Retries only transient errors
 *  (429/5xx/network), honors Retry-After, and aborts fast. Throws last error. */
async function withRetry<R>(
  fn: () => Promise<R>, attempts = 3, baseMs = 800, signal?: AbortSignal,
): Promise<R> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    if (isAborted(signal)) throw new Error('aborted');
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;                // terminal → fail immediately, no wasted retries
      if (a < attempts - 1 && !isAborted(signal)) {
        const wait = retryAfterMs(e) || (baseMs * Math.pow(2, a) + Math.floor((a + 1) * 137 % 250));
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// Clean, non-Markdown failure placeholders — never leak '*(...)*' into a document.
const FAIL_RETRY = '(تعذّر توليد هذا القسم بعد عدة محاولات — يمكن إعادة التوليد لاحقاً.)';
const FAIL_CONN  = '(تعذّر توليد هذا القسم بسبب خطأ اتصال — يمكن إعادة التوليد لاحقاً.)';

// Per-section output ceiling: scale with target density so a 25-page section is
// not silently truncated at the 8k default. Bounded to the model's hard limit.
function sectionTokens(targetPages?: number): number {
  if (!targetPages || targetPages <= 0) return 16384;        // bulk full-doc default
  const perSec = Math.round((targetPages * 320 * 1.6) / Math.max(4, targetPages));
  return Math.max(8192, Math.min(32768, perSec * 60));       // ~ generous, capped
}

/** Deterministic canonical-naming registry from the model → injected into every
 *  bulk section so sibling docs reference identical unit/role/policy names. */
function coherenceMemo(m: CompanyGovernanceModel): string {
  const take = (xs: string[], n = 40) => xs.filter(Boolean).slice(0, n).join('، ') || '—';
  return [
    'سجل التسميات الموحّد (استخدم هذه المسميات حرفياً للحفاظ على الاتساق بين الوثائق):',
    `- الوحدات: ${take((m.orgUnits || []).map(u => u.name))}`,
    `- الأدوار: ${take((m.roles || []).map(r => r.title))}`,
    `- السياسات: ${take((m.policies || []).map(p => p.title))}`,
    `- مؤشرات الأداء: ${take((m.kpis || []).map(k => k.name))}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sentiment signal (Stage-0 derives chunk tone; here we turn it into a signal
// that actually influences the model build + gap severity).
// ---------------------------------------------------------------------------

/** Aggregate chunk sentiment into a compact, injectable signal + a per-area
 *  negative-tone map used to bias gap severity. */
function sentimentSignal(chunks: DocChunk[]): { block: string; negChunkIds: Set<string>; avg: number } {
  const scored = chunks.filter(c => c.sentiment && typeof c.sentiment.score === 'number');
  const negChunkIds = new Set<string>();
  if (!scored.length) return { block: '', negChunkIds, avg: 0 };
  let sum = 0;
  const neg: { path: string; score: number }[] = [];
  for (const c of scored) {
    const s = c.sentiment!.score;
    sum += s;
    if (c.sentiment!.label === 'negative' || s <= -0.25) {
      negChunkIds.add(c.id);
      neg.push({ path: `${c.docName} › ${c.headingPath}`, score: s });
    }
  }
  const avg = sum / scored.length;
  neg.sort((a, b) => a.score - b.score);
  const negList = neg.slice(0, 12).map(n => `- ${n.path} (نبرة ${n.score.toFixed(2)})`).join('\n');
  const overall = avg > 0.2 ? 'إيجابية عامة' : avg < -0.2 ? 'سلبية عامة' : 'محايدة/مختلطة';
  const block = [
    `\n\nإشارة وجدانية مستخرجة آلياً من نبرة الوثائق (متوسط ${avg.toFixed(2)} — ${overall}).`,
    'استخدمها كمؤشر مخاطر تبنٍّ/رضا: المقاطع ذات النبرة السلبية قد تدل على فجوات تطبيق أو مقاومة تغيير حتى لو كانت السياسة موجودة شكلياً.',
    neg.length ? `أبرز المقاطع السلبية:\n${negList}` : '',
    neg.length ? 'ارفع خطورة (severity) أي فجوة يقع دليلها ضمن هذه المقاطع السلبية درجة واحدة.' : '',
  ].filter(Boolean).join('\n');
  return { block, negChunkIds, avg };
}

// ===========================================================================
// PHASE 2 — Build the Company Governance Model from sources
// ===========================================================================

const modelSchema = {
  type: Type.OBJECT,
  properties: {
    orgUnits: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          parent: { type: Type.STRING },   // parent unit name, "" if root
          mandate: { type: Type.STRING },
          objective: { type: Type.STRING },                                   // الهدف العام للوحدة
          feeds: { type: Type.ARRAY, items: { type: Type.STRING } },          // أسماء الوحدات التي تُغذّيها
          dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },      // أسماء الوحدات التي تعتمد عليها
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } }, // chunk indices
        },
        required: ['name', 'mandate'],
      },
    },
    roles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          unit: { type: Type.STRING },
          purpose: { type: Type.STRING },
          responsibilities: { type: Type.ARRAY, items: { type: Type.STRING } },
          managerialLevel: { type: Type.STRING },                             // المستوى الإداري
          summary: { type: Type.STRING },                                     // ملخص الوظيفة
          responsibilityGroups: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                theme: { type: Type.STRING },
                items: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
            },
          },
          qualifications: {
            type: Type.OBJECT,
            properties: {
              education: { type: Type.STRING },
              experience: { type: Type.STRING },
              certifications: { type: Type.STRING },
            },
          },
          skills: {
            type: Type.OBJECT,
            properties: {
              technical: { type: Type.ARRAY, items: { type: Type.STRING } },
              soft: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
          relations: {
            type: Type.OBJECT,
            properties: {
              reportsTo: { type: Type.STRING },
              supervises: { type: Type.ARRAY, items: { type: Type.STRING } },
              interactsWith: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['title', 'purpose'],
      },
    },
    kpis: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          unit: { type: Type.STRING },           // owning unit name
          role: { type: Type.STRING },           // owning role title, "" if unit-level
          formula: { type: Type.STRING },
          target: { type: Type.STRING },
          weight: { type: Type.NUMBER },         // 0-100, sum per owner ≈ 100
          frequency: { type: Type.STRING },
          measurementMethod: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['name'],
      },
    },
    authorities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          decision: { type: Type.STRING },
          role: { type: Type.STRING },           // role title that holds it
          level: { type: Type.STRING },          // recommend|approve|execute|inform
          threshold: { type: Type.STRING },      // حدّ التفويض المالي (مبلغ)
          limit: { type: Type.STRING },          // السقف الأعلى
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['decision'],
      },
    },
    committees: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          members: { type: Type.ARRAY, items: { type: Type.STRING } },
          mandate: { type: Type.STRING },
          cadence: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['name'],
      },
    },
    meetings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },
          purpose: { type: Type.STRING },
          frequency: { type: Type.STRING },
          attendees: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['type'],
      },
    },
    policies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          domain: { type: Type.STRING },
          summary: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['title', 'domain'],
      },
    },
    procedures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          unit: { type: Type.STRING },        // owning unit name
          policy: { type: Type.STRING },      // related policy title, "" if none
          purpose: { type: Type.STRING },
          steps: { type: Type.ARRAY, items: { type: Type.STRING } },
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['title', 'purpose'],
      },
    },
    gaps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          area: { type: Type.STRING },
          description: { type: Type.STRING },
          severity: { type: Type.STRING },   // low|medium|high|critical
          recommendation: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        },
        required: ['area', 'description', 'severity'],
      },
    },
  },
  required: ['orgUnits', 'roles', 'policies', 'gaps'],
};

export interface BuildModelParams {
  tenantId: string;
  companyName: string;
  chunks: DocChunk[];
  nodes?: KnowledgeNode[];
  referenceProjects?: ReferenceProject[];
  sector?: string;
  size?: string;
  language?: Language;
  /** Survey/assessment outputs surfaced as a data source (مخرجات الاستبيانات والتقييمات). */
  assessmentContext?: string;
  /** تعليمات/برومبت مخصّص من المالك قبل بناء الهيكل (FIX A) — يوجّه التركيز/الأسلوب دون اختراع خارج الأدلة. */
  customInstructions?: string;
  signal?: AbortSignal;
  onProgress?: (p: GovProgress) => void;
}

/** Build a structured, provenance-linked governance model from ingested sources. */
export async function buildModel(p: BuildModelParams): Promise<CompanyGovernanceModel> {
  const { tenantId, companyName, chunks, signal, onProgress } = p;

  onProgress?.({ phase: 'reality', current: 0, total: 1, label: 'تحليل الواقع وبناء النموذج المؤسسي...' });

  // Build a numbered evidence digest the model can cite by index.
  // GovF3: at scale (30–50 docs) a flat slice(0,60000) starves tail documents —
  // chunks are doc-ordered, so the cut drops the last ~90% of files entirely.
  // Instead: round-robin across documents so every file contributes evidence,
  // and lift the budget to use the model's large context window.
  const DIGEST_BUDGET = 240000;
  const PER_CHUNK = 1400;
  const digest = (() => {
    // entry text keyed by the chunk's ORIGINAL index (so evidence[] citations stay valid).
    const entry = (c: DocChunk, i: number) => `[${i}] (${c.docName} › ${c.headingPath})\n${c.text.slice(0, PER_CHUNK)}`;
    const flat = chunks.map((c, i) => ({ i, c }));
    const full = flat.map(({ c, i }) => entry(c, i)).join('\n\n');
    if (full.length <= DIGEST_BUDGET) return full;
    // Over budget → interleave by document so coverage spans the whole corpus.
    const byDoc = new Map<string, { i: number; c: DocChunk }[]>();
    for (const e of flat) {
      const k = e.c.docName || '—';
      (byDoc.get(k) || byDoc.set(k, []).get(k)!).push(e);
    }
    const queues = [...byDoc.values()];
    const picked: { i: number; c: DocChunk }[] = [];
    let used = 0, active = true;
    while (active) {
      active = false;
      for (const q of queues) {
        const e = q.shift();
        if (!e) continue;
        active = true;
        const len = entry(e.c, e.i).length + 2;
        if (used + len > DIGEST_BUDGET) { active = false; break; }
        picked.push(e); used += len;
      }
    }
    // restore original order for readability, keep original indices for citations.
    picked.sort((a, b) => a.i - b.i);
    return picked.map(({ c, i }) => entry(c, i)).join('\n\n');
  })();

  // CRITICAL #2 (cap surface): at very large scale the digest may not fit every chunk
  // even after round-robin. Make that visible instead of silently under-citing.
  const totalDocs = new Set(chunks.map(c => c.docName || '—')).size;
  const citedDocs = new Set((digest.match(/›/g) ? digest.split('\n\n') : [])
    .map(s => (s.match(/\(([^›]+) ›/) || [])[1]).filter(Boolean)).size;
  if (citedDocs && citedDocs < totalDocs) {
    // N9: surface coverage as an explicit percentage. Below 80% it is a real
    // accuracy risk (the model never saw a fifth of the corpus) → escalate to a
    // WARNING with an actionable fix instead of a soft informational note.
    const pct = Math.round((citedDocs / totalDocs) * 100);
    const low = pct < 80;
    onProgress?.({
      phase: 'reality', current: 0, total: 1,
      label: low
        ? `⚠️ تحذير تغطية: النموذج بُني على ${citedDocs}/${totalDocs} وثيقة فقط (${pct}٪) — أقل من 80٪. الباقي مفهرس لكن خارج سعة هذا التحليل، فقد تنقص دقة الواقع الراهن. الحل: قلّل/ادمج المصادر المكرّرة أو ابنِ النموذج على دفعات.`
        : `تغطية الأدلة: ${citedDocs}/${totalDocs} وثيقة (${pct}٪) ضمن سعة التحليل (الباقي مفهرس لكن خارج هذا الملخص).`,
    });
  }

  // HIGH: at scale (30-50 files) the same entity (e.g. "إدارة الموارد البشرية") is
  // extracted from many files → duplicate KnowledgeNodes flood the 60-cap and bias the
  // hint toward whatever files happened to repeat it. Dedup by normalized type+name,
  // keep a frequency count, then surface the most-cited UNIQUE entities first.
  const entitiesHint = (() => {
    const raw = p.nodes || [];
    if (!raw.length) return '';
    const norm = (s: string) => (s || '').toLowerCase().replace(/[ً-ْٰـ]/g, '')
      .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
    const seen = new Map<string, { type: string; name: string; freq: number }>();
    for (const n of raw) {
      const key = `${norm(n.type)}::${norm(n.name)}`;
      const cur = seen.get(key);
      if (cur) cur.freq++;
      else seen.set(key, { type: n.type, name: n.name, freq: 1 });
    }
    const uniq = [...seen.values()].sort((a, b) => b.freq - a.freq).slice(0, 60);
    return `\nكيانات مستخرجة مسبقاً (${seen.size} فريدة من ${raw.length}): ${uniq.map(n => `${n.type}:${n.name}`).join('، ')}`;
  })();

  // مخرجات الاستبيانات والتقييمات كمصدر بيانات (الفجوات/نقاط القوة/التوصيات تُغذّي النموذج).
  const assessmentBlock = (p.assessmentContext || '').trim()
    ? `\n\nمخرجات الاستبيانات والتقييمات (مصدر بيانات إضافي — استند إليها في الفجوات والتوصيات وقياس النضج، ولا تخترع خارجها):\n${p.assessmentContext!.trim().slice(0, 12000)}`
    : '';

  // ج4 — إشارة وجدانية: نبرة الوثائق تُغذّي خطورة الفجوات + قياس النضج.
  const sent = sentimentSignal(chunks);

  // FIX B — حقن المعايير المرجعية (ISO/COSO/EFQM/التنظيمات/المعايير المهنية) كعدسة تقييم
  // عند بناء الهيكل نفسه (كانت تُحقن فقط في توليد الوثائق، فالهيكل لا "يأخذ المعايير في الحسبان").
  const standardsBlock = `\n\n${standardsLens()}`;

  // FIX A — تعليمات/برومبت مخصّص من المالك قبل البناء. يُوضع في صدر البرومبت كأولوية توجيهية
  // (تركيز/أسلوب/أولويات) لكنه لا يلغي قاعدة عدم الاختراع خارج الأدلة.
  const ci = (p.customInstructions || '').trim();
  const customBlock = ci
    ? `\n\nتعليمات إلزامية من العميل (وجّه التحليل والبناء وفقها مع الالتزام الصارم بالأدلة وعدم الاختراع):\n${ci.slice(0, 4000)}\n`
    : '';

  const prompt = `أنت محلل حوكمة مؤسسية خبير. من الأدلة المرقّمة التالية (مقاطع من وثائق الشركة)، استخرج نموذج الحوكمة الفعلي للشركة "${companyName}".${customBlock}
لا تخترع أي شيء غير مذكور. لكل عنصر أرفق "evidence" = مصفوفة أرقام المقاطع [N] التي يستند إليها.
- orgUnits: الوحدات التنظيمية (مع parent باسم الوحدة الأعلى أو ""، objective الهدف، feeds الوحدات التي تُغذّيها، dependsOn الوحدات التي تعتمد عليها — بالأسماء).
- roles: الأدوار/الوظائف وغرضها ومسؤولياتها. إن توفّر: managerialLevel المستوى الإداري، summary ملخص الوظيفة، responsibilityGroups مهام مجمّعة بمحاور، qualifications{education,experience,certifications}، skills{technical[],soft[]}، relations{reportsTo,supervises[],interactsWith[]}.
- policies: السياسات الموجودة فعلاً (عنوان + مجال + ملخص).
- procedures: الإجراءات التشغيلية الفعلية (title، unit الوحدة المالكة، policy السياسة المرتبطة أو ""، purpose، steps خطوات مرتّبة).
- kpis: مؤشرات الأداء (name، unit أو role المالك، formula، target، weight وزن 0-100، frequency الدورية، measurementMethod طريقة القياس).
- authorities: الصلاحيات/الاعتمادات (decision القرار، role صاحب الصلاحية، level من [recommend|approve|execute|inform]، threshold حدّ التفويض المالي، limit السقف).
- committees: اللجان (name، members الأعضاء، mandate المهمة، cadence الدورية).
- meetings: الاجتماعات الدورية (type النوع، purpose الغرض، frequency التكرار، attendees الحضور).
- gaps: الفجوات الحوكمية الملحوظة (area، description، severity من [low|medium|high|critical]، recommendation).
${industryLens(p.sector)}${referenceProjectsBlock(p.referenceProjects, p.sector)}${standardsBlock}

الأدلة:
${digest}${entitiesHint}${assessmentBlock}${sent.block}

أعد JSON فقط وفق المخطط.`;

  // GovF (CRITICAL #2): the model build is the spine of the whole governance path —
  // bulk gen, gap-fix, diagrams all consume it. A single transient Gemini hiccup must
  // not collapse it to an empty shell presented as "success". Retry with backoff, and
  // if every attempt fails on a non-empty corpus, THROW so the caller surfaces the
  // failure instead of silently saving a blank model.
  let raw: any = { orgUnits: [], roles: [], policies: [], procedures: [], gaps: [] };
  try {
    raw = await withRetry(() => generateJson(prompt, modelSchema, { signal, temperature: 0.2 }), 3, 900, signal);
  } catch (e: any) {
    if (isAborted(signal)) throw new Error('aborted');
    // No evidence to build from → an empty model is a legitimate (not failed) outcome.
    if (!chunks.length) {
      raw = { orgUnits: [], roles: [], policies: [], procedures: [], gaps: [] };
    } else {
      throw new Error(`فشل بناء النموذج بعد عدة محاولات: ${e?.message || e}`);
    }
  }

  // SECONDARY PASS — when main digest left >20% of docs uncovered, run a targeted
  // supplementary extraction over the missing documents and MERGE the results.
  // This closes the "corpus blind spot" that silently omits late documents.
  if (!isAborted(signal) && chunks.length > 0) {
    const coveredDocNames = new Set(
      digest.split('\n\n')
        .map(s => (s.match(/\(([^›\)]+) ›/) || [])[1])
        .filter(Boolean)
    );
    // Carry the GLOBAL chunk index so supplementary evidence ([S_N], N = local)
    // can be remapped back to the global `chunks` array before merge — otherwise
    // prov() resolves the wrong chunk and corrupts provenance.
    const missingChunks: { c: DocChunk; gi: number }[] = [];
    chunks.forEach((c, gi) => { if (!coveredDocNames.has(c.docName || '—')) missingChunks.push({ c, gi }); });
    const missingDocs = new Set(missingChunks.map(m => m.c.docName || '—'));
    if (missingDocs.size > 0) {
      onProgress?.({ phase: 'reality', current: 0, total: 1,
        label: `استخراج تكميلي: ${missingDocs.size} وثيقة إضافية…` });
      const SUPP_BUDGET = 80000;
      const suppEntry = (c: DocChunk, i: number) => `[S${i}] (${c.docName} › ${c.headingPath})\n${c.text.slice(0, 1400)}`;
      let suppUsed = 0;
      const suppLines: string[] = [];
      const localToGlobal: number[] = []; // local [S_N] index → global chunk index
      for (let i = 0; i < missingChunks.length; i++) {
        const localIdx = suppLines.length;
        const line = suppEntry(missingChunks[i].c, localIdx);
        if (suppUsed + line.length > SUPP_BUDGET) break;
        suppLines.push(line); suppUsed += line.length + 2;
        localToGlobal.push(missingChunks[i].gi);
      }
      const suppDigest = suppLines.join('\n\n');

      // Existing names for dedup guidance
      const existingUnits = (raw.orgUnits || []).map((u: any) => u.name).join('، ');
      const existingPolicies = (raw.policies || []).map((p: any) => p.title).join('، ');
      const suppPrompt = `من الوثائق التالية، استخرج فقط الكيانات الحوكمية الجديدة غير الموجودة بالفعل.
الكيانات الموجودة مسبقاً (لا تُكرّرها):
- وحدات: ${existingUnits || 'لا يوجد'}
- سياسات: ${existingPolicies || 'لا يوجد'}

أعد ONLY الكيانات الجديدة بنفس مخطط JSON (orgUnits، roles، policies، procedures، kpis، authorities، gaps). أرفق evidence كمصفوفة أرقام المقاطع [S_N].

${suppDigest}

أعد JSON فقط.`;
      try {
        const suppRaw: any = await withRetry(
          () => generateJson(suppPrompt, modelSchema, { signal, temperature: 0.15 }),
          2, 700, signal,
        );
        // Remap supplementary [S_N] evidence (local) → global chunk indices,
        // THEN merge. Dedup by name/title happens in a later pass.
        const remapEv = (e?: number[]): number[] =>
          (Array.isArray(e) ? e : [])
            .map(n => localToGlobal[n])
            .filter((n): n is number => typeof n === 'number');
        for (const key of ['orgUnits', 'roles', 'policies', 'procedures', 'kpis', 'authorities', 'committees', 'meetings', 'gaps']) {
          if (Array.isArray(suppRaw[key]) && suppRaw[key].length) {
            const items = suppRaw[key].map((it: any) =>
              it && typeof it === 'object' && 'evidence' in it
                ? { ...it, evidence: remapEv(it.evidence) }
                : it,
            );
            raw[key] = [...(raw[key] || []), ...items];
          }
        }
      } catch { /* supplementary pass is best-effort */ }
    }
  }

  // CROSS-DOC ENTITY DEDUP — same unit/role/policy extracted from multiple files
  // creates duplicates that waste model capacity and cause contradictory generation.
  // Normalize Arabic (diacritics, alef variants, teh marbuta, ya) and merge by name.
  const normEnt = (s: string) => (s || '').replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();

  const deduplicateByName = <T extends { name?: string; title?: string; evidence?: number[] }>(
    arr: T[], key: 'name' | 'title',
  ): T[] => {
    const seen = new Map<string, T>();
    let emptyCounter = 0;
    for (const item of arr) {
      const k = normEnt(item[key] || '');
      if (!k) { seen.set(`__empty_${emptyCounter++}`, item); continue; }
      const existing = seen.get(k);
      if (!existing) { seen.set(k, { ...item }); continue; }
      // merge evidence arrays and keep the longer descriptive field
      (existing as any).evidence = [...new Set([...(existing.evidence || []), ...(item.evidence || [])])];
      if (key === 'name' && (item as any).mandate && !(existing as any).mandate)
        (existing as any).mandate = (item as any).mandate;
      if (key === 'title' && (item as any).summary && !(existing as any).summary)
        (existing as any).summary = (item as any).summary;
    }
    return [...seen.values()];
  };

  raw.orgUnits = deduplicateByName(raw.orgUnits || [], 'name');
  raw.roles    = deduplicateByName(raw.roles    || [], 'title');
  raw.policies = deduplicateByName(raw.policies || [], 'title');

  // Resolve evidence indices → provenance refs.
  const prov = (idxs?: number[]): ProvenanceRef[] =>
    (idxs || [])
      .filter(i => i >= 0 && i < chunks.length)
      .map(i => ({
        kind: 'file' as const,
        refId: chunks[i].id,
        label: chunks[i].headingPath,
        docName: chunks[i].docName,
      }));

  const unitByName = new Map<string, string>(); // name → id
  const orgUnits: GovOrgUnit[] = (raw.orgUnits || []).map((u: any) => {
    const id = uid('unit');
    unitByName.set(u.name, id);
    const unit: GovOrgUnit = { id, name: u.name, mandate: u.mandate || '', provenance: prov(u.evidence) };
    if (u.objective) unit.objective = u.objective;
    return unit;
  });
  // link parents + interconnection feeds/dependsOn (second pass, resolve names → ids)
  const resolveUnitIds = (names?: string[]): string[] =>
    (Array.isArray(names) ? names : []).map(n => unitByName.get(n)).filter((x): x is string => !!x);
  (raw.orgUnits || []).forEach((u: any, i: number) => {
    if (u.parent && unitByName.has(u.parent)) orgUnits[i].parentId = unitByName.get(u.parent);
    const feeds = resolveUnitIds(u.feeds); if (feeds.length) orgUnits[i].feeds = feeds;
    const dependsOn = resolveUnitIds(u.dependsOn); if (dependsOn.length) orgUnits[i].dependsOn = dependsOn;
  });

  const roleByTitle = new Map<string, string>(); // title → id
  const roles: GovRole[] = (raw.roles || []).map((r: any) => {
    const id = uid('role');
    roleByTitle.set(r.title, id);
    const role: GovRole = {
      id,
      title: r.title,
      unitId: unitByName.get(r.unit) || '',
      purpose: r.purpose || '',
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
      provenance: prov(r.evidence),
    };
    if (r.managerialLevel) role.managerialLevel = r.managerialLevel;
    if (r.summary) role.summary = r.summary;
    if (Array.isArray(r.responsibilityGroups) && r.responsibilityGroups.length) role.responsibilityGroups = r.responsibilityGroups;
    if (r.qualifications) role.qualifications = r.qualifications;
    if (r.skills) role.skills = r.skills;
    if (r.relations) role.relations = r.relations;
    return role;
  });

  const policyByTitle = new Map<string, string>(); // title → id
  const policies: GovPolicy[] = (raw.policies || []).map((pol: any) => {
    const id = uid('pol');
    policyByTitle.set(pol.title, id);
    return {
      id,
      title: pol.title,
      domain: pol.domain || 'عام',
      body: pol.summary || '',
      status: 'draft' as const,
      provenance: prov(pol.evidence),
    };
  });

  const procedures: GovProcedure[] = (raw.procedures || []).map((pr: any) => {
    const steps = Array.isArray(pr.steps) ? pr.steps.filter(Boolean) : [];
    return {
      id: uid('proc'),
      title: pr.title,
      unitId: unitByName.get(pr.unit) || undefined,
      policyId: pr.policy ? (policyByTitle.get(pr.policy) || undefined) : undefined,
      purpose: pr.purpose || '',
      steps,
      // editable "reality" body seeded from steps; user refines it in the canvas
      body: steps.length ? steps.map((s: string, n: number) => `${n + 1}. ${s}`).join('\n') : (pr.purpose || ''),
      status: 'draft' as const,
      provenance: prov(pr.evidence),
    };
  });

  // KPIs (unit- or role-owned, with weight/frequency/method).
  const kpis: GovKpi[] = (raw.kpis || []).map((k: any) => {
    const kpi: GovKpi = { id: uid('kpi'), name: k.name, formula: k.formula || '', target: k.target || '', provenance: prov(k.evidence) };
    const uId = unitByName.get(k.unit); if (uId) kpi.unitId = uId;
    const rId = roleByTitle.get(k.role); if (rId) kpi.roleId = rId;
    if (typeof k.weight === 'number') kpi.weight = k.weight;
    if (k.frequency) kpi.frequency = k.frequency;
    if (k.measurementMethod) kpi.measurementMethod = k.measurementMethod;
    return kpi;
  });

  // Authorities / DoA matrix.
  const authorities: GovAuthority[] = (raw.authorities || []).map((a: any) => {
    const lvl = ['recommend', 'approve', 'execute', 'inform'].includes(a.level) ? a.level : 'approve';
    const auth: GovAuthority = { id: uid('auth'), decision: a.decision, roleId: roleByTitle.get(a.role) || '', level: lvl, provenance: prov(a.evidence) };
    if (a.threshold) auth.threshold = a.threshold;
    if (a.limit) auth.limit = a.limit;
    return auth;
  });

  // Committees + meetings.
  const committees: GovCommittee[] = (raw.committees || []).map((c: any) => ({
    id: uid('cmt'), name: c.name, members: Array.isArray(c.members) ? c.members : [],
    mandate: c.mandate || '', cadence: c.cadence, provenance: prov(c.evidence),
  }));
  const meetings: GovMeeting[] = (raw.meetings || []).map((mt: any) => ({
    id: uid('mtg'), type: mt.type, purpose: mt.purpose || '', frequency: mt.frequency || '',
    attendees: Array.isArray(mt.attendees) ? mt.attendees : [],
  }));

  // Gaps + reference-project matching (Phase 2 recommendation layer).
  const gaps: GovGap[] = [];
  const refs = p.referenceProjects || [];
  let gi = 0;
  for (const g of (raw.gaps || [])) {
    if (isAborted(signal)) break;
    gi++;
    onProgress?.({ phase: 'match', current: gi, total: (raw.gaps || []).length, label: `مطابقة المشاريع السابقة للفجوة: ${g.area}` });
    let matchedProjectIds: string[] = [];
    if (refs.length) {
      try {
        const matches = await matchProjects(
          `${g.area} ${g.description} ${g.recommendation || ''}`,
          { sector: p.sector, size: p.size, kind: 'policy' },
          refs, 3, signal,
        );
        matchedProjectIds = matches.filter(m => m.score > 0.3).map(m => m.project.id);
      } catch { /* matching optional */ }
    }
    let sev = ['low', 'medium', 'high', 'critical'].includes(g.severity) ? g.severity : 'medium';
    // ج4 — bias severity up one level if the gap's evidence sits in negative-tone chunks.
    if (sent.negChunkIds.size) {
      const evIds = (Array.isArray(g.evidence) ? g.evidence : [])
        .filter((i: number) => i >= 0 && i < chunks.length).map((i: number) => chunks[i].id);
      if (evIds.some((id: string) => sent.negChunkIds.has(id))) {
        const order = ['low', 'medium', 'high', 'critical'];
        sev = order[Math.min(order.length - 1, order.indexOf(sev) + 1)];
      }
    }
    gaps.push({
      id: uid('gap'),
      area: g.area,
      description: g.description,
      severity: sev,
      recommendation: g.recommendation || '',
      matchedProjectIds,
      provenance: prov(g.evidence),
    });
  }

  return {
    tenantId, companyName,
    orgUnits, roles, policies, procedures, authorities, kpis, gaps,
    committees, meetings,
    updatedAt: new Date().toISOString(), version: 1,
  };
}

// ===========================================================================
// PHASE 3 — Generate a long, coherent, CITED governance document from the model
// ===========================================================================

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
          query: { type: Type.STRING },   // retrieval query for evidence
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

export interface GenerateDocParams {
  docTitle: string;
  goal: string;
  model: CompanyGovernanceModel;
  chunks: DocChunk[];                 // tenant evidence (for retrieval + citations)
  referenceProjects?: ReferenceProject[];
  sector?: string;
  size?: string;
  language?: Language;
  targetPages?: number;               // desired length; scales section count + per-section depth
  kind?: string;
  signal?: AbortSignal;
  // Cross-document coherence: shared fact memory across a batch of docs. Seeded
  // into this doc's working memory and appended to as new facts are distilled,
  // so sibling docs in the same batch cross-reference consistent names/numbers.
  sharedFacts?: string[];
  onProgress?: (p: GovProgress | { phase: string; current: number; total: number; label: string }) => void;
  onThought?: (t: string) => void;
  onSection?: (sections: ArtifactSection[]) => void;
}

export interface GovernanceDocument extends GeneratedArtifact {
  citations: Record<string, ProvenanceRef[]>;  // sectionId → refs used
}

// Compact, deterministic summary of the model the AI must stay consistent with.
function modelFacts(m: CompanyGovernanceModel): string {
  const units = m.orgUnits.map(u => `- ${u.name}: ${u.mandate}`).join('\n') || 'لا يوجد';
  const roles = m.roles.map(r => `- ${r.title}: ${r.purpose}`).join('\n') || 'لا يوجد';
  // Bodies/steps/KPIs/authorities included (bounded) — starving the generator of
  // them was the #1 inaccuracy root cause: it invented what the model already knew.
  const pols = m.policies.map(p => `- ${p.title} (${p.domain})${p.body ? `: ${p.body.slice(0, 600)}` : ''}`).join('\n') || 'لا يوجد';
  const procs = (m.procedures || []).map(p => {
    const steps = (p.steps || []).slice(0, 8).map((s, i) => `${i + 1}) ${s}`).join(' ');
    return `- ${p.title}: ${p.purpose}${steps ? ` | الخطوات: ${steps}` : ''}`;
  }).join('\n') || 'لا يوجد';
  const kpis = (m.kpis || []).map(k =>
    `- ${k.name}${k.formula ? ` = ${k.formula}` : ''}${k.target ? ` | المستهدف: ${k.target}` : ''}${k.unitId ? ` | المالك: ${m.orgUnits.find(u => u.id === k.unitId)?.name || '—'}` : ''}`,
  ).join('\n') || 'لا يوجد';
  const auths = (m.authorities || []).map(a =>
    `- ${a.decision} | المستوى: ${a.level}${a.roleId ? ` | الدور: ${m.roles.find(r => r.id === a.roleId)?.title || '—'}` : ''}`,
  ).join('\n') || 'لا يوجد';
  const gaps = m.gaps.map(g => `- [${g.severity}] ${g.area}: ${g.description}`).join('\n') || 'لا يوجد';
  return `# الوحدات التنظيمية\n${units}\n\n# الأدوار\n${roles}\n\n# السياسات الحالية\n${pols}\n\n# الإجراءات الحالية\n${procs}\n\n# مؤشرات الأداء\n${kpis}\n\n# الصلاحيات\n${auths}\n\n# الفجوات\n${gaps}`;
}

/** Standards directive for a document kind — catalog frameworks, with a strong
 *  default so EVERY generated document embeds international standards. */
function docStandards(kind?: string): string {
  const entry = kind ? GOV_DOC_CATALOG.find(d => d.key === kind) : undefined;
  return frameworksDirective(entry?.frameworks?.length
    ? entry.frameworks
    : ['ISO 9001', 'EFQM', 'KAQA', 'McKinsey 7S', 'PwC Governance']);
}

// HIGH (industry-awareness): sector was plumbed into every generation param but
// NEVER injected into the prompt — so the model defaulted to generic/IT examples
// regardless of the real industry. This block forces the output into the actual
// sector's terminology, processes, risks, and KPIs, and explicitly forbids the
// IT/software drift the owner reported for a construction company.
export function industryLens(sector?: string): string {
  const s = (sector || '').trim();
  if (!s) return '';
  return `
=== عدسة القطاع (إلزامية — لا تتجاوزها) ===
الشركة تعمل في قطاع: "${s}".
- استخدم حصراً مصطلحات ووحدات وعمليات ومخاطر ومؤشرات هذا القطاع.
- لقطاع المقاولات/الإنشاءات مثالاً: إدارة المشاريع والعقود، أوامر التغيير، المقاولون من الباطن، المستخلصات والمطالبات، المشتريات والتوريد، الجدولة والتكلفة (EVM)، السلامة والصحة المهنية في المواقع (HSE)، ضبط الجودة والاستلام، المعدات والمخازن.
- ممنوع منعاً باتاً إقحام محتوى تقنية المعلومات أو البرمجيات أو الأنظمة السحابية أو الأمن السيبراني ما لم يرد صراحةً في مصادر الشركة. لا تفترض أن الشركة تقنية.
- إن خلت المصادر من تفصيل قطاعي، اكتب ما يناسب قطاع "${s}" منطقياً دون اختلاق أرقام.`;
}

// HIGH (reference projects): the owner uploads prior real projects as a basis,
// but only the gap-fix path consumed them. Inject a ranked (sector-first) basis
// block into model-build + every doc-generation path so output mirrors the
// owner's real reference work instead of inventing generic structure.
export function referenceProjectsBlock(refs?: ReferenceProject[], sector?: string): string {
  const list = (refs || []).filter(Boolean);
  if (!list.length) return '';
  const s = (sector || '').trim().toLowerCase();
  const ranked = [...list].sort((a, b) => {
    const am = (a.sector || '').toLowerCase() === s ? 1 : 0;
    const bm = (b.sector || '').toLowerCase() === s ? 1 : 0;
    return bm - am;
  }).slice(0, 3);
  const body = ranked.map(rp => {
    const tags = (rp.tags || []).join('، ');
    const excerpt = (rp.content || rp.summary || '').slice(0, 2500);
    return `• ${rp.name}${rp.sector ? ` (${rp.sector})` : ''}${tags ? ` — ${tags}` : ''}\n${excerpt}`;
  }).join('\n\n');
  return `
=== مشاريع مرجعية سابقة (استلهم منها البنية وأفضل الممارسات وكيّفها على سياق الشركة وقطاعها — لا تنسخ حرفياً، ولا تنقل بيانات شركة أخرى) ===
${body}`;
}

// BPM/BPMN directive for operational procedures — owner requires operations
// modeled per Business Process Modeling standards (swimlanes, roles, SLA, KPIs,
// control points), with a high-quality flow diagram per procedure.
const BPM_PROC_DIRECTIVE = `
اكتب الإجراء وفق منهجية نمذجة العمليات BPM / BPMN 2.0:
- لكل خطوة: الدور المسؤول (مسار/Swimlane)، المدخلات، المخرجات، نقطة الضبط/الموافقة، واتفاقية مستوى الخدمة SLA (المدة القصوى).
- أضف مصفوفة RACI (مسؤول/مساءل/مُستشار/مُطّلع).
- أضف مؤشرات أداء العملية (KPIs) مع المستهدف ودورية القياس.
- أنهِ الإجراء بمخطط تدفق BPMN بصيغة Mermaid (flowchart) يبيّن المسارات حسب الأدوار ونقاط القرار:
\`\`\`mermaid
flowchart TD
  ...عُقد بأسماء عربية مختصرة، معيّنات للقرار، وأسهم تبيّن المسار...
\`\`\``;

export async function generateGovernanceDoc(p: GenerateDocParams): Promise<GovernanceDocument> {
  const { model, chunks, signal, onProgress, onThought, onSection } = p;
  const language = p.language || 'ar';
  const facts = modelFacts(model);

  const sys = `أنت مستشار حوكمة مؤسسية. تكتب وثيقة رسمية اعتماداً حصرياً على "نموذج حوكمة الشركة" والأدلة المُسترجعة.
قواعد صارمة:
- لا تخالف حقائق النموذج التالي ولا تخترع أرقاماً.
- استشهد بعد كل ادعاء مأخوذ من الأدلة بصيغة [مصدر N] حسب الترقيم المعطى لكل قسم.
- حافظ على الاتساق مع بقية الوثيقة (نفس المسميات والأرقام).
- اللغة: العربية الفصحى الرصينة، تنسيق Markdown.

=== نموذج حوكمة الشركة (مصدر الحقيقة) ===
${facts}

=== ${coherenceMemo(model)} ===
${industryLens(p.sector)}${referenceProjectsBlock(p.referenceProjects, p.sector)}

${docStandards(p.kind)}`;

  const artifact: GovernanceDocument = {
    title: p.docTitle, goal: p.goal, language,
    sections: [], createdAt: new Date(), complete: false, citations: {},
  };

  // page-length scaling: ~1.5 sections/page, ~320 words/page → per-section word target
  const targetPages = p.targetPages && p.targetPages > 0 ? Math.min(100, Math.round(p.targetPages)) : 0;
  const secMin = targetPages ? Math.max(4, Math.round(targetPages * 1.3)) : 6;
  const secMax = targetPages ? Math.max(secMin + 1, Math.round(targetPages * 1.8)) : 10;
  const wordsPerSection = targetPages ? Math.max(120, Math.round((targetPages * 320) / ((secMin + secMax) / 2))) : 0;
  const lenDirective = wordsPerSection
    ? `\nالطول المستهدف لهذا القسم: ~${wordsPerSection} كلمة (الوثيقة كلها ≈ ${targetPages} صفحة). اكتب بعمق كافٍ لبلوغ هذا الطول دون حشو.`
    : '';

  // grounding guard — abort early if model is empty (avoids hollow hallucinated doc)
  const modelEntityCount = (model.orgUnits?.length || 0) + (model.roles?.length || 0) + (model.policies?.length || 0);
  if (modelEntityCount === 0) {
    throw new Error('النموذج فارغ — ابنِ النموذج أولاً من مرحلة الهيكل التنظيمي قبل توليد الوثائق');
  }

  // ---- A: outline ----
  onProgress?.({ phase: 'outline', current: 0, total: 1, label: 'بناء هيكل الوثيقة...' });
  let plans: { id: string; title: string; goal: string; query: string }[] = [];
  try {
    const res = await generateJson<{ sections: { title: string; goal: string; query?: string }[] }>(
      `صمّم هيكل وثيقة "${p.docTitle}" (الهدف: ${p.goal}) من ${secMin} إلى ${secMax} أقسام${targetPages ? ` (الوثيقة المستهدفة ≈ ${targetPages} صفحة)` : ''}. لكل قسم title وgoal وquery (عبارة بحث لاسترجاع الأدلة المناسبة). اجعل القسم **الأخير** بعنوان «الاستناد المعياري» مخصصاً لسرد المعايير الدولية وجدول المواءمة (Compliance Mapping) — ولا تضع أي إشارات معيارية في أقسام المتن. JSON فقط.`,
      outlineSchema, { systemInstruction: sys, signal },
    );
    plans = (res.sections || []).map((s, i) => ({ id: `s${i + 1}`, title: s.title, goal: s.goal, query: s.query || s.title }));
  } catch {
    plans = [
      { id: 's1', title: 'الملخص التنفيذي', goal: 'أبرز النتائج والتوصيات', query: 'ملخص' },
      { id: 's2', title: 'الواقع التنظيمي الراهن', goal: 'الهيكل والأدوار الحالية', query: 'هيكل تنظيمي أدوار' },
      { id: 's3', title: 'السياسات والإجراءات', goal: 'تقييم السياسات الحالية', query: 'سياسات إجراءات' },
      { id: 's4', title: 'تحليل الفجوات', goal: 'الفجوات والمخاطر', query: 'فجوات مخاطر' },
      { id: 's5', title: 'التوصيات وخارطة الطريق', goal: 'خطة التنفيذ', query: 'توصيات خطة' },
    ];
  }
  if (isAborted(signal)) return artifact;

  artifact.sections = plans.map(pl => ({ id: pl.id, title: pl.title, content: '', status: 'pending' as const }));
  onSection?.(artifact.sections);
  const outlineText = plans.map((pl, i) => `${i + 1}. ${pl.title} — ${pl.goal}`).join('\n');
  // accumulating fact memory for coherence; seed from shared cross-doc memory
  const globalFacts: string[] = p.sharedFacts ? [...p.sharedFacts] : [];

  // ---- B: per-section retrieve + draft + cite ----
  // Parallelized (was serial → 150-200s for 10 sections): evidence pre-fetched
  // for ALL sections at once, then drafts pooled at 3 like the bulk path.
  // Coherence holds via the shared outline + coherenceMemo in sys + globalFacts.
  onProgress?.({ phase: 'section', current: 0, total: plans.length, label: 'استرجاع الأدلة لكل الأقسام...' });
  const evidences = await mapPool(plans, 6, signal, async pl => {
    try { return await retrieve(`${pl.title} ${pl.query}`, chunks, 12, signal); } catch { return []; }
  });
  let writtenCount = 0;
  await mapPool(plans, 3, signal, async (pl, i) => {
    if (isAborted(signal)) return;
    artifact.sections[i].status = 'writing';
    onSection?.([...artifact.sections]);
    onProgress?.({ phase: 'section', current: Math.min(writtenCount + 1, plans.length), total: plans.length, label: `كتابة: ${pl.title}` });

    const rc = evidences[i] || [];
    const refs = chunksToProvenance(rc);
    artifact.citations[pl.id] = refs;
    const evidence = rc.length
      ? rc.map((r, n) => `[مصدر ${n + 1}] (${r.chunk.docName} › ${r.chunk.headingPath})\n${r.chunk.text.slice(0, 600)}`).join('\n\n')
      : '(لا توجد أدلة مسترجعة لهذا القسم — اكتب من النموذج فقط دون اختلاق أرقام.)';

    const memo = globalFacts.length ? `\nحقائق مثبتة سابقاً في الوثيقة (التزم بها):\n${globalFacts.slice(-12).join('\n')}` : '';

    const mermaidDirective = `

إذا كان هذا القسم يتعلق بإجراء / عملية / خطوات / تدفق عمل / مسار قرار:
أضف في نهاية القسم مخططاً بصيغة Mermaid بين علامتَي الكود التالية (بدون تعديل):
\`\`\`mermaid
flowchart TD
  ...خطوات المخطط...
\`\`\`
استخدم أسماء عربية مختصرة للعُقد. لو القسم ليس إجراءً ولا عملية ← لا تُضف مخططاً.`;

    const sectionPrompt = `اكتب القسم ${i + 1}: "${pl.title}". هدفه: ${pl.goal}
الهيكل الكامل (اكتب هذا القسم فقط، تفادَ تكرار غيره):
${outlineText}
${memo}

الأدلة المسترجعة لهذا القسم (استشهد بها بصيغة [مصدر N]):
${evidence}

ابدأ بعنوان ## مناسب. اكتب بعمق استشاري. لا تخترع أرقاماً غير موجودة في الأدلة أو النموذج.${lenDirective}${mermaidDirective}`;

    let content = '';
    try {
      await streamChat(
        { systemInstruction: sys, history: [], message: sectionPrompt, signal },
        {
          onThought: t => onThought?.(t),
          onAnswer: a => { content += a; artifact.sections[i].content = content; onSection?.([...artifact.sections]); },
        },
      );
      artifact.sections[i].content = content || FAIL_RETRY;
      artifact.sections[i].status = content.trim() ? 'done' : 'failed';
      // Distill a richer fact for coherence memory: the section's lead +
      // a couple of substantive sentences (not just the first line). This lets
      // later sections actually reference what earlier ones established —
      // tightening cross-section الترابط/التكامل instead of a thin headline.
      if (content.trim()) {
        const lines = content.replace(/[#*>`]/g, '').split('\n').map(s => s.trim()).filter(Boolean);
        // prefer informative lines (skip pure headings / very short fragments)
        const substantive = lines.filter(l => l.length > 25).slice(0, 3);
        const gist = (substantive.length ? substantive : lines.slice(0, 2)).join(' ').slice(0, 320);
        if (gist) {
          const fact = `- ${p.docTitle} › ${pl.title}: ${gist}`;
          globalFacts.push(fact);
          // publish to shared cross-doc memory (cap to keep prompt bounded)
          if (p.sharedFacts) { p.sharedFacts.push(fact); if (p.sharedFacts.length > 40) p.sharedFacts.splice(0, p.sharedFacts.length - 40); }
        }
      }
    } catch {
      artifact.sections[i].content = FAIL_CONN;
      artifact.sections[i].status = 'failed';
    }
    writtenCount++;
    onSection?.([...artifact.sections]);
  });

  if (isAborted(signal)) return artifact;

  // ---- C: global critique ----
  onProgress?.({ phase: 'critique', current: 0, total: 1, label: 'تدقيق الاتساق والاستشهادات...' });
  let issues: { sectionIndex: number; issue: string; fix: string }[] = [];
  try {
    // Prorate the budget across remaining sections so later sections never
    // collapse to empty excerpts (the naive Math.min(4000, budget) starved every
    // section past ~#10 once the budget was spent on early ones).
    let critBudget = Math.max(40000, artifact.sections.length * 3000);
    const dg = artifact.sections.map((s, i) => {
      const remaining = artifact.sections.length - i;
      const fairShare = Math.ceil(critBudget / Math.max(1, remaining));
      const cap = Math.min(4000, Math.max(600, fairShare));
      const excerpt = s.content.slice(0, cap);
      critBudget = Math.max(0, critBudget - excerpt.length);
      return `### قسم ${i + 1}: ${s.title}\n${excerpt}`;
    }).join('\n\n');
    const res = await generateJson<{ issues: typeof issues }>(
      `راجع المسودة: حدّد التناقضات بين الأقسام، الأرقام بلا [مصدر]، الاستشهادات الناقصة، مخالفة نموذج الشركة. لكل مشكلة: sectionIndex (من 1)، issue، fix. JSON فقط.\n\n${dg}`,
      critiqueSchema, { systemInstruction: sys, signal },
    );
    issues = (res.issues || []).filter(it => it.sectionIndex >= 1 && it.sectionIndex <= plans.length);
  } catch { issues = []; }

  // ---- D: targeted revise ----
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
      onProgress?.({ phase: 'revise', current: done, total: byIdx.size, label: `تنقيح: ${plans[idx]?.title || ''}` });
      let revised = '';
      try {
        await streamChat(
          {
            systemInstruction: sys, history: [], signal,
            message: `أعد كتابة القسم بعد معالجة الملاحظات مع إضافة [مصدر N] الناقصة والحفاظ على الاتساق. أعد المحتوى الكامل Markdown فقط.\n\nالملاحظات:\n${fixes.join('\n')}\n\nالنص الحالي:\n${artifact.sections[idx].content}`,
          },
          { onThought: t => onThought?.(t), onAnswer: a => { revised += a; } },
        );
        if (revised.trim()) { artifact.sections[idx].content = revised; onSection?.([...artifact.sections]); }
      } catch { /* keep original */ }
    }
  }

  if (isAborted(signal)) return artifact;

  // ---- E: executive summary (stitch) ----
  onProgress?.({ phase: 'assemble', current: 0, total: 1, label: 'صياغة الملخص التنفيذي الرابط...' });
  try {
    const dg = artifact.sections.map((s, i) => `${i + 1}. ${s.title}: ${s.content.slice(0, 500)}`).join('\n');
    let summary = '';
    await streamChat(
      { systemInstruction: sys, history: [], message: `اكتب ملخصاً تنفيذياً مترابطاً (3-5 فقرات) يربط الأقسام ويبرز أهم التوصيات. Markdown عربي.\n\n${dg}`, signal, maxOutputTokens: 2048 },
      { onThought: t => onThought?.(t), onAnswer: a => { summary += a; } },
    );
    if (summary.trim()) artifact.executiveSummary = summary;
  } catch { /* optional */ }

  artifact.complete = !isAborted(signal);
  onProgress?.({ phase: 'done', current: plans.length, total: plans.length, label: 'اكتملت الوثيقة ✅' });
  onSection?.([...artifact.sections]);
  return artifact;
}

// ===========================================================================
// BULK generation — produce COMPLETE output in one long pass:
//   scope 'policies'   → one full section per policy
//   scope 'procedures' → one full section per procedure (full operational text)
//   scope 'departments'→ one full section per org unit (charter + roles + procedures)
// Deterministic outline (no AI outline step) so nothing is skipped.
// ===========================================================================

export type BulkScope = 'policies' | 'procedures' | 'departments' | 'authorities' | 'kpis';

export interface GenerateBulkParams {
  scope: BulkScope;
  model: CompanyGovernanceModel;
  chunks: DocChunk[];
  ids?: string[];                 // optional subset; empty/undefined = ALL
  language?: Language;
  sector?: string;                // industry lens (construction-wise, not IT)
  referenceProjects?: ReferenceProject[];  // prior real projects as a basis
  signal?: AbortSignal;
  onProgress?: (p: { phase: string; current: number; total: number; label: string }) => void;
  onThought?: (t: string) => void;
  onSection?: (sections: ArtifactSection[]) => void;
}

/** Standards each bulk scope must embed — injected into the bulk sys prompt. */
const SCOPE_FRAMEWORKS: Record<BulkScope, string[]> = {
  policies:    ['ISO 9001', 'COSO', 'ISO 37301'],
  procedures:  ['ISO 9001', 'BPMN 2.0', 'LEAN'],
  departments: ['EFQM', 'McKinsey 7S', 'KAQA'],
  authorities: ['COSO', 'IIA IPPF', 'ISO 38500'],
  kpis:        ['BSC', 'OKR', 'EFQM'],
};

const SCOPE_META: Record<BulkScope, { title: string; goal: string; unit: string }> = {
  policies:    { title: 'دليل السياسات المؤسسية الكامل', goal: 'صياغة كل سياسة بشكل رسمي كامل (الغرض، النطاق، البنود، المسؤوليات، المراجعة)', unit: 'سياسة' },
  procedures:  { title: 'دليل الإجراءات التشغيلية الكامل', goal: 'توثيق كل إجراء بخطوات دقيقة قابلة للتنفيذ (المدخلات، الخطوات، الأدوار، المخرجات، الضوابط)', unit: 'إجراء' },
  departments: { title: 'أدلة الإدارات الكاملة', goal: 'لكل إدارة: ميثاقها، أدوارها، سياساتها وإجراءاتها', unit: 'إدارة' },
  authorities: { title: 'مصفوفة الصلاحيات والاعتمادات الكاملة', goal: 'توثيق كل قرار وصلاحية: من يوصي/يعتمد/ينفّذ/يُبلَّغ وحدود التفويض', unit: 'صلاحية' },
  kpis: { title: 'دليل مؤشرات الأداء الكامل', goal: 'لكل مؤشر: التعريف، المعادلة، المستهدف، الجهة المالكة، دورية القياس، مصدر البيانات', unit: 'مؤشر' },
};

export async function generateBulkDoc(p: GenerateBulkParams): Promise<GovernanceDocument> {
  const { scope, model, chunks, signal, onProgress, onThought, onSection } = p;
  const language = p.language || 'ar';
  const facts = modelFacts(model);
  const meta = SCOPE_META[scope];
  const wanted = (id: string) => !p.ids || p.ids.length === 0 || p.ids.includes(id);

  const sys = `أنت مستشار حوكمة مؤسسية. تكتب وثائق رسمية مفصّلة ودقيقة اعتماداً حصرياً على "نموذج حوكمة الشركة" والأدلة المُسترجعة.
قواعد صارمة:
- لا تخالف حقائق النموذج ولا تخترع أرقاماً.
- استشهد بعد كل ادعاء مأخوذ من الأدلة بصيغة [مصدر N].
- نص دقيق ومزبوط، عربي فصيح، تنسيق Markdown، عناوين فرعية واضحة.

=== نموذج حوكمة الشركة (مصدر الحقيقة) ===
${facts}

=== ${coherenceMemo(model)} ===
${industryLens(p.sector)}${referenceProjectsBlock(p.referenceProjects, p.sector)}

${frameworksDirective(SCOPE_FRAMEWORKS[scope])}${scope === 'procedures' ? BPM_PROC_DIRECTIVE : ''}`;

  // ---- deterministic outline: one section per entity ----
  type Plan = { id: string; title: string; query: string; instruction: string };
  let plans: Plan[] = [];

  if (scope === 'policies') {
    plans = model.policies.filter(x => wanted(x.id)).map(pol => ({
      id: pol.id,
      title: pol.title,
      query: `${pol.title} ${pol.domain} سياسة`,
      instruction: `اكتب وثيقة سياسة "${pol.title}" (المجال: ${pol.domain}) كاملة: 1) الغرض 2) النطاق 3) التعريفات 4) بنود السياسة التفصيلية 5) المسؤوليات والصلاحيات 6) المخالفات 7) المراجعة والتحديث. الملخص الحالي: ${pol.body || '—'}`,
    }));
  } else if (scope === 'procedures') {
    plans = (model.procedures || []).filter(x => wanted(x.id)).map(pr => {
      const unit = model.orgUnits.find(u => u.id === pr.unitId);
      const pol = model.policies.find(x => x.id === pr.policyId);
      return {
        id: pr.id,
        title: pr.title,
        query: `${pr.title} ${pr.purpose} إجراء خطوات`,
        instruction: `اكتب الإجراء التشغيلي "${pr.title}" كاملاً ودقيقاً وفق منهجية BPM/BPMN 2.0: 1) الغرض (${pr.purpose}) 2) النطاق ${unit ? `(الإدارة المالكة: ${unit.name})` : ''} 3) المدخلات والمتطلبات 4) الخطوات التفصيلية المرقّمة، لكل خطوة: الدور المسؤول (Swimlane) + المدخلات + المخرجات + نقطة الضبط/الموافقة + اتفاقية مستوى الخدمة SLA (المدة القصوى) 5) مصفوفة RACI 6) مؤشرات أداء العملية KPIs مع المستهدف ودورية القياس 7) المخرجات والسجلات ${pol ? `8) السياسة المرجعية: ${pol.title}` : ''} 9) مخطط تدفق BPMN بصيغة Mermaid في النهاية. الخطوات المعروفة حالياً:\n${(pr.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '—'}`,
      };
    });
  } else if (scope === 'authorities') {
    plans = (model.authorities || []).filter(x => wanted(x.id)).map(a => {
      const role = model.roles.find(r => r.id === a.roleId);
      return {
        id: a.id,
        title: a.decision,
        query: `${a.decision} صلاحية اعتماد تفويض ${role?.title || ''}`,
        instruction: `وثّق صلاحية القرار "${a.decision}" كاملةً: 1) وصف القرار ونطاقه 2) مستوى الصلاحية (${a.level}) 3) الدور الحامل${role ? ` (${role.title})` : ''} 4) مصفوفة RACI (مسؤول/مساءل/مُستشار/مُطّلع) 5) حدود التفويض المالي/التنظيمي 6) مسار التصعيد عند تجاوز الحد 7) السجل والتوثيق المطلوب.`,
      };
    });
  } else if (scope === 'kpis') {
    plans = (model.kpis || []).filter(x => wanted(x.id)).map(k => {
      const unit = model.orgUnits.find(u => u.id === k.unitId);
      return {
        id: k.id,
        title: k.name,
        query: `${k.name} مؤشر أداء قياس ${k.formula}`,
        instruction: `وثّق مؤشر الأداء "${k.name}" كاملاً: 1) التعريف والغرض 2) المعادلة (${k.formula || '—'}) 3) المستهدف (${k.target || '—'}) 4) الجهة المالكة${unit ? ` (${unit.name})` : ''} 5) دورية القياس 6) مصدر البيانات وآلية الجمع 7) حدود الإنذار والتدخّل 8) ارتباطه بالأهداف الاستراتيجية.`,
      };
    });
  } else {
    plans = model.orgUnits.filter(x => wanted(x.id)).map(u => {
      const roles = model.roles.filter(r => r.unitId === u.id);
      const procs = (model.procedures || []).filter(pr => pr.unitId === u.id);
      return {
        id: u.id,
        title: u.name,
        query: `${u.name} ${u.mandate}`,
        instruction: `اكتب دليل إدارة "${u.name}" كاملاً: 1) ميثاق الإدارة وغرضها (${u.mandate}) 2) الهيكل والأدوار${roles.length ? ` (${roles.map(r => r.title).join('، ')})` : ''} 3) مسؤوليات كل دور 4) السياسات والإجراءات التي تملكها${procs.length ? ` (${procs.map(pr => pr.title).join('، ')})` : ''} 5) مؤشرات الأداء والتقارير.`,
      };
    });
  }

  const artifact: GovernanceDocument = {
    title: meta.title, goal: meta.goal, language,
    sections: plans.map(pl => ({ id: pl.id, title: pl.title, content: '', status: 'pending' as const })),
    createdAt: new Date(), complete: false, citations: {},
  };
  onSection?.([...artifact.sections]);

  if (!plans.length) {
    artifact.complete = true;
    onProgress?.({ phase: 'done', current: 0, total: 0, label: `لا توجد عناصر من نوع "${meta.unit}" في النموذج بعد.` });
    return artifact;
  }

  // ---- write each entity fully (retrieve + cite) — ج1: bounded-concurrency pool ----
  // cap 3 keeps us under model rate limits while cutting wall-clock ~3-4x vs serial.
  // Each task owns a distinct section index, so concurrent writes never collide.
  // globalFacts: coherence window — sections that complete first share their lead line
  // so later concurrent sections can maintain naming/numbering consistency.
  const secTokens = sectionTokens();
  const globalFacts: string[] = [];
  let done = 0;
  await mapPool(plans, 3, signal, async (pl, i) => {
    if (isAborted(signal)) return;
    artifact.sections[i].status = 'writing';
    onSection?.([...artifact.sections]);

    let content = '';
    try {
      const rc = await withRetry(() => retrieve(pl.query, chunks, 12, signal), 2, 600, signal);
      const refs = chunksToProvenance(rc);
      artifact.citations[pl.id] = refs;
      const evidence = rc.length
        ? rc.map((r, n) => `[مصدر ${n + 1}] (${r.chunk.docName} › ${r.chunk.headingPath})\n${r.chunk.text.slice(0, 600)}`).join('\n\n')
        : '(لا أدلة مسترجعة — اكتب من النموذج فقط دون اختلاق أرقام.)';

      const memo = globalFacts.length
        ? `\nحقائق مثبتة من وثائق أخرى (حافظ على الاتساق):\n${globalFacts.slice(-10).join('\n')}\n`
        : '';

      await withRetry(async () => {
        content = '';
        await streamChat(
          {
            systemInstruction: sys, history: [], signal, maxOutputTokens: secTokens,
            message: `${pl.instruction}\n\nابدأ بعنوان ## ${pl.title}. اكتب بعمق استشاري ودقة. استشهد [مصدر N] عند الاقتباس من الأدلة. التزم بسجل التسميات الموحّد في الأعلى للحفاظ على الاتساق مع باقي الوثائق.${memo}\n\nالأدلة المسترجعة:\n${evidence}`,
          },
          {
            onThought: t => onThought?.(t),
            onAnswer: a => { content += a; artifact.sections[i].content = content; onSection?.([...artifact.sections]); },
          },
        );
        if (!content.trim() && !isAborted(signal)) throw new Error('empty-section');
      }, 3, 800, signal);

      artifact.sections[i].content = content.trim() || FAIL_RETRY;
      artifact.sections[i].status = content.trim() ? 'done' : 'failed';

      // push 2-3 substantive lines into coherence window so later concurrent sections
      // can actually reference what earlier ones established (not just a thin headline).
      if (content.trim()) {
        const lines = content.replace(/[#*>`]/g, '').split('\n').map(s => s.trim()).filter(Boolean);
        const substantive = lines.filter(l => l.length > 25).slice(0, 3);
        const gist = (substantive.length ? substantive : lines.slice(0, 2)).join(' ').slice(0, 320);
        if (gist) globalFacts.push(`- ${pl.title}: ${gist}`);
        if (globalFacts.length > 30) globalFacts.splice(0, globalFacts.length - 30);
      }
    } catch {
      artifact.sections[i].content = content.trim() || FAIL_CONN;
      artifact.sections[i].status = content.trim() ? 'done' : 'failed';
    }
    done++;
    onProgress?.({ phase: 'section', current: done, total: plans.length, label: `اكتمل ${meta.unit}: ${pl.title} (${done}/${plans.length})` });
    onSection?.([...artifact.sections]);
  });

  // ---- BULK Quality Pass (phase C): detect thin/failed sections and rewrite ----
  // A thin section (< 300 chars) signals the model hit a rate limit or timed out.
  // Rewrite at concurrency 2 to stay under rate limits; skip if already aborted.
  const thinThreshold = 300;
  const thinItems = artifact.sections
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status === 'failed' || s.content.trim().length < thinThreshold);

  if (thinItems.length && !isAborted(signal)) {
    onProgress?.({ phase: 'quality', current: 0, total: thinItems.length, label: `إعادة توليد ${thinItems.length} قسم ناقص...` });
    let qDone = 0;
    await mapPool(thinItems, 2, signal, async ({ i }) => {
      if (isAborted(signal)) return;
      const pl = plans[i];
      artifact.sections[i].status = 'writing';
      onSection?.([...artifact.sections]);
      let content = '';
      try {
        const rc = await withRetry(() => retrieve(pl.query, chunks, 12, signal), 2, 600, signal);
        const evidence = rc.length
          ? rc.map((r, n) => `[مصدر ${n + 1}] (${r.chunk.docName} › ${r.chunk.headingPath})\n${r.chunk.text.slice(0, 600)}`).join('\n\n')
          : '(لا أدلة مسترجعة — اكتب من النموذج فقط دون اختلاق أرقام.)';
        await withRetry(async () => {
          content = '';
          await streamChat(
            {
              systemInstruction: sys, history: [], signal, maxOutputTokens: secTokens,
              message: `${pl.instruction}\n\nابدأ بعنوان ## ${pl.title}. اكتب بعمق استشاري ودقة. استشهد [مصدر N] عند الاقتباس. التزم بسجل التسميات الموحّد للحفاظ على الاتساق.\n\nالأدلة المسترجعة:\n${evidence}`,
            },
            { onThought: t => onThought?.(t), onAnswer: a => { content += a; artifact.sections[i].content = content; onSection?.([...artifact.sections]); } },
          );
          if (!content.trim() && !isAborted(signal)) throw new Error('empty-section');
        }, 2, 800, signal);
        artifact.sections[i].content = content.trim() || FAIL_RETRY;
        artifact.sections[i].status = content.trim() ? 'done' : 'failed';
      } catch {
        artifact.sections[i].content = content.trim() || FAIL_CONN;
        artifact.sections[i].status = 'failed';
      }
      qDone++;
      onProgress?.({ phase: 'quality', current: qDone, total: thinItems.length, label: `جودة: ${pl.title} (${qDone}/${thinItems.length})` });
      onSection?.([...artifact.sections]);
    });
  }

  artifact.complete = !isAborted(signal);
  onProgress?.({ phase: 'done', current: plans.length, total: plans.length, label: 'اكتمل التوليد الشامل ✅' });
  onSection?.([...artifact.sections]);
  return artifact;
}

// ===========================================================================
// GAP → FIX loop — generate a remedial policy + procedure that closes a gap.
// Returns a GovernanceDocument (2 sections) AND a draft GovPolicy/GovProcedure
// the caller can "approve to model" and link back to the gap (resolved=true).
// ===========================================================================

export interface GapFixParams {
  gap: GovGap;
  model: CompanyGovernanceModel;
  chunks: DocChunk[];
  language?: Language;
  signal?: AbortSignal;
  /** ج6 — reference projects to mine as a best-practice basis for the fix. */
  referenceProjects?: ReferenceProject[];
  sector?: string;
  size?: string;
  onThought?: (t: string) => void;
  onSection?: (sections: ArtifactSection[]) => void;
  onProgress?: (p: { phase: string; current: number; total: number; label: string }) => void;
}

/** ج6 — build an injectable best-practice block from reference projects matched to a gap.
 *  Prefers the gap's pre-matched projects; falls back to a live vector/context match. */
async function referenceBasisBlock(
  gap: GovGap, refs: ReferenceProject[], sector?: string, size?: string, signal?: AbortSignal,
): Promise<string> {
  if (!refs?.length) return '';
  let chosen: ReferenceProject[] = [];
  const pre = new Set(gap.matchedProjectIds || []);
  if (pre.size) chosen = refs.filter(r => pre.has(r.id));
  if (!chosen.length) {
    try {
      const matches = await matchProjects(
        `${gap.area} ${gap.description} ${gap.recommendation || ''}`,
        { sector, size, kind: 'policy' }, refs, 3, signal,
      );
      chosen = matches.filter(m => m.score > 0.3).map(m => m.project);
    } catch { /* matching optional */ }
  }
  if (!chosen.length) return '';
  const body = chosen.slice(0, 3).map(rp => {
    const tags = (rp.tags || []).join('، ');
    const excerpt = (rp.content || rp.summary || '').slice(0, 1500);
    return `• ${rp.name}${rp.sector ? ` (${rp.sector})` : ''}${tags ? ` — ${tags}` : ''}\n${excerpt}`;
  }).join('\n\n');
  return `\n\n=== ممارسات مرجعية من مشاريع سابقة مطابِقة (استلهم منها البنية وأفضل الممارسات، وكيّفها على سياق الشركة — لا تنسخ حرفياً) ===\n${body}`;
}

export interface GapFixResult {
  doc: GovernanceDocument;
  policy: GovPolicy;
  procedure: GovProcedure;
}

export async function generateGapFix(p: GapFixParams): Promise<GapFixResult> {
  const { gap, model, chunks, signal, onThought, onSection, onProgress } = p;
  const language = p.language || 'ar';
  const facts = modelFacts(model);

  const sys = `أنت مستشار حوكمة. تعالج فجوة حوكمية محددة بإنتاج سياسة وإجراء عمليّين يغلقانها، متسقَين مع نموذج الشركة.
- لا تخالف النموذج ولا تخترع أرقاماً. استشهد [مصدر N] عند الاقتباس.
- عربي فصيح، Markdown.

=== نموذج حوكمة الشركة ===
${facts}

=== الفجوة المستهدفة ===
المجال: ${gap.area}
الوصف: ${gap.description}
الخطورة: ${gap.severity}
التوصية: ${gap.recommendation || '—'}${await referenceBasisBlock(gap, p.referenceProjects || [], p.sector, p.size, signal)}`;

  const titles = { policy: `سياسة ${gap.area}`, procedure: `إجراء معالجة ${gap.area}` };
  const sections: ArtifactSection[] = [
    { id: 'gapfix_policy', title: titles.policy, content: '', status: 'pending' },
    { id: 'gapfix_proc', title: titles.procedure, content: '', status: 'pending' },
  ];
  const doc: GovernanceDocument = {
    title: `إغلاق فجوة: ${gap.area}`, goal: gap.recommendation || `معالجة ${gap.area}`,
    language, sections, createdAt: new Date(), complete: false, citations: {},
  };
  onSection?.([...sections]);

  const rc = await retrieve(`${gap.area} ${gap.description} ${gap.recommendation || ''}`, chunks, 12, signal);
  const refs = chunksToProvenance(rc);
  doc.citations['gapfix_policy'] = refs;
  doc.citations['gapfix_proc'] = refs;
  const evidence = rc.length
    ? rc.map((r, n) => `[مصدر ${n + 1}] (${r.chunk.docName} › ${r.chunk.headingPath})\n${r.chunk.text.slice(0, 600)}`).join('\n\n')
    : '(لا أدلة مسترجعة — اكتب من النموذج فقط دون اختلاق أرقام.)';

  // --- 1) policy ---
  onProgress?.({ phase: 'section', current: 1, total: 2, label: `صياغة ${titles.policy}` });
  sections[0].status = 'writing'; onSection?.([...sections]);
  let polBody = '';
  try {
    await streamChat(
      { systemInstruction: sys, history: [], signal,
        message: `اكتب وثيقة سياسة كاملة تغلق هذه الفجوة بعنوان ## ${titles.policy}: 1) الغرض 2) النطاق 3) البنود 4) المسؤوليات 5) المراجعة. استشهد بالأدلة.\n\nالأدلة:\n${evidence}` },
      { onThought: t => onThought?.(t), onAnswer: a => { polBody += a; sections[0].content = polBody; onSection?.([...sections]); } },
    );
    sections[0].status = polBody.trim() ? 'done' : 'failed';
  } catch { sections[0].status = 'failed'; }

  // --- 2) procedure ---
  if (!isAborted(signal)) {
    onProgress?.({ phase: 'section', current: 2, total: 2, label: `صياغة ${titles.procedure}` });
    sections[1].status = 'writing'; onSection?.([...sections]);
    let procBody = '';
    try {
      await streamChat(
        { systemInstruction: sys, history: [], signal,
          message: `اكتب إجراءً تشغيلياً يفعّل السياسة السابقة بعنوان ## ${titles.procedure}: خطوات مرقّمة دقيقة، الدور المسؤول لكل خطوة، نقاط الضبط، المخرجات. استشهد بالأدلة.\n\nالأدلة:\n${evidence}` },
        { onThought: t => onThought?.(t), onAnswer: a => { procBody += a; sections[1].content = procBody; onSection?.([...sections]); } },
      );
      sections[1].status = procBody.trim() ? 'done' : 'failed';
    } catch { sections[1].status = 'failed'; }
  }

  doc.complete = !isAborted(signal);
  onProgress?.({ phase: 'done', current: 2, total: 2, label: 'جاهز للاعتماد إلى النموذج ✅' });
  onSection?.([...sections]);

  const policy: GovPolicy = {
    id: uid('pol'), title: titles.policy, domain: gap.area, body: sections[0].content,
    status: 'draft', provenance: refs,
  };
  const procedure: GovProcedure = {
    id: uid('proc'), title: titles.procedure, policyId: policy.id, purpose: gap.recommendation || `معالجة ${gap.area}`,
    steps: [], body: sections[1].content, status: 'draft', provenance: refs,
  };

  return { doc, policy, procedure };
}

// ---------------------------------------------------------------------------
// CRITICAL #3 — edit an EXISTING generated document.
// The super-agent could create/generate-bulk but never EDIT a produced doc.
// editArtifact applies a targeted instruction: it picks the section(s) the edit
// refers to (fuzzy title/keyword match; falls back to all sections for a global
// pass), rewrites them with streamChat grounded in the model + retrieved evidence,
// and returns a NEW artifact (original untouched) so undo stays trivial.
// ---------------------------------------------------------------------------
export interface EditArtifactParams {
  artifact: GeneratedArtifact;
  instruction: string;                 // what to change
  model: CompanyGovernanceModel;
  chunks?: DocChunk[];
  language?: Language;
  sector?: string;                     // keep edits inside the real industry
  referenceProjects?: ReferenceProject[];
  signal?: AbortSignal;
  onProgress?: (p: GovProgress | { phase: string; current: number; total: number; label: string }) => void;
  onThought?: (t: string) => void;
  onSection?: (s: ArtifactSection[]) => void;
}

// Arabic-aware normalizer for fuzzy section matching (strip tashkeel/tatweel, fold variants).
function normalizeAr(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function pickEditTargets(sections: ArtifactSection[], instruction: string): number[] {
  const instrKey = normalizeAr(instruction);
  const hits: number[] = [];
  sections.forEach((s, i) => {
    const title = normalizeAr(s.title);
    if (!title) return;
    // section title mentioned in the instruction, or strong word overlap
    const words = title.split(/\s+/).filter(w => w.length >= 3);
    const overlap = words.filter(w => instrKey.includes(w)).length;
    if (instrKey.includes(title) || overlap >= Math.max(1, Math.ceil(words.length / 2))) hits.push(i);
  });
  // No explicit target → treat as a global revision (all done sections).
  if (!hits.length) return sections.map((_, i) => i).filter(i => sections[i].content.trim());
  return hits;
}

export async function editArtifact(p: EditArtifactParams): Promise<GeneratedArtifact> {
  const { artifact, instruction, model, signal, onProgress, onThought, onSection } = p;
  const chunks = p.chunks || [];
  const language = p.language || artifact.language || 'ar';
  const facts = modelFacts(model);

  // deep clone so the original stays intact (undo-friendly)
  const next: GeneratedArtifact = JSON.parse(JSON.stringify(artifact));
  next.createdAt = artifact.createdAt;     // preserve provenance timestamp
  next.complete = false;

  const sys = `أنت مستشار حوكمة يحرّر وثيقة قائمة. عدّل المحتوى وفق تعليمات المستخدم مع:
- الالتزام التام بحقائق النموذج (لا تخترع أرقاماً أو كيانات غير موجودة).
- الحفاظ على نفس المسميات والأسلوب وتنسيق Markdown وعناوين ## .
- تطبيق التعديل المطلوب فقط دون حذف محتوى صحيح غير مقصود بالتعديل.

=== نموذج حوكمة الشركة (مصدر الحقيقة) ===
${facts}
${industryLens(p.sector)}${referenceProjectsBlock(p.referenceProjects, p.sector)}`;

  const targets = pickEditTargets(next.sections, instruction);
  if (!targets.length) { next.complete = !isAborted(signal); return next; }

  const outline = next.sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  onProgress?.({ phase: 'section', current: 0, total: targets.length, label: `تحرير ${targets.length} قسم...` });

  for (let t = 0; t < targets.length; t++) {
    if (isAborted(signal)) { return next; }
    const i = targets[t];
    const sec = next.sections[i];
    sec.status = 'writing';
    onSection?.([...next.sections]);
    onProgress?.({ phase: 'section', current: t + 1, total: targets.length, label: `تحرير: ${sec.title}` });

    const rc = chunks.length ? await retrieve(`${sec.title} ${instruction}`, chunks, 5, signal) : [];
    const evidence = rc.length
      ? rc.map((r, n) => `[مصدر ${n + 1}] (${r.chunk.docName} › ${r.chunk.headingPath})\n${r.chunk.text.slice(0, 500)}`).join('\n\n')
      : '(لا أدلة إضافية — حرّر اعتماداً على النموذج والمحتوى الحالي دون اختلاق.)';

    const editPrompt = `هيكل الوثيقة الكامل (للسياق فقط):
${outline}

القسم المطلوب تحريره: "${sec.title}".
محتواه الحالي:
"""
${sec.content || '(فارغ)'}
"""

تعليمات التعديل من المستخدم: ${instruction}

الأدلة المسترجعة (استشهد عند الحاجة بصيغة [مصدر N]):
${evidence}

أعد كتابة هذا القسم كاملاً بعد تطبيق التعديل. ابدأ بعنوان ## "${sec.title}". أعد النص الكامل المعدّل فقط.`;

    let content = '';
    try {
      await streamChat(
        { systemInstruction: sys, history: [], message: editPrompt, signal },
        {
          onThought: th => onThought?.(th),
          onAnswer: a => { content += a; next.sections[i].content = content; onSection?.([...next.sections]); },
        },
      );
      next.sections[i].content = content.trim() || sec.content;   // never blank a section
      next.sections[i].status = content.trim() ? 'done' : 'failed';
    } catch {
      next.sections[i].content = sec.content;     // keep original on failure
      next.sections[i].status = 'failed';
    }
    onSection?.([...next.sections]);
  }

  next.complete = !isAborted(signal);
  onProgress?.({ phase: 'done', current: targets.length, total: targets.length, label: 'اكتمل التحرير ✅' });
  return next;
}
