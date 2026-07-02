// Typed client for the Python Hawkama Copilot backend (FastAPI, `copilot/`).
//
// The copilot can run on either intelligence layer:
//   • the in-app TS path (governanceChat.stageChat + exportService), the default;
//   • the Python google-genai agent exposed by copilot/hawkama_copilot/api.py.
//
// Selection is a build-time feature flag: set VITE_COPILOT_API to the backend
// base URL (e.g. http://localhost:8000) to route the copilot through the Python
// agent. When unset, copilotEnabled() is false and nothing here is used, so the
// deployed app's behavior is unchanged. The corpus id == the front-end tenantId,
// so both stacks read the same uploaded files.

import { parseTargetPages, dedupeList, currentStateDigest, type CopilotPlanPayload } from './governanceChat';
import { draftPacing } from './generationProgress';
import { downloadBlob } from './exportService';
import type { CompanyGovernanceModel, Language } from '../types';

const BASE = (import.meta.env.VITE_COPILOT_API as string | undefined)?.replace(/\/$/, '') || '';

// V4: the requested page-count is a single source of truth shared with the
// in-app path. GovCopilot passes the raw request text but no explicit
// target_pages, so derive it here from the request when not given. Sending it on
// the wire lets the backend honor the SAME target (the backend must respect it
// — see PR notes / generation.py). When no count is requested this stays
// undefined and the request body is byte-for-byte what it was before.
function withTargetPages<T extends { request: string; target_pages?: number }>(params: T): T {
  const target_pages = params.target_pages ?? parseTargetPages(params.request);
  return target_pages ? { ...params, target_pages } : params;
}

export function copilotEnabled(): boolean {
  return !!BASE;
}

// ---------------------------------------------------------------------------
// P5/D2 — grounding (V9/BE-3 contract, now honored end-to-end by the backend).
//
// GovCopilot holds the live CompanyGovernanceModel but used to send only
// {corpus, request/message, language, target_pages} — none of the real
// company/org_units/roles/departments/current_state keys the backend's
// `_grounding_from_body` reads (copilot/hawkama_copilot/api.py). This builds
// that payload from the model, with minimal per-item shapes (matching exactly
// what the backend GroundingContext stores: org_units→{id,name,parentId},
// roles→{id,title,unitId}) so a large org chart doesn't bloat every request.
// ---------------------------------------------------------------------------

export interface CopilotGrounding {
  company?: string;
  org_units?: { id: string; name: string; parentId?: string }[];
  roles?: { id: string; title: string; unitId: string }[];
  departments?: string[];
  current_state?: string;
}

/** Build the grounding payload from the live governance model. `plan`
 *  departments (when the confirmed wizard plan is driving the request) win
 *  over departments derived from org units, mirroring the backend's own
 *  plan-overrides-departments behavior (generation.py `_plan_grounding`).
 *  Returns `{}` for a null/empty model, so an ungrounded request attaches no
 *  grounding at all — the ungrounded path stays byte-for-byte unchanged. */
export function buildGrounding(
  model: CompanyGovernanceModel | null | undefined,
  opts?: { plan?: CopilotPlanPayload; language?: Language },
): CopilotGrounding {
  if (!model) return {};
  const g: CopilotGrounding = {};
  if (model.companyName) g.company = model.companyName;
  const orgUnits = (model.orgUnits || []).filter(u => u?.id && u?.name);
  if (orgUnits.length) {
    g.org_units = orgUnits.map(u => ({ id: u.id, name: u.name, parentId: u.parentId || undefined }));
  }
  const roles = (model.roles || []).filter(r => r?.id && r?.title);
  if (roles.length) g.roles = roles.map(r => ({ id: r.id, title: r.title, unitId: r.unitId }));
  const departments = opts?.plan?.departments?.length
    ? opts.plan.departments
    : dedupeList((model.orgUnits || []).map(u => u?.name));
  if (departments.length) g.departments = departments;
  const current_state = currentStateDigest(model, opts?.language);
  if (current_state) g.current_state = current_state;
  return g;
}

