// Ingestion pipeline (Phase 1).
// Raw document text → hierarchical chunks (heading-aware) → embeddings →
// entity extraction → KnowledgeNodes. Each chunk keeps a `headingPath` anchor so
// generated docs can cite "اللائحة › الباب الثاني › المادة 5".
//
// Input is plain text already extracted upstream (OrganizationDocument.content).
// For scanned/visual PDFs use Gemini multimodal extraction before calling here
// (extractTextFromImageDoc) — Arabic OCR via text-extraction is unreliable.

import { Type } from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import { MODELS } from '../constants/models';
import { embedBatch } from './embeddingService';
import type {
  DocChunk, DocKind, KnowledgeNode, EntityType, GovProgress,
  ChunkSentiment, SentimentLabel,
} from '../types';

function getAI(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: process.env.API_KEY! });
}

let _idc = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(_idc++).toString(36)}`;

// ---- Heading-aware hierarchical chunking ----------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;                       // markdown headings
// Arabic legal/structural markers: الباب / الفصل / المادة / البند / القسم / أولاً..
const AR_HEADING_RE = /^\s*((?:الباب|الفصل|المادة|البند|القسم|المبحث|أولاً|ثانياً|ثالثاً|رابعاً|خامساً)\b[^\n]{0,80})$/;

const MAX_CHARS = 1400;   // ~512 tokens target; large enough to "understand"
const MIN_CHARS = 200;    // avoid tiny fragments

interface RawChunk { headingPath: string; text: string; charStart: number; }

/** Split text into heading-anchored chunks, preserving the heading breadcrumb. */
export function hierarchicalChunk(text: string): RawChunk[] {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const stack: { level: number; title: string }[] = [];
  const chunks: RawChunk[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  let cursor = 0;

  const pathStr = () => stack.map(s => s.title).join(' › ') || 'المستند';

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body.length >= MIN_CHARS || (body.length > 0 && chunks.length === 0)) {
      chunks.push({ headingPath: pathStr(), text: body, charStart: bufStart });
    } else if (body.length > 0 && chunks.length) {
      // merge tiny tail into previous chunk
      chunks[chunks.length - 1].text += '\n' + body;
    }
    buf = [];
  };

  const pushHeading = (level: number, title: string) => {
    flush();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: title.trim().slice(0, 80) });
    bufStart = cursor;
  };

  for (const line of lines) {
    const md = line.match(HEADING_RE);
    const ar = !md && line.match(AR_HEADING_RE);
    if (md) {
      pushHeading(md[1].length, md[2]);
    } else if (ar) {
      pushHeading(3, ar[1]);
    } else {
      if (!buf.length) bufStart = cursor;
      buf.push(line);
      // size-based split inside a long section
      if (buf.join('\n').length >= MAX_CHARS) {
        flush();
        bufStart = cursor;
      }
    }
    cursor += line.length + 1;
  }
  flush();
  return chunks.filter(c => c.text.trim().length > 0);
}

/** Heuristic document-kind classifier (cheap, no model call). */
export function classifyDocKind(name: string, content: string): DocKind {
  const s = (name + ' ' + content.slice(0, 500)).toLowerCase();
  const has = (...w: string[]) => w.some(x => s.includes(x));
  if (has('لائحة', 'regulation', 'نظام داخلي')) return 'regulation';
  if (has('سياسة', 'policy', 'policies')) return 'policy';
  if (has('عقد', 'contract', 'اتفاقية')) return 'contract';
  if (has('محضر', 'اجتماع', 'minutes', 'meeting')) return 'meeting_minutes';
  if (has('هيكل', 'org chart', 'تنظيمي', 'organization chart')) return 'org_chart';
  if (has('براند', 'brand', 'هوية')) return 'brand';
  if (has('بروفايل', 'profile', 'تعريفي', 'company profile')) return 'profile';
  if (has('استبيان', 'survey')) return 'survey';
  if (has('تقييم', 'assessment')) return 'assessment';
  return 'other';
}

// ---- Entity extraction (one model call per chunk-batch) --------------------

const entitySchema = {
  type: Type.OBJECT,
  properties: {
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },   // EntityType
          name: { type: Type.STRING },
          note: { type: Type.STRING },
        },
        required: ['type', 'name'],
      },
    },
  },
  required: ['entities'],
};

const VALID_ENTITY: EntityType[] = ['employee', 'department', 'role', 'policy', 'procedure', 'authority', 'kpi', 'system', 'risk', 'process'];

async function extractEntitiesFromChunk(chunk: DocChunk, signal?: AbortSignal): Promise<KnowledgeNode[]> {
  const prompt = `استخرج الكيانات التنظيمية من النص التالي فقط (لا تخترع). لكل كيان: type واحد من [${VALID_ENTITY.join(', ')}]، name مختصر، note اختياري.
