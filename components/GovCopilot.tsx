import React, { useEffect, useRef, useState } from 'react';
import type { CompanyGovernanceModel, DocChunk, Language, ThinkingStep } from '../types';
import { stageChat, type GovStageKey, type GovCopilotMode, type GovStateSnapshot } from '../services/governanceChat';
import type { ChatTurn } from '../services/agentOrchestrator';
import { loadChunks, retrieve } from '../services/governanceService';
import { exportMessageDocx, exportMessageXlsx, exportMessagePdfDirect, exportMessageHtml, exportWorkflowManual, exportJobDescriptions, exportPoliciesManual } from '../services/exportService';
import { exportMessagePptx } from '../services/pptxExport';
import { copilotEnabled, askStream as copilotAsk, draft as copilotDraft, exportDoc as copilotExport, stats as copilotStats, ingestFiles as copilotIngest } from '../services/copilotClient';
import ThinkingTrace from './ThinkingTrace';
import Markdown, { type CiteRef } from './Markdown';

// Build ordered citation refs from the backend's labeled source list. The
// Python copilot labels each evidence item "مصدر N" (1-indexed); we map that
// number → {doc, heading} so inline [مصدر N] markers become clickable.
const toCiteRefs = (ss: { label?: string; doc?: string; heading?: string }[]): CiteRef[] =>
  (ss || [])
    .map((s, i) => ({
      num: parseInt((s.label || '').replace(/[^\d]/g, ''), 10) || (i + 1),
      doc: s.doc || '',
      heading: s.heading || undefined,
    }))
    .filter(r => r.doc);

// ===========================================================================
//  GovCopilot — ONE persistent governance copilot for the whole Governance
//  Center. Stage-aware (knows the active stage + the live model), bound to the
//  tenant's uploaded files (RAG retrieval per question), renders rich Markdown,
//  expands to full-screen, and turns any answer into a real file
//  (Word / Excel / PDF / PowerPoint). Three modes:
//    • ask    → grounded Q&A / long-form drafting via stageChat (+files)
//    • edit   → propose structured model edits (parent applies, snapshotted)
//    • reason → run the composite reasoning agent (parent owns the engine)
// ===========================================================================

interface Msg {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  thoughts: ThinkingStep[];
  thinking: boolean;
  streaming: boolean;
  sources?: string[];   // doc names grounded this answer (deduped, for the footer)
  srcRefs?: CiteRef[];  // ordered [مصدر N] → {doc, heading} for inline citations
}

export interface ProposedActionLite {
  type: string;
  title?: string;
  name?: string;
  decision?: string;
  rationale?: string;
}

export interface AgentStepLite {
  index: number;
  toolCall: { tool: string };
  status: string;
  thought?: string;
  observation?: string;
  durationMs?: number;
}

interface Props {
  stageKey: GovStageKey;
  stageLabel: string;
  model?: CompanyGovernanceModel | null;
  language?: Language;
  extraContext?: string;
  logoUrl?: string;           // company logo (base64) → branded PPTX/DOCX exports
  tenantId?: string;          // binds the copilot to this tenant's uploaded files
  seedChunks?: DocChunk[];    // dev/test injection — bypass Firestore loadChunks
  stateSnapshot?: GovStateSnapshot; // P0-2: live page state — copilot never contradicts it
  onOpenSource?: (docName: string) => void; // clicking a citation collapses the copilot and jumps to that resource

  // edit mode (parent owns the engine + state)
  actionInput: string;
  setActionInput: (v: string) => void;
  onPropose: () => void;
  proposing: boolean;
  proposedActions: any[];
  onApplyActions: () => void;
  onDiscardActions: () => void;
  applyBusy: boolean;

  // reason mode
  agentInput: string;
  setAgentInput: (v: string) => void;
  onRunAgent: () => void;
  agentRunning: boolean;
  agentSteps: any[];
  agentAnswer: string;
  agentTrace?: string;          // full run trace (markdown) — exportable audit trail
  agentAutoApply: boolean;
  setAgentAutoApply: (v: boolean) => void;
}

let _mid = 0;
const nid = () => `gc_${_mid++}`;

// ── Gemini-style spark (single 4-point sparkle, teal→blue brand gradient) ──
const GeminiSpark: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="gcSparkGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#11a8bc" />
        <stop offset="55%" stopColor="#1e6fa8" />
        <stop offset="100%" stopColor="#0b8090" />
      </linearGradient>
    </defs>
    <path fill="url(#gcSparkGrad)" d="M12 2c.8 5.5 4.5 9.2 10 10-5.5.8-9.2 4.5-10 10-.8-5.5-4.5-9.2-10-10 5.5-.8 9.2-4.5 10-10z" />
  </svg>
);

