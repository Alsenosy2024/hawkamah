// Per-stage agentic assistant for the Governance Center.
// Reasons first (visible thinking via streamChat), then converses — asking the
// user clarifying questions and giving guidance specific to the current stage,
// always grounded in the live CompanyGovernanceModel (single source of truth).

import { ThinkingLevel } from '@google/genai';
import { streamChat, generateJson, type ChatTurn, type StreamCallbacks } from './agentOrchestrator';
import type { CompanyGovernanceModel, Language } from '../types';

export type GovStageKey = 'projects' | 'sources' | 'model' | 'diagrams' | 'generation' | 'assurance' | 'library';

const STAGE_BRIEF: Record<GovStageKey, { ar: string; en: string }> = {
  projects: {
    ar: 'المرحلة: المشاريع. لكل جهة مشروع مستقل (اسم، هوية، قطاع، تخصص، تفاصيل). ساعد المستخدم على إنشاء المشروع يدويًا أو باستخراج البيانات من ملفات مرفوعة، ثم اختيار المشروع النشط الذي يحدّد سياق الحوكمة بالكامل.',
    en: 'Stage: Projects. Each company is its own project (name, identity, sector, specialization, details). Help create a project manually or by extracting fields from uploaded files, then select the active project that scopes the whole governance flow.',
  },
  sources: {
    ar: 'المرحلة: المصادر والملفات. ساعد المستخدم على تحديد الوثائق الناقصة المطلوبة لبناء حوكمة دقيقة (هياكل، لوائح، سياسات، إجراءات، محاضر). اسأله أسئلة محددة عمّا لديه وما ينقصه.',
    en: 'Stage: Sources & files. Help identify which documents are missing to build accurate governance. Ask targeted questions.',
  },
  model: {
    ar: 'المرحلة: نموذج الحوكمة. ناقش الوحدات والأدوار والسياسات والإجراءات والفجوات المستخرجة. اقترح تصحيحات وأكمل النواقص بالحوار قبل التوليد.',
    en: 'Stage: Governance model. Discuss extracted units/roles/policies/procedures/gaps. Propose fixes and fill gaps via dialogue.',
  },
  diagrams: {
    ar: 'المرحلة: المخططات والكانفاس. اقترح أنسب أنواع المخططات للحالة، وراجع منطق الربط بين الوحدات والأدوار والإجراءات.',
    en: 'Stage: Diagrams & canvas. Suggest the best diagram types and review the linking logic.',
  },
  generation: {
    ar: 'المرحلة: البناء وتوليد الوثائق. ابنِ المخرجات (الهيكل، السياسات، الإجراءات، الوثائق) من النموذج المُحلَّل بالفعل ومن تعديلات المستخدم على الوحدات (مثل: «هذا مكتب مشاريع، احذف المالية وأضف كذا»). عندما يطلب المستخدم «ابنِ» فابدأ البناء فعليًّا — لا تُعِد تحليل الواقع الراهن ولا حصر/تقدير الفجوات هنا، فذلك مرحلته الخاصة (الواقع الراهن/التحقق). ساعد المستخدم على تحديد نطاق التوليد (سياسات كاملة، إجراءات كاملة، إدارات بالكامل) والهدف والجمهور قبل التشغيل.',
    en: 'Stage: Build & document generation. Build the outputs (structure, policies, procedures, documents) FROM the already-analyzed model and the user’s unit edits (e.g. “this is a projects office, remove finance, add X”). When the user says “build”, actually build — do NOT re-run the current-state analysis or re-count/re-estimate gaps here; that has its own stage (current-state/assurance). Help define generation scope (full policies/procedures/departments), goal and audience.',
  },
  assurance: {
    ar: 'المرحلة: الضمان والتحقق. راجع تماسك النموذج وسلامته (فجوات، تعارضات، تغطية الأدوار والسياسات والإجراءات). اقترح إصلاحات الفجوات وتحقق من اكتمال الحوكمة قبل الاعتماد النهائي.',
    en: 'Stage: Assurance & validation. Review the model integrity (gaps, conflicts, coverage of roles/policies/procedures). Propose gap fixes and verify governance completeness before final sign-off.',
  },
  library: {
    ar: 'المرحلة: المكتبة المرجعية. ساعد على مطابقة الفجوات بمشاريع سابقة وأفضل الممارسات.',
    en: 'Stage: Reference library. Help match gaps to prior projects and best practices.',
  },
};

function modelSnapshot(m?: CompanyGovernanceModel | null): string {
  if (!m) return 'لا يوجد نموذج حوكمة مبني بعد.';
  const c = (n: number) => String(n);
  const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
  const units = arr(m.orgUnits), roles = arr(m.roles), policies = arr(m.policies),
    procedures = arr(m.procedures), gaps = arr(m.gaps);
  return [
    `الشركة: ${m.companyName || '—'}`,
    `الوحدات (${c(units.length)}): ${units.map(u => u?.name).filter(Boolean).slice(0, 30).join('، ') || '—'}`,
    `الأدوار (${c(roles.length)}): ${roles.map(r => r?.title).filter(Boolean).slice(0, 30).join('، ') || '—'}`,
    `السياسات (${c(policies.length)}): ${policies.map(p => p?.title).filter(Boolean).slice(0, 30).join('، ') || '—'}`,
    `الإجراءات (${c(procedures.length)}): ${procedures.map(p => p?.title).filter(Boolean).slice(0, 30).join('، ') || '—'}`,
    `الفجوات (${c(gaps.length)}): ${gaps.map(g => `[${g?.severity}] ${g?.area}`).slice(0, 20).join('، ') || '—'}`,
  ].join('\n');
}

export type GovCopilotMode = 'ask' | 'edit' | 'reason';

const MODE_BRIEF: Record<GovCopilotMode, { ar: string; en: string }> = {
  ask: {
    ar: 'الوضع: سؤال/إرشاد. أجب واطرح أسئلة توضيحية عند الحاجة.',
    en: 'Mode: ask/guide. Answer and ask clarifying questions when needed.',
  },
  edit: {
    ar: 'الوضع: اقتراح تعديل النموذج. صف بدقة التعديلات المنظّمة المقترحة (إضافة/تعديل وحدات/أدوار/سياسات/إجراءات/صلاحيات) كقائمة قابلة للمراجعة قبل التطبيق.',
    en: 'Mode: propose model edits. Describe structured changes (add/modify units/roles/policies/procedures/authorities) as a reviewable checklist.',
  },
  reason: {
    ar: 'الوضع: هدف مركّب. خطّط خطوة بخطوة (استرجاع، اقتراح، تطبيق، تحقّق سلامة) وصحّح نفسك قبل الإنهاء.',
    en: 'Mode: composite goal. Plan step by step (retrieve, propose, apply, validate) and self-correct.',
  },
};

