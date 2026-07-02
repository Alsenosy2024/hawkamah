import { describe, it, expect, vi, beforeEach } from 'vitest';

// P14 — [MAJOR] a total simulation failure (every batch's generateJson call
// throwing) used to be swallowed and reported as a SUCCESSFUL run with 0
// respondents (SurveyLab then toasted "simulation complete: 0 saved" as if
// nothing were wrong). These tests pin: (1) a total batch failure now throws,
// (2) a partial failure still returns whatever succeeded (so the caller can
// report "N of M"), and (3) the `grounded` stamp records whether the run had
// ingested-document context available (the empty-chunk-bank warning fix).
const fs = vi.hoisted(() => ({
  setDoc: vi.fn(() => Promise.resolve()),
  doc: vi.fn((_db: unknown, coll: string, id?: string) => ({ coll, id })),
}));
vi.mock('firebase/firestore', () => fs);
vi.mock('../../firebase', () => ({ db: {} }));

const orchestrator = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock('../../services/agentOrchestrator', () => orchestrator);

const gemini = vi.hoisted(() => ({ analyzeWorkEnvironment: vi.fn() }));
vi.mock('../../services/geminiService', () => gemini);

import {
  simulateRespondents, toAssessmentRecord, runSurveySimulation,
  type SimulatedRespondent,
} from '../../services/surveySimulation';

const respondent = (n: string): SimulatedRespondent => ({
  persona: { name: n, jobTitle: 'Engineer', department: 'IT', tenureYears: 2, sentiment: 'positive' },
  answers: {
    proceduresAndPolicies: 'a', digitalInfrastructure: 'b', challengesAndProblems: 'c',
    employeeRelationships: 'd', aspirationsAndDevelopment: 'e', organizationalReconstructionOpinion: 'f',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('simulateRespondents — batch failure surfacing (P14 MAJOR)', () => {
  it('throws when EVERY batch fails, instead of silently returning zero respondents', async () => {
    orchestrator.generateJson.mockRejectedValue(new Error('model unavailable'));
    await expect(simulateRespondents({
      count: 8, companyName: 'X', orgContext: 'ctx', language: 'ar',
    })).rejects.toThrow();
  });

  it('returns the successful batch(es) on a PARTIAL failure, without throwing', async () => {
    // count=12 → two batches of size 8 and 4. First batch fails, second succeeds.
    orchestrator.generateJson
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ respondents: [respondent('A'), respondent('B'), respondent('C'), respondent('D')] });
    const out = await simulateRespondents({ count: 12, companyName: 'X', orgContext: 'ctx', language: 'ar' });
    expect(out.length).toBe(4);
    expect(out.map(r => r.persona.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('does not throw when cancelled before any batch runs (0 attempted is not "all failed")', async () => {
    const ac = new AbortController();
    ac.abort();
    orchestrator.generateJson.mockRejectedValue(new Error('should not be called'));
    const out = await simulateRespondents({ count: 8, companyName: 'X', orgContext: 'ctx', language: 'ar', signal: ac.signal });
    expect(out).toEqual([]);
    expect(orchestrator.generateJson).not.toHaveBeenCalled();
  });

  it('succeeds normally when every batch succeeds', async () => {
    orchestrator.generateJson.mockResolvedValue({ respondents: [respondent('A')] });
    const out = await simulateRespondents({ count: 1, companyName: 'X', orgContext: 'ctx', language: 'ar' });
    expect(out.length).toBe(1);
  });
});

describe('toAssessmentRecord — grounded stamp (P14 MAJOR, empty chunk-bank warning)', () => {
  it('stamps grounded:true/false exactly as passed', () => {
    const r = respondent('A');
    expect(toAssessmentRecord('tenant1', r, null, 0, true).grounded).toBe(true);
    expect(toAssessmentRecord('tenant1', r, null, 0, false).grounded).toBe(false);
  });
});

describe('runSurveySimulation — honest partial/failure reporting + grounded stamping', () => {
  it('propagates a total batch failure as a thrown error (no false-positive success)', async () => {
    orchestrator.generateJson.mockRejectedValue(new Error('model unavailable'));
    await expect(runSurveySimulation({
      count: 4, tenantId: 't1', companyName: 'X', orgContext: 'ctx', language: 'ar', analyze: false,
    })).rejects.toThrow();
  });

  it('reports `requested` alongside `saved` so a caller can detect a partial run', async () => {
    orchestrator.generateJson.mockResolvedValue({
      respondents: [respondent('A'), respondent('B')],
    });
    const res = await runSurveySimulation({
      count: 2, tenantId: 't1', companyName: 'X', orgContext: 'ctx', language: 'ar', analyze: false,
    });
    expect(res.requested).toBe(2);
    expect(res.saved).toBe(2);
  });

  it('stamps every produced record grounded:true when chunkContext was supplied', async () => {
    orchestrator.generateJson.mockResolvedValue({ respondents: [respondent('A')] });
    const res = await runSurveySimulation({
      count: 1, tenantId: 't1', companyName: 'X', orgContext: 'ctx',
      chunkContext: '[doc] some real content', language: 'ar', analyze: false,
    });
    expect(res.records.every(r => r.grounded === true)).toBe(true);
  });

  it('stamps every produced record grounded:false when chunkContext is empty (no indexed docs)', async () => {
    orchestrator.generateJson.mockResolvedValue({ respondents: [respondent('A')] });
    const res = await runSurveySimulation({
      count: 1, tenantId: 't1', companyName: 'X', orgContext: 'ctx',
      chunkContext: '', language: 'ar', analyze: false,
    });
    expect(res.records.every(r => r.grounded === false)).toBe(true);
  });
});