// Crisp stroke icons (replace the old unicode glyphs)
const IconSend: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
const IconStop: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
);
const IconExpand: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
);
const IconRestore: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 9h3a2 2 0 0 0 2-2V4M20 9h-3a2 2 0 0 1-2-2V4M4 15h3a2 2 0 0 1 2 2v3M20 15h-3a2 2 0 0 0-2 2v3" /></svg>
);
const IconClose: React.FC = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
);
const IconAttach: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
);

// Gemini "thinking" placeholder — breathing spark + shimmering skeleton bars.
const GcThinking: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-3 py-1">
    <GeminiSpark className="w-5 h-5 shrink-0 gc-spark-breathe" />
    <div className="flex-1 min-w-0 space-y-1.5 max-w-[230px]">
      <div className="gc-shimmer h-2.5 w-full" />
      <div className="gc-shimmer h-2.5 w-4/5" />
      <div className="gc-shimmer h-2.5 w-3/5" />
    </div>
    <span className="sr-only">{label}</span>
  </div>
);

// Heuristic: does the user want a long, document-grade draft?
const LONG_RE = /(كامل|كاملة|مفصّل|مفصل|تفصيل|استراتيج|سياسة|لائحة|دليل|إجراء|اجراء|عملية|عمليات|صياغة|اكتب|أكتب|حرّر|حرر|وثيق|كمّل|كمل|أكمل|اكمل|استمر|تابع|واصل|أطول|full|complete|draft|strategy|policy|regulation|manual|procedure|process|write|detailed|continue|expand|longer)/i;

// Output-formatting directive sent to the model (not shown in the UI bubble):
// any diagram must be a real Mermaid code block — never ASCII art — and tabular
// data must be Markdown tables. The front-end renders both as styled visuals.
const FORMAT_HINT =
  '\n\n[تعليمات التنسيق — لا تذكرها في الرد: إذا تطلّب الجواب رسمًا بيانيًا أو هيكلاً تنظيميًا أو مخطط تدفّق أو علاقات، فأخرِجه حصراً ككتلة ```mermaid``` بصياغة Mermaid صحيحة (graph TD / flowchart). لا ترسم المخططات بالحروف أو ASCII أبداً. قدّم البيانات الجدولية كجداول Markdown.]';

