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

const BASE = (import.meta.env.VITE_COPILOT_API as string | undefined)?.replace(/\/$/, '') || '';

export function copilotEnabled(): boolean {
  return !!BASE;
}

export interface AskCallbacks {
  onSources?: (sources: CopilotSource[]) => void;
  onAnswer?: (chunk: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: unknown) => void;
}

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
 *  the same callback shape GovCopilot already uses for stageChat. */
export async function askStream(
  params: { corpus: string; message: string; history?: { role: string; content: string }[]; conversation_id?: string },
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const handle = (line: string) => {
    const payload = line.replace(/^data:\s?/, '').trim();
    if (!payload) return;
    let ev: any;
    try { ev = JSON.parse(payload); } catch { return; }
    if (ev.type === 'sources') cb.onSources?.(ev.sources || []);
    else if (ev.type === 'delta') { full += ev.text || ''; cb.onAnswer?.(ev.text || ''); }
    else if (ev.type === 'done') { full = ev.text || full; cb.onDone?.(full); }
  };

  try {
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
  } catch (e) {
    cb.onError?.(e);
    throw e;
  }
  return full;
}

/** Generate one large multi-page document (the "اطلب صياغة كاملة" path). */
export async function draft(
  params: { corpus: string; request: string; language?: string; target_pages?: number },
  signal?: AbortSignal,
): Promise<CopilotDoc> {
  const res = await fetch(`${BASE}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) throw new Error(`copilot /draft failed: ${res.status}`);
  return res.json();
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
  const safe = title.replace(/[^\w؀-ۿ \-]+/g, '_').slice(0, 80).trim() || 'document';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
