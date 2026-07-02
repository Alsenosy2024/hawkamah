// Agentic streaming layer. Wraps Gemini streaming so the UI can show a live
// chain-of-thought (reasoning parts) separately from the final answer parts.
// Single place that knows how to read `part.thought` from the stream.

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { MODELS } from '../constants/models';

export interface StreamCallbacks {
  onThought?: (chunk: string) => void;   // a reasoning fragment
  onAnswer?: (chunk: string) => void;    // a final-answer fragment
  onDone?: (fullAnswer: string) => void;
  onError?: (err: any) => void;
}

export interface ChatTurn {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export interface StreamChatParams {
  systemInstruction: string;
  history: ChatTurn[];
  message: string;
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingLevel?: ThinkingLevel;
}

const MODEL = MODELS.TEXT;

function getAI(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: process.env.API_KEY! });
}

/**
 * Stream a single chat turn with visible thinking.
 * Resolves to the full final answer text (thoughts excluded).
 * Aborts cleanly when `signal` fires.
 */
export async function streamChat(p: StreamChatParams, cb: StreamCallbacks = {}): Promise<string> {
  const ai = getAI();
  const contents: ChatTurn[] = [...p.history, { role: 'user', parts: [{ text: p.message }] }];
  let answer = '';
  try {
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents,
      config: {
        systemInstruction: p.systemInstruction,
        temperature: p.temperature ?? 0.4,
        maxOutputTokens: p.maxOutputTokens ?? 8192,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: p.thinkingLevel ?? ThinkingLevel.MEDIUM,
        },
      },
    });

    for await (const chunk of stream) {
      if (p.signal?.aborted) break;
      const parts = chunk?.candidates?.[0]?.content?.parts;
      if (!parts) continue;
      for (const part of parts) {
        const text = (part as any)?.text;
        if (typeof text !== 'string' || !text) continue;
        if ((part as any).thought === true) {
          cb.onThought?.(text);
        } else {
          answer += text;
          cb.onAnswer?.(text);
        }
      }
    }

    if (p.signal?.aborted) {
      cb.onDone?.(answer);
      return answer;
    }
    if (!answer.trim()) {
      answer = 'تعذّر توليد رد. أعد صياغة الطلب أو تحقّق من اتصال محرك Gemini.';
      cb.onAnswer?.(answer);
    }
    cb.onDone?.(answer);
    return answer;
  } catch (err) {
    if (p.signal?.aborted) { cb.onDone?.(answer); return answer; }
    cb.onError?.(err);
    throw err;
  }
}

function isTransient(err: any): boolean {
  const s = String(err?.message || err || '');
  return /GENJSON_EMPTY|GENJSON_PARSE|503|429|overload|unavailable|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|deadline|timeout/i.test(s);
}

// Extract the first complete JSON object from a string that may contain preamble/postamble text.
function extractJson(raw: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Fast path: already valid
  try { JSON.parse(stripped); return stripped; } catch { /* try extraction */ }
  // Find outermost { ... }
  const start = stripped.indexOf('{');
  if (start === -1) throw new Error('GENJSON_PARSE: no JSON object found in response');
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) return stripped.slice(start, i + 1); }
  }
  throw new Error('GENJSON_PARSE: unterminated JSON object in response');
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Non-streaming JSON helper (outline / critique / question-gen). Honors abort.
 *
 * CRITICAL: a thinking budget can silently eat the WHOLE output budget — when
 * `maxOutputTokens` is left at the model default and `thinkingLevel` is MEDIUM,
 * large JSON requests came back with thoughtsTokenCount ≈ budget and
 * candidatesTokenCount ≈ 0 → empty body → GENJSON_EMPTY ("فشل التوليد").
 * So: default to a LOW thinking level and a large explicit output budget, and
 * retry transient failures (503/429/empty) with backoff.
 */
