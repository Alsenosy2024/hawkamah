import React, { useEffect, useRef, useState } from 'react';
import type { CompanyGovernanceModel, DocChunk, Language, ThinkingStep } from '../types';
import { stageChat, type GovStageKey, type GovCopilotMode, type GovStateSnapshot } from '../services/governanceChat';
import type { ChatTurn } from '../services/agentOrchestrator';
import { loadChunks, retrieve } from '../services/governanceService';
import { exportMessageDocx, exportMessageXlsx, exportMessagePdfDirect, exportMessageHtml, exportWorkflowManual, exportJobDescriptions, exportPoliciesManual } from '../services/exportService';
import { exportMessagePptx } from '../services/pptxExport';
import ThinkingTrace from './ThinkingTrace';
import Markdown from './Markdown';

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
  sources?: string[];   // doc names grounded this answer
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

// Heuristic: does the user want a long, document-grade draft?
const LONG_RE = /(كامل|كاملة|مفصّل|مفصل|تفصيل|استراتيج|سياسة|لائحة|دليل|إجراء|اجراء|عملية|عمليات|صياغة|اكتب|أكتب|حرّر|حرر|وثيق|كمّل|كمل|أكمل|اكمل|استمر|تابع|واصل|أطول|full|complete|draft|strategy|policy|regulation|manual|procedure|process|write|detailed|continue|expand|longer)/i;

