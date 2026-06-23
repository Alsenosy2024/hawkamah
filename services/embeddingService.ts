// Embedding layer for the Governance Center.
// Wraps Gemini embeddings + cosine similarity. Used by ingestion (chunk vectors),
// reference matching (project vectors) and retrieval (query vectors).
//
// Decision: simple in-app vector store (vectors live on the chunk/project docs in
// Firestore; similarity computed client-side). Cheap and sufficient for a handful
// of tenants. Swappable for Vertex AI Vector Search later without touching callers.

import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../constants/models';

const EMBED_MODEL = MODELS.EMBED;
const FALLBACK_MODEL = MODELS.EMBED_FALLBACK;

function getAI(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: process.env.API_KEY! });
}

// HIGH: under the 5-wide embedding pool, bursts hit the embeddings rate limit (429).
// The old code swallowed it and returned [] → all-zero vectors → that chunk silently
// dropped to lexical-only retrieval. Classify the error: retry 429/5xx with backoff
// (honoring Retry-After), give up immediately on terminal 4xx (bad input).
function errStatus(e: any): number {
  const s = e?.status ?? e?.code ?? e?.response?.status;
  if (typeof s === 'number') return s;
  const mm = String(e?.message || e).match(/\b(4\d\d|5\d\d)\b/);
  return mm ? parseInt(mm[1], 10) : 0;
}
function retryAfterMs(e: any): number {
  const ra = e?.response?.headers?.['retry-after'] ?? e?.headers?.['retry-after'];
  const n = Number(ra);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 15000) : 0;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Embed a single text → vector. Returns [] on failure (caller degrades to lexical). */
export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const clean = (text || '').trim().slice(0, 8000);
  if (!clean) return [];
  const ai = getAI();
  for (const model of [EMBED_MODEL, FALLBACK_MODEL]) {
    for (let a = 0; a < 4; a++) {
      if (signal?.aborted) return [];
      try {
        const res = await ai.models.embedContent({ model, contents: clean });
        const vec = res.embeddings?.[0]?.values;
        if (vec && vec.length) return vec;
        break;                              // empty (no error) → try next model
      } catch (e: any) {
        const st = errStatus(e);
        const retryable = st === 429 || (st >= 500 && st < 600);
        if (retryable && a < 3 && !signal?.aborted) {
          await sleep(retryAfterMs(e) || (700 * Math.pow(2, a) + Math.floor(Math.random() * 250)));
          continue;                         // backoff + retry SAME model
        }
        break;                              // terminal (4xx) or out of attempts → next model
      }
    }
  }
  return [];
}

/** Embed many texts with bounded concurrency (order-preserving), reporting progress.
 *  GovF1: at scale (hundreds of chunks) sequential embedding dominated ingest time;
 *  a small pool cuts wall-clock ~Nx while staying under the embedding rate limit. */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  concurrency = 10,
): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  let next = 0, done = 0;
  const limit = Math.max(1, Math.min(concurrency, texts.length || 1));
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= texts.length) return;
      out[i] = await embedText(texts[i], signal);
      done++;
      onProgress?.(done, texts.length);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Scored<T> { item: T; score: number; }

/** Top-K nearest items by cosine to a query vector. */
export function topK<T>(
  queryVec: number[],
  items: T[],
  getVec: (t: T) => number[] | undefined,
  k = 6,
  minScore = 0.0,
): Scored<T>[] {
  return items
    .map(item => ({ item, score: cosine(queryVec, getVec(item) || []) }))
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Lexical fallback when no embeddings are available (keyword overlap). */
export function lexicalScore(query: string, text: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2);
  const q = new Set(norm(query));
  if (!q.size) return 0;
  const t = norm(text);
  let hit = 0;
  for (const w of t) if (q.has(w)) hit++;
  return hit / Math.max(t.length, 1);
}
