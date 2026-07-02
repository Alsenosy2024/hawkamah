import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../services/governanceEngine';

// P19 — the extract phase of buildModel (governanceEngine.ts) used to hang
// indefinitely at "الاستخراج" (50%): generateJson called the SDK with no
// deadline and no abort signal wired into the actual HTTP request, so a
// hung/slow call stalled the build forever and the Stop button's AbortSignal
// never actually cancelled the in-flight request. These tests pin the fix:
// - generateJson now bounds each attempt with an internal deadline
//   (opts.timeoutMs) and passes a combined caller+deadline AbortSignal into
//   the SDK request itself (config.abortSignal — verified against
//   node_modules/@google/genai/dist/genai.d.ts's GenerateContentConfig).
// - a caller-signal abort mid-flight still rejects with 'ABORTED'.
// - withRetry (governanceEngine.ts) gained an onAttempt(n, total) hook so the
//   build's progress label can show a live attempt counter instead of a
//   single frozen label across an unbounded worst-case wait.
// - generateJsonStream gained an INTER-CHUNK stall deadline (reset on every
//   chunk) rather than a total cap, since long streams are legitimate.

describe('generateJson — bounded deadline + real cancellation (P19)', () => {
  it('rejects with a /timeout/i transient error when the request never resolves, attempting exactly twice with retries:1', async () => {
    vi.resetModules();
    let callCount = 0;
    vi.doMock('@google/genai', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@google/genai')>();
      return {
        ...actual,
        GoogleGenAI: vi.fn().mockImplementation(() => ({
          models: {
            generateContent: vi.fn(() => {
              callCount++;
              // Never resolves and never rejects on its own — only our own
              // deadline race can unblock this, exactly like a hung HTTP call.
              return new Promise(() => {});
            }),
          },
        })),
      };
    });
    const { generateJson } = await import('../../services/agentOrchestrator');

    await expect(
      generateJson('prompt', { type: 'object' }, { timeoutMs: 50, retries: 1 }),
    ).rejects.toThrow(/timeout/i);
    expect(callCount).toBe(2);
  });

  it('passes an abortSignal into the SDK request config (correct field per GenerateContentConfig)', async () => {
    vi.resetModules();
    let capturedConfig: any = null;
    vi.doMock('@google/genai', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@google/genai')>();
      return {
        ...actual,
        GoogleGenAI: vi.fn().mockImplementation(() => ({
          models: {
            generateContent: vi.fn((params: any) => {
              capturedConfig = params.config;
              return Promise.resolve({ text: '{"ok":true}' });
            }),
          },
        })),
      };
    });
    const { generateJson } = await import('../../services/agentOrchestrator');

    const result = await generateJson<{ ok: boolean }>('prompt', { type: 'object' });
    expect(result).toEqual({ ok: true });
    expect(capturedConfig.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects with ABORTED when the caller signal fires mid-flight, and the SDK-received signal itself aborts', async () => {
    vi.resetModules();
    let capturedSignal: AbortSignal | null = null;
    vi.doMock('@google/genai', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@google/genai')>();
      return {
        ...actual,
        GoogleGenAI: vi.fn().mockImplementation(() => ({
          models: {
            generateContent: vi.fn((params: any) => {
              capturedSignal = params.config.abortSignal;
              return new Promise(() => {}); // hangs until the caller aborts
            }),
          },
        })),
      };
    });
    const { generateJson } = await import('../../services/agentOrchestrator');

    const ac = new AbortController();
    const promise = generateJson('prompt', { type: 'object' }, { signal: ac.signal, timeoutMs: 60_000 });
    // give the request a tick to be issued and capture the signal
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();

    await expect(promise).rejects.toThrow('ABORTED');
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
  });
});

describe('withRetry onAttempt — live attempt counter (P19)', () => {
  it('fires onAttempt(1..N) in order, once per attempt, across retries of a transient failure', async () => {
    let calls = 0;
    const seen: Array<[number, number]> = [];
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('503 overloaded');
        return 'ok';
      },
      3, 1, undefined,
      (attempt, total) => seen.push([attempt, total]),
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('fires onAttempt exactly once when the first attempt succeeds', async () => {
    const seen: Array<[number, number]> = [];
    await withRetry(async () => 'ok', 3, 1, undefined, (attempt, total) => seen.push([attempt, total]));
    expect(seen).toEqual([[1, 3]]);
  });
});

describe('generateJsonStream — inter-chunk stall deadline (P19)', () => {
  it('rejects with a /timeout/i error when the stream stalls after one chunk', async () => {
    vi.resetModules();
    vi.doMock('@google/genai', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@google/genai')>();
      return {
        ...actual,
        GoogleGenAI: vi.fn().mockImplementation(() => ({
          models: {
            generateContentStream: vi.fn(async () => ({
              [Symbol.asyncIterator]() {
                let yielded = false;
                return {
                  next: () => {
                    if (!yielded) {
                      yielded = true;
                      return Promise.resolve({
                        done: false,
                        value: { candidates: [{ content: { parts: [{ text: '{"a":1' }] } }] },
                      });
                    }
                    // Stalls forever after the first chunk — only the stall
                    // deadline can unblock this.
                    return new Promise(() => {});
                  },
                };
              },
            })),
          },
        })),
      };
    });
    const { generateJsonStream } = await import('../../services/agentOrchestrator');

    await expect(
      generateJsonStream('prompt', { type: 'object' }, { timeoutMs: 50 }),
    ).rejects.toThrow(/timeout/i);
  });
});