// P5/D7 — the Python /export endpoint's markdown renderer has NO image support
// at all (verified against copilot/hawkama_copilot/exporters/markdown_ast.py:
// its `_inline()` regex strips `![alt](url)` down to bare alt text, and no
// exporter — docx/pdf/pptx/xlsx — ever branches on an "image" block type), so
// it dumps every ```mermaid fence as raw, literal diagram source into Word and
// PowerPoint output. Pre-rasterizing a diagram to a data-URI and sending THAT
// markdown to the backend would NOT embed an image — the backend would just as
// silently strip it to alt text (worse: a multi-MB request for nothing).
// Detect mermaid-fenced content here so the caller (GovCopilot.exportAs) can
// route a diagram-bearing DOCX/PPTX export through the in-app exporters
// instead — they already rasterize + embed real diagram images — bypassing the
// backend only for the formats/content it genuinely cannot render.
const MERMAID_FENCE_RE = /```\s*mermaid\b/i;
export function hasMermaidFence(markdown: string): boolean {
  return MERMAID_FENCE_RE.test(markdown || '');
}

export interface AskCallbacks {
  onSources?: (sources: CopilotSource[]) => void;
  onAnswer?: (chunk: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: unknown) => void;
}

// ---------------------------------------------------------------------------
// P12 — outgoing message payloads for /ask vs. the local stageChat fallback.
//
// /ask is gated by the backend's smalltalk carve-out (agent.py
// _SMALLTALK_MAX_CHARS = 40): a short greeting/thanks gets a quick reply
// instead of the full grounded RAG+citation treatment. GovCopilot used to
// append this ~473-char FORMAT_HINT to EVERY /ask message, so every real
// message — even "مرحبا" — exceeded 40 chars and the smalltalk branch was
// unreachable from the real UI. /ask must receive the user's RAW question;
// the backend already carries its own formatting/conversation rules in its
// system prompts. The in-app stageChat fallback (no Python backend, no
// smalltalk gate) still needs the mermaid/table formatting directive, so it
// keeps appending FORMAT_HINT.
// ---------------------------------------------------------------------------
export const FORMAT_HINT =
  '\n\n[تعليمات التنسيق — لا تذكرها في الرد: إذا تطلّب الجواب رسمًا بيانيًا أو هيكلاً تنظيميًا أو مخطط تدفّق أو علاقات، فأخرِجه حصراً ككتلة ```mermaid``` بصياغة Mermaid صحيحة (graph TD / flowchart). لا ترسم المخططات بالحروف أو ASCII أبداً. لا تضع وسوم [مصدر N] أو أقواس مربّعة داخل تسميات عُقد mermaid (تُفسد الرسم)؛ ضع الاستشهادات في النص خارج المخطط فقط. قدّم البيانات الجدولية كجداول Markdown. لا تذكر اسم أداة الرسم (مثل mermaid) داخل نص الوثيقة — اكتفِ بإدراج المخطط نفسه.]';

/** The /ask `message` field — the raw user question, no FORMAT_HINT. */
export const askMessagePayload = (q: string): string => q;

/** The local stageChat fallback's message — keeps the formatting directive
 *  (that path has no smalltalk gate to break). */
export const stageChatMessagePayload = (q: string): string => q + FORMAT_HINT;

export interface CopilotSource {
  label: string;
  doc: string;
  heading: string;
  score?: number;
  text?: string;
}

export interface CopilotDoc {
  title: string;
  markdown: string;
  html?: string;
  word_count: number;
  pages: number;
  sections: { title: string; goal: string }[];
  sources: { label: string; doc: string; heading: string }[];
}

export type CopilotFormat = 'md' | 'txt' | 'html' | 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'json';

// Progress event for the long-form /draft path. The blocking /draft endpoint is
// silent for the whole 7-8 min run; draftStream() surfaces named stages so the
// UI can narrate what the Copilot is doing (HWK-A1). `stage` is a free string
// (the backend may emit finer-grained names than the four canonical ones below).
export interface DraftProgressEvent {
  type: 'progress';
  stage: string;     // 'outline' | 'drafting' | 'critique' | 'revising' | backend-specific
  done: number;      // steps completed
  total: number;     // steps expected
}
export type DraftProgressCb = (ev: DraftProgressEvent) => void;

// Durable chat history — a saved conversation thread and its lightweight summary
// (the shape the history sidebar lists). Messages are stored verbatim, so we keep
// the type loose (the front-end's own Msg shape minus transient fields).
export interface CopilotConvSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  preview: string;
}
export interface CopilotConversation {
  id: string;
  corpus?: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: any[];
}

/** Stream a grounded answer from the Python agent (SSE). Maps server events to
 *  the same callback shape GovCopilot already uses for stageChat.
 *
 *  P5/D2: accepts the same CopilotGrounding fields as draft/draftStream so the
 *  wire contract is consistent. NOTE — verified against
 *  copilot/hawkama_copilot/api.py `ask()` and agent.py `ask_stream`/`_ask_prompt`:
 *  the /ask endpoint does not currently call `_grounding_from_body` at all, so
 *  these fields are inert on today's backend. Sending them is forward-compatible
 *  (harmless extra JSON keys) for when /ask adopts grounding; the ACTIVE fix is
 *  on /draft and /draft/stream, which already honor it end-to-end. */
// ---------------------------------------------------------------------------
// P12 — SSE frame parsing was duplicated almost verbatim between askStream and
// _consumeDraftStream (accumulate into a buffer, split on '\n\n', strip
// 'data: ', JSON.parse each line). One shared parser now backs both, so any
// protocol fix (e.g. tolerating a stray non-JSON keep-alive line) is made
// once. Exported for direct unit testing.
// ---------------------------------------------------------------------------
/** Read an SSE body to completion, calling `onEvent` with each parsed JSON
 *  data payload in order. A malformed data line is skipped, not thrown. If
 *  `onEvent` throws, the error propagates to the caller (used by
 *  _consumeDraftStream to reject on a backend 'error' frame). */
export async function parseSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (line: string) => {
    const payload = line.replace(/^data:\s?/, '').trim();
    if (!payload) return;
    let ev: any;
    try { ev = JSON.parse(payload); } catch { return; }
    onEvent(ev);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      frame.split('\n').forEach(handle);
    }
  }
  if (buffer.trim()) buffer.split('\n').forEach(handle);
}

export async function askStream(
  params: { corpus: string; message: string; history?: { role: string; content: string }[]; conversation_id?: string } & CopilotGrounding,
  cb: AskCallbacks,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`copilot /ask failed: ${res.status}`);

  let full = '';
  try {
    await parseSSE(res.body, ev => {
      if (ev.type === 'sources') cb.onSources?.(ev.sources || []);
      else if (ev.type === 'delta') { full += ev.text || ''; cb.onAnswer?.(ev.text || ''); }
      else if (ev.type === 'done') { full = ev.text || full; cb.onDone?.(full); }
    });
  } catch (e) {
    cb.onError?.(e);
    throw e;
  }
  return full;
}

/** Generate one large multi-page document (the "اطلب صياغة كاملة" path).
 *
 *  P5/D1+D2: `plan` (the confirmed wizard plan, mapped via
 *  governanceChat.planToPayload) bypasses the backend's keyword deliverable
 *  routing entirely; the CopilotGrounding fields (company/org_units/roles/
 *  departments/current_state) ground the draft in the real company instead of
 *  generic boilerplate. Both are optional — omitting them keeps the request
 *  byte-for-byte what it was before. */
export async function draft(
  params: { corpus: string; request: string; language?: string; target_pages?: number; plan?: CopilotPlanPayload } & CopilotGrounding,
  signal?: AbortSignal,
): Promise<CopilotDoc> {
  const res = await fetch(`${BASE}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withTargetPages(params)),
    signal,
  });
  if (!res.ok) throw new Error(`copilot /draft failed: ${res.status}`);
  return res.json();
}