const GovCopilot: React.FC<Props> = (props) => {
  const { stageKey, stageLabel, model, language, extraContext, logoUrl, tenantId, seedChunks, stateSnapshot } = props;
  const ar = (language || 'ar') === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
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

  // Invalidate cached chunks when tenant changes (BUG-15 fix).
  useEffect(() => { chunksRef.current = null; }, [tenantId]);

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

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    const userMsg: Msg = { id: nid(), sender: 'user', text: q, thoughts: [], thinking: false, streaming: false };
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
      const { ctx, count, sources } = await buildFileContext(q, ac.signal);
      if (sources.length) patch(m => ({ ...m, sources }));
      await stageChat(
        {
          stage: stageKey, model, history, message: q, language, signal: ac.signal,
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
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); setBusy(false); };

  // Turn any answer into a real downloadable file.
  const exportAs = async (kind: 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'html', md: string) => {
    const title = (md.match(/^#+\s*(.+)$/m)?.[1] || stageLabel || 'governance').slice(0, 60).trim();
    setExporting(kind + md.slice(0, 8));
    try {
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
        className="hw-btn hw-btn-primary fixed bottom-5 end-5 z-40 rounded-full px-5 h-12 text-sm font-extrabold">
        🤖 {t('كوبايلوت الحوكمة', 'Governance copilot')}
      </button>
    );
  }

  const modePill = (m: GovCopilotMode, icon: string, label: string) => (
    <button onClick={() => setMode(m)}
      className={`hw-btn hw-btn-xs ${mode === m ? 'hw-btn-primary' : 'hw-btn-ghost'}`}>
      {icon} {label}
    </button>
  );

  const exportBtn = (kind: 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'html', icon: string, label: string, md: string) => (
    <button onClick={() => exportAs(kind, md)} disabled={!!exporting}
      className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-[11px] font-bold text-slate-600 dark:text-slate-300 disabled:opacity-50">
      {exporting === kind + md.slice(0, 8) ? '⏳' : icon} {label}
    </button>
  );

  const exportRow = (md: string) => (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      <span className="text-[10px] text-slate-400">{t('تصدير:', 'Export:')}</span>
      {exportBtn('html', '🌐', t('HTML تفاعلي', 'Interactive HTML'), md)}
      {exportBtn('docx', '📄', 'Word', md)}
      {exportBtn('pdf', '📕', 'PDF', md)}
      {exportBtn('xlsx', '📊', 'Excel', md)}
      {exportBtn('pptx', '📈', t('عرض', 'Slides'), md)}
    </div>
  );

  // Shell geometry: full-screen vs in-screen SIDE PANEL (docked to the edge,
  // full height — "في الجنب"، not a floating bubble). The page stays visible
  // beside it; the panel is page-aware (stageKey) and acts inline.
  const shellCls = full
    ? 'fixed inset-0 z-50 w-screen h-screen rounded-none bg-white dark:bg-slate-900 flex flex-col'
    : 'fixed top-0 end-0 z-40 h-screen w-[min(96vw,460px)] rounded-none border-s border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-2xl flex flex-col';
  const shellStyle = full ? undefined : { maxHeight: '100vh' };
  const bodyWrap = full ? 'mx-auto w-full max-w-3xl' : '';

  return (
    <div className={shellCls} style={shellStyle}>
      {/* header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-700 bg-emerald-50/70 dark:bg-emerald-900/20 shrink-0">
        <div className="flex flex-col">
          <span className="text-sm font-extrabold text-emerald-800 dark:text-emerald-200">🤖 {t('كوبايلوت الحوكمة', 'Governance copilot')}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            {t('المرحلة', 'Stage')}: {stageLabel}
            {/* P0-2: truthful connection status from the live snapshot — never claim
                "bound to files" when nothing is uploaded or indexing failed. */}
            {stateSnapshot && (
              stateSnapshot.permissionError
                ? <span className="ms-2 text-rose-600 dark:text-rose-400">· ⛔ {t('تعذّر قراءة البيانات (صلاحيات)', 'cannot read data (perm)')}</span>
                : stateSnapshot.chunkCount > 0
                  ? <span className="ms-2">· 📎 {t(`${stateSnapshot.documentsCount} وثيقة · ${stateSnapshot.chunkCount} مقطع مفهرس`, `${stateSnapshot.documentsCount} docs · ${stateSnapshot.chunkCount} indexed`)}</span>
                  : stateSnapshot.documentsCount > 0
                    ? <span className="ms-2 text-amber-600 dark:text-amber-400">· ⚠️ {t(`${stateSnapshot.documentsCount} وثيقة مرفوعة · غير مفهرسة`, `${stateSnapshot.documentsCount} uploaded · un-indexed`)}</span>
                    : <span className="ms-2">· {t('لا مصادر بعد', 'no sources yet')}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setFull(f => !f)} title={full ? t('تصغير', 'Restore') : t('ملء الشاشة', 'Full screen')}
            className="text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-300 text-lg leading-none px-1">
            {full ? '🗗' : '⛶'}
          </button>
          <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>
      </div>

      {/* mode pills + full-manual export */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-100 dark:border-slate-700 shrink-0">
        {modePill('ask', '💬', t('سؤال', 'Ask'))}
        {modePill('edit', '✏️', t('تعديل النموذج', 'Edit model'))}
        {modePill('reason', '🎯', t('هدف', 'Goal'))}

        {/* full structured governance manual — built from the live model */}
        <div className="relative ms-auto">
          <button
            onClick={() => hasModel && setManualMenu(v => !v)}
            disabled={!hasModel || !!manualBusy}
            title={hasModel ? t('تصدير دليل الحوكمة الكامل', 'Export full governance manual') : t('ابنِ نموذج الحوكمة أولاً', 'Build the governance model first')}
            className="px-2.5 py-1 rounded-lg text-[11px] font-extrabold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed">
            {manualBusy ? '⏳' : '📚'} {t('الدليل الكامل', 'Full manual')}
          </button>
          {manualMenu && hasModel && (
            <div className="absolute end-0 mt-1 z-50 w-60 rounded-xl border border-emerald-200 dark:border-emerald-700 bg-white dark:bg-slate-800 shadow-2xl p-1.5 text-start"
              dir={ar ? 'rtl' : 'ltr'}>
              <div className="px-2 py-1 text-[10px] font-bold text-slate-400">{t('تصدير دليل الحوكمة الكامل (Word)', 'Export full governance manual (Word)')}</div>
              <button onClick={() => exportManual('workflow')} disabled={!!manualBusy}
                className="w-full text-start px-2 py-1.5 rounded-lg text-[12px] font-bold text-slate-700 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 disabled:opacity-50">
                {manualBusy === 'workflow' ? '⏳' : '🔄'} {t('دليل دورة العمل المتكاملة', 'Integrated workflow manual')}
              </button>
              <button onClick={() => exportManual('jds')} disabled={!!manualBusy}
                className="w-full text-start px-2 py-1.5 rounded-lg text-[12px] font-bold text-slate-700 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 disabled:opacity-50">
                {manualBusy === 'jds' ? '⏳' : '👤'} {t('دليل الأوصاف الوظيفية', 'Job descriptions manual')}
              </button>
              <button onClick={() => exportManual('policies')} disabled={!!manualBusy}
                className="w-full text-start px-2 py-1.5 rounded-lg text-[12px] font-bold text-slate-700 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 disabled:opacity-50">
                {manualBusy === 'policies' ? '⏳' : '📋'} {t('دليل السياسات والصلاحيات', 'Policies & authorities manual')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3" dir={ar ? 'rtl' : 'ltr'}>
        <div className={bodyWrap}>
        {mode === 'ask' && (
          <>
            {msgs.length === 0 && (
              <div className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed space-y-1">
                <p>{t('اسأل أو اطلب صياغة كاملة — يفكّر، يسترجع من ملفاتك المرفوعة، ويكتب وثيقة كاملة قابلة للتصدير.', 'Ask or request a full draft — it reasons, retrieves from your uploaded files, and writes an export-ready document.')}</p>
                <p className="text-[11px]">{t('مثال: «اكتب سياسة تضارب المصالح كاملة مستندة للملفات» أو «صيغة استراتيجية حوكمة كاملة».', 'e.g. "Write a complete conflict-of-interest policy grounded in the files" or "A full governance strategy".')}</p>
              </div>
            )}
            {msgs.map(m => (
              <div key={m.id} className={`${m.sender === 'user' ? 'text-end' : ''} space-y-1`}>
                {m.sender === 'agent' && (m.thinking || m.thoughts.length > 0) && (
                  <ThinkingTrace thoughts={m.thoughts} active={m.thinking} language={language || 'ar'} />
                )}
                {m.sender === 'user' ? (
                  <div className="inline-block max-w-[88%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap bg-emerald-600 text-white">
                    {m.text}
                  </div>
                ) : (
                  <div className="block w-full px-3 py-2 rounded-2xl text-sm bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100">
                    {m.text
                      ? <Markdown text={m.text} rtl={ar} />
                      : <span className="text-slate-400">{m.thinking ? t('يفكّر…', 'thinking…') : ''}</span>}
                    {m.sources && m.sources.length > 0 && (
                      <div className="mt-2 text-[10px] text-slate-400 dark:text-slate-500">
                        📎 {t('مصادر', 'Sources')}: {m.sources.join('، ')}
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
          <div className="space-y-2">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">{t('اكتب أمراً بلغة طبيعية — يقترح تعديلات منظّمة تراجعها قبل التطبيق (يُحفظ snapshot).', 'Describe a change in natural language — it proposes structured actions you review before applying (snapshotted).')}</div>
            {!model && <div className="text-xs text-amber-600">{t('ابنِ النموذج أولاً.', 'Build the model first.')}</div>}
            {props.proposedActions.length > 0 && (
              <div className="space-y-1">
                {props.proposedActions.map((a, i) => (
                  <div key={i} className="text-xs rounded-lg bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-700 p-2">
                    <span className="font-bold text-emerald-700 dark:text-emerald-300">{a.type}</span>
                    {a.title || a.name || a.decision ? ` — ${a.title || a.name || a.decision}` : ''}
                    {a.rationale && <span className="text-slate-400"> · {a.rationale}</span>}
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <button onClick={props.onApplyActions} disabled={props.applyBusy} className="hw-btn hw-btn-xs hw-btn-primary">✅ {t(`تطبيق ${props.proposedActions.length}`, `Apply ${props.proposedActions.length}`)}</button>
                  <button onClick={props.onDiscardActions} className="px-3 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold">{t('تجاهل', 'Discard')}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'reason' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-slate-500 dark:text-slate-400 flex-1">{t('هدف مركّب — يخطّط خطوة بخطوة ويصحّح نفسه قبل الإنهاء.', 'A composite goal — plans step-by-step and self-corrects before finishing.')}</div>
              <label className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 font-bold cursor-pointer shrink-0">
                <input type="checkbox" checked={props.agentAutoApply} onChange={e => props.setAgentAutoApply(e.target.checked)} className="accent-emerald-600" />
                {t('تطبيق تلقائي', 'Auto-apply')}
              </label>
            </div>
            {!model && <div className="text-xs text-amber-600">{t('ابنِ النموذج أولاً.', 'Build the model first.')}</div>}
            {(props.agentSteps.length > 0 || props.agentRunning) && (
              <div className="space-y-1.5">
                {props.agentSteps.map((s, i) => (
                  <div key={i} className="rounded-lg bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-700 p-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-emerald-500">#{s.index + 1}</span>
                      <span className="font-black text-emerald-700 dark:text-emerald-300">{s.toolCall.tool}</span>
                      <span className={`text-[10px] ${s.status === 'error' ? 'text-rose-500' : 'text-emerald-500'}`}>{s.status === 'error' ? '⚠' : '✓'}</span>
                      {typeof s.durationMs === 'number' && (
                        <span className="ms-auto font-mono text-[10px] text-slate-400">{(s.durationMs / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                    {s.thought && <div className="text-slate-500 dark:text-slate-400 mt-0.5 italic">{s.thought}</div>}
                    {s.observation && <div className="text-slate-600 dark:text-slate-300 mt-0.5 whitespace-pre-wrap leading-snug">{s.observation}</div>}
                  </div>
                ))}
                {props.agentRunning && <div className="text-[11px] text-emerald-500 animate-pulse">{t('الوكيل يفكّر…', 'agent reasoning…')}</div>}
              </div>
            )}
            {props.agentAnswer && (
              <div className="rounded-lg bg-white dark:bg-slate-800 border-2 border-emerald-300 dark:border-emerald-600 p-3 text-sm text-slate-700 dark:text-slate-200">
                <Markdown text={props.agentAnswer} rtl={ar} />
                {exportRow(props.agentAnswer)}
                {props.agentTrace && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="text-[10px] text-slate-400">{t('سجل التنفيذ الكامل:', 'Full run trace:')}</span>
                    {exportBtn('docx', '🧾', t('أثر (Word)', 'Trace (Word)'), props.agentTrace)}
                    {exportBtn('pdf', '🧾', t('أثر (PDF)', 'Trace (PDF)'), props.agentTrace)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* composer */}
      <div className="border-t border-slate-100 dark:border-slate-700 p-2 shrink-0" dir={ar ? 'rtl' : 'ltr'}>
        <div className={`${bodyWrap} flex items-end gap-2`}>
        {mode === 'ask' && (
          <>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              rows={full ? 2 : 1}
              placeholder={t('اكتب سؤالك أو اطلب صياغة كاملة…', 'Ask, or request a full draft…')}
              className="flex-1 resize-none text-sm rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2 max-h-40"
            />
            {busy
              ? <button onClick={stop} className="px-3 h-9 rounded-xl bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 text-xs font-bold">⏹ {t('إيقاف', 'Stop')}</button>
              : <button onClick={() => send(input)} disabled={!input.trim()} className="hw-btn hw-btn-primary hw-btn-sm">{t('إرسال', 'Send')}</button>}
          </>
        )}
        {mode === 'edit' && (
          <>
            <input
              value={props.actionInput}
              onChange={e => props.setActionInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !props.proposing && props.actionInput.trim()) props.onPropose(); }}
              placeholder={t('مثال: أضف دور مدير امتثال + سياسة تضارب مصالح', 'e.g. Add a compliance-manager role + conflict-of-interest policy')}
              className="flex-1 text-sm rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2"
            />
            <button onClick={props.onPropose} disabled={props.proposing || !props.actionInput.trim()} className="hw-btn hw-btn-primary hw-btn-sm">{props.proposing ? '⏳' : t('اقترح', 'Propose')}</button>
          </>
        )}
        {mode === 'reason' && (
          <>
            <input
              value={props.agentInput}
              onChange={e => props.setAgentInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !props.agentRunning && props.agentInput.trim()) props.onRunAgent(); }}
              placeholder={t('مثال: عالج فجوات الامتثال وأضف ما يلزم', 'e.g. Close compliance gaps and add what is needed')}
              className="flex-1 text-sm rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2"
            />
            <button onClick={props.onRunAgent} disabled={props.agentRunning || !props.agentInput.trim()} className="hw-btn hw-btn-primary hw-btn-sm">{props.agentRunning ? '⏳' : t('شغّل', 'Run')}</button>
          </>
        )}
        </div>
      </div>
    </div>
  );
};

export default GovCopilot;