// P0-2: authoritative live page state — bound to the copilot so it can NEVER
// contradict what the user sees (e.g. claim "no files" when 5 are uploaded).
export interface GovStateSnapshot {
  documentsCount: number;    // raw documents uploaded to this tenant (indexed or not)
  chunkCount: number;        // indexed/embedded chunks actually persisted
  modelBuilt: boolean;       // a governance model exists
  activeProjectName?: string;
  permissionError?: boolean; // data layer is failing (perm/connection)
}

function snapshotLine(s: GovStateSnapshot | undefined, ar: boolean): string {
  if (!s) return '';
  const yn = (b: boolean) => (ar ? (b ? 'نعم' : 'لا') : (b ? 'yes' : 'no'));
  if (ar) {
    return [
      '=== الحالة الحيّة للصفحة (مصدر الحقيقة المطلق — لا تناقضها أبداً) ===',
      `المشروع النشط: ${s.activeProjectName || '—'}`,
      `وثائق مرفوعة: ${s.documentsCount}`,
      `مقاطع مفهرسة: ${s.chunkCount}`,
      `النموذج مبني: ${yn(!!s.modelBuilt)}`,
      `خطأ صلاحيات/اتصال: ${yn(!!s.permissionError)}`,
      s.documentsCount > 0 && s.chunkCount === 0
        ? '⚠️ يوجد وثائق مرفوعة لكنها غير مفهرسة بعد — لا تقل «لا توجد ملفات»؛ قل إن الملفات مرفوعة لكن لم تُفهرس، واطلب تشغيل الفهرسة في مرحلة المصادر.'
        : '',
      s.permissionError
        ? '⚠️ طبقة البيانات تفشل حالياً (صلاحيات/اتصال) — صرّح بأنك قد لا تقرأ المقاطع، ولا تدّعِ معرفة محتوى لا تستطيع قراءته.'
        : '',
    ].filter(Boolean).join('\n');
  }
  return [
    '=== LIVE PAGE STATE (absolute source of truth — never contradict it) ===',
    `Active project: ${s.activeProjectName || '—'}`,
    `Documents uploaded: ${s.documentsCount}`,
    `Indexed chunks: ${s.chunkCount}`,
    `Model built: ${yn(!!s.modelBuilt)}`,
    `Permission/connection error: ${yn(!!s.permissionError)}`,
    s.documentsCount > 0 && s.chunkCount === 0
      ? '⚠️ Documents ARE uploaded but NOT indexed yet — do not say "no files"; say files are uploaded but un-indexed and ask to run indexing in the Sources stage.'
      : '',
    s.permissionError
      ? '⚠️ The data layer is currently failing (permissions/connection) — state you may be unable to read chunks; never claim knowledge of content you cannot read.'
      : '',
  ].filter(Boolean).join('\n');
}

export interface StageChatParams {
  stage: GovStageKey;
  model?: CompanyGovernanceModel | null;
  history: ChatTurn[];
  message: string;
  language?: Language;
  signal?: AbortSignal;
  extraContext?: string;     // e.g. # of loaded source docs / chunks
  mode?: GovCopilotMode;     // copilot mode flavors the system prompt
  fileContext?: string;      // retrieved actual content from uploaded files (RAG)
  fileCount?: number;        // how many source files are bound to the tenant
  longForm?: boolean;        // request thorough, document-grade output
  targetPages?: number;      // V4: explicit requested length (overrides parsing message)
  stateSnapshot?: GovStateSnapshot; // P0-2: live page state, authoritative
}

// Capability brief — the copilot is "unlimited open actions": it can draft full
// policies, procedures, strategies, manuals, tables, and presentation/sheet
// outlines on demand, and the UI turns any answer into Word/Excel/PDF/PPTX.
const CAPABILITY_AR =
  'قدراتك مفتوحة بالكامل: يمكنك صياغة وثائق كاملة (سياسات، إجراءات، لوائح، أدلة، استراتيجيات)، وإنشاء جداول، ومخططات نصية، ومخطط عرض تقديمي (شرائح بعناوين #)، وملخصات تنفيذية. كل إجابة يمكن تصديرها Word/Excel/PDF/PowerPoint، فاكتب بنية واضحة قابلة للتصدير.';
const CAPABILITY_EN =
  'Your actions are fully open: draft complete documents (policies, procedures, regulations, manuals, strategies), build tables, text diagrams, presentation outlines (slides via # headings), and executive summaries. Every answer is exportable to Word/Excel/PDF/PowerPoint — write clean, export-ready structure.';

const FORMAT_AR =
  'التنسيق: استخدم Markdown نظيفاً ومنظّماً — عناوين (#، ##)، قوائم، جداول (| ... |)، فواصل (---)، **غامق**. لا تترك هاشتاجات أو رموز خام بلا معنى. رتّب المحتوى تسلسلياً وبأقسام واضحة.';
const FORMAT_EN =
  'Formatting: clean structured Markdown — headings (#, ##), lists, tables (| ... |), rules (---), **bold**. Never emit stray hashtags or raw symbols. Sequence the content in clear sections.';

// Fallback density bands — used ONLY when the user gives NO explicit page count
// (a vague "اكتب سياسة كاملة"). When a count IS stated it wins (see
// resolveLengthTarget / buildLengthDirective below), which is the V4 fix.
const LONG_AR =
  'عندما يطلب المستخدم صياغة كاملة (استراتيجية / سياسة / لائحة / دليل) دون تحديد عدد صفحات: أعطِ إجابة طويلة دقيقة ومكتملة الأقسام (مقدمة، نطاق، تعريفات، بنود تفصيلية مرقّمة، أدوار ومسؤوليات بجدول، مؤشرات أداء، ملاحق) — لا تختصر. ضبط الدسامة حسب الحجم: وثيقة بسيطة ≈ 8–12 صفحة، متوسطة ≈ 15–20، شاملة ≈ 25–30 صفحة. وزّع الأقسام والجداول لتعكس هذا الحجم.';
const LONG_EN =
  'When the user asks for a full draft (strategy/policy/regulation/manual) WITHOUT stating a page count: produce a long, accurate, fully-sectioned answer (purpose, scope, definitions, numbered detailed clauses, roles & responsibilities table, KPIs, annexes) — do not truncate. Calibrate density to scope: simple ≈ 8–12 pages, medium ≈ 15–20, comprehensive ≈ 25–30 pages. Distribute sections and tables to match.';