/**
 * Like draft(), but emits progress events during the long generation so the UI
 * is never silent (HWK-A1). It first probes the additive SSE endpoint
 * POST /draft/stream and relays real backend stage events; if that endpoint is
 * absent (404/405) or the network errors, it falls back to the unchanged
 * blocking draft() wrapped in a timer-based staged heartbeat. Either way the
 * caller receives ≥1 progress event before completion. The blocking /draft
 * endpoint and draft() are untouched, so this is non-regressing.
 */
export async function draftStream(
  params: { corpus: string; request: string; language?: string; target_pages?: number; plan?: CopilotPlanPayload } & CopilotGrounding,
  onProgress: DraftProgressCb,
  signal?: AbortSignal,
): Promise<CopilotDoc> {
  // Resolve the requested length ONCE so both the stream and the fallback send
  // (and pace to) the same single-source-of-truth target (V4).
  const resolved = withTargetPages(params);
  let streamAccepted = false;   // true once the backend returned 200 + a body (generation started)
  try {
    const res = await fetch(`${BASE}/draft/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolved),
      signal,
    });
    if (res.ok && res.body) {
      streamAccepted = true;
      return await _consumeDraftStream(res.body, onProgress);
    }
    // Non-OK (e.g. 404/405 on an older deployment) → fall through to heartbeat.
  } catch (e) {
    // A user/unmount abort must propagate — do NOT silently restart as a blocking run.
    if (e instanceof Error && e.name === 'AbortError') throw e;
    // CRITICAL: once the stream was accepted the backend is already drafting; a
    // mid-stream failure (network drop / 'no document' / SSE error frame) must
    // NOT fall through to draft() — that would run a SECOND 7-8 min generation
    // (double cost) while the first may still be executing. Re-throw instead.
    if (streamAccepted) throw e;
    // Pre-200 / never-connected network error → safe to fall through to heartbeat.
  }
  return _draftWithHeartbeat(resolved, onProgress, signal);
}

// Parse the SSE frames from /draft/stream: 'progress' events feed onProgress,
// the terminal 'done' event carries the finished document, 'error' rejects.
async function _consumeDraftStream(
  body: ReadableStream<Uint8Array>,
  onProgress: DraftProgressCb,
): Promise<CopilotDoc> {
  let doc: CopilotDoc | undefined;
  await parseSSE(body, ev => {
    if (ev.type === 'progress') onProgress(ev as DraftProgressEvent);
    else if (ev.type === 'done' && ev.doc) doc = ev.doc as CopilotDoc;
    else if (ev.type === 'error') throw new Error(`copilot /draft/stream: ${ev.detail || 'error'}`);
  });
  if (!doc) throw new Error('copilot /draft/stream: no document received');
  return doc;
}

// Fallback for deployments without /draft/stream: run the unchanged blocking
// draft() while a timer walks named stages so the UI shows live progress. The
// first event fires immediately (guarantees ≥1 progress event before
// completion); the interval then advances through the stages and holds on the
// last one. All timers are cleared when the draft resolves or the run aborts.
// V4/V7: cadence and total come from draftPacing(target_pages) so the heartbeat
// reflects the (correctly-scoped) effort — a small doc advances faster.
async function _draftWithHeartbeat(
  params: { corpus: string; request: string; language?: string; target_pages?: number; plan?: CopilotPlanPayload } & CopilotGrounding,
  onProgress: DraftProgressCb,
  signal?: AbortSignal,
): Promise<CopilotDoc> {
  const { stages, total, intervalMs } = draftPacing(params.target_pages);
  let i = 0;
  const tick = () => {
    if (signal?.aborted) return;
    const idx = Math.min(i, stages.length - 1);
    onProgress({ type: 'progress', stage: stages[idx], done: Math.min(i + 1, total), total });
    i++;
  };
  tick();                                   // immediate first event — no startup silence
  const handle = setInterval(tick, intervalMs);
  try {
    return await draft(params, signal);
  } finally {
    clearInterval(handle);
  }
}

/** Run the whole governance skill → deliverables + a single RTL HTML manual. */
export async function buildFull(
  params: { corpus: string; company?: string; departments?: string[]; language?: string },
  signal?: AbortSignal,
): Promise<{ documents: CopilotDoc[]; manual_html: string; stats: unknown }> {
  const res = await fetch(`${BASE}/build_full`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) throw new Error(`copilot /build_full failed: ${res.status}`);
  return res.json();
}

/** Render markdown to any format server-side and trigger a browser download. */
export async function exportDoc(
  markdown: string,
  title: string,
  format: CopilotFormat,
  opts?: { company?: string },
): Promise<void> {
  const res = await fetch(`${BASE}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, title, format, company: opts?.company || '' }),
  });
  if (!res.ok) throw new Error(`copilot /export failed: ${res.status}`);
  const blob = await res.blob();
  // P5/D5 — downloadBlob() silently REFUSES a 0-byte blob (console.warn only,
  // no throw), which used to let this function resolve "successfully" on an
  // empty export. downloadBlob is shared by many other export call sites
  // (exportService.ts), so rather than change its contract for all of them, we
  // check here and throw — the caller (GovCopilot.exportAs) now propagates this
  // so the chat/UI shows the real failure instead of a false "file ready ✓".
  if (!blob || blob.size === 0) throw new Error(`copilot /export produced an empty file for format '${format}'`);
  const safe = title.replace(/[^\w؀-ۿ \-]+/g, '_').slice(0, 80).trim() || 'document';
  // Route through exportService's hardened downloadBlob (FE-4): it refuses a
  // 0-byte blob and keeps the anchor + object URL alive past a.click() with a
  // single deferred cleanup. The old inline version revoked the URL synchronously
  // right after click() — the dead-download pattern that opens as "File not found".
  downloadBlob(blob, `${safe}.${format}`);
}

