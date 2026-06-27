import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaperQuestion, UnifiedAssessmentResult, UnifiedAssessmentToken } from '../../types';

// Firebase is mocked so these run offline and we can capture exactly what would
// be written to Firestore. vi.hoisted lets the (hoisted) vi.mock factories share
// the same spy instances we assert on below.
const fs = vi.hoisted(() => ({
  setDoc: vi.fn((..._a: any[]) => Promise.resolve()),
  addDoc: vi.fn((..._a: any[]) => Promise.resolve({ id: 'generated-id' })),
  updateDoc: vi.fn((..._a: any[]) => Promise.resolve()),
  doc: vi.fn((_db: unknown, coll: string, id?: string) => ({ coll, id })),
  collection: vi.fn((_db: unknown, coll: string) => ({ coll })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
}));

vi.mock('../../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => fs);
vi.mock('../../services/agentOrchestrator', () => ({ generateJson: vi.fn() }));
vi.mock('../../services/exportService', () => ({ exportDocx: vi.fn(), exportPdfDirect: vi.fn() }));

import { createUnifiedToken, saveUnifiedResult, scoreAttempt } from '../../services/unifiedAssessmentService';

// Recursively assert no value is literally `undefined` — Firestore rejects those.
const hasUndefined = (o: unknown): boolean => {
  if (o === undefined) return true;
  if (o === null || typeof o !== 'object') return false;
  return Object.values(o as Record<string, unknown>).some(hasUndefined);
};

const q = (correctAnswer: string, isVoice = false): PaperQuestion =>
  ({ text: 'q', type: 'mcq', correctAnswer, isVoice } as unknown as PaperQuestion);

beforeEach(() => {
  vi.clearAllMocks();
  // createUnifiedToken builds the URL from window.location.origin.
  vi.stubGlobal('window', { location: { origin: 'https://app.test' } });
});

// ─── createUnifiedToken — the bug that started this: undefined companyLogoUrl ──
describe('createUnifiedToken', () => {
  const base = {
    tenantId: 't1', projectId: 't1', companyName: 'شركة كلمة',
    questionCount: 20, behavioralPct: 30, difficulty: 'medium',
    secondsPerQuestion: 60, maxAttempts: 1, passingScore: 60,
    voiceQuestionCount: 0, cameraProctoring: false,
    theories: { birkman: false, holland: true, psychTech: false, bloom: false },
    allowedJobTitles: ['محاسب'],
  };

  it('strips an undefined companyLogoUrl instead of sending it to Firestore', async () => {
    await createUnifiedToken({ ...base, companyLogoUrl: undefined } as any);
    expect(fs.setDoc).toHaveBeenCalledTimes(1);
    const data = fs.setDoc.mock.calls[0][1] as Record<string, unknown>;
    expect('companyLogoUrl' in data).toBe(false);   // omitted, not written as undefined
    expect(hasUndefined(data)).toBe(false);          // nothing undefined anywhere
  });

  it('keeps a real companyLogoUrl when present', async () => {
    await createUnifiedToken({ ...base, companyLogoUrl: 'https://logo.png' } as any);
    const data = fs.setDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(data.companyLogoUrl).toBe('https://logo.png');
  });

  it('stamps id/createdAt/active and returns a working assess URL', async () => {
    const { token, url } = await createUnifiedToken({ ...base } as any);
    const data = fs.setDoc.mock.calls[0][1] as UnifiedAssessmentToken;
    expect(data.id).toBe(token);
    expect(data.active).toBe(true);
    expect(typeof data.createdAt).toBe('string');
    expect(url).toBe(`https://app.test/?assess=${token}`);
  });

  it('preserves falsy values (0 / false / "") — clean only drops undefined', async () => {
    await createUnifiedToken({ ...base, passingScore: 0, cameraProctoring: false } as any);
    const data = fs.setDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(data.passingScore).toBe(0);
    expect(data.cameraProctoring).toBe(false);
  });

  it('carries cameraProctoring=true through to the saved token (AI proctoring config travels)', async () => {
    await createUnifiedToken({ ...base, cameraProctoring: true } as any);
    const data = fs.setDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(data.cameraProctoring).toBe(true);   // portal gates camera+screen monitoring on this flag
  });
});

// ─── saveUnifiedResult — same undefined hazard (analysis before it's generated) ─
describe('saveUnifiedResult', () => {
  const result = (over: Partial<UnifiedAssessmentResult> = {}): UnifiedAssessmentResult =>
    ({
      tenantId: 't1', tokenId: 'tok1', projectId: 't1', companyName: 'شركة',
      employeeName: 'سعيد', jobTitle: 'محاسب', attempts: [], bestScore: 0,
      passed: false, submittedAt: new Date().toISOString(),
      analysis: undefined,            // not generated yet → must be stripped
      ...over,
    } as unknown as UnifiedAssessmentResult);

  it('addDoc path strips undefined and returns the new id', async () => {
    const id = await saveUnifiedResult(result());
    expect(fs.addDoc).toHaveBeenCalledTimes(1);
    const data = fs.addDoc.mock.calls[0][1] as Record<string, unknown>;
    expect('analysis' in data).toBe(false);
    expect(hasUndefined(data)).toBe(false);
    expect(id).toBe('generated-id');
  });

  it('updateDoc path drops the id field and any undefined', async () => {
    const id = await saveUnifiedResult(result({ id: 'r1' }));
    expect(fs.updateDoc).toHaveBeenCalledTimes(1);
    const data = fs.updateDoc.mock.calls[0][1] as Record<string, unknown>;
    expect('id' in data).toBe(false);          // id is the doc key, not a field
    expect(hasUndefined(data)).toBe(false);
    expect(id).toBe('r1');
  });
});

// ─── scoreAttempt — MCQ scoring, voice questions excluded ──────────────────────
describe('scoreAttempt', () => {
  it('scores only MCQs and ignores voice questions', () => {
    const questions = [q('A'), q('B'), q('C', true), q('D')];   // index 2 is voice
    const answers = { 0: 'A', 1: 'X', 3: 'D' };                  // 2 of 3 MCQs correct
    expect(scoreAttempt(questions, answers)).toBe(67);           // round(2/3*100)
  });

  it('matches when the chosen answer starts with the correct letter', () => {
    const questions = [q('A'), q('B')];
    expect(scoreAttempt(questions, { 0: 'A) الخيار', 1: 'B) آخر' })).toBe(100);
  });

  it('returns 0 when there are no MCQs (all voice)', () => {
    expect(scoreAttempt([q('A', true), q('B', true)], { 0: 'A', 1: 'B' })).toBe(0);
  });

  it('returns 0 for an empty answer set', () => {
    expect(scoreAttempt([q('A'), q('B')], {})).toBe(0);
  });

  it('never scores a question correct when its correctAnswer is empty', () => {
    // A degenerate question (model emitted an empty correctAnswer) must NOT be
    // counted correct for everyone — startsWith('') is always true. Regression
    // guard: only the genuinely-correct Q1 should count.
    expect(scoreAttempt([q(''), q('B')], { 0: 'anything', 1: 'B) آخر' })).toBe(50);
    expect(scoreAttempt([q('')], { 0: '' })).toBe(0);
  });
});