// ---------------------------------------------------------------------------
// V4 — the requested page-count is a single source of truth.
//
// The user states a length in free Arabic/English text ("اكتب 10 صفحات", "عشر
// صفحات", "a 25-page report"). Historically that number was ignored: the draft
// prompt hard-coded the density bands above and the copilot path passed a loose
// target, so a "10 pages" ask ballooned to ~105. parseTargetPages extracts the
// requested count from the request string so EVERY generation path (in-app
// stageChat + the copilot /draft backend) honors the SAME target. It returns
// undefined when no explicit page count is asked for — callers then keep their
// existing default density, so vague requests are unchanged (no regression).
// ---------------------------------------------------------------------------

// Arabic-Indic (U+0660–0669) + Extended-Arabic/Persian (U+06F0–06F9) digits → ASCII.
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, d => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
}

// Spelled Arabic cardinals that realistically precede "صفحة/صفحات" in a request.
const AR_SPELLED: Record<string, number> = {
  'واحدة': 1, 'واحده': 1, 'واحد': 1,
  'اثنتين': 2, 'اثنتان': 2, 'اثنين': 2, 'اثنان': 2, 'إثنين': 2, 'إثنتين': 2,
  'ثلاث': 3, 'ثلاثة': 3, 'ثلاثه': 3,
  'أربع': 4, 'اربع': 4, 'أربعة': 4, 'اربعة': 4, 'اربعه': 4,
  'خمس': 5, 'خمسة': 5, 'خمسه': 5,
  'ست': 6, 'ستة': 6, 'سته': 6,
  'سبع': 7, 'سبعة': 7, 'سبعه': 7,
  'ثمان': 8, 'ثماني': 8, 'ثمانية': 8, 'ثمانيه': 8,
  'تسع': 9, 'تسعة': 9, 'تسعه': 9,
  'عشر': 10, 'عشرة': 10, 'عشره': 10,
  'عشرين': 20, 'عشرون': 20, 'ثلاثين': 30, 'ثلاثون': 30,
  'أربعين': 40, 'اربعين': 40, 'خمسين': 50, 'خمسون': 50,
  'ستين': 60, 'سبعين': 70, 'ثمانين': 80, 'تسعين': 90,
  'مئة': 100, 'مائة': 100, 'مية': 100, 'ميه': 100,
};
const AR_PAGE = 'صفحات|صفحة|صفحه';

/**
 * Extract the requested document length (in pages) from a free-text request,
 * Arabic or English. Only matches a number/cardinal that DIRECTLY precedes a
 * page word ("10 صفحات", "عشر صفحات", "25-page", "صفحتين") so it never picks up
 * unrelated numbers (years, "ISO 9001", "صفحة 3 من العقد"). Returns undefined
 * when no page count is requested. Clamped to a sane 1–300 before return.
 */
export function parseTargetPages(text?: string | null): number | undefined {
  if (!text) return undefined;
  const s = normalizeDigits(String(text));

  // Number immediately before a page word, Arabic or English (the length idiom).
  const numPatterns = [
    new RegExp(`(\\d{1,3})\\s*(?:${AR_PAGE})`),                       // "10 صفحات"
    new RegExp(`(\\d{1,3})\\s*[-\\u2013]?\\s*pages?`, 'i'),           // "10 pages", "10-page"
  ];
  for (const re of numPatterns) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 300) return n;
    }
  }

  // Dual page word with no number → exactly two pages.
  if (/صفحتين|صفحتان/.test(s)) return 2;

  // Spelled Arabic cardinal immediately before a page word ("عشر صفحات").
  const sm = s.match(new RegExp(`([\\u0621-\\u064A]+)\\s+(?:${AR_PAGE})`));
  if (sm && sm[1] in AR_SPELLED) return AR_SPELLED[sm[1]];

  return undefined;
}

export interface ResolvedLength {
  pages: number;            // clamped target
  sections: number;         // suggested section count
  wordsPerSection: number;  // per-section word budget
  maxOutputTokens: number;  // single-shot output ceiling (a hard runaway guard)
}

const WORDS_PER_PAGE = 340; // ~ one dense Arabic governance page

/** Turn a requested page count into a concrete, shared generation budget. */
export function resolveLengthTarget(pages: number): ResolvedLength {
  const p = Math.max(1, Math.min(120, Math.round(pages)));
  const sections = Math.max(3, Math.min(16, Math.round(p / 2) + 2));
  const wordsPerSection = Math.max(80, Math.round((p * WORDS_PER_PAGE) / sections));
  // Generous per page so we never truncate mid-document, yet far below the old
  // flat 32k ceiling that let a "10 pages" ask balloon to ~100.
  const maxOutputTokens = Math.max(3072, Math.min(32768, Math.round(p * 900 * 1.25)));
  return { pages: p, sections, wordsPerSection, maxOutputTokens };
}

/** The length steering text injected into the draft system prompt. A stated
 *  page count produces a STRICT target; otherwise the legacy density band is
 *  used for long-form requests (and nothing for short ones). Exported (P5/D3)
 *  so the web-research generation path (geminiService.generateGroundedDocument)
 *  reuses the SAME directive instead of having no length steering at all. */
export function buildLengthDirective(ar: boolean, longForm: boolean, target?: number): string {
  if (target && target > 0) {
    const { pages, sections, wordsPerSection } = resolveLengthTarget(target);
    return ar
      ? `التزام صارم بالطول: اجعل الوثيقة قريبة من ${pages} صفحة (هامش ±20% فقط). لا تتجاوز هذا الطول إطلاقاً ولا تُضِف أقساماً أو حشواً لإطالتها. وزّع المحتوى على نحو ${sections} أقسام بمعدل ~${wordsPerSection} كلمة لكل قسم، وامنح كل قسم عمقاً مناسباً لطوله دون تكرار أو إطناب. الجودة قبل الكمّ: وثيقة ${pages} صفحات دقيقة أفضل من وثيقة مطوّلة.`
      : `Strict length compliance: keep the document close to ${pages} page(s) (±20% only). Never exceed this length and do not add filler sections to pad it. Spread the content across ~${sections} sections at ~${wordsPerSection} words each, giving each section depth proportional to its budget with no repetition or padding. Quality over quantity: an accurate ${pages}-page document beats a longer one.`;
  }
  return longForm ? (ar ? LONG_AR : LONG_EN) : '';
}