السياق الهرمي: ${chunk.headingPath}

النص:
${chunk.text.slice(0, 1800)}

أعد JSON فقط.`;
  try {
    const res = await generateJson<{ entities: { type: string; name: string; note?: string }[] }>(
      prompt, entitySchema, { signal, temperature: 0.1 },
    );
    return (res.entities || [])
      .filter(e => VALID_ENTITY.includes(e.type as EntityType) && e.name?.trim())
      .map(e => ({
        id: uid('node'),
        tenantId: chunk.tenantId,
        type: e.type as EntityType,
        name: e.name.trim().slice(0, 120),
        attributes: e.note ? { note: e.note.slice(0, 300) } : {},
        sourceChunkIds: [chunk.id],
      }));
  } catch {
    return [];
  }
}

// ---- Sentiment (auto, batched — one model call per group of chunks) --------

const sentimentSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          i: { type: Type.NUMBER },                 // chunk index in batch
          label: { type: Type.STRING },             // positive|neutral|negative|mixed
          score: { type: Type.NUMBER },             // -1..+1
        },
        required: ['i', 'label', 'score'],
      },
    },
  },
  required: ['items'],
};

const VALID_SENT: SentimentLabel[] = ['positive', 'neutral', 'negative', 'mixed'];
const SENT_BATCH = 12;     // chunks per model call

const clampScore = (n: number) => Math.max(-1, Math.min(1, Number.isFinite(n) ? n : 0));

/** Derive sentiment for every chunk, in batches. Failures default to neutral/0. */
async function deriveSentiments(
  chunks: DocChunk[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = chunks.length;
  let done = 0;
  for (let start = 0; start < total; start += SENT_BATCH) {
    if (signal?.aborted) break;
    const batch = chunks.slice(start, start + SENT_BATCH);
    const listing = batch
      .map((c, j) => `[${j}] (${c.headingPath})\n${c.text.slice(0, 600)}`)
      .join('\n\n---\n\n');
    const prompt = `حلّل نبرة كل مقطع تنظيمي تالٍ. لكل مقطع أعد:
- i: رقم المقطع كما هو بين []
- label: واحدة من [positive, neutral, negative, mixed] (إيجابي=نقاط قوة/إنجاز، سلبي=مشكلة/مخاطرة/شكوى، mixed=الاثنان، neutral=وصف محايد)
- score: رقم من -1 (سلبي جدًا) إلى +1 (إيجابي جدًا)

المقاطع:
${listing}

