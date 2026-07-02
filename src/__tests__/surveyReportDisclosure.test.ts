import { describe, it, expect, vi, beforeEach } from 'vitest';

// P14 — [CRITICAL] aggregate reports used to silently blend AI-simulated
// respondents with real employee responses with no disclosure anywhere in the
// exported artifact. These tests pin: (1) the pure real/simulated split math
// (computeAggregate), (2) the mandatory bilingual disclosure text
// (methodologyDisclosure), and (3) that buildAggregateArtifact always renders
// the disclosure as the FIRST section — before even the statistics — and
// propagates cancellation instead of returning a fabricated "successful"
// artifact.
const orchestrator = vi.hoisted(() => ({
  generateJson: vi.fn(),
  generateJsonStream: vi.fn(),
}));
vi.mock('../../services/agentOrchestrator', () => orchestrator);

import {
  computeAggregate, methodologyDisclosure, countStreamedSections,
  buildAggregateArtifact, type SurveyResponseRecord,
} from '../../services/surveyReport';

const realRecord = (over: Partial<SurveyResponseRecord> = {}): SurveyResponseRecord => ({
  userName: 'Real Employee', jobTitle: 'Engineer', department: 'IT',
  sentiment: 'positive', simulated: false, ...over,
});
const simRecord = (over: Partial<SurveyResponseRecord> = {}): SurveyResponseRecord => ({
  userName: 'Sim Persona', jobTitle: 'Analyst', department: 'Ops',
  sentiment: 'neutral', simulated: true, ...over,
});

describe('computeAggregate — real/simulated split (P14 CRITICAL)', () => {
  it('counts an all-real pool as 0 simulated', () => {
    const agg = computeAggregate([realRecord(), realRecord(), realRecord()]);
    expect(agg.count).toBe(3);
    expect(agg.simulatedCount).toBe(0);
    expect(agg.realCount).toBe(3);
  });

  it('splits a mixed pool correctly', () => {
    const agg = computeAggregate([realRecord(), simRecord(), simRecord(), realRecord(), simRecord()]);
    expect(agg.count).toBe(5);
    expect(agg.simulatedCount).toBe(3);
    expect(agg.realCount).toBe(2);
  });

  it('treats records with no `simulated` field as real (undefined is falsy)', () => {
    const agg = computeAggregate([{ userName: 'legacy' } as SurveyResponseRecord]);
    expect(agg.simulatedCount).toBe(0);
    expect(agg.realCount).toBe(1);
  });
});

describe('methodologyDisclosure — mandatory bilingual disclosure text (P14 CRITICAL)', () => {
  it('states data is fully real when there are no simulated respondents (ar)', () => {
    const agg = computeAggregate([realRecord(), realRecord()]);
    const text = methodologyDisclosure(agg, true);
    expect(text).toContain('حقيقية بالكامل');
    expect(text).not.toMatch(/محاكى/);
  });

  it('states data is fully real when there are no simulated respondents (en)', () => {
    const agg = computeAggregate([realRecord(), realRecord()]);
    const text = methodologyDisclosure(agg, false);
    expect(text).toContain('fully real');
    expect(text).toContain('No AI-simulated');
  });

  it('discloses exact counts + a mandatory caveat when simulated responses exist (ar)', () => {
    const agg = computeAggregate([realRecord(), simRecord(), simRecord()]);
    const text = methodologyDisclosure(agg, true);
    expect(text).toContain('2 رداً محاكى');
    expect(text).toContain('من إجمالي 3');
    expect(text).toContain('1 رد حقيقي');
    expect(text).toMatch(/لا يجوز/); // the "must not present as fully real" caveat
  });

  it('discloses exact counts + a mandatory caveat when simulated responses exist (en)', () => {
    const agg = computeAggregate([realRecord(), simRecord(), simRecord()]);
    const text = methodologyDisclosure(agg, false);
    expect(text).toContain('2 AI-simulated');
    expect(text).toContain('out of 3');
    expect(text).toContain('only 1');
    expect(text).toMatch(/must not/i);
  });
});

describe('countStreamedSections — best-effort live progress proxy', () => {
  it('counts zero on an empty/preamble-only buffer', () => {
    expect(countStreamedSections('')).toBe(0);
    expect(countStreamedSections('{"executiveSummary": "...", "sections": [')).toBe(0);
  });
  it('counts each section object as its "title" key appears', () => {
    const acc = '{"executiveSummary":"x","sections":[{"title":"A","body":"..."},{"title":"B","body":"partial';
    expect(countStreamedSections(acc)).toBe(2);
  });
});

describe('buildAggregateArtifact — disclosure leads every aggregate artifact (P14 CRITICAL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator.generateJsonStream.mockResolvedValue({
      executiveSummary: 'ملخص', sections: [{ title: 'قسم 1', body: 'محتوى' }],
    });
    orchestrator.generateJson.mockResolvedValue({
      executiveSummary: 'ملخص', sections: [{ title: 'قسم 1', body: 'محتوى' }],
    });
  });

  it('renders the methodology-disclosure section FIRST, ahead of the statistics section', async () => {
    const art = await buildAggregateArtifact({
      records: [realRecord(), simRecord()],
      companyName: 'شركة تجريبية', mode: 'brief', language: 'ar',
    });
    expect(art.sections[0].id).toBe('methodology');
    expect(art.sections[0].content).toContain('1 رداً محاكى');
    expect(art.sections[1].id).toBe('stats');
  });

  it('discloses even when the AI narrative call fails entirely (stats-only fallback)', async () => {
    orchestrator.generateJsonStream.mockRejectedValue(new Error('boom'));
    orchestrator.generateJson.mockRejectedValue(new Error('boom'));
    const art = await buildAggregateArtifact({
      records: [simRecord(), simRecord()],
      companyName: 'شركة', mode: 'brief', language: 'ar',
    });
    expect(art.sections[0].id).toBe('methodology');
    expect(art.sections[0].content).toContain('2 رداً محاكى');
  });

  it('excludeSimulated:true computes the split over real records only', async () => {
    const art = await buildAggregateArtifact({
      records: [realRecord(), simRecord(), simRecord()],
      companyName: 'شركة', mode: 'brief', language: 'ar',
      excludeSimulated: true,
    });
    expect(art.sections[0].content).toContain('حقيقية بالكامل');
  });

  it('propagates cancellation instead of returning a fabricated "successful" artifact', async () => {
    const ac = new AbortController();
    ac.abort();
    orchestrator.generateJsonStream.mockRejectedValue(new Error('stream aborted'));
    orchestrator.generateJson.mockRejectedValue(new Error('ABORTED'));
    await expect(buildAggregateArtifact({
      records: [realRecord()], companyName: 'شركة', mode: 'brief', language: 'ar',
      signal: ac.signal,
    })).rejects.toThrow('ABORTED');
  });

  it('reports staged progress via onPhase (compiling → generating → complete)', async () => {
    const phases: string[] = [];
    await buildAggregateArtifact({
      records: [realRecord()], companyName: 'شركة', mode: 'brief', language: 'ar',
      onPhase: (msg) => phases.push(msg),
    });
    expect(phases.length).toBeGreaterThan(1);
    expect(phases[phases.length - 1]).toMatch(/اكتمل/);
  });
});