/** Stream one assistant turn for the given stage, grounded in the model + files. */
export async function stageChat(p: StageChatParams, cb: StreamCallbacks): Promise<string> {
  const ar = (p.language || 'ar') === 'ar';
  const brief = STAGE_BRIEF[p.stage][ar ? 'ar' : 'en'];
  const modeBrief = MODE_BRIEF[p.mode || 'ask'][ar ? 'ar' : 'en'];
  const hasFiles = !!(p.fileContext && p.fileContext.trim());
  const snap = snapshotLine(p.stateSnapshot, ar);
  const hasDocs = (p.stateSnapshot?.documentsCount ?? 0) > 0;
  // V4: the requested length is a single source of truth — an explicit param
  // wins, else parse it from the user's message. A stated count is honored even
  // for short asks; only when none is found do we fall back to legacy density.
  const targetPages = (p.targetPages && p.targetPages > 0) ? p.targetPages : parseTargetPages(p.message);
  const sys = [
    ar
      ? 'أنت مساعد حوكمة ذكي وتفاعلي (Agentic). فكّر أولاً ثم تحاور. كن دقيقاً وعملياً. تنسيق Markdown عربي.'
      : 'You are an interactive (agentic) governance assistant. Reason first, then converse. Be precise and practical.',
    brief,
    modeBrief,
    ar ? CAPABILITY_AR : CAPABILITY_EN,
    ar ? FORMAT_AR : FORMAT_EN,
    buildLengthDirective(ar, !!p.longForm, targetPages),
    p.extraContext ? `سياق إضافي: ${p.extraContext}` : '',
    snap, // P0-2: authoritative live page state, before model/files
    '=== نموذج حوكمة الشركة (مصدر الحقيقة الحي) ===',
    modelSnapshot(p.model),
    hasFiles
      ? (ar
          ? `=== مقتطفات من الملفات المرفوعة (${p.fileCount ?? ''} ملف) — استند إليها أولاً ===\n${p.fileContext}\n\nمهم: اعتمد على محتوى الملفات أعلاه كمصدر أساسي. لا تخترع حقائق غير موجودة فيها أو في النموذج. عند الاقتباس أشِر لاسم المستند.`
          : `=== Excerpts from uploaded files (${p.fileCount ?? ''}) — ground answers here first ===\n${p.fileContext}\n\nIMPORTANT: rely on the file content above as the primary source. Do not invent facts absent from the files or model. Cite the document name when quoting.`)
      // No RAG excerpts. Distinguish "uploaded but un-indexed" from "nothing uploaded"
      // using the authoritative snapshot — never blanket-claim "no files".
      : hasDocs
        ? (ar
            ? `لم تُسترجَع مقتطفات نصية لهذا السؤال رغم وجود ${p.stateSnapshot?.documentsCount} وثيقة مرفوعة (${p.stateSnapshot?.chunkCount ?? 0} مقطع مفهرس). لا تقل «لا توجد ملفات». إن كانت المقاطع المفهرسة = 0 فالملفات مرفوعة لكن غير مفهرسة — اطلب تشغيل الفهرسة في مرحلة المصادر. وإلا فالسؤال خارج نطاق المقاطع المسترجعة.`
            : `No text excerpts retrieved for this query although ${p.stateSnapshot?.documentsCount} document(s) are uploaded (${p.stateSnapshot?.chunkCount ?? 0} indexed chunks). Do NOT say "no files". If indexed chunks = 0, files are uploaded but un-indexed — ask to run indexing in the Sources stage. Otherwise the query is outside the retrieved excerpts.`)
        : (ar
            ? 'لا توجد وثائق مرفوعة لهذا المشروع. اعتمد على النموذج، واطلب من المستخدم رفع الملفات المناسبة.'
            : 'No documents are uploaded for this project. Rely on the model; ask the user to upload the relevant files.'),
    ar
      ? 'إن كان السؤال يتطلب معلومة غير موجودة في الملفات أو النموذج، اسأل المستخدم صراحةً قبل المتابعة.'
      : 'If a question needs info absent from files and model, ask the user explicitly first.',
  ].filter(Boolean).join('\n');

  // Density control (not random). A stated page count drives a scoped ceiling
  // (the V4 runaway guard); otherwise keep the legacy behavior — base 16k, full
  // document requests get 32k — so vague/long asks are never truncated at the
  // old 8k floor (which caused "incomplete Word" exports).
  const maxOutputTokens = targetPages
    ? resolveLengthTarget(targetPages).maxOutputTokens
    : (p.longForm ? 32768 : 16384);
  return streamChat(
    {
      systemInstruction: sys, history: p.history, message: p.message, signal: p.signal,
      temperature: 0.5,
      maxOutputTokens,
    },
    cb,
  );
}

// ---------------------------------------------------------------------------
// V11 — inline "smart-edit" rewrite on a canvas selection.
//
// The document canvas (DocumentCanvas) shows a floating toolbar over any text
// selection with one-click AI actions. The text actions (shorten / lengthen /
// improve / rewrite) call here: a single, low-latency turn that transforms ONLY
// the selected passage and returns plain text meant to REPLACE that selection in
// place. (Delete + font-size are pure DOM edits handled in the canvas, no AI.)
// The result is persisted with the document via the existing canvas save path.
// ---------------------------------------------------------------------------

export type SmartEditAction = 'shorten' | 'lengthen' | 'improve' | 'rewrite';

const SMART_EDIT_BRIEF: Record<SmartEditAction, { ar: string; en: string }> = {
  shorten: {
    ar: 'اختصر النص التالي إلى نسخة أقصر وأكثر إيجازًا مع الحفاظ على المعنى الأساسي والمصطلحات المهمة.',
    en: 'Shorten the following text into a more concise version while preserving its core meaning and key terms.',
  },
  lengthen: {
    ar: 'وسّع النص التالي واجعله أطول قليلًا بإضافة تفصيل وإيضاح مناسبين، دون حشو أو تكرار أو اختراع حقائق غير موجودة.',
    en: 'Expand the following text to be somewhat longer with appropriate detail and clarification — no padding, no repetition, and never invent facts.',
  },
  improve: {
    ar: 'حسّن صياغة النص التالي ليصبح أوضح وأكثر احترافية ودقة لغويًا، مع الحفاظ على المعنى واللغة نفسها.',
    en: 'Improve the wording of the following text so it is clearer, more professional and linguistically precise, keeping the same meaning and language.',
  },
  rewrite: {
    ar: 'أعد صياغة النص التالي بأسلوب مختلف وأفضل، مع الحفاظ التام على المعنى والمحتوى والمصطلحات.',
    en: 'Rewrite the following text in a different, better style while fully preserving its meaning, content and terminology.',
  },
};

// Strip wrappers the model sometimes adds around a bare rewrite (code fences,
// a single pair of surrounding quotes) so the output drops cleanly in place.
function cleanRewrite(s: string): string {
  let out = (s || '').trim();
  out = out.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const pairs: [string, string][] = [['"', '"'], ['«', '»'], ['“', '”'], ['«', '»']];
  for (const [open, close] of pairs) {
    if (out.length > 1 && out.startsWith(open) && out.endsWith(close)) { out = out.slice(1, -1).trim(); break; }
  }
  return out;
}

export interface SmartEditParams {
  text: string;
  action: SmartEditAction;
  language?: Language;
  signal?: AbortSignal;
}