export async function generateJson<T = any>(
  prompt: string,
  responseSchema: any,
  opts: {
    systemInstruction?: string;
    signal?: AbortSignal;
    temperature?: number;
    maxOutputTokens?: number;
    thinkingLevel?: ThinkingLevel;
    disableThinking?: boolean;
    retries?: number;
  } = {},
): Promise<T> {
  const ai = getAI();
  const maxOutputTokens = opts.maxOutputTokens ?? 32000;
  const retries = opts.retries ?? 2;
  // Thinking tokens eat into the output budget — disable for structured JSON generation.
  const thinkingConfig = opts.disableThinking
    ? { thinkingBudget: 0 }
    : { thinkingLevel: opts.thinkingLevel ?? ThinkingLevel.LOW };

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('ABORTED');
    try {
      const res = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: opts.systemInstruction,
          temperature: opts.temperature ?? 0.3,
          responseMimeType: 'application/json',
          responseSchema,
          maxOutputTokens,
          thinkingConfig,
        },
      });
      const raw = (res.text || '').trim();
      if (!raw) {
        throw new Error('GENJSON_EMPTY: model returned no content (blocked or truncated)');
      }
      // Robust extraction: strips fences, finds outermost JSON object even if model adds preamble.
      const jsonStr = extractJson(raw); // throws GENJSON_PARSE → treated as transient → retried
      return JSON.parse(jsonStr) as T;
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw new Error('ABORTED');
      const transient = isTransient(err);
      if (transient && attempt < retries) {
        await sleep(800 * (attempt + 1) + Math.floor(Math.random() * 400)); // backoff + jitter
        continue;
      }
      if (!transient) {
        throw new Error('GENJSON_PARSE: model returned non-JSON output');
      }
      // exhausted retries on a transient failure
      throw new Error('GENJSON_EMPTY: model returned no content after retries (blocked or truncated)');
    }
  }
  throw lastErr ?? new Error('GENJSON_EMPTY: unknown failure');
}

/**
 * Streaming variant of {@link generateJson}. Streams the JSON body as the model
 * writes it so the UI can render a PROGRESSIVE preview — `opts.onText` fires
 * after every chunk with the full accumulated text so far (callers parse it
 * leniently for a live view). Reasoning parts (`part.thought === true`) are
 * skipped; only answer text is accumulated. When the stream finishes the text
 * is fence-stripped + parsed via the same robust {@link extractJson} path and
 * returned. Best-effort: it throws if the accumulated text can't parse, so
 * callers should fall back to the blocking {@link generateJson} on failure.
 */
export async function generateJsonStream<T = any>(
  prompt: string,
  responseSchema: any,
  opts: {
    temperature?: number;
    signal?: AbortSignal;
    onText?: (accumulated: string) => void;
    maxOutputTokens?: number;
    thinkingLevel?: ThinkingLevel;
  } = {},
): Promise<T> {
  const ai = getAI();
  let acc = '';
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: opts.temperature ?? 0.2,
      // Mirrors generateJson's fix (see its docstring above): an unbounded
      // thinking budget at MEDIUM can silently eat the WHOLE output budget,
      // truncating the streamed JSON — extractJson then throws at stream end
      // and the caller falls back to the blocking ladder, so the live
      // preview never shows for exactly the long (comprehensive) runs that
      // need it most. Explicit large budget + LOW thinking keeps the output
      // budget intact.
      maxOutputTokens: opts.maxOutputTokens ?? 32000,
      thinkingConfig: { thinkingLevel: opts.thinkingLevel ?? ThinkingLevel.LOW },
    },
  });

  for await (const chunk of stream) {
    if (opts.signal?.aborted) break;
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!parts) continue;
    for (const part of parts) {
      const text = (part as any)?.text;
      if (typeof text !== 'string' || !text) continue;
      if ((part as any).thought === true) continue; // skip visible reasoning
      acc += text;
    }
    opts.onText?.(acc);
  }

  // Reuse the blocking helper's robust extraction: strips ```json fences and
  // finds the outermost object even if the model added preamble; throws on junk.
  const jsonStr = extractJson(acc);
  return JSON.parse(jsonStr) as T;
}
