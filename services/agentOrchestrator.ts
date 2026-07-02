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
 * Combines a caller-supplied AbortSignal with an internal deadline into one
 * downstream AbortController, so a single signal captures both "caller gave
 * up" and "we gave up waiting" (the SDK's own `abortSignal` is a client-only
 * cancel — the goal here is bounding OUR wait, not the server's work).
 * `reset(ms)` re-arms the deadline without touching the caller-abort wiring —
 * used by the streaming variant to implement an inter-chunk stall timeout
 * instead of one flat cap. `dispose()` MUST be called exactly once (in a
 * `finally`) to clear the timer and detach the listener on `callerSignal` —
 * otherwise listeners pile up across retry attempts.
 */
function withDeadline(callerSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }

  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  };
  arm(timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    reset: (ms: number) => arm(ms),
    dispose: () => {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Settles as soon as `signal` aborts, even if `promise` itself never settles.
 * Needed because AbortSignal is only a hint to the SDK's transport — a
 * slow/misbehaving or mocked call is not guaranteed to actually reject
 * promptly just because the signal fired, so we can't rely on that alone to
 * bound the wait.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('DEADLINE_ABORT'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('DEADLINE_ABORT'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

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
    /** Per-attempt wall-clock deadline. Without this, a hung/slow request
     *  stalled forever — opts.signal was only ever checked BEFORE each attempt
     *  and in the catch, never during the in-flight HTTP call. Default 150s. */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const ai = getAI();
  const maxOutputTokens = opts.maxOutputTokens ?? 32000;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 150_000;
  // Thinking tokens eat into the output budget — disable for structured JSON generation.
  const thinkingConfig = opts.disableThinking
    ? { thinkingBudget: 0 }
    : { thinkingLevel: opts.thinkingLevel ?? ThinkingLevel.LOW };

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('ABORTED');
    const deadline = withDeadline(opts.signal, timeoutMs);
    try {
      const res = await raceAbort(
        ai.models.generateContent({
          model: MODEL,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            systemInstruction: opts.systemInstruction,
            temperature: opts.temperature ?? 0.3,
            responseMimeType: 'application/json',
            responseSchema,
            maxOutputTokens,
            thinkingConfig,
            abortSignal: deadline.signal,
          },
        }),
        deadline.signal,
      );
      const raw = (res.text || '').trim();
      if (!raw) {
        throw new Error('GENJSON_EMPTY: model returned no content (blocked or truncated)');
      }
      // Robust extraction: strips fences, finds outermost JSON object even if model adds preamble.
      const jsonStr = extractJson(raw); // throws GENJSON_PARSE → treated as transient → retried
      return JSON.parse(jsonStr) as T;
    } catch (err) {
      const callerAborted = !!opts.signal?.aborted;
      const timedOut = !callerAborted && deadline.timedOut();
      const effectiveErr = timedOut ? new Error(`timeout: generateJson request exceeded ${timeoutMs}ms`) : err;
      lastErr = effectiveErr;
      if (callerAborted) throw new Error('ABORTED');
      const transient = isTransient(effectiveErr);
      if (transient && attempt < retries) {
        await sleep(800 * (attempt + 1) + Math.floor(Math.random() * 400)); // backoff + jitter
        continue;
      }
      if (!transient) {
        throw new Error('GENJSON_PARSE: model returned non-JSON output');
      }
      // A deadline expiry is a distinct, actionable failure — surface it as-is
      // rather than folding it into the generic "no content" message below.
      if (timedOut) throw effectiveErr;
      // exhausted retries on a transient failure
      throw new Error('GENJSON_EMPTY: model returned no content after retries (blocked or truncated)');
    } finally {
      deadline.dispose();
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
    /** Inter-chunk STALL deadline, reset on every chunk received — NOT a
     *  total cap, since a long stream is legitimate. Fires only when no new
     *  chunk arrives within the window. Default 90s. */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const ai = getAI();
  const staleMs = opts.timeoutMs ?? 90_000;
  const deadline = withDeadline(opts.signal, staleMs);
  let acc = '';
  try {
    const stream = await raceAbort(
      ai.models.generateContentStream({
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
          abortSignal: deadline.signal,
        },
      }),
      deadline.signal,
    );

    // Drive the async iterator manually (rather than `for await...of`) so each
    // `.next()` call — i.e. the wait for the NEXT chunk — is itself bounded by
    // the stall deadline. A `for await` loop has no way to interrupt a pull
    // that never settles.
    const iterator = (stream as AsyncIterable<any>)[Symbol.asyncIterator]();
    while (true) {
      const { value: chunk, done } = await raceAbort(iterator.next(), deadline.signal);
      if (done) break;
      deadline.reset(staleMs); // a chunk arrived — push the stall window back out
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
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (deadline.timedOut()) throw new Error(`timeout: generateJsonStream stalled for ${staleMs}ms without a new chunk`);
    throw err;
  } finally {
    deadline.dispose();
  }

  // Reuse the blocking helper's robust extraction: strips ```json fences and
  // finds the outermost object even if the model added preamble; throws on junk.
  const jsonStr = extractJson(acc);
  return JSON.parse(jsonStr) as T;
}