/** Transform a selected passage with a one-click AI action. Resolves to the
 *  plain-text replacement; throws when the model returns nothing usable so the
 *  caller leaves the selection untouched (never inserts an error string). */
export async function rewriteSelection(p: SmartEditParams): Promise<string> {
  const ar = (p.language || 'ar') === 'ar';
  const brief = SMART_EDIT_BRIEF[p.action][ar ? 'ar' : 'en'];
  const sys = [
    ar
      ? 'أنت محرّر وثائق حوكمة محترف. تُعدّل المقطع المحدّد فقط داخل وثيقة قائمة.'
      : 'You are a professional governance-document editor. You edit only the selected passage inside an existing document.',
    brief,
    ar
      ? 'أعِد المخرجات كنص عادي صرف يحل محل المقطع المحدّد مباشرة: باللغة نفسها، دون أي مقدمات أو شروح أو علامات اقتباس أو رموز Markdown أو عناوين. حافظ على النبرة الرسمية للوثيقة.'
      : 'Return plain text only, meant to directly replace the selected passage: same language, with no preamble, explanation, quotes, Markdown markers or headings. Keep the document’s formal tone.',
  ].join('\n');

  const answer = await streamChat({
    systemInstruction: sys,
    history: [],
    message: p.text,
    signal: p.signal,
    temperature: p.action === 'rewrite' ? 0.6 : 0.4,
    maxOutputTokens: 2048,
    thinkingLevel: ThinkingLevel.LOW,
  });
  const out = cleanRewrite(answer);
  // streamChat returns a fixed Arabic fallback string when the model produced no
  // content — never drop that (or an empty result) into the user's document.
  if (!out || out.includes('تعذّر توليد رد')) throw new Error('REWRITE_EMPTY');
  return out;
}

// ===========================================================================
// V5 + V16 — the conversational build wizard.
//
// The copilot used to jump straight from a build/long-doc request into a 7–8 min
// autonomous generation with nothing the user could review or edit (V5: "it
// didn't ask me a single question … there should always be an option, don't
// leave anything fixed — I can change page count, change axes"). V16 wants the
// SAME flow to be conversational: it asks which departments/scope, lets the user
// add/remove departments, takes notes, and only then builds.
//
// This module is the PURE half of that wizard — no React, no I/O beyond a single
// optional model call. A `BuildPlan` is the editable contract: the copilot
// proposes one, the user tweaks it in the UI (page count, axes, departments,
// components, notes), and `planToBuildRequest` serializes the CONFIRMED plan into
// the request string that actually drives generation. Everything here is unit
// tested so the wizard's behavior is pinned independently of the UI.
// ===========================================================================

/** One proposed section/component of the build. The user can toggle it out. */
export interface BuildPlanComponent {
  id: string;
  title: string;
  include: boolean;
}

/** The editable build plan the copilot proposes and the user confirms (V5/V16). */
export interface BuildPlan {
  title: string;                    // proposed document/build title
  targetPages: number;              // editable target length (pages) — drives V4 budget
  axes: string[];                   // governance axes to cover (add/remove)
  departments: string[];           // departments/units to build for (add/remove) — V16
  components: BuildPlanComponent[]; // proposed structure/outline (toggle on/off)
  notes: string;                    // free-text notes injected into every section
  audience: string;                 // who the output is for (editable)
}

// Default governance axes — mirrors GovernanceCenter's DIAG_AXES so a plan made
// without a model still proposes a sensible, fully-editable axis set.
export const DEFAULT_GOV_AXES = [
  'القيادة والحوكمة',
  'الاستراتيجية والتخطيط',
  'الهيكل التنظيمي والأدوار',
  'السياسات واللوائح',
  'الإجراءات والعمليات',
  'الموارد البشرية والكفاءات',
  'إدارة المخاطر والامتثال',
  'الأداء والمؤشرات',
];

// The default components/structure of a governance document, used as the fallback
// outline when no model call is made (or it fails). Kept deliberately generic so
// the user shapes it via toggles.
const DEFAULT_COMPONENTS_AR = [
  'ملخص تنفيذي',
  'النطاق والأهداف',
  'الواقع الراهن',
  'الهيكل التنظيمي',
  'السياسات',
  'الإجراءات',
  'الأدوار والمسؤوليات (RACI)',
  'مؤشرات الأداء',
  'المخاطر والامتثال',
  'خارطة التنفيذ',
];
const DEFAULT_COMPONENTS_EN = [
  'Executive summary',
  'Scope & objectives',
  'Current state',
  'Organizational structure',
  'Policies',
  'Procedures',
  'Roles & responsibilities (RACI)',
  'KPIs',
  'Risk & compliance',
  'Implementation roadmap',
];

// Explicit "build now" commands that should ALSO open the wizard even when the
// generic long-form heuristic (LONG_RE in GovCopilot) doesn't fire — the owner's
// exact phrasings ("ابنِ الهيكل التنظيمي", "ابدأ البناء", "ولّد الكل").
const EXPLICIT_BUILD_RE =
  /(ابنِ|ابن\s|ابني|ابدأ\s*البناء|ابدا\s*البناء|ولّد\s*الكل|ولد\s*الكل|نبني|build\s+(it|all|the|me)|generate\s+all|start\s+building)/i;

// P5/D4b — «الهيكل التنظيمي» ("the org structure") used to be a BARE alternative
// in EXPLICIT_BUILD_RE, so a pure QUESTION about the structure ("ما رأيك في
// الهيكل التنظيمي الحالي؟") was hijacked straight into the build-plan card,
// contradicting V27 (conversation first). It now only counts as an explicit
// build command when it co-occurs with an actual construction verb in the same
// message — never as a bare noun.
const STRUCTURE_NOUN_RE = /الهيكل\s*التنظيمي/i;
const STRUCTURE_BUILD_VERB_RE = /(ابنِ|ابن|ابني|اعمل|إعمل|أنشئ|انشئ|أنشِئ|صمّم|صمم|جهّز|جهز|design|build|create)/i;

/** True when the message is an explicit "build" command (a wizard trigger that
 *  complements the generic long-form detector). */
export function isExplicitBuild(text?: string | null): boolean {
  const s = (text || '').trim();
  if (s.length < 3) return false;
  if (EXPLICIT_BUILD_RE.test(s)) return true;
  // "build the org structure" (any construction verb) counts; a bare mention of
  // the org structure — e.g. inside a question — does not.
  return STRUCTURE_NOUN_RE.test(s) && STRUCTURE_BUILD_VERB_RE.test(s);
}

