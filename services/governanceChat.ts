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

const LONG_AR =
  'عندما يطلب المستخدم صياغة كاملة (استراتيجية / سياسة / لائحة / دليل): أعطِ إجابة طويلة دقيقة ومكتملة الأقسام (مقدمة، نطاق، تعريفات، بنود تفصيلية مرقّمة، أدوار ومسؤوليات بجدول، مؤشرات أداء، ملاحق) — لا تختصر. ضبط الدسامة حسب الحجم: وثيقة بسيطة ≈ 8–12 صفحة، متوسطة ≈ 15–20، شاملة ≈ 25–30 صفحة. وزّع الأقسام والجداول لتعكس هذا الحجم.';
const LONG_EN =
  'When the user asks for a full draft (strategy/policy/regulation/manual): produce a long, accurate, fully-sectioned answer (purpose, scope, definitions, numbered detailed clauses, roles & responsibilities table, KPIs, annexes) — do not truncate. Calibrate density to scope: simple ≈ 8–12 pages, medium ≈ 15–20, comprehensive ≈ 25–30 pages. Distribute sections and tables to match.';

/** Stream one assistant turn for the given stage, grounded in the model + files. */
export async function stageChat(p: StageChatParams, cb: StreamCallbacks): Promise<string> {
  const ar = (p.language || 'ar') === 'ar';
  const brief = STAGE_BRIEF[p.stage][ar ? 'ar' : 'en'];
  const modeBrief = MODE_BRIEF[p.mode || 'ask'][ar ? 'ar' : 'en'];
  const hasFiles = !!(p.fileContext && p.fileContext.trim());
  const snap = snapshotLine(p.stateSnapshot, ar);
  const hasDocs = (p.stateSnapshot?.documentsCount ?? 0) > 0;
  const sys = [
    ar
      ? 'أنت مساعد حوكمة ذكي وتفاعلي (Agentic). فكّر أولاً ثم تحاور. كن دقيقاً وعملياً. تنسيق Markdown عربي.'
      : 'You are an interactive (agentic) governance assistant. Reason first, then converse. Be precise and practical.',
    brief,
    modeBrief,
    ar ? CAPABILITY_AR : CAPABILITY_EN,
    ar ? FORMAT_AR : FORMAT_EN,
    p.longForm ? (ar ? LONG_AR : LONG_EN) : '',
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

  // Density control (not random): a full-document request lifts the output ceiling
  // so a 10–30 page draft is not silently truncated at the default 8k tokens.
  return streamChat(
    {
      systemInstruction: sys, history: p.history, message: p.message, signal: p.signal,
      temperature: 0.5,
      // Copilot is document-grade: never cap a draft at the old 8k floor (caused
      // "incomplete Word" exports). Base 16k; full-document requests get 32k.
      maxOutputTokens: p.longForm ? 32768 : 16384,
    },
    cb,
  );
}
