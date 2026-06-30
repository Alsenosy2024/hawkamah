// Per-stage agentic assistant for the Governance Center.
// Reasons first (visible thinking via streamChat), then converses — asking the
// user clarifying questions and giving guidance specific to the current stage,
// always grounded in the live CompanyGovernanceModel (single source of truth).

import { streamChat, type ChatTurn, type StreamCallbacks } from './agentOrchestrator';
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
    ar: 'المرحلة: توليد الوثائق. ساعد المستخدم على تحديد نطاق التوليد (سياسات كاملة، إجراءات كاملة، إدارات بالكامل) والهدف والجمهور قبل التشغيل.',
    en: 'Stage: Document generation. Help define generation scope (full policies/procedures/departments), goal and audience.',
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
 *  used for long-form requests (and nothing for short ones). */
function buildLengthDirective(ar: boolean, longForm: boolean, target?: number): string {
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