// P5/D4a — a genuine document-CREATION command: a creation verb co-occurring
// with a document-type noun, and not phrased as a question. Distinguishes "اكتب
// لي دليل حوكمة كامل" (must open the plan card even with the wizard OFF — V5's
// exact complaint: a silent 7-8 min autonomous draft with zero chance to adjust
// scope) from a long QUESTION/analysis ask that merely mentions a document type
// ("ما رأيك في هذه السياسة؟"), which must stay conversational (V27).
const CREATION_VERB_RE =
  /(اكتب|أكتب|اكتبلي|انشئ|أنشئ|أنشِئ|جهّز|جهز|صمّم|صمم|أعدّ|اعدّ|اعد|حرّر|حرر|صِغ|صغ|write|create|draft|generate|prepare|design)/i;
const DOC_NOUN_RE =
  /(دليل|سياسة|لائحة|إجراء|اجراء|عملية|وثيقة|مستند|تقرير|خطة|خطّة|عقد|اتفاقية|محضر|خطاب|ميثاق|مصفوفة|قالب|استمارة|نموذج|مذكرة|استراتيج|manual|policy|regulation|procedure|report|plan|contract|agreement|document|template|charter|proposal|strategy)/i;
// Any question mark, or an interrogative opener, rules a message out — a real
// creation command is an imperative, not a question.
const QUESTION_LIKE_RE =
  /[؟?]|^\s*(ما\s|ماذا\s|هل\s|كيف\s|لماذا\s|متى\s|أين\s|من\s+هو|what\s|how\s|why\s|when\s|where\s|is\s|are\s|do\s|does\s)/i;

/** True for a genuine document-creation COMMAND (P5/D4a) — used to carve a
 *  narrow, deliberate exception into V27's "conversation first" default. */
export function isDocCreationRequest(text?: string | null): boolean {
  const s = (text || '').trim();
  if (!s || QUESTION_LIKE_RE.test(s)) return false;
  return CREATION_VERB_RE.test(s) && DOC_NOUN_RE.test(s);
}

// P5/D3 — does this document-creation request need CURRENT/EXTERNAL facts (→
// live web research via Google Search grounding) rather than only the user's
// uploaded files? GovCopilot.runGeneration gates the (slower, previously
// length-unbounded — see geminiService.generateGroundedDocument) web-research
// path on this. Recency + market/competitive-data signals ONLY. Deliberately
// EXCLUDES generic scope/quality adjectives that used to be in this list —
// «دولي/عالمي/معايير دولية/أفضل الممارسات» and their English equivalents
// «international/global/best practices/state of the art». Those describe the
// TONE of an entirely ordinary document request («اكتب دليل حوكمة وفق أفضل
// الممارسات الدولية») without implying the model needs to fetch live web pages;
// a mere Arabic word-boundary fix would NOT have been enough to stop that
// hijack, because «أفضل الممارسات» matched as its own, full, intended word —
// not a substring accident like «دولي» inside «الدولية». Removing the
// over-broad terms fixes both mechanisms at once.
const NEEDS_RESEARCH_RE =
  /(ابحث|بحث|الويب|الإنترنت|أحدث|الأحدث|حديثة|حديث|٢٠٢٥|٢٠٢٦|٢٠٢٧|2025|2026|2027|السوق|سوق|مقارنة|قارن|منافس|اتجاهات|إحصاء|إحصائيات|research|web|internet|online|latest|recent|current|today|news|market|benchmark|compare|competitor|trend|statistics)/i;

export function needsWebResearch(text?: string | null): boolean {
  return NEEDS_RESEARCH_RE.test((text || '').trim());
}

/**
 * V27 — should this message open the build-wizard (propose an editable plan)
 * versus flow straight into a normal grounded conversation?
 *
 * The copilot is now CONVERSATIONAL BY DEFAULT: the wizard is OPT-IN, not the
 * forced entry. Two regimes:
 *  • Conversational mode (`wizardOn` = false, the default): only a CLEAR,
 *    explicit build command (`isExplicitBuild`) opens the wizard. Every other
 *    message — including a long-doc ask like "اكتب سياسة كاملة" — flows to the
 *    normal ask/draft path and gets a real grounded answer, never a forced plan.
 *  • Wizard mode (`wizardOn` = true): the user opted into "ask before
 *    generating", so any long-form/document request (`longForm`) OR an explicit
 *    build opens the plan — the V5/V16 behavior, unchanged.
 *
 * P5/D4a refines the conversational-default regime with ONE narrow exception: a
 * genuine long document-CREATION command (`isDocCreationRequest`) still opens
 * the plan even with the wizard off — V5's exact complaint was a doc-creation
 * ask silently firing a 7-8 min autonomous draft with zero chance to adjust
 * scope/length/departments, and the plan card is cheap to confirm or skip. A
 * long QUESTION or analysis ask that merely mentions a document type is
 * excluded by `isDocCreationRequest` and stays fully conversational.
 *
 * Pure + tested so the default-entry behavior is pinned independently of the UI.
 */
export function shouldOpenBuildWizard(p: { wizardOn: boolean; text: string; longForm: boolean }): boolean {
  const explicit = isExplicitBuild(p.text);
  if (p.wizardOn) return p.longForm || explicit;
  return explicit || (p.longForm && isDocCreationRequest(p.text));
}

