import React, { useEffect, useRef, useState } from 'react';
import type { CompanyGovernanceModel, DocChunk, Language, ThinkingStep, ProgressStep } from '../types';
import {
  stageChat,
  // V5 + V16 — conversational build wizard (pure logic lives in governanceChat).
  // V27 — shouldOpenBuildWizard gates the wizard so conversation is the default.
  proposeBuildPlan, planToBuildRequest, shouldOpenBuildWizard,
  addPlanItem, removePlanItem, toggleComponent, clampPlanPages,
  // P5/D1 + D3 — the requested-length parser, the structured plan→backend
  // mapper, the web-research-need detector, and the long-form/authoring-intent
  // detector (replaces the old bare-noun LONG_RE).
  parseTargetPages, planToPayload, needsWebResearch, isLongFormRequest,
  type BuildPlan,
  type GovStageKey, type GovCopilotMode, type GovStateSnapshot,
} from '../services/governanceChat';
import type { ChatTurn } from '../services/agentOrchestrator';
import { toStreamCallbacks, toAskCallbacks, type GenerationProgressHandler } from '../services/generationProgress';
import { loadChunks, retrieve } from '../services/governanceService';
import { exportMessageDocx, exportMessageXlsx, exportMessagePdfDirect, exportMessageHtml } from '../services/exportService';
import { exportMessagePptx } from '../services/pptxExport';
import {
  copilotEnabled, askStream as copilotAsk, draftStream as copilotDraftStream, exportDoc as copilotExport,
  stats as copilotStats, ingestFiles as copilotIngest, listConversations, getConversation, saveConversation, deleteConversation,
  // P5/D2 — real-company grounding; P5/D7 — mermaid-fence detection for the export bypass.
  buildGrounding, hasMermaidFence,
  // P12 — the outgoing-message contract: FORMAT_HINT is the mermaid/table
  // formatting directive; askMessagePayload/stageChatMessagePayload decide
  // which paths get it (see copilotClient.ts for why /ask must NOT).
  FORMAT_HINT, askMessagePayload, stageChatMessagePayload,
  type CopilotConvSummary,
} from '../services/copilotClient';
import { generateGroundedDocument } from '../services/geminiService';
import ThinkingTrace from './ThinkingTrace';
import StepTimeline from './StepTimeline';
import Markdown, { type CiteRef } from './Markdown';
import DocumentCanvas from './DocumentCanvas';
import { looksLikeDocument, canvasHtmlToMarkdown } from '../services/canvasDocument';
import { replaceMermaidFence } from '../services/mermaidDetect';
import { createSharedDoc } from '../services/sharedDocService';
// Copilot avatar art — a bundled SVG line-icon (robot/chatbot face). Imported as
// an asset (Vite gives us its hashed URL) and painted via CSS mask so it inherits
// the live --hw-brand teal in both RTL and dark mode (see RobotAvatar below).
import robotAvatarUrl from '../src/assets/copilot-robot.svg';

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
  steps: ProgressStep[];   // live generation-step timeline (HWK-A2); transient, not persisted
  thinking: boolean;
  streaming: boolean;
  sources?: string[];   // doc names grounded this answer (deduped, for the footer)
  srcRefs?: CiteRef[];  // ordered [مصدر N] → {doc, heading} for inline citations
  webSources?: { title: string; uri: string }[]; // live Google-Search citations (research docs)
  searchHtml?: string;  // Google "search suggestions" HTML (must be displayed when grounding)
  // P12 — live done/total for the /draft/stream progress bar. Distinct from
  // `steps` (which only tracks STAGE transitions): a single stage like
  // "drafting" emits many progress events as sections complete, and this is
  // what lets the bubble render a real percent + "section N of M" counter
  // instead of a static label. Transient, not persisted.
  draftProgress?: { stage: string; label: string; done: number; total: number };
  // P12 — set when a stream errored/aborted AFTER tokens already rendered, so
  // the partial text isn't silently left looking like a finished answer.
  // `onRetry` re-runs the same turn from scratch; both are transient/local
  // (never serialized — see serializeMsgs).
  interrupted?: boolean;
  onRetry?: () => void;
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
  // V16: when the build wizard's confirmed plan changes the departments, the
  // parent folds the new ones into model.orgUnits (so the build reflects them).
  onApplyDepartments?: (names: string[]) => void;

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

// ── Robot copilot face — the bundled SVG asset painted with the current text
// color via a CSS mask, so it tracks --hw-brand in light/dark and never needs a
// second copy of the artwork. The icon is symmetric, so it is correct in RTL. ──
const RobotMark: React.FC<{ className?: string }> = ({ className }) => (
  <span
    aria-hidden="true"
    className={className}
    style={{
      display: 'inline-block',
      backgroundColor: 'currentColor',
      WebkitMaskImage: `url(${robotAvatarUrl})`,
      maskImage: `url(${robotAvatarUrl})`,
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
    }}
  />
);

// The copilot's avatar: a soft-teal brand badge framing the robot face. `label`
// drives role="img"/aria-label so screen readers announce the assistant identity.
const RobotAvatar: React.FC<{ className?: string; markClassName?: string; label: string }> = ({ className, markClassName, label }) => (
  <span
    role="img"
    aria-label={label}
    title={label}
    className={`grid place-items-center shrink-0 rounded-full bg-[var(--hw-brand-100)] text-[color:var(--hw-brand)] ${className || ''}`}
  >
    <RobotMark className={markClassName || 'w-[64%] h-[64%]'} />
  </span>
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
const IconDownload: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
);
const IconAttach: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
);
const IconHistory: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></svg>
);
const IconNewChat: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
);
const IconTrash: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
);

// Compact relative-time label (Arabic/English) for the history list.
const relTime = (sec: number, ar: boolean): string => {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  const m = Math.floor(d / 60), h = Math.floor(d / 3600), dd = Math.floor(d / 86400);
  if (d < 60) return ar ? 'الآن' : 'now';
  if (m < 60) return ar ? `قبل ${m} د` : `${m}m`;
  if (h < 24) return ar ? `قبل ${h} س` : `${h}h`;
  if (dd < 30) return ar ? `قبل ${dd} ي` : `${dd}d`;
  return new Date(sec * 1000).toLocaleDateString(ar ? 'ar' : 'en');
};

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

// P12 — real percent + section counter for the long-running /draft/stream
// timeline. Reuses the app's existing .hw-progress/.hw-progress-bar bar (see
// ArtifactProgress.tsx, same classes) instead of a second bespoke progress
// bar. Sits alongside StepTimeline: StepTimeline narrates STAGE transitions
// ("outline done ✓, now drafting…"), this narrates the granular done/total
// the backend reports WITHIN the running stage (e.g. "section 3 of 8").
const GcDraftProgress: React.FC<{
  progress: { stage: string; label: string; done: number; total: number };
  ar: boolean;
  t: (a: string, e: string) => string;
}> = ({ progress, ar, t }) => {
  const total = Math.max(0, progress.total || 0);
  const done = Math.max(0, total > 0 ? Math.min(progress.done || 0, total) : progress.done || 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mb-2 rounded-lg border border-[var(--hw-border)] bg-white dark:bg-slate-800/60 px-3 py-2" dir={ar ? 'rtl' : 'ltr'}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 truncate">{progress.label}</span>
        <span className="text-[11px] font-bold text-[color:var(--hw-brand)] tabular-nums shrink-0">{pct}%</span>
      </div>
      <div className="hw-progress"><div className="hw-progress-bar" style={{ width: `${pct}%` }} /></div>
      {total > 0 && (
        <p className="text-[10.5px] text-slate-400 dark:text-slate-500 mt-1">{t(`القسم ${done} من ${total}`, `Section ${done} of ${total}`)}</p>
      )}
    </div>
  );
};

// Document-creation intent: does the user want a real, document-grade draft of
// ANY kind (not a short Q&A)? P5 addendum — this used to be a bare-noun regex
// (`LONG_RE`) here, so a plain QUESTION mentioning any governance noun (e.g.
// «هل عندنا سياسة لتضارب المصالح؟») matched via «سياسة» alone and hijacked
// GovCopilot.runGeneration's draftStream-vs-ask branch into the 7-8 min /draft
// path with zero authoring intent. Replaced with `isLongFormRequest`, imported
// from governanceChat (unit-testable there; see its doc comment for the exact
// repro + the fix: verb+noun / continuation / explicit page count — never a
// bare noun alone).

// Output-formatting directive sent to the model (not shown in the UI bubble):
// any diagram must be a real Mermaid code block — never ASCII art — and tabular
// data must be Markdown tables. The front-end renders both as styled visuals.
// P5/D3 — "does this request need live web research?" is `needsWebResearch`,
// imported from governanceChat (moved there so it's unit-testable without
// importing this whole component, which transitively pulls in Firebase/
// mermaid/docx/xlsx/pptxgenjs). See governanceChat.ts for the regex + the
// reasoning behind removing the over-broad terms that used to live here.