أعد JSON فقط.`;
    try {
      const res = await generateJson<{ items: { i: number; label: string; score: number }[] }>(
        prompt, sentimentSchema, { signal, temperature: 0.1 },
      );
      for (const it of (res.items || [])) {
        const c = batch[it.i];
        if (!c) continue;
        const label = (VALID_SENT.includes(it.label as SentimentLabel) ? it.label : 'neutral') as SentimentLabel;
        c.sentiment = { label, score: clampScore(it.score) };
      }
    } catch {
      // leave undefined → treated as neutral downstream
    }
    // default any unscored chunk in this batch to neutral
    for (const c of batch) if (!c.sentiment) c.sentiment = { label: 'neutral', score: 0 };
    done = Math.min(total, start + batch.length);
    onProgress?.(done, total);
  }
}

/** Aggregate doc-level sentiment summary from scored chunks. */
export function summarizeSentiment(chunks: DocChunk[]): { label: SentimentLabel; score: number; positive: number; negative: number; neutral: number; mixed: number } {
  let pos = 0, neg = 0, neu = 0, mix = 0, sum = 0, n = 0;
  for (const c of chunks) {
    const s = c.sentiment;
    if (!s) continue;
    n++; sum += s.score;
    if (s.label === 'positive') pos++;
    else if (s.label === 'negative') neg++;
    else if (s.label === 'mixed') mix++;
    else neu++;
  }
  const avg = n ? sum / n : 0;
  const label: SentimentLabel = avg > 0.2 ? 'positive' : avg < -0.2 ? 'negative' : (mix > pos && mix > neg ? 'mixed' : 'neutral');
  return { label, score: avg, positive: pos, negative: neg, neutral: neu, mixed: mix };
}

/** Merge duplicate nodes by (type,name); union their source chunks. */
export function dedupeNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  const map = new Map<string, KnowledgeNode>();
  for (const n of nodes) {
    const key = `${n.type}::${n.name.toLowerCase()}`;
    const ex = map.get(key);
    if (ex) {
      ex.sourceChunkIds = Array.from(new Set([...ex.sourceChunkIds, ...n.sourceChunkIds]));
      ex.attributes = { ...n.attributes, ...ex.attributes };
    } else {
      map.set(key, { ...n });
    }
  }
  return Array.from(map.values());
}

export interface IngestResult {
  chunks: DocChunk[];
  nodes: KnowledgeNode[];
}

export interface IngestParams {
  tenantId: string;
  docId: string;
  docName: string;
  content: string;
  kind?: DocKind;
  signal?: AbortSignal;
  onProgress?: (p: GovProgress) => void;
  extractEntities?: boolean;   // default true
  deriveSentiment?: boolean;   // default true
}

/** Full ingest of one document: chunk → embed → entities. */
export async function ingestDocument(p: IngestParams): Promise<IngestResult> {
  const { tenantId, docId, docName, content, signal, onProgress } = p;
  const kind = p.kind || classifyDocKind(docName, content);

  onProgress?.({ phase: 'ingest', current: 0, total: 1, label: `تقطيع «${docName}»...` });
  const raw = hierarchicalChunk(content);
  const now = new Date().toISOString();
  let ord = 0;
  const chunks: DocChunk[] = raw.map(r => ({
    id: uid('chunk'),
    tenantId, docId, docName, docKind: kind,
    headingPath: r.headingPath,
    text: r.text,
    charStart: r.charStart,
    ordinal: ord++,
    createdAt: now,
  }));

  // embed
  onProgress?.({ phase: 'embed', current: 0, total: chunks.length, label: 'توليد المتجهات (embeddings)...' });
  const vecs = await embedBatch(
    chunks.map(c => `${c.headingPath}\n${c.text}`),
    (done, total) => onProgress?.({ phase: 'embed', current: done, total, label: `embeddings ${done}/${total}` }),
    signal,
  );
  chunks.forEach((c, i) => { if (vecs[i]?.length) c.embedding = vecs[i]; });

  // sentiment (auto)
  if (p.deriveSentiment !== false && chunks.length) {
    onProgress?.({ phase: 'sentiment', current: 0, total: chunks.length, label: 'تحليل النبرة (sentiment)...' });
    await deriveSentiments(
      chunks,
      (done, total) => onProgress?.({ phase: 'sentiment', current: done, total, label: `تحليل النبرة ${done}/${total}` }),
      signal,
    );
  }

  // entities — GovF2: bounded-concurrency extraction (was a serial per-chunk loop
  // that dominated ingest time at 30–50 docs). Order of nodes is irrelevant (deduped).
  const nodes: KnowledgeNode[] = [];
  if (p.extractEntities !== false && chunks.length) {
    let next = 0, doneE = 0;
    const limit = Math.max(1, Math.min(4, chunks.length));
    const worker = async () => {
      while (true) {
        if (signal?.aborted) return;
        const i = next++;
        if (i >= chunks.length) return;
        const ns = await extractEntitiesFromChunk(chunks[i], signal);
        nodes.push(...ns);
        doneE++;
        onProgress?.({ phase: 'entities', current: doneE, total: chunks.length, label: `استخراج الكيانات ${doneE}/${chunks.length}` });
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
  }

  return { chunks, nodes: dedupeNodes(nodes) };
}

/** Multimodal text extraction for scanned/visual PDFs (Arabic-safe via image read). */
export async function extractTextFromImageDoc(base64: string, mimeType: string, signal?: AbortSignal): Promise<string> {
  const ai = getAI();
  try {
    const res = await ai.models.generateContent({
      model: MODELS.TEXT,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: base64, mimeType } },
          { text: 'استخرج كامل النص من هذا المستند مع الحفاظ على العناوين والتسلسل الهرمي (استخدم ## للعناوين). أعد النص فقط.' },
        ],
      }],
      config: { temperature: 0 },
    });
    return (res.text || '').trim();
  } catch {
    return '';
  }
}
