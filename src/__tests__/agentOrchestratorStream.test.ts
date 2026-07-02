import { describe, it, expect, vi } from 'vitest';

// D3 (P7) — generateJsonStream used to omit maxOutputTokens and hardcode
// MEDIUM thinking. generateJson's own docstring documents the failure mode
// this causes: an unbounded thinking budget at MEDIUM can silently eat the
// WHOLE output budget on a comprehensive-length diagnostic, truncating the
// streamed JSON so extractJson throws at stream end and the caller silently
// falls back to the blocking ladder — the live preview never shows for
// exactly the long runs that need it. These tests pin the fixed config:
// an explicit generous maxOutputTokens + LOW thinking by default, still
// overridable per-call.
const captured = vi.hoisted(() => ({ config: null as any }));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContentStream: vi.fn(async (params: any) => {
          captured.config = params.config;
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: '{"totalScore":1}' }] } }] };
          })();
        }),
      },
    })),
  };
});

import { ThinkingLevel } from '@google/genai';
import { generateJsonStream } from '../../services/agentOrchestrator';

describe('generateJsonStream config (D3 — robust streamed diagnostic)', () => {
  it('defaults to an explicit generous maxOutputTokens and LOW thinking', async () => {
    const result = await generateJsonStream<any>('prompt', { type: 'object' });
    expect(result).toEqual({ totalScore: 1 });
    expect(captured.config.maxOutputTokens).toBeGreaterThanOrEqual(32000);
    expect(captured.config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
  });

  it('lets a caller override maxOutputTokens and thinkingLevel', async () => {
    await generateJsonStream<any>('prompt', { type: 'object' }, {
      maxOutputTokens: 8000,
      thinkingLevel: ThinkingLevel.MEDIUM,
    });
    expect(captured.config.maxOutputTokens).toBe(8000);
    expect(captured.config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
  });
});