/** Upload & index files into the tenant's corpus (RAG ingestion). */
export async function ingestFiles(
  corpus: string,
  files: File[],
): Promise<{ corpus: string; reports: { file: string; method: string; chunks: number; error?: string }[]; stats: unknown }> {
  const fd = new FormData();
  fd.append('corpus', corpus);
  files.forEach(f => fd.append('files', f));
  const res = await fetch(`${BASE}/ingest`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`copilot /ingest failed: ${res.status}`);
  return res.json();
}

export async function stats(corpus: string): Promise<{ corpus_id: string; documents: number; chunks: number; embedded: number }> {
  const res = await fetch(`${BASE}/stats?corpus=${encodeURIComponent(corpus)}`);
  if (!res.ok) throw new Error(`copilot /stats failed: ${res.status}`);
  return res.json();
}

export async function health(): Promise<any> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`copilot /health failed: ${res.status}`);
  return res.json();
}

// --------------------------------------------------------------------------- //
// Chat history (durable conversation threads)                                 //
// --------------------------------------------------------------------------- //
/** List saved chat threads for a tenant, newest first. */
export async function listConversations(corpus: string): Promise<CopilotConvSummary[]> {
  const res = await fetch(`${BASE}/conversations?corpus=${encodeURIComponent(corpus)}`);
  if (!res.ok) throw new Error(`copilot /conversations failed: ${res.status}`);
  const data = await res.json();
  return (data?.conversations || []) as CopilotConvSummary[];
}

/** Load one full chat thread (its messages). Returns null if it no longer exists. */
export async function getConversation(corpus: string, id: string): Promise<CopilotConversation | null> {
  const res = await fetch(`${BASE}/conversation?corpus=${encodeURIComponent(corpus)}&id=${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`copilot /conversation failed: ${res.status}`);
  return res.json();
}

/** Upsert a chat thread (durable). Returns the refreshed summary. */
export async function saveConversation(
  corpus: string,
  conversation: { id: string; title?: string; messages: any[]; created_at?: number },
): Promise<CopilotConvSummary> {
  const res = await fetch(`${BASE}/conversations/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corpus, conversation }),
  });
  if (!res.ok) throw new Error(`copilot /conversations/save failed: ${res.status}`);
  const data = await res.json();
  return data?.summary as CopilotConvSummary;
}

/** Delete a chat thread. */
export async function deleteConversation(corpus: string, id: string): Promise<void> {
  const res = await fetch(`${BASE}/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corpus, id }),
  });
  if (!res.ok) throw new Error(`copilot /conversations/delete failed: ${res.status}`);
}
