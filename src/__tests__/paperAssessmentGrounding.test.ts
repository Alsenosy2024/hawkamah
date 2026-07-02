import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaperQuestion } from '../../types';

// CRITICAL fix under test: generatePaperQuestions used to build its prompt from
// nothing but the job-title string — never loading the tenant's ingested
// document chunks. These tests prove (a) the pure prompt-builder degrades to the
// exact prior (ungrounded) shape when there's no context, (b) grounding context
// actually reaches the model prompt when a tenant's chunk bank has content, (c)
// it degrades gracefully (no throw, grounded:false) when the bank is empty or
// compileChunkContext fails, and (d) per-batch progress is reported.
const gj = vi.hoisted(() => ({ generateJson: vi.fn() }));
const gs = vi.hoisted(() => ({ compileChunkContext: vi.fn() }));

vi.mock('../../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(), doc: vi.fn(), setDoc: vi.fn(), getDoc: vi.fn(),
}));
vi.mock('../../services/agentOrchestrator', () => gj);
vi.mock('../../services/governanceService', () => gs);

import { generatePaperQuestions, buildChunkBlock } from '../../services/paperAssessmentService';

const stubQuestions = (n: number): { questions: PaperQuestion[] } => ({
  questions: Array.from({ length: n }, (_, i) => ({
    type: 'technical', text: `Q${i}`, options: ['a. 1', 'b. 2', 'c. 3', 'd. 4'], correctAnswer: 'a',
  })) as unknown as PaperQuestion[],
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── buildChunkBlock — pure prompt-builder, no network ──────────────────────
describe('buildChunkBlock', () => {
  it('returns an empty string for empty context (prior ungrounded prompt shape is unchanged)', () => {
    expect(buildChunkBlock('')).toBe('');
  });

  it('wraps non-empty context in a grounding instruction block', () => {
    const block = buildChunkBlock('[دليل الموارد البشرية]\nسياسة الإجازات...');
    expect(block).not.toBe('');
    expect(block).toContain('سياسة الإجازات');
    expect(block).toContain('مستندات الشركة');
  });
});

// ─── generatePaperQuestions — grounding injection + graceful degradation ────
describe('generatePaperQuestions grounding', () => {
  it('is ungrounded and never calls compileChunkContext when no tenantId is given', async () => {
    gj.generateJson.mockResolvedValue(stubQuestions(6));
    const res = await generatePaperQuestions('محاسب', 4, 'medium', 50);
    expect(res.grounded).toBe(false);
    expect(gs.compileChunkContext).not.toHaveBeenCalled();
    // No batch prompt should carry the grounding block when ungrounded.
    for (const call of gj.generateJson.mock.calls) {
      expect(call[0] as string).not.toContain('مستندات الشركة الفعلية');
    }
  });

  it('is grounded and injects the tenant chunk context into every batch prompt when the bank has content', async () => {
    gs.compileChunkContext.mockResolvedValue('[سياسات الشركة]\nإجازة سنوية 30 يوماً.');
    gj.generateJson.mockResolvedValue(stubQuestions(6));
    const res = await generatePaperQuestions('محاسب', 4, 'medium', 50, undefined, undefined, 'tenant-a');
    expect(gs.compileChunkContext).toHaveBeenCalledWith('tenant-a', expect.any(Number));
    expect(res.grounded).toBe(true);
    expect(gj.generateJson.mock.calls.length).toBeGreaterThan(0);
    for (const call of gj.generateJson.mock.calls) {
      expect(call[0] as string).toContain('إجازة سنوية 30 يوماً');
    }
  });

  it('degrades to ungrounded (no throw) when the tenant chunk bank is empty', async () => {
    gs.compileChunkContext.mockResolvedValue('');
    gj.generateJson.mockResolvedValue(stubQuestions(6));
    const res = await generatePaperQuestions('محاسب', 4, 'medium', 50, undefined, undefined, 'tenant-empty');
    expect(res.grounded).toBe(false);
  });

  it('degrades to ungrounded (no throw) when compileChunkContext itself fails', async () => {
    gs.compileChunkContext.mockRejectedValue(new Error('firestore unavailable'));
    gj.generateJson.mockResolvedValue(stubQuestions(6));
    const res = await generatePaperQuestions('محاسب', 4, 'medium', 50, undefined, undefined, 'tenant-b');
    expect(res.grounded).toBe(false);
    expect(res.questions.length).toBeGreaterThan(0);   // generation itself still succeeds
  });

  it('reports batch completion progress up to the requested total', async () => {
    gj.generateJson.mockResolvedValue(stubQuestions(6));
    const onProgress = vi.fn();
    const res = await generatePaperQuestions('محاسب', 4, 'medium', 50, undefined, undefined, undefined, onProgress);
    expect(onProgress).toHaveBeenCalled();
    const [lastDone, lastTotal] = onProgress.mock.calls[onProgress.mock.calls.length - 1];
    expect(lastTotal).toBe(4);
    expect(lastDone).toBe(res.questions.length);
  });
});