const GovCopilot: React.FC<Props> = (props) => {
  const { stageKey, stageLabel, model, language, extraContext, logoUrl, tenantId, seedChunks, stateSnapshot, onOpenSource } = props;
  const ar = (language || 'ar') === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);   // play exit animation before unmount
  const [full, setFull] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const [mode, setMode] = useState<GovCopilotMode>('ask');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [manualMenu, setManualMenu] = useState(false);
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chunksRef = useRef<DocChunk[] | null>(null);
  // Ask-mode image attachments (multimodal RAG via gemini-embedding-2). Kept
  // LOCAL to the copilot (no new parent props) so it never touches the parent.
  const [attachments, setAttachments] = useState<{ file: File; url: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Memoizes the one-time sync of this tenant's docs into the Python copilot
  // corpus (see ensureCorpus). Reset when the tenant changes.
  const corpusReadyRef = useRef<Promise<void> | null>(null);

  // Invalidate cached chunks when tenant changes (BUG-15 fix).
  useEffect(() => { chunksRef.current = null; corpusReadyRef.current = null; }, [tenantId]);

  // Lazily load the tenant's chunks once the panel opens (RAG corpus).
  useEffect(() => {
    if (!open || chunksRef.current) return;
    if (seedChunks && seedChunks.length) { chunksRef.current = seedChunks; return; }  // dev/test injection
    if (!tenantId) return;
    let alive = true;
    loadChunks(tenantId).then(cs => { if (alive) chunksRef.current = cs; }).catch(() => { chunksRef.current = []; });
    return () => { alive = false; };
  }, [open, tenantId, seedChunks]);

  const scrollDown = () => requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });

  // Retrieve top-k uploaded-file excerpts for this question.
  const buildFileContext = async (q: string, signal: AbortSignal): Promise<{ ctx: string; count: number; sources: string[] }> => {
    const chunks = chunksRef.current;
    if (!chunks || !chunks.length) return { ctx: '', count: 0, sources: [] };
    try {
      const rc = await retrieve(q, chunks, 12, signal);
      if (!rc.length) return { ctx: '', count: 0, sources: [] };
      const docs = new Set<string>();
      let used = 0;
      const parts: string[] = [];
      for (const r of rc) {
        const c = r.chunk;
        const piece = `[${c.docName}${c.headingPath ? ' › ' + c.headingPath : ''}]\n${c.text}`;
        if (used + piece.length > 9000) break;
        parts.push(piece); used += piece.length + 2; docs.add(c.docName);
      }
      return { ctx: parts.join('\n\n'), count: docs.size, sources: [...docs] };
    } catch { return { ctx: '', count: 0, sources: [] }; }
  };

  // Bridge: the Python copilot has its own RAG store, separate from Firestore.
  // The app's uploads live in Firestore (gov_chunks); nothing else feeds the
  // Python corpus, so without this it would answer with no evidence and just ask
  // the user for documents. On first use per tenant we reconstruct each document
  // from its Firestore chunks and ingest them once into the copilot corpus
  // (skipped if the corpus is already populated — e.g. still warm from earlier).
  const ensureCorpus = (): Promise<void> => {
    if (!copilotEnabled() || !tenantId) return Promise.resolve();
    if (corpusReadyRef.current) return corpusReadyRef.current;
    corpusReadyRef.current = (async () => {
      try {
        const st = await copilotStats(tenantId);
        if ((st?.chunks || 0) > 0) return;                 // already indexed
      } catch { /* stats unreachable → attempt ingest anyway */ }

      let chunks = chunksRef.current;
      if (!chunks) {
        try { chunks = await loadChunks(tenantId); chunksRef.current = chunks; }
        catch { chunks = []; }
      }
      if (!chunks || !chunks.length) return;               // nothing to ingest

      // Reconstruct documents from their ordered chunks.
      const byDoc = new Map<string, DocChunk[]>();
      for (const c of chunks) {
        const key = c.docName || c.docId || 'document';
        (byDoc.get(key) || byDoc.set(key, []).get(key)!).push(c);
      }
      const files: File[] = [];
      for (const [name, cs] of byDoc) {
        cs.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        const body = cs.map(c => (c.headingPath ? c.headingPath + '\n' : '') + c.text).join('\n\n');
        const fname = /\.[a-z0-9]+$/i.test(name) ? name : name + '.md';
        files.push(new File([body], fname, { type: 'text/markdown' }));
      }
      try {
        await copilotIngest(tenantId, files);
      } catch (e) {
        corpusReadyRef.current = null;                     // allow retry next time
        throw e;
      }
    })();
    return corpusReadyRef.current;
  };

  const pickImages = () => fileInputRef.current?.click();
  const onFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files;
    const picked: File[] = [];
    for (let i = 0; fl && i < fl.length; i++) {
      const f = fl.item(i);
      if (f && f.type.startsWith('image/')) picked.push(f);
    }
    if (picked.length) setAttachments(a => [...a, ...picked.map(f => ({ file: f, url: URL.createObjectURL(f) }))]);
    if (fileInputRef.current) fileInputRef.current.value = '';   // allow re-picking the same file
  };
  const removeAttachment = (i: number) => setAttachments(a => {
    if (a[i]?.url) URL.revokeObjectURL(a[i].url);
    return a.filter((_, j) => j !== i);
  });

  const send = async (text: string) => {
    const raw = text.trim();
    const att = attachments;                 // snapshot; chips clear immediately
    if ((!raw && !att.length) || busy) return;
    const q = raw || t('حلّل الصور المرفقة وصِفها.', 'Analyze and describe the attached image(s).');
    setInput('');
    setAttachments([]);
    const attNote = att.length ? t(` (${att.length} صورة مرفقة)`, ` (${att.length} image(s) attached)`) : '';
    const userMsg: Msg = { id: nid(), sender: 'user', text: q + attNote, thoughts: [], thinking: false, streaming: false };
    const agentId = nid();
    const agentMsg: Msg = { id: agentId, sender: 'agent', text: '', thoughts: [], thinking: true, streaming: true };
    const history: ChatTurn[] = msgs.map(m => ({ role: m.sender === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
    setMsgs(m => [...m, userMsg, agentMsg]);
    setBusy(true);
    scrollDown();
    const ac = new AbortController();
    abortRef.current = ac;
    const patch = (fn: (m: Msg) => Msg) => setMsgs(ms => ms.map(m => m.id === agentId ? fn(m) : m));
    try {
      // Python google-genai agent path (feature-flagged via VITE_COPILOT_API).
      // A long-form request → /draft (full multi-page doc); else → /ask (grounded
      // streaming Q&A). Falls through to the in-app stageChat path when disabled.
      if (copilotEnabled()) {
        const corpus = tenantId || 'default';
        // Make sure this tenant's documents are indexed in the copilot corpus
        // before we query, so it answers from the files instead of asking for them.
        if (!corpusReadyRef.current) {
          patch(m => ({ ...m, thoughts: [...m.thoughts, { id: nid(), text: t('جاري فهرسة ملفات المشروع للمرة الأولى…', 'Indexing project files for the first time…') }] }));
          scrollDown();
        }
        try { await ensureCorpus(); } catch { /* degrade: query with whatever is indexed */ }
        // Ingest any attached images into the corpus (multimodal gemini-embedding-2)
        // so this and later questions can retrieve them.
        if (att.length) {
          patch(m => ({ ...m, thoughts: [...m.thoughts, { id: nid(), text: t('جاري تحليل وفهرسة الصور المرفقة…', 'Analyzing & indexing attached image(s)…') }] }));
          scrollDown();
          try { await copilotIngest(corpus, att.map(a => a.file)); } catch { /* non-fatal */ }
        }
        if (LONG_RE.test(q)) {
          const doc = await copilotDraft({ corpus, request: q + FORMAT_HINT, language }, ac.signal);
          const docs = [...new Set(doc.sources.map(s => s.doc).filter(Boolean))];
          patch(m => ({ ...m, thinking: false, streaming: false, text: doc.markdown, sources: docs, srcRefs: toCiteRefs(doc.sources) }));
        } else {
          await copilotAsk(
            { corpus, message: q + FORMAT_HINT, history: history.map(h => ({ role: h.role, content: h.parts?.[0]?.text || '' })) },
            {
              onSources: ss => { const d = [...new Set(ss.map(s => s.doc).filter(Boolean))]; const refs = toCiteRefs(ss); patch(m => ({ ...m, sources: d.length ? d : m.sources, srcRefs: refs.length ? refs : m.srcRefs })); },
              onAnswer: chunk => { patch(m => ({ ...m, thinking: false, text: m.text + chunk })); scrollDown(); },
              onDone: () => patch(m => ({ ...m, thinking: false, streaming: false })),
              onError: () => patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('تعذّر الرد. أعد المحاولة.', 'Failed. Retry.') })),
            },
            ac.signal,
          );
        }
        return;
      }
      const { ctx, count, sources } = await buildFileContext(q, ac.signal);
      if (sources.length) patch(m => ({ ...m, sources }));
      await stageChat(
        {
          stage: stageKey, model, history, message: q + FORMAT_HINT, language, signal: ac.signal,
          extraContext, mode, fileContext: ctx, fileCount: count, longForm: LONG_RE.test(q),
          stateSnapshot,
        },
        {
          onThought: chunk => { patch(m => ({ ...m, thoughts: [...m.thoughts, { id: nid(), text: chunk }] })); scrollDown(); },
          onAnswer: chunk => { patch(m => ({ ...m, thinking: false, text: m.text + chunk })); scrollDown(); },
          onDone: () => patch(m => ({ ...m, thinking: false, streaming: false })),
          onError: () => patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('تعذّر الرد. أعد المحاولة.', 'Failed. Retry.') })),
        },
      );
    } catch {
      patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('تعذّر الرد.', 'Failed.') }));
    } finally {
      att.forEach(a => URL.revokeObjectURL(a.url));   // free object URLs
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); setBusy(false); };

  // Animated close: play the exit keyframe, then unmount. A fallback timer
  // guarantees teardown even when animations are disabled (reduced-motion),
  // where animationend never fires.
  const finishClose = () => {
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    setClosing(false);
    setOpen(false);
  };
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(finishClose, 360);
  };
  const onShellAnimEnd = (e: React.AnimationEvent) => {
    if (e.target !== e.currentTarget) return;   // ignore child animations
    if (closing) finishClose();
  };

  // Clicking a source citation/chip → collapse the copilot, then jump the page
  // to that resource (the parent navigates + highlights it).
  const handleCite = (doc: string) => {
    if (!doc) return;
    onOpenSource?.(doc);
    requestClose();
  };
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); }, []);

  // Turn any answer into a real downloadable file.
  const exportAs = async (kind: 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'html', md: string) => {
    const title = (md.match(/^#+\s*(.+)$/m)?.[1] || stageLabel || 'governance').slice(0, 60).trim();
    setExporting(kind + md.slice(0, 8));
    try {
      // Server-side rendering via the Python agent when enabled (Arabic RTL
      // DOCX/PDF/XLSX/PPTX/HTML), else the in-app exporters.
      if (copilotEnabled()) {
        await copilotExport(md, title, kind, { company: model?.companyName || undefined });
        return;
      }
      const o = {
        language: (language || 'ar') as Language,
        fontFamily: 'Tajawal',
        companyName: model?.companyName || undefined,
        logoUrl: logoUrl || undefined,
      };
      if (kind === 'docx') await exportMessageDocx(md, title, o);
      else if (kind === 'pdf') await exportMessagePdfDirect(md, title, o);
      else if (kind === 'html') await exportMessageHtml(md, title, o);
      else if (kind === 'xlsx') exportMessageXlsx(md, title);
      else await exportMessagePptx(md, title, { companyName: model?.companyName || undefined, logoUrl: logoUrl || undefined });
    } catch (e) { console.error('export failed', e); }
    finally { setExporting(null); }
  };

  // Does the copilot have a real, non-empty governance model to export?
  const hasModel = !!(model && (
    (model.orgUnits?.length || 0) > 0 ||
    (model.roles?.length || 0) > 0 ||
    (model.policies?.length || 0) > 0 ||
    (model.procedures?.length || 0) > 0
  ));

  // Export the FULL structured governance manual straight from the live model
  // (not a single chat message). Three model-driven manuals are available.
  const exportManual = async (kind: 'workflow' | 'jds' | 'policies') => {
    if (!model || !hasModel || manualBusy) return;
    setManualBusy(kind);
    setManualMenu(false);
    const o = {
      language: (language || 'ar') as Language,
      fontFamily: 'Tajawal',
      companyName: model.companyName || undefined,
    };
    try {
      if (kind === 'workflow') await exportWorkflowManual(model, o);
      else if (kind === 'jds') await exportJobDescriptions(model, o);
      else await exportPoliciesManual(model, o);
    } catch (e) { console.error('manual export failed', e); }
    finally { setManualBusy(null); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="gc-launch gc-spark-hover fixed bottom-5 end-5 z-40"
        title={t('كوبايلوت الحوكمة', 'Governance copilot')}>
        <GeminiSpark className="w-5 h-5 gc-spark-idle" />
        {t('كوبايلوت الحوكمة', 'Governance copilot')}
      </button>
    );
  }

  const modePill = (m: GovCopilotMode, _icon: string, label: string) => (
    <button onClick={() => setMode(m)}
      className={`gc-chip ${mode === m ? 'gc-chip-active' : ''}`}>
      {label}
    </button>
  );

  const exportBtn = (kind: 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'html', icon: string, label: string, md: string) => (
    <button onClick={() => exportAs(kind, md)} disabled={!!exporting}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:border-emerald-400 hover:text-emerald-700 dark:hover:border-emerald-500 dark:hover:text-emerald-300 text-[11px] font-medium text-slate-600 dark:text-slate-300 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed">
      {exporting === kind + md.slice(0, 8) ? <span className="animate-spin inline-block">↻</span> : null}{label}
    </button>
  );

  const exportRow = (md: string) => (
    <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-slate-100 dark:border-slate-700">
      <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">{t('تصدير', 'Export')}</span>
      {exportBtn('html', '', t('HTML', 'HTML'), md)}
      {exportBtn('docx', '', 'Word', md)}
      {exportBtn('pdf', '', 'PDF', md)}
      {exportBtn('xlsx', '', 'Excel', md)}
      {exportBtn('pptx', '', t('عرض', 'Slides'), md)}
    </div>
  );

  // Shell geometry: full-screen vs in-screen SIDE PANEL (docked to the edge,
  // full height — "في الجنب"، not a floating bubble). The page stays visible
  // beside it; the panel is page-aware (stageKey) and acts inline.
  const animCls = closing ? 'gc-panel-out' : (full ? 'gc-full-in' : 'gc-panel-in');
  const busyCls = busy ? 'gc-busy' : '';
  const shellCls = full
    ? `gc-shell ${animCls} ${busyCls} fixed inset-0 z-50 rounded-none flex flex-col overflow-hidden`
    : `gc-shell ${animCls} ${busyCls} fixed top-3 bottom-3 end-3 z-40 w-[min(94vw,440px)] rounded-[28px] flex flex-col overflow-hidden`;
  const shellStyle = { '--gc-fx': ar ? '-24px' : '24px' } as React.CSSProperties;
  const bodyWrap = full ? 'mx-auto w-full max-w-3xl' : '';

  return (
    <div className={shellCls} style={shellStyle} onAnimationEnd={onShellAnimEnd}>
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--hw-border)] shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <GeminiSpark className={`w-6 h-6 shrink-0 ${busy ? 'gc-spark-breathe' : 'gc-spark-idle'}`} />
          <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[15px] font-bold text-slate-900 dark:text-slate-100 truncate">{t('كوبايلوت الحوكمة', 'Governance copilot')}</span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate leading-none">
            {stageLabel}
            {/* P0-2: truthful connection status from the live snapshot — never claim
                "bound to files" when nothing is uploaded or indexing failed. */}
            {stateSnapshot && (
              stateSnapshot.permissionError
                ? <span className="ms-2 text-rose-600 dark:text-rose-400">{t('· تعذّر قراءة البيانات (صلاحيات)', '· cannot read data (perm)')}</span>
                : stateSnapshot.chunkCount > 0
                  ? <span className="ms-2 text-slate-400">{t(`· ${stateSnapshot.documentsCount} وثيقة · ${stateSnapshot.chunkCount} مقطع`, `· ${stateSnapshot.documentsCount} docs · ${stateSnapshot.chunkCount} indexed`)}</span>
                  : stateSnapshot.documentsCount > 0
                    ? <span className="ms-2 text-amber-600 dark:text-amber-400">{t(`· ${stateSnapshot.documentsCount} وثيقة غير مفهرسة`, `· ${stateSnapshot.documentsCount} un-indexed`)}</span>
                    : <span className="ms-2 text-slate-400">{t('· لا مصادر', '· no sources')}</span>
            )}
          </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 ms-2">
          <button onClick={() => setFull(f => !f)} title={full ? t('تصغير', 'Restore') : t('ملء الشاشة', 'Full screen')} className="gc-icon-btn">
            {full ? <IconRestore /> : <IconExpand />}
          </button>
          <button onClick={requestClose} title={t('إغلاق', 'Close')} className="gc-icon-btn">
            <IconClose />
          </button>
        </div>
      </div>

      {/* mode tabs + full-manual export */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[var(--hw-border)] shrink-0">
        {modePill('ask', '💬', t('سؤال', 'Ask'))}
        {modePill('edit', '✏️', t('تعديل', 'Edit'))}
        {modePill('reason', '🎯', t('هدف', 'Goal'))}

        {/* full structured governance manual — built from the live model */}
        <div className="relative ms-auto pb-px">
          <button
            onClick={() => hasModel && setManualMenu(v => !v)}
            disabled={!hasModel || !!manualBusy}
            title={hasModel ? t('تصدير دليل الحوكمة الكامل', 'Export full governance manual') : t('ابنِ نموذج الحوكمة أولاً', 'Build the governance model first')}
            className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {manualBusy ? <span className="animate-spin inline-block">↻</span> : null} {t('الدليل الكامل', 'Full manual')}
          </button>
          {manualMenu && hasModel && (
            <div className="absolute end-0 mt-1 z-50 w-60 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-md p-1 text-start"
              dir={ar ? 'rtl' : 'ltr'}>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{t('تصدير Word', 'Export as Word')}</div>
              <button onClick={() => exportManual('workflow')} disabled={!!manualBusy}
                className="w-full text-start px-3 py-2 rounded-md text-[12px] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors duration-150">
                {manualBusy === 'workflow' ? <span className="animate-spin inline-block me-1">↻</span> : null}{t('دليل دورة العمل المتكاملة', 'Integrated workflow manual')}
              </button>
              <button onClick={() => exportManual('jds')} disabled={!!manualBusy}
                className="w-full text-start px-3 py-2 rounded-md text-[12px] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors duration-150">
                {manualBusy === 'jds' ? <span className="animate-spin inline-block me-1">↻</span> : null}{t('دليل الأوصاف الوظيفية', 'Job descriptions manual')}
              </button>
              <button onClick={() => exportManual('policies')} disabled={!!manualBusy}
                className="w-full text-start px-3 py-2 rounded-md text-[12px] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors duration-150">
                {manualBusy === 'policies' ? <span className="animate-spin inline-block me-1">↻</span> : null}{t('دليل السياسات والصلاحيات', 'Policies & authorities manual')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3" dir={ar ? 'rtl' : 'ltr'}>
        <div className={bodyWrap}>
        {mode === 'ask' && (
          <>
            {msgs.length === 0 && (
              <div className="flex flex-col items-center text-center gap-3 py-12 px-4 gc-msg-in">
                <GeminiSpark className="w-11 h-11 gc-spark-breathe" />
                <p className="text-[16px] font-bold text-slate-700 dark:text-slate-200">{t('كيف أساعدك في الحوكمة؟', 'How can I help with governance?')}</p>
                <p className="text-[12.5px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-xs">{t('اسأل أو اطلب صياغة كاملة — يفكّر، يسترجع من ملفاتك المرفوعة، ويكتب وثيقة قابلة للتصدير.', 'Ask or request a full draft — reasons, retrieves from your files, and writes an export-ready document.')}</p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 max-w-xs">{t('مثال: «اكتب سياسة تضارب المصالح كاملة مستندة للملفات»', 'e.g. "Write a complete conflict-of-interest policy grounded in the files"')}</p>
              </div>
            )}
            {msgs.map(m => (
              <div key={m.id} className={`space-y-1 ${m.sender === 'user' ? 'flex flex-col items-end' : ''}`}>
                {m.sender === 'agent' && (m.thinking || m.thoughts.length > 0) && (
                  <ThinkingTrace thoughts={m.thoughts} active={m.thinking} language={language || 'ar'} />
                )}
                {m.sender === 'user' ? (
                  <div className="gc-msg-user gc-msg-in">{m.text}</div>
                ) : (
                  <div className="gc-msg-model gc-msg-in">
                    {m.text ? (
                      <>
                        <Markdown text={m.text} rtl={ar} citations={m.srcRefs} onCite={handleCite} />
                        {m.streaming && (
                          <div className="flex items-center gap-2 mt-2.5 text-[11px] text-[color:var(--hw-text-subtle)]">
                            <GeminiSpark className="w-3.5 h-3.5 gc-spark-breathe" />
                            <span className="inline-flex items-center gap-1"><span className="gc-dot" /><span className="gc-dot" /><span className="gc-dot" /></span>
                          </div>
                        )}
                      </>
                    ) : (
                      <GcThinking label={t('يفكّر…', 'thinking…')} />
                    )}
                    {m.sources && m.sources.length > 0 && (
                      <div className="mt-2 pt-1.5 border-t border-[var(--hw-border)] flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">{t('مصادر', 'Sources')}</span>
                        {m.sources.map((s, x) => (
                          <button key={x} type="button" onClick={() => handleCite(s)} title={s}
                            className="hw-cite max-w-[170px]" aria-label={t(`فتح المصدر ${s}`, `Open source ${s}`)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                            <span className="truncate">{s}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {!m.streaming && m.text.length > 40 && exportRow(m.text)}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {mode === 'edit' && (
          <div className="space-y-3 py-2">
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{t('اكتب أمراً بلغة طبيعية — يقترح تعديلات منظّمة تراجعها قبل التطبيق (يُحفظ snapshot).', 'Describe a change in natural language — it proposes structured actions you review before applying (snapshotted).')}</p>
            {!model && <div className="text-[11px] font-medium text-amber-600 dark:text-amber-400">{t('ابنِ النموذج أولاً.', 'Build the model first.')}</div>}
            {props.proposedActions.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{t('الإجراءات المقترحة', 'Proposed actions')} ({props.proposedActions.length})</div>
                {props.proposedActions.map((a, i) => (
                  <div key={i} className="text-[12px] rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-2">
                    <span className="font-semibold text-emerald-700 dark:text-emerald-300">{a.type}</span>
                    {a.title || a.name || a.decision ? <span className="text-slate-700 dark:text-slate-200"> · {a.title || a.name || a.decision}</span> : ''}
                    {a.rationale && <span className="text-slate-400"> — {a.rationale}</span>}
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <button onClick={props.onApplyActions} disabled={props.applyBusy} className="hw-btn hw-btn-primary hw-btn-sm">{t(`تطبيق ${props.proposedActions.length}`, `Apply ${props.proposedActions.length}`)}</button>
                  <button onClick={props.onDiscardActions} className="hw-btn hw-btn-ghost hw-btn-sm">{t('تجاهل', 'Discard')}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'reason' && (
          <div className="space-y-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed flex-1">{t('هدف مركّب — يخطّط خطوة بخطوة ويصحّح نفسه قبل الإنهاء.', 'A composite goal — plans step-by-step and self-corrects before finishing.')}</p>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 font-medium cursor-pointer shrink-0 mt-0.5">
                <input type="checkbox" checked={props.agentAutoApply} onChange={e => props.setAgentAutoApply(e.target.checked)} className="accent-emerald-600 rounded-sm" />
                {t('تطبيق تلقائي', 'Auto-apply')}
              </label>
            </div>
            {!model && <div className="text-[11px] font-medium text-amber-600 dark:text-amber-400">{t('ابنِ النموذج أولاً.', 'Build the model first.')}</div>}
            {(props.agentSteps.length > 0 || props.agentRunning) && (
              <div className="space-y-1">
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{t('خطوات التنفيذ', 'Execution steps')}</div>
                {props.agentSteps.map((s, i) => (
                  <div key={i} className="rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-slate-400">#{s.index + 1}</span>
                      <span className="font-semibold text-slate-700 dark:text-slate-200">{s.toolCall.tool}</span>
                      <span className={`text-[10px] font-medium ${s.status === 'error' ? 'text-rose-500' : 'text-green-600'}`}>{s.status === 'error' ? t('خطأ', 'error') : t('تم', 'done')}</span>
                      {typeof s.durationMs === 'number' && (
                        <span className="ms-auto font-mono text-[10px] text-slate-400">{(s.durationMs / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                    {s.thought && <div className="text-slate-500 dark:text-slate-400 mt-1 text-[11px] italic leading-snug">{s.thought}</div>}
                    {s.observation && <div className="text-slate-600 dark:text-slate-300 mt-1 text-[11px] whitespace-pre-wrap leading-snug">{s.observation}</div>}
                  </div>
                ))}
                {props.agentRunning && <div className="text-[11px] text-slate-500 dark:text-slate-400 py-1">{t('الوكيل يفكّر…', 'Agent reasoning…')}</div>}
              </div>
            )}
            {props.agentAnswer && (
              <div className="rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-3 text-sm text-slate-700 dark:text-slate-200">
                <Markdown text={props.agentAnswer} rtl={ar} onCite={handleCite} />
                {exportRow(props.agentAnswer)}
                {props.agentTrace && (
                  <div className="flex items-center gap-2 mt-2 pt-1.5 border-t border-slate-100 dark:border-slate-700">
                    <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">{t('سجل التنفيذ', 'Run trace')}</span>
                    {exportBtn('docx', '', 'Word', props.agentTrace)}
                    {exportBtn('pdf', '', 'PDF', props.agentTrace)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* composer */}
      <div className="px-4 pt-2 pb-4 shrink-0" dir={ar ? 'rtl' : 'ltr'}>
        <div className={bodyWrap}>
        {mode === 'ask' && (
          <>
            {copilotEnabled() && attachments.length > 0 && (
              <div className="gc-attach-row" dir={ar ? 'rtl' : 'ltr'}>
                {attachments.map((a, i) => (
                  <div key={a.url} className="gc-thumb">
                    <img src={a.url} alt={a.file.name} />
                    <button type="button" className="gc-thumb-x" onClick={() => removeAttachment(i)} title={t('إزالة', 'Remove')} aria-label={t('إزالة', 'Remove')}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="gc-composer">
              {copilotEnabled() && (
                <>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={onFilesSelected} className="hidden" />
                  <button type="button" onClick={pickImages} className="gc-attach" title={t('إرفاق صورة', 'Attach image')} aria-label={t('إرفاق صورة', 'Attach image')}><IconAttach /></button>
                </>
              )}
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
                rows={full ? 2 : 1}
                placeholder={t('اكتب سؤالك أو اطلب صياغة كاملة…', 'Ask, or request a full draft…')}
                className="gc-input"
              />
              {busy
                ? <button onClick={stop} className="gc-send gc-send-stop" title={t('إيقاف', 'Stop')} aria-label={t('إيقاف', 'Stop')}><IconStop /></button>
                : <button onClick={() => send(input)} disabled={!input.trim() && !attachments.length} className="gc-send" title={t('إرسال', 'Send')} aria-label={t('إرسال', 'Send')}><IconSend /></button>}
            </div>
          </>
        )}
        {mode === 'edit' && (
          <div className="gc-composer">
            <input
              value={props.actionInput}
              onChange={e => props.setActionInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !props.proposing && props.actionInput.trim()) props.onPropose(); }}
              placeholder={t('مثال: أضف دور مدير امتثال + سياسة تضارب مصالح', 'e.g. Add a compliance-manager role + conflict-of-interest policy')}
              className="gc-input"
            />
            <button onClick={props.onPropose} disabled={props.proposing || !props.actionInput.trim()} className="hw-btn hw-btn-primary hw-btn-sm shrink-0 !rounded-full">{props.proposing ? <span className="animate-spin inline-block">↻</span> : t('اقترح', 'Propose')}</button>
          </div>
        )}
        {mode === 'reason' && (
          <div className="gc-composer">
            <input
              value={props.agentInput}
              onChange={e => props.setAgentInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !props.agentRunning && props.agentInput.trim()) props.onRunAgent(); }}
              placeholder={t('مثال: عالج فجوات الامتثال وأضف ما يلزم', 'e.g. Close compliance gaps and add what is needed')}
              className="gc-input"
            />
            <button onClick={props.onRunAgent} disabled={props.agentRunning || !props.agentInput.trim()} className="hw-btn hw-btn-primary hw-btn-sm shrink-0 !rounded-full">{props.agentRunning ? <span className="animate-spin inline-block">↻</span> : t('شغّل', 'Run')}</button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
};

export default GovCopilot;