// Export intent: the user wants to turn the LAST generated document into a real
// file (download/convert), NOT author a brand-new document. We must handle this
// in-app via exportAs() instead of sending it to the LLM (which refuses to emit
// binary files). Two conditions: (1) a format token is present, and (2) the
// message reads like a terse command. Errs toward NOT hijacking real authoring.
const EXPORT_FMT: { kind: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html'; label: string; re: RegExp }[] = [
  { kind: 'pdf',  label: 'PDF',   re: /(pdf|بي ?دي ?اف|بدف)/i },
  { kind: 'xlsx', label: 'Excel', re: /(excel|اكسل|إكسل|xlsx|جدول ?اكسل)/i },
  { kind: 'pptx', label: 'PowerPoint', re: /(عرض|بوربوينت|باوربوينت|pptx|powerpoint|slides|شرائح)/i },
  { kind: 'docx', label: 'Word',  re: /(word|وورد|ورد|docx|مستند ?وورد)/i },
  { kind: 'html', label: 'HTML',  re: /(html|اتش ?تي ?ام ?ال)/i },
];
// Verbs that refer to AN EXISTING doc ("make it / convert it / download it"),
// not authoring a new one. "اعمللي" (make me a …) is intentionally excluded.
const EXPORT_VERB_RE = /(اعملها|اعمله|سوّيها|سويها|حوّلها|حولها|صدّرها|صدرها|صدّر|صدر|نزّلها|نزلها|نزّل|نزل|حمّلها|حملها|حمّل|حمل|اطبعها|اطبع|export|convert|download|save as|make it|turn it into|as a)/i;
// "about <topic>" markers signal a NEW authoring request ("make a deck ABOUT X"),
// so we must NOT treat those as an export of the previous document.
const AUTHORING_TOPIC_RE = /(\bعن\b|\bحول\b|\bبخصوص\b|\bبشأن\b|\babout\b|\bregarding\b)/i;
// Detect export intent and map to a target format. Returns null when it is not a
// (short, format-bearing) export command — so normal authoring requests like
// "اكتب لي تقرير …" / "اعملي عرض عن الحوكمة" are never swallowed.
const detectExportIntent = (text: string): { kind: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html'; label: string } | null => {
  const s = text.trim();
  if (!s) return null;
  if (!EXPORT_VERB_RE.test(s)) return null;       // require a convert/download verb
  if (AUTHORING_TOPIC_RE.test(s)) return null;     // "… عن/حول <topic>" → new authoring, not export
  // Keep it terse: a command about the previous doc, not a new authoring request.
  // ~12 words / 80 chars is plenty for "صدّرها word" / "convert to pdf".
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (wordCount > 12 || s.length > 80) return null;
  for (const f of EXPORT_FMT) {                    // require a format token; first match wins
    if (f.re.test(s)) return { kind: f.kind, label: f.label };
  }
  return null;
};

