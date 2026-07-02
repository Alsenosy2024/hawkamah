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

import {
  createUnifiedToken, saveUnifiedResult, scoreAttempt,
  getAttemptQuestions, buildEmployeeArtifact,
} from '../../services/unifiedAssessmentService';

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

  it('treats a skipped question (no recorded answer) as incorrect — A5 skip', () => {
    // A5: skipping records NO entry for that index. Q1 + Q3 answered correctly,
    // Q2 skipped → 2 of 3 MCQs correct. The skipped question stays in the
    // denominator (it counts against the score), so totals stay consistent —
    // a skip is exactly equivalent to a wrong answer, never silently dropped.
    const questions = [q('A'), q('B'), q('C')];
    expect(scoreAttempt(questions, { 0: 'A) ok', 2: 'C) ok' })).toBe(67); // round(2/3*100)
    // Every question skipped → 0.
    expect(scoreAttempt(questions, {})).toBe(0);
  });
});

// ─── getAttemptQuestions — CRITICAL fix: real persisted questions, never a ──
// ─── fabricated placeholder (legacy-record fallback) ────────────────────────
describe('getAttemptQuestions', () => {
  const attempt = (over: Partial<import('../../types').UnifiedAttempt> = {}): import('../../types').UnifiedAttempt =>
    ({
      attemptNumber: 1, answers: {}, score: 0, violations: 0,
      jobTitle: 'محاسب', startedAt: 't0', finishedAt: 't1',
      ...over,
    } as import('../../types').UnifiedAttempt);

  const baseResult = (over: Partial<UnifiedAssessmentResult> = {}): UnifiedAssessmentResult =>
    ({
      tokenId: 'tok1', tenantId: 't1', projectId: 't1', companyName: 'شركة',
      employeeName: 'سعيد', jobTitle: 'محاسب', bestScore: 0, passed: false,
      submittedAt: new Date().toISOString(), attempts: [],
      ...over,
    } as unknown as UnifiedAssessmentResult);

  it('returns the real persisted question set from the best-scoring attempt', () => {
    const realQs = [q('A'), q('B')];
    const result = baseResult({
      bestScore: 80,
      attempts: [
        attempt({ attemptNumber: 1, score: 40, questions: [q('X')] }),
        attempt({ attemptNumber: 2, score: 80, questions: realQs }),
      ],
    });
    expect(getAttemptQuestions(result)).toBe(realQs);
  });

  it('falls back to the first attempt when none matches bestScore', () => {
    const first = [q('A')];
    const result = baseResult({
      bestScore: 999,   // no attempt has this score (defensive edge case)
      attempts: [attempt({ questions: first })],
    });
    expect(getAttemptQuestions(result)).toBe(first);
  });

  it('returns [] — never a fabricated placeholder — for a legacy attempt with no persisted questions', () => {
    const result = baseResult({
      bestScore: 60,
      attempts: [attempt({ score: 60, answers: { 0: 'A', 1: 'B' } })],   // no `questions` field
    });
    expect(getAttemptQuestions(result)).toEqual([]);
  });

  it('returns [] for a result with no attempts at all', () => {
    expect(getAttemptQuestions(baseResult({ attempts: [] }))).toEqual([]);
  });
});

// ─── buildEmployeeArtifact — CRITICAL fix: honest legacy state, no fabricated ─
// ─── answer sheet (every ❌, "سؤال N") when questions weren't persisted ──────
describe('buildEmployeeArtifact', () => {
  const result = (over: Partial<UnifiedAssessmentResult> = {}): UnifiedAssessmentResult =>
    ({
      tokenId: 'tok1', tenantId: 't1', projectId: 't1', companyName: 'شركة',
      employeeName: 'سعيد الأحمد', jobTitle: 'محاسب أول', bestScore: 100,
      passed: true, submittedAt: new Date().toISOString(),
      attempts: [{
        attemptNumber: 1, answers: { 0: 'A' }, score: 100, violations: 0,
        jobTitle: 'محاسب أول', startedAt: 't0', finishedAt: 't1',
      }],
      ...over,
    } as unknown as UnifiedAssessmentResult);

  it('renders the REAL question text/answers when questions were persisted', () => {
    const realQs = [
      { type: 'technical', text: 'ما هو المعيار المحاسبي المطبق؟', options: ['A. أ', 'B. ب'], correctAnswer: 'A' },
    ] as unknown as import('../../types').PaperQuestion[];
    const artifact = buildEmployeeArtifact(result(), realQs);
    const answers = artifact.sections.find(s => s.id === 'answers')!;
    expect(answers.content).toContain('ما هو المعيار المحاسبي المطبق؟');
    expect(answers.content).toContain('✅');   // chosen 'A' matches correctAnswer 'A'
  });

  it('shows an honest legacy notice — never a fabricated "سؤال N" / all-❌ sheet — when no questions were persisted', () => {
    const artifact = buildEmployeeArtifact(result(), []);
    const answers = artifact.sections.find(s => s.id === 'answers')!;
    expect(answers.content).toContain('الأسئلة الأصلية غير محفوظة لهذا التقييم');
    // Regression guard against the old fabrication path's exact shape.
    expect(answers.content).not.toMatch(/سؤال \d/);
    expect(answers.content).not.toContain('❌');
  });
});