let _planSeq = 0;
const planUid = (): string => `cmp_${(_planSeq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Trim + de-duplicate a free list (axes / departments), preserving first-seen
// order and dropping blanks. Comparison is case/space-insensitive so "المالية"
// and "المالية " never both land in the list.
const normItem = (s: string): string => (s || '').trim().replace(/\s+/g, ' ');
// Exported (P5/D2) so copilotClient's grounding builder can derive a
// departments-from-org-units fallback with the SAME trim/dedupe rules as the
// wizard's own plan (fallbackBuildPlan), instead of re-implementing them.
export function dedupeList(items: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = normItem(raw || '');
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Add a value to a plan list (axes/departments), idempotent + trimmed. */
export function addPlanItem(list: string[], value: string): string[] {
  return dedupeList([...(list || []), value]);
}

/** Remove a value from a plan list (case/space-insensitive). */
export function removePlanItem(list: string[], value: string): string[] {
  const key = normItem(value).toLowerCase();
  return (list || []).filter(v => normItem(v).toLowerCase() !== key);
}

/** Toggle a component's `include` flag, returning a new array. */
export function toggleComponent(components: BuildPlanComponent[], id: string): BuildPlanComponent[] {
  return (components || []).map(c => (c.id === id ? { ...c, include: !c.include } : c));
}

/** Clamp an edited page count into the supported 1–120 range (shared with V4). */
export function clampPlanPages(pages: number): number {
  if (!Number.isFinite(pages)) return 1;
  return Math.max(1, Math.min(120, Math.round(pages)));
}

// Pull a sensible default title out of a free-text request (strip the leading
// build verb), falling back to a generic governance-document title.
function deriveTitle(request: string, ar: boolean): string {
  const stripped = (request || '')
    .trim()
    .replace(/^\s*(?:من فضلك|لو سمحت|please)\s*/i, '')
    .replace(/^\s*(?:اكتب|اكتبلي|صغ|صياغة|أنشئ|انشئ|جهّز|جهز|أعدّ|اعد|صمّم|صمم|ابنِ|ابن|ابني|ولّد|ولد|نبني|write|generate|create|draft|design|prepare|build)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = stripped.slice(0, 90).trim();
  if (cut) return cut;
  return ar ? 'وثيقة الحوكمة' : 'Governance document';
}

/**
 * Build a complete, sensible plan WITHOUT any model call — from the request text
 * and (optionally) the live governance model. Pure + deterministic, so it is the
 * safe fallback whenever the AI proposal fails or is skipped, and it is unit
 * tested directly. Departments seed from `model.orgUnits` (the owner's "اختر من
 * دول أو أضِف"); axes/components seed from the defaults; the page target honors a
 * count stated in the request (V4), else a modest default.
 */
export function fallbackBuildPlan(p: {
  request: string;
  model?: CompanyGovernanceModel | null;
  language?: Language;
}): BuildPlan {
  const ar = (p.language || 'ar') === 'ar';
  const stated = parseTargetPages(p.request);
  const unitNames = Array.isArray(p.model?.orgUnits)
    ? p.model!.orgUnits.map(u => u?.name).filter((n): n is string => !!n && !!n.trim())
    : [];
  const compNames = ar ? DEFAULT_COMPONENTS_AR : DEFAULT_COMPONENTS_EN;
  return {
    title: deriveTitle(p.request, ar),
    targetPages: clampPlanPages(stated ?? 12),
    axes: [...DEFAULT_GOV_AXES],
    departments: dedupeList(unitNames),
    components: compNames.map(title => ({ id: planUid(), title, include: true })),
    notes: '',
    audience: ar ? 'مجلس الإدارة والإدارة التنفيذية' : 'Board & executive management',
  };
}

// JSON shape the model returns for an AI-proposed plan. Kept loose; we sanitize
// every field before it becomes a BuildPlan, so a malformed proposal can never
// corrupt the wizard state.
interface RawPlanProposal {
  title?: string;
  targetPages?: number;
  axes?: string[];
  departments?: string[];
  components?: string[];
  audience?: string;
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    targetPages: { type: 'integer' },
    axes: { type: 'array', items: { type: 'string' } },
    departments: { type: 'array', items: { type: 'string' } },
    components: { type: 'array', items: { type: 'string' } },
    audience: { type: 'string' },
  },
  required: ['title', 'targetPages', 'axes', 'components'],
} as const;

// Merge a raw AI proposal onto the deterministic fallback so the result is ALWAYS
// a complete, valid BuildPlan (every list deduped/trimmed, page count clamped,
// components carried as toggleable items). Pure + tested.
export function mergeProposalIntoFallback(fallback: BuildPlan, raw: RawPlanProposal | null | undefined): BuildPlan {
  if (!raw || typeof raw !== 'object') return fallback;
  const title = normItem(raw.title || '') || fallback.title;
  const targetPages = raw.targetPages ? clampPlanPages(raw.targetPages) : fallback.targetPages;
  const axes = dedupeList(Array.isArray(raw.axes) && raw.axes.length ? raw.axes : fallback.axes);
  // Departments: keep the model's units as the spine, fold in anything the AI
  // suggested — the user prunes/edits afterwards.
  const departments = dedupeList([...(fallback.departments || []), ...(Array.isArray(raw.departments) ? raw.departments : [])]);
  const compTitles = dedupeList(Array.isArray(raw.components) && raw.components.length ? raw.components : fallback.components.map(c => c.title));
  const components: BuildPlanComponent[] = compTitles.map(title => ({ id: planUid(), title, include: true }));
  const audience = normItem(raw.audience || '') || fallback.audience;
  return { ...fallback, title, targetPages, axes, departments, components, audience };
}

export interface ProposePlanParams {
  request: string;
  model?: CompanyGovernanceModel | null;
  language?: Language;
  fileContext?: string;   // RAG excerpts so the proposal is grounded in real files
  signal?: AbortSignal;
}

/**
 * Propose an editable build plan for a request (V5). Tries a single low-latency
 * structured model call, then merges it onto the deterministic fallback so the
 * caller ALWAYS receives a complete, valid plan — the wizard never hard-fails or
 * blocks on the network. The returned plan is fully editable; nothing is fixed.
 */
export async function proposeBuildPlan(p: ProposePlanParams): Promise<BuildPlan> {
  const ar = (p.language || 'ar') === 'ar';
  const fallback = fallbackBuildPlan({ request: p.request, model: p.model, language: p.language });
  try {
    const sys = ar
      ? 'أنت مساعد حوكمة. اقترح خطة بناء قابلة للتعديل بالكامل قبل التوليد (لا تكتب الوثيقة نفسها). أعِد JSON فقط: عنوان مقترح، عدد صفحات مستهدف واقعي يناسب حجم المنشأة، محاور الحوكمة، الإدارات المعنية، قائمة الأقسام/المكوّنات، والجمهور. كن موجزاً ودقيقاً واستند للنموذج والملفات إن وُجدت.'
      : 'You are a governance assistant. Propose a fully-editable BUILD PLAN before any generation (do NOT write the document itself). Return JSON only: a proposed title, a realistic target page count suited to the org size, governance axes, relevant departments, a list of sections/components, and the audience. Be concise and ground it in the model/files when present.';
    const ctxParts = [
      `الطلب: ${p.request}`,
      '=== النموذج ===',
      modelSnapshot(p.model),
      p.fileContext && p.fileContext.trim()
        ? `=== مقتطفات من الملفات ===\n${p.fileContext.slice(0, 4000)}`
        : '',
    ].filter(Boolean).join('\n');
    const raw = await generateJson<RawPlanProposal>(ctxParts, PLAN_SCHEMA as any, {
      systemInstruction: sys,
      signal: p.signal,
      temperature: 0.3,
      maxOutputTokens: 2048,
      thinkingLevel: ThinkingLevel.LOW,
      retries: 1,
    });
    return mergeProposalIntoFallback(fallback, raw);
  } catch {
    // Network/parse/abort → the deterministic plan still lets the user build.
    return fallback;
  }
}

/**
 * Serialize a CONFIRMED (possibly user-edited) plan into the request string that
 * drives generation (V5 acceptance: "confirmed config is what actually drives
 * generation"). Pure + tested: only included components are listed, lists are
 * cleaned, and the notes/axes/departments become explicit directives the
 * generator must follow. The stated page count is embedded so parseTargetPages
 * (and the backend's target_pages derivation) honor the SAME length (V4).
 */
export function planToBuildRequest(plan: BuildPlan, language?: Language): string {
  const ar = (language || 'ar') === 'ar';
  const pages = clampPlanPages(plan.targetPages);
  const comps = (plan.components || []).filter(c => c.include && c.title.trim()).map(c => c.title.trim());
  const axes = dedupeList(plan.axes);
  const depts = dedupeList(plan.departments);
  const notes = (plan.notes || '').trim();
  const title = (plan.title || '').trim() || (ar ? 'وثيقة الحوكمة' : 'Governance document');
  const lines: string[] = [];
  if (ar) {
    lines.push(`اكتب وثيقة حوكمة كاملة بعنوان: «${title}».`);
    lines.push(`الطول المستهدف: ${pages} صفحة تقريباً (التزم به).`);
    if (plan.audience?.trim()) lines.push(`الجمهور المستهدف: ${plan.audience.trim()}.`);
    if (axes.length) lines.push(`المحاور الحوكمية المطلوب تغطيتها: ${axes.join('، ')}.`);
    if (depts.length) lines.push(`الإدارات/الوحدات المشمولة (اربط الإجراءات والسياسات بها بالاسم): ${depts.join('، ')}.`);
    if (comps.length) lines.push(`الأقسام/المكوّنات المطلوبة بالترتيب (التزم بها ولا تُضِف أقساماً خارجها): ${comps.join('، ')}.`);
    if (notes) lines.push(`ملاحظات وتوجيهات إلزامية من المالك (طبّقها في كل قسم): ${notes}`);
  } else {
    lines.push(`Write a complete governance document titled: "${title}".`);
    lines.push(`Target length: about ${pages} page(s) — keep to it.`);
    if (plan.audience?.trim()) lines.push(`Intended audience: ${plan.audience.trim()}.`);
    if (axes.length) lines.push(`Governance axes to cover: ${axes.join(', ')}.`);
    if (depts.length) lines.push(`Departments/units in scope (name them in procedures & policies): ${depts.join(', ')}.`);
    if (comps.length) lines.push(`Required sections/components, in order (keep to these, add nothing outside them): ${comps.join(', ')}.`);
    if (notes) lines.push(`Mandatory owner notes (apply to every section): ${notes}`);
  }
  return lines.join('\n');
}

// ===========================================================================
// P5/D1 — the structured plan payload sent to the backend's `plan` field.
//
// The confirmed wizard plan used to reach the backend ONLY serialized into
// prose (planToBuildRequest above), which the backend used to discard once a
// deliverable keyword matched. The backend now also accepts the plan as a
// STRUCTURED object that bypasses its own keyword-based deliverable routing
// entirely (see copilot/hawkama_copilot/api.py `_plan_from_body` /
// generation.py `_draft_from_plan`). This maps the CONFIRMED BuildPlan onto
// that exact shape. Pure + tested; the prose request stays as accompanying
// fallback context (see copilotClient.draft/draftStream), and this is what
// GovCopilot.acceptPlan() sends alongside it.
// ===========================================================================

export interface CopilotPlanPayload {
  title: string;
  pages: number;
  axes: string[];
  departments: string[];
  components: string[];
  notes: string;
}

/** Map a CONFIRMED (possibly user-edited) plan onto the backend's `plan` shape
 *  — the same field/derivation rules as planToBuildRequest (only INCLUDED
 *  components, deduped axes/departments, trimmed notes), so the structured
 *  payload and the prose fallback never disagree. */
export function planToPayload(plan: BuildPlan): CopilotPlanPayload {
  return {
    title: (plan.title || '').trim(),
    pages: clampPlanPages(plan.targetPages),
    axes: dedupeList(plan.axes),
    departments: dedupeList(plan.departments),
    components: (plan.components || []).filter(c => c.include && c.title.trim()).map(c => c.title.trim()),
    notes: (plan.notes || '').trim(),
  };
}

// ===========================================================================
// P5/D2 — a bounded "current-state diagnostic" digest for the backend's
// GroundingContext.current_state_md.
//
// GovCopilot already receives the live `model` prop, which carries the
// maturity assessment (CMMI + SWOT/PESTEL + BSC) and the open gap list — the
// app's actual current-state diagnostic — so this needs nothing from
// GovernanceCenter.tsx. It is deliberately DISTINCT from org_units/roles (sent
// as their own grounding keys, see copilotClient.buildGrounding): this is the
// diagnostic VERDICT, not a re-dump of the org chart, and it is character-
// bounded so a large gap list can never blow up the request payload.
// ===========================================================================

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Build a bounded current-state digest from the live model's maturity
 *  assessment + open gaps. Returns '' when the model has neither (never
 *  invents a diagnosis the app hasn't actually produced). */
export function currentStateDigest(m?: CompanyGovernanceModel | null, language?: Language): string {
  if (!m) return '';
  const ar = (language || 'ar') === 'ar';
  const parts: string[] = [];
  const a = m.assessment;
  if (a) {
    const overall = typeof a.overall === 'number' ? Math.round(a.overall) : undefined;
    if (overall !== undefined) {
      parts.push(ar
        ? `النضج العام: ${overall}/100${a.cmmiLevel ? ` (CMMI ${a.cmmiLevel})` : ''}`
        : `Overall maturity: ${overall}/100${a.cmmiLevel ? ` (CMMI ${a.cmmiLevel})` : ''}`);
    }
    const dims = (a.dimensions || [])
      .slice(0, 10)
      .map(d => `${d.name}: ${Math.round(d.score)} (${d.label})`);
    if (dims.length) parts.push((ar ? 'الأبعاد: ' : 'Dimensions: ') + dims.join(ar ? '، ' : ', '));
  }
  const gaps = (Array.isArray(m.gaps) ? m.gaps : []).filter(g => !g?.resolved);
  if (gaps.length) {
    const bySev = (sev: string) => gaps.filter(g => g.severity === sev).length;
    parts.push(ar
      ? `الفجوات المفتوحة (${gaps.length}): حرجة ${bySev('critical')}، عالية ${bySev('high')}، متوسطة ${bySev('medium')}، منخفضة ${bySev('low')}.`
      : `Open gaps (${gaps.length}): critical ${bySev('critical')}, high ${bySev('high')}, medium ${bySev('medium')}, low ${bySev('low')}.`);
    const top = gaps
      .slice()
      .sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0))
      .slice(0, 8)
      .map(g => `- [${g.severity}] ${g.area}: ${g.description}`.slice(0, 200));
    if (top.length) parts.push(top.join('\n'));
  }
  return parts.filter(Boolean).join('\n').slice(0, 3000);
}