// HWK-A4: a panel-scoped error boundary. Without it, a render error inside the
// copilot panel escapes to the app-level ErrorBoundary, which unmounts the
// whole GovernanceCenter — to the user, the run "did a refresh and disappeared".
// This catches the error inside the panel, shows an in-app error state with a
// retry, and leaves the rest of the page intact. It is a backstop; mermaid
// render throws are already contained by MermaidErrorBoundary in Markdown.tsx.
class CopilotRunBoundary extends React.Component<{ ar: boolean; children: React.ReactNode }, { error: string | null }> {
  // This project ships no @types/react, so inherited members aren't typed (see ErrorBoundary.tsx).
  declare props: { ar: boolean; children: React.ReactNode };
  declare setState: (partial: { error: string | null }) => void;
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(err: unknown) { return { error: err instanceof Error ? err.message : String(err) }; }
  componentDidCatch(err: unknown, info: unknown) { console.error('[CopilotRunBoundary]', err, info); }
  render() {
    const { ar } = this.props;
    if (this.state.error !== null) {
      return (
        <div className="gc-shell fixed top-3 bottom-3 end-3 z-40 w-[min(94vw,440px)] rounded-[28px] flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-[14px] font-bold text-slate-800 dark:text-slate-100">{ar ? 'حدث خطأ في المساعد' : 'Copilot hit an error'}</p>
          <pre className="text-[11px] text-rose-600 bg-rose-50 dark:bg-rose-900/20 rounded-lg p-3 overflow-auto text-start whitespace-pre-wrap max-w-full">{this.state.error}</pre>
          <button type="button" onClick={() => this.setState({ error: null })} className="hw-btn hw-btn-primary hw-btn-sm">{ar ? 'إعادة المحاولة' : 'Retry'}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const GovCopilot: React.FC<Props> = (props) => {
  const { stageKey, stageLabel, model, language, extraContext, logoUrl, tenantId, seedChunks, stateSnapshot, onOpenSource, onApplyDepartments } = props;
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
  // Document canvas — the open doc (by message id) + in-session edited-HTML cache
  // so reopening a document shows the user's edits.
  // NOTE (P12/MINOR-modularity, out of this PR's scope): this open/track/persist
  // "canvas session" state machine duplicates GovernanceCenter's
  // openArtifactInCanvas/saveCanvasArtHtml (a richer strategy — Firestore-backed,
  // not just localStorage). Left as-is here; unifying the two into a shared
  // useCanvasSession hook is a separate modularity lane, not a GovCopilot-only fix.
  const [canvasDoc, setCanvasDoc] = useState<{ id: string; md: string } | null>(null);
  const canvasEditsRef = useRef<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  // ── V5 + V16 + V27: conversational build wizard (now OPT-IN) ──
  // Before a long autonomous build the copilot can propose an editable plan
  // (length, axes, departments, components, notes); nothing is fixed. `plan` is
  // that editable contract; `building` is true while a confirmed plan is
  // generating (so the user can intervene). V27 — the copilot is CONVERSATIONAL
  // BY DEFAULT: `wizardOn` now defaults OFF, so a normal message gets a real
  // grounded reply instead of a forced build-plan. Turning it ON (the toggle in
  // the composer) restores the "ask before generating" wizard for every doc
  // request; an explicit build command still opens it either way (see send()).
  const [wizardOn, setWizardOn] = useState(false);
  const [plan, setPlan] = useState<BuildPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);     // proposing/regenerating a plan
  const [building, setBuilding] = useState(false);     // a confirmed plan is generating
  const [deptDraft, setDeptDraft] = useState('');      // add-department input
  const [axisDraft, setAxisDraft] = useState('');      // add-axis input
  const [interjectNote, setInterjectNote] = useState(''); // mid-build note (V16 intervene)
  const planReqRef = useRef('');                       // the original request that opened the plan
  const planAbortRef = useRef<AbortController | null>(null);
  const buildInterruptedRef = useRef(false);           // user paused a build to adjust the plan
  const scrollRef = useRef<HTMLDivElement>(null);
  const chunksRef = useRef<DocChunk[] | null>(null);
  // Ask-mode image/video attachments (multimodal RAG via gemini-embedding-2). Kept
  // LOCAL to the copilot (no new parent props) so it never touches the parent.
  const [attachments, setAttachments] = useState<{ file: File; url: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Memoizes the one-time sync of this tenant's docs into the Python copilot
  // corpus (see ensureCorpus). Reset when the tenant changes.
  const corpusReadyRef = useRef<Promise<void> | null>(null);

  // ── Durable chat history (backend-backed conversation threads) ──
  const [convs, setConvs] = useState<CopilotConvSummary[]>([]);   // history list, newest first
  const [convId, setConvId] = useState<string>('');               // active thread id ('' = fresh)
  const [histOpen, setHistOpen] = useState(false);                // history drawer toggle
  const convIdRef = useRef<string>('');                           // stable read in async/effects
  const convCreatedRef = useRef<number | undefined>(undefined);   // preserve created_at across saves
  const suppressSaveRef = useRef(false);                          // skip autosave right after hydration
  const historyOn = copilotEnabled() && !!tenantId;              // history needs the Python backend

  // Invalidate cached chunks AND reset the chat when the tenant changes.
  useEffect(() => {
    chunksRef.current = null; corpusReadyRef.current = null;
    convIdRef.current = ''; convCreatedRef.current = undefined;
    setConvId(''); setConvs([]); setMsgs([]); setHistOpen(false);
    setPlan(null); setBuilding(false); setPlanBusy(false);
  }, [tenantId]);

  const lsKey = (tid: string) => `gc_conv:${tid}`;
  // HWK-A3: a localStorage mirror of the IN-FLIGHT run so a refresh/crash mid-generation
  // can be recovered. The backend autosave only fires once a turn settles (!busy), so a
  // reload during the 7–8 min draft would otherwise lose everything.
  const lsDraftKey = (tid: string) => `gc_draft:${tid}`;
  // V14: persist in-canvas edits (by message id) so reopening a document — even
  // after a reload — shows the user's edits. Mirrors the conversation persistence.
  const lsCanvasKey = (tid: string) => `gc_canvas_edits:${tid}`;
  const persistCanvasEdits = (tid: string) => {
    try { localStorage.setItem(lsCanvasKey(tid), JSON.stringify(canvasEditsRef.current)); } catch { /* quota — ignore */ }
  };
  const hydrateDraftMsgs = (arr: any[]): Msg[] => (arr || []).map((m: any): Msg => ({
    id: m.id || nid(),
    sender: m.sender === 'user' ? 'user' : 'agent',
    text: m.text || '',
    thoughts: [], steps: [], thinking: false, streaming: false,
    sources: m.sources, srcRefs: m.srcRefs, webSources: m.webSources, searchHtml: m.searchHtml,
  }));

  // Serialize the live messages to the durable shape (drop transient fields).
  const serializeMsgs = (ms: Msg[]) => ms
    .filter(m => !(m.sender === 'agent' && !m.text.trim()))   // skip empty streaming placeholder
    .map(m => ({
      id: m.id, sender: m.sender, text: m.text,
      sources: m.sources, srcRefs: m.srcRefs, webSources: m.webSources, searchHtml: m.searchHtml,
    }));

  // Mint a thread id on first turn of a fresh conversation (idempotent).
  const ensureConvId = (): string => {
    if (convIdRef.current) return convIdRef.current;
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    convIdRef.current = id; setConvId(id);
    convCreatedRef.current = Date.now() / 1000;
    try { if (tenantId) localStorage.setItem(lsKey(tenantId), id); } catch { /* ignore */ }
    return id;
  };

  const refreshConvs = async () => {
    if (!historyOn) return;
    try { setConvs(await listConversations(tenantId!)); } catch { /* offline → keep current */ }
  };

  // Persist the current thread (debounced via the autosave effect). Captures every
  // turn type uniformly — grounded Q&A, full drafts, web-researched docs, exports.
  const persistConversation = async (ms: Msg[]) => {
    if (!historyOn) return;
    const messages = serializeMsgs(ms);
    if (!messages.length) return;
    const id = ensureConvId();
    try {
      const summary = await saveConversation(tenantId!, { id, messages, created_at: convCreatedRef.current });
      setConvs(cs => [summary, ...cs.filter(c => c.id !== summary.id)]);
      // HWK-A3: the turn is now durably saved → the in-flight recovery mirror is no longer needed.
      try { if (tenantId) localStorage.removeItem(lsDraftKey(tenantId)); } catch { /* ignore */ }
    } catch { /* offline → will retry on the next turn */ }
  };

  // Load a saved thread into the chat (hydrate, without re-saving it).
  const loadConversation = async (id: string) => {
    if (!historyOn || !id) return;
    try {
      const conv = await getConversation(tenantId!, id);
      if (!conv) { setConvs(cs => cs.filter(c => c.id !== id)); return; }
      suppressSaveRef.current = true;
      setMsgs((conv.messages || []).map((m: any): Msg => ({
        id: m.id || nid(),
        sender: m.sender === 'user' ? 'user' : 'agent',
        text: m.text || '',
        thoughts: [], steps: [], thinking: false, streaming: false,
        sources: m.sources, srcRefs: m.srcRefs, webSources: m.webSources, searchHtml: m.searchHtml,
      })));
      convIdRef.current = conv.id; setConvId(conv.id);
      convCreatedRef.current = conv.created_at;
      try { localStorage.setItem(lsKey(tenantId!), conv.id); } catch { /* ignore */ }
      setHistOpen(false);
      scrollDown();
    } catch { /* keep current view */ }
  };

  const newChat = () => {
    setMsgs([]); convIdRef.current = ''; setConvId(''); convCreatedRef.current = undefined;
    try { if (tenantId) { localStorage.removeItem(lsKey(tenantId)); localStorage.removeItem(lsDraftKey(tenantId)); } } catch { /* ignore */ }
    setHistOpen(false); setInput('');
    setPlan(null); setBuilding(false);   // drop any open build plan
    setAttachments(a => { a.forEach(x => URL.revokeObjectURL(x.url)); return []; });
  };

  const removeConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConvs(cs => cs.filter(c => c.id !== id));
    try { await deleteConversation(tenantId!, id); } catch { /* best effort */ }
    if (convIdRef.current === id) newChat();
  };

  // On open: recover an interrupted run first, then load history / resume the last thread.
  useEffect(() => {
    if (!open || !tenantId) return;
    // V14: rehydrate persisted in-canvas edits so reopening a document shows them.
    try { const raw = localStorage.getItem(lsCanvasKey(tenantId)); if (raw) canvasEditsRef.current = JSON.parse(raw) || {}; } catch { /* ignore */ }
    if (!convIdRef.current && !msgs.length) {
      // HWK-A3: a refresh mid-generation left a draft mirror → restore it (works even when
      // the backend history is off). Not suppressing autosave, so the recovered run is then
      // saved to the backend normally and the mirror is cleared.
      let draft: any = null;
      try { const raw = localStorage.getItem(lsDraftKey(tenantId)); if (raw) draft = JSON.parse(raw); } catch { /* ignore */ }
      if (draft && Array.isArray(draft.msgs) && draft.msgs.length) {
        setMsgs(hydrateDraftMsgs(draft.msgs));
        if (draft.convId) { convIdRef.current = draft.convId; setConvId(draft.convId); }
        if (draft.created) convCreatedRef.current = draft.created;  // keep the original created_at through recovery
        scrollDown();
      } else if (historyOn) {
        let saved = ''; try { saved = localStorage.getItem(lsKey(tenantId)) || ''; } catch { /* ignore */ }
        if (saved) loadConversation(saved);
      }
    }
    if (historyOn) refreshConvs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId]);

  // Autosave the thread once a turn settles (not mid-stream). Debounced.
  useEffect(() => {
    if (!historyOn || busy || !msgs.length) return;
    if (suppressSaveRef.current) { suppressSaveRef.current = false; return; }  // skip the hydration echo
    const h = window.setTimeout(() => { persistConversation(msgs); }, 700);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, busy]);

  // HWK-A3: while a turn is streaming, mirror it to localStorage so a refresh/crash mid-run
  // can be recovered on next open. Cleared once the turn is durably persisted (persistConversation)
  // or on newChat. Only writes while busy, so it never interferes with settled-turn autosave.
  useEffect(() => {
    if (!tenantId || !busy || !msgs.length) return;
    try {
      localStorage.setItem(lsDraftKey(tenantId), JSON.stringify({
        convId: convIdRef.current, created: convCreatedRef.current, msgs: serializeMsgs(msgs), at: Date.now(),
      }));
    } catch { /* localStorage quota — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, busy, tenantId]);

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
  // P12 — also return `refs`: one {doc, heading} pair per distinct source doc,
  // in retrieval order. This is the same {doc, heading} shape the backend
  // labels "مصدر N" and toCiteRefs consumes; the local (Python-backend-disabled)
  // fallback previously only kept a bare doc-name Set (`sources`), so its
  // generated docs never got srcRefs / clickable citations like the
  // backend-enabled branches do (see the runGeneration call site below).
  const buildFileContext = async (q: string, signal: AbortSignal): Promise<{ ctx: string; count: number; sources: string[]; refs: { doc: string; heading?: string }[] }> => {
    const chunks = chunksRef.current;
    if (!chunks || !chunks.length) return { ctx: '', count: 0, sources: [], refs: [] };
    try {
      const rc = await retrieve(q, chunks, 12, signal);
      if (!rc.length) return { ctx: '', count: 0, sources: [], refs: [] };
      const docs = new Set<string>();
      const refs: { doc: string; heading?: string }[] = [];
      let used = 0;
      const parts: string[] = [];
      for (const r of rc) {
        const c = r.chunk;
        const piece = `[${c.docName}${c.headingPath ? ' › ' + c.headingPath : ''}]\n${c.text}`;
        if (used + piece.length > 9000) break;
        parts.push(piece); used += piece.length + 2;
        if (!docs.has(c.docName)) { docs.add(c.docName); refs.push({ doc: c.docName, heading: c.headingPath || undefined }); }
      }
      return { ctx: parts.join('\n\n'), count: docs.size, sources: [...docs], refs };
    } catch { return { ctx: '', count: 0, sources: [], refs: [] }; }
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
      if (f && (f.type.startsWith('image/') || f.type.startsWith('video/'))) picked.push(f);
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
    const q = raw || t('حلّل الوسائط المرفقة (صور/فيديو) وصِفها.', 'Analyze and describe the attached media (images/video).');

    // EXPORT INTENT — "اعملها pdf" / "صدّرها word" / "convert to pdf". Turn the
    // LAST generated document into a real file via the existing export pipeline,
    // instead of routing to the LLM (which refuses to send a binary file). Runs
    // first, before the thinking bubble / backend routing.
    if (raw && !att.length) {
      const exp = detectExportIntent(raw);
      if (exp) {
        setInput('');
        setAttachments([]);
        const lastDoc = [...msgs].reverse().find(m => m.sender === 'agent' && m.text.trim().length > 40);
        if (!lastDoc) {
          const noDoc: Msg = {
            id: nid(), sender: 'agent',
            text: t('لا توجد وثيقة لتصديرها بعد — اطلب إنشاء وثيقة أولاً.', 'No document to export yet — ask me to create one first.'),
            thoughts: [], steps: [], thinking: false, streaming: false,
          };
          setMsgs(m => [...m, noDoc]);
          scrollDown();
          return;
        }
        const userMsg: Msg = { id: nid(), sender: 'user', text: q, thoughts: [], steps: [], thinking: false, streaming: false };
        const doneId = nid();
        const statusMsg: Msg = {
          id: doneId, sender: 'agent',
          text: t(`جارٍ تجهيز ملف ${exp.label} للتحميل…`, `Preparing your ${exp.label} file for download…`),
          thoughts: [], steps: [], thinking: false, streaming: false,
        };
        setMsgs(m => [...m, userMsg, statusMsg]);
        scrollDown();
        try {
          // P5/D6 — pass the message id so exportAs resolves the EDITED canvas
          // HTML (effectiveExportMd) when this document was opened & edited in
          // the canvas, instead of always exporting the original markdown.
          await exportAs(exp.kind, lastDoc.text, lastDoc.id);
          setMsgs(ms => ms.map(m => m.id === doneId
            ? { ...m, text: t('تم تجهيز الملف ✓ — تحقّق من تنزيلاتك.', 'File ready ✓ — check your downloads.') }
            : m));
        } catch {
          setMsgs(ms => ms.map(m => m.id === doneId
            ? { ...m, text: t('تعذّر تجهيز الملف. أعد المحاولة.', 'Could not prepare the file. Please retry.') }
            : m));
        }
        scrollDown();
        return;
      }
    }

    // V27 — CONVERSATIONAL BY DEFAULT: a normal message flows straight to a real
    // grounded reply (the ask/draft path below) and is NOT pushed into a build
    // plan. The wizard is opt-in: shouldOpenBuildWizard() opens the editable plan
    // only when the user turned the wizard ON (any doc request) OR clearly asked
    // to build (an explicit build command), preserving the V5/V16 flow exactly.
    if (raw && !att.length && mode === 'ask' && !plan && !planBusy && !building
        && shouldOpenBuildWizard({ wizardOn, text: raw, longForm: isLongFormRequest(raw) })) {
      setInput('');
      await openPlan(q);
      return;
    }

    setInput('');
    setAttachments([]);
    await runGeneration(q, att);
  };

  // Propose an editable build plan for a request (the wizard's "ask first" turn,
  // V5). proposeBuildPlan never throws — it falls back to a deterministic plan —
  // so the card always appears. The request shows as the user's chat bubble.
  const openPlan = async (request: string) => {
    planReqRef.current = request;
    const userMsg: Msg = { id: nid(), sender: 'user', text: request, thoughts: [], steps: [], thinking: false, streaming: false };
    ensureConvId();
    setMsgs(m => [...m, userMsg]);
    setPlan(null);
    setPlanBusy(true);
    scrollDown();
    const ac = new AbortController();
    planAbortRef.current = ac;
    try {
      const { ctx } = await buildFileContext(request, ac.signal);
      const p = await proposeBuildPlan({ request, model, language, fileContext: ctx, signal: ac.signal });
      if (!ac.signal.aborted) { setPlan(p); setDeptDraft(''); setAxisDraft(''); }
    } finally {
      setPlanBusy(false);
      planAbortRef.current = null;
      scrollDown();
    }
  };

  // Accept the (edited) plan → fold any new departments into the model (V16),
  // then build using the CONFIRMED plan as the generation request (V5). The plan
  // stays in state during the build so the user can intervene (stop & adjust).
  const acceptPlan = async () => {
    if (!plan || busy) return;
    const confirmed = plan;
    buildInterruptedRef.current = false;
    try { onApplyDepartments?.(confirmed.departments); } catch { /* parent sync best-effort */ }
    const request = planToBuildRequest(confirmed, language);
    setBuilding(true);
    // P5/D1 — pass the CONFIRMED plan itself (not just its prose serialization)
    // so the backend path sends it through as the structured `plan` field too.
    await runGeneration(request, [], { targetPages: clampPlanPages(confirmed.targetPages), userText: null, plan: confirmed });
    setBuilding(false);
    if (!buildInterruptedRef.current) setPlan(null);   // plan consumed unless the user paused to adjust
  };

  // Build directly from the ORIGINAL request, skipping the plan (the one-shot
  // fallback the wizard must never remove).
  const skipPlanAndBuild = async () => {
    const request = planReqRef.current;
    setPlan(null);
    if (request) await runGeneration(request, []);
  };

  // V16 — intervene mid-build: stop the current generation and reopen the plan
  // (carrying a note the user just typed) so they can adjust departments / scope /
  // notes and rebuild. Finer-grained live injection without a restart is a
  // documented follow-up.
  const interveneAndAdjust = () => {
    buildInterruptedRef.current = true;
    abortRef.current?.abort();
    if (interjectNote.trim()) {
      setPlan(p => (p ? { ...p, notes: (p.notes ? p.notes + '\n' : '') + interjectNote.trim() } : p));
    }
    setInterjectNote('');
    setBuilding(false);   // plan card reappears (plan retained)
  };

  // The generation turn — shared by the direct path and the wizard accept.
  // `opts.userText === null` suppresses the user bubble (wizard build, where the
  // serialized plan request is internal); `opts.targetPages` pins the V4 length.
  // `opts.plan` (P5/D1) is the CONFIRMED wizard plan — present only when this
  // turn came from acceptPlan() — sent through as the backend's structured
  // `plan` field alongside the prose request.
  const runGeneration = async (q: string, att: { file: File; url: string }[], opts?: { targetPages?: number; userText?: string | null; plan?: BuildPlan }) => {
    const attNote = att.length ? t(` (${att.length} ملف مرفق)`, ` (${att.length} file(s) attached)`) : '';
    const agentId = nid();
    const queued: Msg[] = [];
    if (opts?.userText !== null) queued.push({ id: nid(), sender: 'user', text: (opts?.userText ?? q) + attNote, thoughts: [], steps: [], thinking: false, streaming: false });
    queued.push({ id: agentId, sender: 'agent', text: '', thoughts: [], steps: [], thinking: true, streaming: true });
    const history: ChatTurn[] = msgs.map(m => ({ role: m.sender === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
    ensureConvId();   // stable thread id for this turn (and durable autosave)
    setMsgs(m => [...m, ...queued]);
    setBusy(true);
    scrollDown();
    const ac = new AbortController();
    abortRef.current = ac;
    const patch = (fn: (m: Msg) => Msg) => setMsgs(ms => ms.map(m => m.id === agentId ? fn(m) : m));
    try {
      // Document creation that needs CURRENT/EXTERNAL facts → web-grounded
      // (Google Search) document, merged with the user's own files. Front-end
      // path (Gemini google skill), independent of the backend. Degrades to the
      // normal draft on any failure.
      if (!att.length && isLongFormRequest(q) && needsWebResearch(q)) {
        patch(m => ({ ...m, thoughts: [...m.thoughts, { id: nid(), text: t('يبحث في الويب لتجميع أحدث المعلومات…', 'Searching the web for the latest information…') }] }));
        scrollDown();
        try {
          const { ctx, sources } = await buildFileContext(q, ac.signal);
          // P5/D3 — this path had NO length parameter at all (the "asked 10 got
          // 105" bug): thread the SAME requested page count every other path
          // honors (the wizard's confirmed target, else parsed straight from q).
          const researchPages = opts?.targetPages ?? parseTargetPages(q);
          const gdoc = await generateGroundedDocument(q, ctx, language || 'ar', ac.signal, researchPages);
          if (ac.signal.aborted) { patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('أُلغي.', 'Cancelled.') })); return; }
          patch(m => ({ ...m, thinking: false, streaming: false, text: gdoc.markdown, sources: sources.length ? sources : m.sources, webSources: gdoc.webSources, searchHtml: gdoc.searchSuggestionsHtml }));
          return;
        } catch { /* web research failed → fall through to the normal draft path */ }
        // If the user aborted during research, stop here — don't fire a ghost draft.
        if (ac.signal.aborted) { patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('أُلغي.', 'Cancelled.') })); return; }
      }
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
          patch(m => ({ ...m, thoughts: [...m.thoughts, { id: nid(), text: t('جاري تحليل وفهرسة الوسائط المرفقة…', 'Analyzing & indexing attached media…') }] }));
          scrollDown();
          try { await copilotIngest(corpus, att.map(a => a.file)); } catch { /* non-fatal */ }
        }
        if (isLongFormRequest(q)) {
          // Long-form drafting runs 7-8 min; narrate the stages so the panel is
          // never silent (HWK-A1). draftStream() relays real backend events when
          // /draft/stream is deployed, else a timer-based heartbeat. Dedupe by
          // stage so a backend that re-emits 'drafting' per section adds no spam.
          const STAGE_LABELS: Record<string, [string, string]> = {
            outline:  ['جاري بناء هيكل الوثيقة…',    'Building the document outline…'],
            drafting: ['جاري صياغة أقسام الوثيقة…',   'Drafting the document sections…'],
            critique: ['جاري مراجعة جودة المسودة…',    'Reviewing the draft quality…'],
            revising: ['جاري تحسين الأقسام المحددة…',  'Revising the flagged sections…'],
          };
          let lastStage = '';
          // P5/D1+D2 — send the confirmed structured plan (bypasses backend
          // keyword deliverable routing entirely) and the real-company grounding
          // (company/org_units/roles/departments/current_state) alongside the
          // prose request, instead of {corpus, request, language, target_pages}
          // only.
          const planPayload = opts?.plan ? planToPayload(opts.plan) : undefined;
          const grounding = buildGrounding(model, { plan: planPayload, language });
          const doc = await copilotDraftStream(
            { corpus, request: q + FORMAT_HINT, language, target_pages: opts?.targetPages, plan: planPayload, ...grounding },
            ev => {
              const [ar2, en2] = STAGE_LABELS[ev.stage] ?? ['جاري المعالجة…', 'Processing…'];
              const label = t(ar2, en2);
              const stageChanged = ev.stage !== lastStage;
              lastStage = ev.stage;
              // P12 — ev.done/ev.total are per-SECTION counters: a single stage
              // like "drafting" emits many events as sections complete. The old
              // `if (ev.stage === lastStage) return` dedup dropped every one of
              // those after the first, so a 4+ chunk draft never advanced past
              // "drafting the document sections…" for 7-8 min. Now every event
              // updates draftProgress (percent + "section N of M", rendered by
              // GcDraftProgress below); the timeline (`steps`) still only mutates
              // on an actual stage change, so it keeps showing "did X ✓, now Y…".
              patch(m => {
                let steps = m.steps;
                if (stageChanged) {
                  const prior = m.steps.map(s => s.status === 'running' ? { ...s, status: 'done' as const } : s);
                  const exists = prior.some(s => s.step === ev.stage);
                  steps = exists
                    ? prior.map(s => s.step === ev.stage ? { ...s, label, status: 'running' as const } : s)
                    : [...prior, { id: nid(), step: ev.stage, label, status: 'running' as const }];
                }
                return { ...m, steps, draftProgress: { stage: ev.stage, label, done: ev.done, total: ev.total } };
              });
              scrollDown();
            },
            ac.signal,
          );
          const docs = [...new Set(doc.sources.map(s => s.doc).filter(Boolean))];
          // Generation finished → close out every step in the timeline and drop
          // the live progress readout (the message is done; nothing left to show).
          patch(m => ({ ...m, thinking: false, streaming: false, text: doc.markdown, sources: docs, srcRefs: toCiteRefs(doc.sources), steps: m.steps.map(s => s.status === 'running' || s.status === 'pending' ? { ...s, status: 'done' as const } : s), draftProgress: undefined }));
        } else {
          // HWK-A5: route /ask through the unified generation-progress contract.
          const onAsk: GenerationProgressHandler = ev => {
            if (ev.type === 'sources') { const d = [...new Set(ev.items.map(s => s.doc).filter(Boolean))]; const refs = toCiteRefs(ev.items); patch(m => ({ ...m, sources: d.length ? d : m.sources, srcRefs: refs.length ? refs : m.srcRefs })); }
            else if (ev.type === 'delta') { patch(m => ({ ...m, thinking: false, text: m.text + ev.text })); scrollDown(); }
            else if (ev.type === 'done') { patch(m => ({ ...m, thinking: false, streaming: false })); }
            else if (ev.type === 'error') { patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('تعذّر الرد. أعد المحاولة.', 'Failed. Retry.') })); }
          };
          // P5/D2 — send the same real-company grounding on /ask too (forward-
          // compatible; see copilotClient.askStream's doc comment on today's
          // backend not yet consuming it).
          // P12/CRITICAL — `message` MUST be the raw question (askMessagePayload
          // is the identity — no FORMAT_HINT), or every message exceeds the
          // backend's 40-char smalltalk gate and the conversational carve-out is
          // unreachable. `history` was already raw (Msg.text never carries the
          // hint — it's appended only at send time), so no change needed there.
          await copilotAsk(
            {
              corpus, message: askMessagePayload(q), history: history.map(h => ({ role: h.role, content: h.parts?.[0]?.text || '' })),
              conversation_id: convIdRef.current, ...buildGrounding(model, { language }),
            },
            toAskCallbacks(onAsk),
            ac.signal,
          );
        }
        return;
      }
      const { ctx, count, sources, refs } = await buildFileContext(q, ac.signal);
      // P12/MAJOR — populate srcRefs here too (toCiteRefs on the {doc, heading}
      // refs), matching the backend-enabled branches above, so a document
      // generated via this local fallback keeps its per-claim citation mapping
      // instead of losing clickable citations in the canvas/citation UI.
      if (sources.length) patch(m => ({ ...m, sources, srcRefs: refs.length ? toCiteRefs(refs) : m.srcRefs }));
      // HWK-A5: route stageChat through the same unified generation-progress contract.
      const onStage: GenerationProgressHandler = ev => {
        if (ev.type === 'thought') { patch(m => ({ ...m, thoughts: [...m.thoughts, { id: nid(), text: ev.text }] })); scrollDown(); }
        else if (ev.type === 'delta') { patch(m => ({ ...m, thinking: false, text: m.text + ev.text })); scrollDown(); }
        else if (ev.type === 'done') { patch(m => ({ ...m, thinking: false, streaming: false })); }
        else if (ev.type === 'error') { patch(m => ({ ...m, thinking: false, streaming: false, text: m.text || t('تعذّر الرد. أعد المحاولة.', 'Failed. Retry.') })); }
      };
      await stageChat(
        {
          stage: stageKey, model, history, message: stageChatMessagePayload(q), language, signal: ac.signal,
          extraContext, mode, fileContext: ctx, fileCount: count, longForm: isLongFormRequest(q) || !!opts?.targetPages,
          targetPages: opts?.targetPages,
          stateSnapshot,
        },
        toStreamCallbacks(onStage),
      );
    } catch (e) {
      // HWK-A4: distinguish a user/unmount abort from a real failure so the message
      // is correct and only genuine errors are logged. HWK-A2: flip the active
      // timeline step to error, not leave it spinning. Either way the error is
      // surfaced IN the panel — it never bubbles up to reload/unmount the page.
      const isAbort = e instanceof DOMException && e.name === 'AbortError';
      // P12/MAJOR — `text: m.text || failText` only ever kicked in when the
      // bubble was still EMPTY; a stream that already rendered tokens before
      // erroring/aborting kept its partial text with zero indication it was
      // truncated, so the user couldn't tell it apart from a finished answer.
      // Mark it `interrupted` (with a retry that re-runs this exact turn) so
      // the bubble shows a visible notice instead of a silently-truncated
      // "finished" answer — the partial text itself is still kept verbatim.
      patch(m => {
        const hadText = !!m.text.trim();
        return {
          ...m,
          thinking: false, streaming: false,
          text: m.text || (isAbort ? t('أُلغيت العملية.', 'Cancelled.') : t('تعذّر الرد.', 'Failed.')),
          interrupted: hadText,
          onRetry: hadText ? () => { runGeneration(q, att, opts).catch(() => {}); } : undefined,
          steps: m.steps.map(s => s.status === 'running' ? { ...s, status: isAbort ? ('done' as const) : ('error' as const) } : s),
        };
      });
      if (!isAbort) console.error('[GovCopilot] generation error:', e);
    } finally {
      att.forEach(a => URL.revokeObjectURL(a.url));   // free object URLs
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); planAbortRef.current?.abort(); setBusy(false); };

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

  // P8 — a ```mermaid fence rendered inside an assistant bubble now has an "edit by
  // chatting" pencil (EditableDiagram, via Markdown's onMermaidEdit). Accepting an
  // edit rewrites that ONE fence inside the message's own stored text; the existing
  // debounced autosave effect (keyed on `msgs`) then persists it like any other turn.
  const handleMermaidEdit = (msgId: string, oldCode: string, newCode: string) => {
    setMsgs(ms => ms.map(m => (m.id === msgId ? { ...m, text: replaceMermaidFence(m.text, oldCode, newCode) } : m)));
  };
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); }, []);
  // HWK-A4: if the panel ever unmounts mid-run (parent navigates / an outer
  // boundary fires), abort the in-flight request instead of leaving a ghost
  // fetch whose late resolution would setState on an unmounted tree.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // FE-1: a chat bubble's export should match the EDITED canvas (true WYSIWYG),
  // not the raw model markdown. When a message has been opened + edited in the
  // document canvas, its saved HTML is serialized back to Markdown through the
  // same bridge DocumentCanvas uses; otherwise we fall back to the raw markdown.
  const effectiveExportMd = (id: string | undefined, md: string): string => {
    const html = id ? canvasEditsRef.current[id] : undefined;
    if (html) {
      try { const conv = canvasHtmlToMarkdown(html); if (conv && conv.trim()) return conv; }
      catch { /* fall back to the raw markdown below */ }
    }
    return md;
  };

  // Turn any answer into a real downloadable file. `id` (when given) lets the
  // export reflect that message's in-canvas edits (FE-1).
  const exportAs = async (kind: 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'html', md: string, id?: string) => {
    const source = effectiveExportMd(id, md);
    // Busy key stays keyed on the raw md so the right button shows its spinner.
    const title = (source.match(/^#+\s*(.+)$/m)?.[1] || stageLabel || 'governance').slice(0, 60).trim();
    setExporting(kind + md.slice(0, 8));
    const o = {
      language: (language || 'ar') as Language,
      fontFamily: 'Tajawal',
      companyName: model?.companyName || undefined,
      logoUrl: logoUrl || undefined,
    };
    try {
      // PDF always renders in-app (brand-styled: teal + Thmanyah via html2canvas),
      // even when the Python backend is enabled — it's the brand document surface.
      if (kind === 'pdf') { await exportMessagePdfDirect(source, title, o); return; }
      // P5/D7 — the backend's markdown renderer cannot embed images at all (see
      // copilotClient.hasMermaidFence for the full reasoning), so a diagram-
      // bearing DOCX/PPTX must go through the in-app exporters below — they
      // already rasterize + embed real diagram images — instead of the backend,
      // which would otherwise dump the raw ```mermaid source as literal text.
      const bypassBackendForDiagram = hasMermaidFence(source) && (kind === 'docx' || kind === 'pptx');
      // Other formats: server-side rendering via the Python agent when enabled
      // (Arabic RTL DOCX/XLSX/PPTX/HTML), else the in-app exporters.
      if (copilotEnabled() && !bypassBackendForDiagram) {
        await copilotExport(source, title, kind, { company: model?.companyName || undefined });
        return;
      }
      if (kind === 'docx') await exportMessageDocx(source, title, o);
      else if (kind === 'html') await exportMessageHtml(source, title, o);
      else if (kind === 'xlsx') exportMessageXlsx(source, title);
      else await exportMessagePptx(source, title, { companyName: model?.companyName || undefined, logoUrl: logoUrl || undefined });
    } catch (e) {
      // P5/D5 — this used to swallow every failure with console.error only, so
      // the chat quick-export caller (send()) always overwrote the status bubble
      // with a false "تم تجهيز الملف ✓" even on a backend 500 or an empty blob.
      // Rethrow so every caller sees the real outcome.
      console.error('export failed', e);
      throw e;
    }
    finally { setExporting(null); }
  };

  // ── Build-wizard plan editors (pure state updates) ──
  const updatePlan = (patch: Partial<BuildPlan>) => setPlan(p => (p ? { ...p, ...patch } : p));
  const addDept = () => { if (!plan || !deptDraft.trim()) return; updatePlan({ departments: addPlanItem(plan.departments, deptDraft) }); setDeptDraft(''); };
  const addAxis = () => { if (!plan || !axisDraft.trim()) return; updatePlan({ axes: addPlanItem(plan.axes, axisDraft) }); setAxisDraft(''); };

  // The editable plan card — the heart of the wizard (V5/V16). Everything is
  // editable: title, target pages, audience, governance axes (add/remove),
  // departments (add/remove), components (toggle), and free-text notes. Nothing
  // is fixed; "ابنِ الآن" runs the build from THIS confirmed config.
  const renderPlanCard = () => {
    if (!plan) return null;
    return (
      <div className="gc-msg-in rounded-2xl border border-[color:var(--hw-brand)]/30 bg-[var(--hw-brand-50,rgba(17,168,188,0.06))] dark:bg-slate-800/60 p-3.5 space-y-3" dir={ar ? 'rtl' : 'ltr'}>
        <div className="flex items-start gap-2.5">
          <RobotAvatar label={t('المساعد', 'Assistant')} className="w-7 h-7 mt-0.5" markClassName="w-[17px] h-[17px]" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-slate-800 dark:text-slate-100">{t('خطة البناء المقترحة — راجِعها وعدّلها قبل أن أبدأ', 'Proposed build plan — review & edit before I start')}</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{t('كل شيء قابل للتعديل: الطول، المحاور، الإدارات، الأقسام والملاحظات. ابدأ متى شئت.', 'Everything is editable: length, axes, departments, sections and notes. Build whenever you like.')}</div>
          </div>
        </div>

        {/* title + length + audience */}
        <div className="space-y-2">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide">{t('العنوان', 'Title')}</label>
          <input value={plan.title} onChange={e => updatePlan({ title: e.target.value })}
            className="hw-input w-full text-sm font-bold py-1.5" dir={ar ? 'rtl' : 'ltr'} />
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400">{t('عدد الصفحات', 'Pages')}</label>
              <input type="number" min={1} max={120} value={plan.targetPages}
                onChange={e => updatePlan({ targetPages: clampPlanPages(parseInt(e.target.value, 10)) })}
                className="hw-input w-16 text-sm text-center py-1.5" />
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-[10rem]">
              <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 shrink-0">{t('الجمهور', 'Audience')}</label>
              <input value={plan.audience} onChange={e => updatePlan({ audience: e.target.value })}
                className="hw-input flex-1 min-w-0 text-sm py-1.5" dir={ar ? 'rtl' : 'ltr'} />
            </div>
          </div>
        </div>

        {/* governance axes — add/remove */}
        {renderChipEditor(
          t('المحاور الحوكمية', 'Governance axes'),
          plan.axes,
          axisDraft, setAxisDraft, addAxis,
          v => updatePlan({ axes: removePlanItem(plan.axes, v) }),
          t('أضف محوراً…', 'Add an axis…'),
        )}

        {/* departments — add/remove (V16 core) */}
        {renderChipEditor(
          t('الإدارات المشمولة', 'Departments in scope'),
          plan.departments,
          deptDraft, setDeptDraft, addDept,
          v => updatePlan({ departments: removePlanItem(plan.departments, v) }),
          t('أضف إدارة…', 'Add a department…'),
        )}

        {/* components — toggle on/off */}
        <div className="space-y-1.5">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide">{t('الأقسام والمكوّنات', 'Sections & components')}</label>
          <div className="flex flex-wrap gap-1.5">
            {plan.components.map(c => (
              <button key={c.id} type="button" onClick={() => updatePlan({ components: toggleComponent(plan.components, c.id) })}
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${c.include ? 'bg-[var(--hw-brand-100)] text-[color:var(--hw-brand)] border-[color:var(--hw-brand)]/40' : 'bg-transparent text-slate-400 border-slate-300 dark:border-slate-600 line-through opacity-70'}`}
                title={c.include ? t('مُضمَّن — اضغط للاستبعاد', 'Included — click to exclude') : t('مُستبعَد — اضغط للتضمين', 'Excluded — click to include')}>
                {c.include ? '✓ ' : ''}{c.title}
              </button>
            ))}
          </div>
        </div>

        {/* notes */}
        <div className="space-y-1.5">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide">{t('ملاحظات وتوجيهات (تُطبَّق على كل قسم)', 'Notes & directives (applied to every section)')}</label>
          <textarea value={plan.notes} onChange={e => updatePlan({ notes: e.target.value })}
            rows={2} dir={ar ? 'rtl' : 'ltr'}
            placeholder={t('مثال: استخدم مصطلحات قطاع المقاولات وأضِف مصفوفة RACI لكل إجراء.', 'e.g. Use construction-sector terms and add a RACI matrix per procedure.')}
            className="hw-input w-full text-sm resize-y py-1.5" />
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-[var(--hw-border)]">
          <button onClick={() => { acceptPlan().catch(() => {}); }} disabled={busy} className="hw-btn hw-btn-primary hw-btn-sm !rounded-full">
            <GeminiSpark className="w-3.5 h-3.5" />{t('ابنِ الآن', 'Build now')}
          </button>
          <button onClick={() => { if (planReqRef.current) openPlan(planReqRef.current).catch(() => {}); }} disabled={busy || planBusy} className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full">
            {t('أعد اقتراح الخطة', 'Re-propose')}
          </button>
          <button onClick={() => { skipPlanAndBuild().catch(() => {}); }} disabled={busy} className="hw-btn hw-btn-ghost hw-btn-sm !rounded-full">
            {t('تخطّى وابنِ مباشرة', 'Skip & build directly')}
          </button>
          <button onClick={() => setPlan(null)} disabled={busy} className="hw-btn hw-btn-ghost hw-btn-sm !rounded-full ms-auto">
            {t('إلغاء', 'Cancel')}
          </button>
        </div>
      </div>
    );
  };

  // A reusable add/remove chip editor (axes + departments share it).
  const renderChipEditor = (
    label: string, items: string[],
    draft: string, setDraft: (v: string) => void, onAdd: () => void,
    onRemove: (v: string) => void, placeholder: string,
  ) => (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {items.map((v, i) => (
          <span key={`${v}-${i}`} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-[var(--hw-brand-100)] text-[color:var(--hw-brand)] border border-[color:var(--hw-brand)]/30">
            {v}
            <button type="button" onClick={() => onRemove(v)} title={t('إزالة', 'Remove')} aria-label={t('إزالة', 'Remove')} className="leading-none text-[13px] hover:text-rose-500">×</button>
          </span>
        ))}
        {!items.length && <span className="text-[11px] text-slate-400">{t('لا شيء بعد — أضِف بالأسفل.', 'None yet — add below.')}</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <input value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
          placeholder={placeholder} dir={ar ? 'rtl' : 'ltr'}
          className="hw-input flex-1 min-w-0 text-sm py-1.5" />
        <button type="button" onClick={onAdd} disabled={!draft.trim()} className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full shrink-0">{t('إضافة', 'Add')}</button>
      </div>
    </div>
  );

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

  // Generated-content action buttons — Ailigent design language (hw-btn + Thmanyah).
  // `id` ties the export to a message's in-canvas edits (FE-1).
  const exportBtn = (kind: 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'html', _icon: string, label: string, md: string, id?: string) => (
    <button onClick={() => { exportAs(kind, md, id).catch(() => {}); }} disabled={!!exporting}
      className="hw-btn hw-btn-subtle hw-btn-xs !rounded-full">
      {exporting === kind + md.slice(0, 8) ? <span className="hw-spin inline-block">↻</span> : <IconDownload />}{label}
    </button>
  );

  const exportRow = (md: string, id?: string) => (
    <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[var(--hw-border)]">
      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide me-0.5">{t('تصدير', 'Export')}</span>
      {exportBtn('html', '', t('HTML', 'HTML'), md, id)}
      {exportBtn('docx', '', 'Word', md, id)}
      {exportBtn('pdf', '', 'PDF', md, id)}
      {exportBtn('xlsx', '', 'Excel', md, id)}
      {exportBtn('pptx', '', t('عرض', 'Slides'), md, id)}
    </div>
  );

  // Open a generated document AS a templated multi-page document in the canvas
  // (cover → TOC → numbered sections, KPI cards, charts, premium tables). The
  // canvas is the brand document surface — view, edit in place, export a real PDF.
  const openCanvas = (id: string, md: string) => { setFull(false); setCanvasDoc({ id, md }); };

  // Primary "open as document" action for document-grade answers. Rendered above
  // the quick-export row so the canvas is the default way to read/edit/print a doc.
  const docCanvasBtn = (id: string, md: string) => (
    <div className="mt-2.5">
      <button onClick={() => openCanvas(id, md)}
        className="hw-btn hw-btn-primary hw-btn-xs !rounded-full">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M9 13h6M9 17h4" /></svg>
        {t('افتح كمستند', 'Open as document')}
      </button>
    </div>
  );

  // V27 — a chat bubble no longer exports directly; it opens in the canvas (the
  // single export surface) where the user can view, edit and export to any
  // format. Used for any substantial answer that isn't already offered as a
  // templated document via docCanvasBtn, so no answer keeps the old direct-export
  // buttons in the bubble.
  const openInCanvasBtn = (id: string, md: string) => (
    <div className="mt-2.5">
      <button onClick={() => openCanvas(id, md)}
        className="hw-btn hw-btn-subtle hw-btn-xs !rounded-full">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M9 13h6M9 17h4" /></svg>
        {t('افتح في الكانفس', 'Open in canvas')}
      </button>
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
    <>
    {canvasDoc && (
      <DocumentCanvas
        markdown={canvasDoc.md}
        initialHtml={canvasEditsRef.current[canvasDoc.id]}
        language={language || 'ar'}
        rootClass="dc-docked"
        brand={model?.companyName ? `${model.companyName} · AILIGENT` : 'AILIGENT'}
        subtitle={stageLabel}
        date={t('بتاريخ ', 'Dated ') + new Date().toLocaleDateString(ar ? 'ar-EG' : 'en-GB')}
        onClose={() => setCanvasDoc(null)}
        onSave={html => { canvasEditsRef.current[canvasDoc.id] = html; if (tenantId) persistCanvasEdits(tenantId); }}
        onShare={tenantId ? async (html, opts) => {
          // V14/V20 — mint a /?doc= client share from the live canvas HTML. The
          // message id is the stable doc id so the owner can correlate comments.
          const title = (canvasDoc.md.match(/^#{1,2}\s+(.+)$/m)?.[1] || model?.companyName || t('وثيقة حوكمة', 'Governance document')).slice(0, 120).trim();
          const { url } = await createSharedDoc({
            tenantId, docId: canvasDoc.id, docTitle: title, html,
            allowComments: opts.allowComments, accessCode: opts.accessCode,
          });
          return { url };
        } : undefined}
        onAskAi={sel => {
          setCanvasDoc(null);
          setInput(prev => `${prev ? prev + '\n' : ''}${t('بخصوص هذا المقطع: «', 'Regarding this passage: «')}${sel}»\n`);
        }}
      />
    )}
    <CopilotRunBoundary ar={ar}>
    <div className={shellCls} style={shellStyle} onAnimationEnd={onShellAnimEnd}>
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--hw-border)] shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <RobotAvatar
            label={t('مساعد الحوكمة الآلي', 'Governance copilot assistant')}
            className={`w-8 h-8 ${busy ? 'gc-spark-breathe' : ''}`}
            markClassName="w-[19px] h-[19px]"
          />
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
          {historyOn && (
            <>
              <button onClick={newChat} title={t('محادثة جديدة', 'New chat')} aria-label={t('محادثة جديدة', 'New chat')} className="gc-icon-btn">
                <IconNewChat />
              </button>
              <button onClick={() => { setHistOpen(o => !o); if (!histOpen) refreshConvs(); }}
                title={t('السجل', 'History')} aria-label={t('السجل', 'History')}
                className={`gc-icon-btn ${histOpen ? 'text-[color:var(--hw-accent,#11a8bc)]' : ''}`}>
                <IconHistory />
              </button>
            </>
          )}
          <button onClick={() => setFull(f => !f)} title={full ? t('تصغير', 'Restore') : t('ملء الشاشة', 'Full screen')} className="gc-icon-btn">
            {full ? <IconRestore /> : <IconExpand />}
          </button>
          <button onClick={requestClose} title={t('إغلاق', 'Close')} className="gc-icon-btn">
            <IconClose />
          </button>
        </div>
      </div>

      {/* history drawer — saved conversation threads (durable, backend-backed) */}
      {historyOn && histOpen && (
        <div className="absolute inset-0 z-30 flex flex-col bg-white dark:bg-slate-900 gc-panel-in" dir={ar ? 'rtl' : 'ltr'}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--hw-border)] shrink-0">
            <span className="text-[14px] font-bold text-slate-900 dark:text-slate-100">{t('سجل المحادثات', 'Chat history')}</span>
            <div className="flex items-center gap-1.5">
              <button onClick={newChat} className="hw-btn hw-btn-subtle hw-btn-xs !rounded-full"><IconNewChat />{t('جديدة', 'New')}</button>
              <button onClick={() => setHistOpen(false)} title={t('إغلاق', 'Close')} className="gc-icon-btn"><IconClose /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
            {convs.length === 0 ? (
              <div className="flex flex-col items-center text-center gap-2 py-14 px-6">
                <IconHistory />
                <p className="text-[12.5px] text-slate-400">{t('لا توجد محادثات محفوظة بعد', 'No saved conversations yet')}</p>
              </div>
            ) : convs.map(c => (
              <div key={c.id} role="button" tabIndex={0}
                onClick={() => loadConversation(c.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadConversation(c.id); } }}
                className={`group w-full text-start rounded-xl px-3 py-2.5 cursor-pointer flex items-start gap-2 transition ${c.id === convId ? 'bg-[var(--hw-accent-soft,rgba(17,168,188,0.12))] ring-1 ring-[var(--hw-accent,#11a8bc)]/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">{c.title || t('محادثة', 'Conversation')}</span>
                    <span className="ms-auto text-[10px] text-slate-400 shrink-0">{relTime(c.updated_at, ar)}</span>
                  </div>
                  {c.preview && <div className="text-[11.5px] text-slate-500 dark:text-slate-400 truncate mt-0.5">{c.preview}</div>}
                </div>
                <button onClick={e => removeConv(c.id, e)} title={t('حذف', 'Delete')} aria-label={t('حذف', 'Delete')}
                  className="gc-icon-btn shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-slate-400 hover:text-rose-500">
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* mode tabs */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[var(--hw-border)] shrink-0">
        {modePill('ask', '💬', t('سؤال', 'Ask'))}
        {modePill('edit', '✏️', t('تعديل', 'Edit'))}
        {modePill('reason', '🎯', t('هدف', 'Goal'))}
      </div>

      {/* body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3" dir={ar ? 'rtl' : 'ltr'}>
        <div className={bodyWrap}>
        {mode === 'ask' && (
          <>
            {msgs.length === 0 && (
              <div className="flex flex-col items-center text-center gap-3 py-12 px-4 gc-msg-in">
                <GeminiSpark className="w-11 h-11 gc-spark-breathe" />
                <p className="text-[16px] font-bold text-slate-700 dark:text-slate-200">{t('اطلب أي وثيقة — أنشئها لك مباشرةً', 'Ask for any document — I’ll create it')}</p>
                <p className="text-[12.5px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-xs">{t('صف ما تريد بلغتك: سياسة، عقد، تقرير، خطة، ميثاق، نموذج… يستند إلى ملفاتك ويبحث في الويب عند الحاجة، ويُنتج وثيقة قابلة للتصدير.', 'Describe what you want: a policy, contract, report, plan, charter, template… grounded in your files, web-researched when needed, and export-ready.')}</p>
                <div className="flex flex-wrap items-center justify-center gap-1.5 mt-1 max-w-sm">
                  {[
                    t('اكتب سياسة تضارب المصالح كاملة', 'Write a complete conflict-of-interest policy'),
                    t('جهّز عقد عمل نموذجي', 'Draft a model employment contract'),
                    t('أعدّ تقريراً عن أحدث ممارسات الحوكمة ٢٠٢٦', 'Report on the latest 2026 governance practices'),
                  ].map((ex, x) => (
                    <button key={x} type="button" onClick={() => send(ex).catch(() => {})} className="gc-chip border border-[var(--hw-border)]">
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map(m => (
              <div key={m.id} className={`space-y-1 ${m.sender === 'user' ? 'flex flex-col items-end' : ''}`}>
                {m.sender === 'agent' && (m.thoughts.length > 0 || (m.thinking && m.steps.length === 0)) && (
                  <ThinkingTrace thoughts={m.thoughts} active={m.thinking} language={language || 'ar'} />
                )}
                {/* P12 — the real percent/section-counter readout for a running
                    /draft/stream (see GcDraftProgress); only while this turn is
                    still live, otherwise it lingers on the finished message. */}
                {m.sender === 'agent' && m.thinking && m.draftProgress && (
                  <GcDraftProgress progress={m.draftProgress} ar={ar} t={t} />
                )}
                {m.sender === 'agent' && m.steps.length > 0 && (
                  <StepTimeline steps={m.steps} active={m.thinking} language={language || 'ar'} />
                )}
                {m.sender === 'user' ? (
                  <div className="gc-msg-user gc-msg-in">{m.text}</div>
                ) : (
                  <div className="flex items-start gap-2.5">
                  <RobotAvatar
                    label={t('المساعد', 'Assistant')}
                    className="w-7 h-7 mt-0.5"
                    markClassName="w-[17px] h-[17px]"
                  />
                  <div className="gc-msg-model gc-msg-in flex-1 min-w-0">
                    {m.text ? (
                      <>
                        <Markdown text={m.text} rtl={ar} citations={m.srcRefs} onCite={handleCite} onMermaidEdit={(oldCode, newCode) => handleMermaidEdit(m.id, oldCode, newCode)} />
                        {m.streaming && (
                          <div className="flex items-center gap-2 mt-2.5 text-[11px] text-[color:var(--hw-text-subtle)]">
                            <GeminiSpark className="w-3.5 h-3.5 gc-spark-breathe" />
                            <span className="inline-flex items-center gap-1"><span className="gc-dot" /><span className="gc-dot" /><span className="gc-dot" /></span>
                          </div>
                        )}
                        {/* P12/MAJOR — a stream that errored/aborted mid-run after
                            tokens already rendered used to leave the partial text
                            with no indication it was cut short. Surface it and
                            offer to redo the exact same turn, without discarding
                            what already streamed in. */}
                        {m.interrupted && (
                          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-900/15 dark:border-amber-700/40 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                            <span className="flex-1">{t('انقطع الرد — أعد المحاولة', 'Response was interrupted — retry')}</span>
                            {m.onRetry && (
                              <button type="button" onClick={m.onRetry} className="hw-btn hw-btn-subtle hw-btn-xs !rounded-full shrink-0">
                                {t('إعادة المحاولة', 'Retry')}
                              </button>
                            )}
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
                    {m.webSources && m.webSources.length > 0 && (
                      <div className="mt-2 pt-1.5 border-t border-[var(--hw-border)] flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">{t('مصادر الويب', 'Web sources')}</span>
                        {m.webSources.map((s, x) => (
                          <a key={x} href={s.uri} target="_blank" rel="noopener noreferrer" title={s.uri} className="hw-cite max-w-[190px]">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20" /></svg>
                            <span className="truncate">{s.title || s.uri}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {/* Google requires displaying the search-suggestions chips when grounding is used */}
                    {m.searchHtml && (
                      <div className="mt-2 overflow-x-auto" dangerouslySetInnerHTML={{ __html: m.searchHtml }} />
                    )}
                    {/* V27 — the canvas is the single export surface. A
                        document-grade answer opens as a templated document; any
                        other substantial answer opens in the canvas (view / edit
                        / export there) instead of exporting straight from the
                        bubble. */}
                    {!m.streaming && looksLikeDocument(m.text) && docCanvasBtn(m.id, m.text)}
                    {!m.streaming && !looksLikeDocument(m.text) && m.text.length > 40 && openInCanvasBtn(m.id, m.text)}
                  </div>
                  </div>
                )}
              </div>
            ))}

            {/* V5/V16 — the wizard: proposing-plan skeleton, the editable plan
                card, or the mid-build intervene strip. */}
            {planBusy && (
              <div className="flex items-start gap-2.5 gc-msg-in">
                <RobotAvatar label={t('المساعد', 'Assistant')} className="w-7 h-7 mt-0.5" markClassName="w-[17px] h-[17px]" />
                <div className="gc-msg-model flex-1 min-w-0">
                  <div className="text-[12px] font-bold text-slate-700 dark:text-slate-200 mb-1.5">{t('أجهّز خطة بناء قابلة للتعديل…', 'Preparing an editable build plan…')}</div>
                  <GcThinking label={t('يخطّط…', 'planning…')} />
                </div>
              </div>
            )}
            {!planBusy && !building && renderPlanCard()}
            {building && (
              <div className="gc-msg-in rounded-2xl border border-amber-300/50 bg-amber-50/70 dark:bg-amber-900/20 p-3 space-y-2" dir={ar ? 'rtl' : 'ltr'}>
                <div className="text-[12px] font-bold text-amber-800 dark:text-amber-200">{t('يبني حسب خطتك المعتمدة…', 'Building from your confirmed plan…')}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">{t('يمكنك التدخّل: أضِف ملاحظة وأوقف البناء لتعديل الخطة ثم أعد البناء.', 'You can intervene: add a note, stop to adjust the plan, then rebuild.')}</div>
                <div className="flex items-center gap-1.5">
                  <input value={interjectNote} onChange={e => setInterjectNote(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); interveneAndAdjust(); } }}
                    placeholder={t('ملاحظة سريعة (اختياري)…', 'Quick note (optional)…')} dir={ar ? 'rtl' : 'ltr'}
                    className="hw-input flex-1 min-w-0 text-sm py-1.5" />
                  <button onClick={interveneAndAdjust} className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full shrink-0">
                    {t('إيقاف وتعديل', 'Stop & adjust')}
                  </button>
                </div>
              </div>
            )}
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
                {looksLikeDocument(props.agentAnswer) && docCanvasBtn('agent-answer', props.agentAnswer)}
                {exportRow(props.agentAnswer, 'agent-answer')}
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
                    {a.file.type.startsWith('video/')
                      ? <video src={a.url} muted playsInline preload="metadata" />
                      : <img src={a.url} alt={a.file.name} />}
                    <button type="button" className="gc-thumb-x" onClick={() => removeAttachment(i)} title={t('إزالة', 'Remove')} aria-label={t('إزالة', 'Remove')}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="gc-composer">
              {copilotEnabled() && (
                <>
                  <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple onChange={onFilesSelected} className="hidden" />
                  <button type="button" onClick={pickImages} className="gc-attach" title={t('إرفاق صورة أو فيديو', 'Attach image or video')} aria-label={t('إرفاق صورة أو فيديو', 'Attach image or video')}><IconAttach /></button>
                </>
              )}
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input).catch(() => {}); } }}
                rows={full ? 2 : 1}
                placeholder={t('اكتب سؤالك أو اطلب صياغة كاملة…', 'Ask, or request a full draft…')}
                className="gc-input"
              />
              {busy
                ? <button onClick={stop} className="gc-send gc-send-stop" title={t('إيقاف', 'Stop')} aria-label={t('إيقاف', 'Stop')}><IconStop /></button>
                : <button onClick={() => send(input).catch(() => {})} disabled={!input.trim() && !attachments.length} className="gc-send" title={t('إرسال', 'Send')} aria-label={t('إرسال', 'Send')}><IconSend /></button>}
            </div>
            {/* V27 — wizard opt-IN (default OFF = conversational). ON: every doc
                request first proposes an editable plan. OFF: a normal message
                gets a real grounded reply; only an explicit build command opens
                the plan. The toggle keeps the wizard discoverable either way. */}
            <label className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer select-none w-fit"
              title={t('افتراضيًا: محادثة طبيعية. فعّله ليقترح المساعد خطة قابلة للتعديل (الطول، المحاور، الإدارات، الأقسام) قبل كل بناء.', 'Default: a natural conversation. Turn it on to have the assistant propose an editable plan (length, axes, departments, sections) before every build.')}>
              <input type="checkbox" checked={wizardOn} onChange={e => setWizardOn(e.target.checked)} className="accent-[color:var(--hw-brand,#11a8bc)] rounded-sm" />
              {t('معالج البناء (يسأل قبل التوليد)', 'Build wizard (asks before generating)')}
            </label>
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
    </CopilotRunBoundary>
    </>
  );
};

export default GovCopilot;
