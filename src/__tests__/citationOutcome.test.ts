import { describe, it, expect } from 'vitest';
import { resolveCitationOutcome } from '../../services/governanceEngine';

// ===========================================================================
//  CRITICAL fix (current-state report, GovernanceCenter.tsx `triggerAutoSurveyReport`)
//  — `sources` isn't in the report schema's `required` list, so the model can
//  legally omit it. The generator used to silently substitute EVERY uploaded
//  document name as if each had been verified as a citation whenever `sources`
//  came back missing/empty — fabricated grounding evidence surfaced in a toast,
//  persisted to reportData, and exported in the report's «المصادر» section.
//  resolveCitationOutcome is the pure decision extracted from that flow, and is
//  deliberately never given the real document NAMES (only a count), so it is
//  structurally unable to reintroduce the "fall back to docNames" bug.
// ===========================================================================

describe('resolveCitationOutcome', () => {
  it('uses the model-provided sources as-is when present', () => {
    const out = resolveCitationOutcome({ parsedSources: ['اللائحة الداخلية', 'دليل السياسات'], docNamesCount: 5 });
    expect(out).toEqual({ citedSources: ['اللائحة الداخلية', 'دليل السياسات'], citationsMissing: false });
  });

  it('is NOT missing when there were zero documents to cite in the first place (survey-only report)', () => {
    const out = resolveCitationOutcome({ parsedSources: undefined, docNamesCount: 0 });
    expect(out).toEqual({ citedSources: [], citationsMissing: false });
  });

  it('CONFIRMED BUG REPRO — empty sources with real documents available and no retry data: flags citationsMissing and returns an EMPTY list, never fabricates a docs list', () => {
    const out = resolveCitationOutcome({ parsedSources: [], docNamesCount: 12 });
    expect(out.citedSources).toEqual([]);
    expect(out.citationsMissing).toBe(true);
  });

  it('missing (undefined) sources field behaves identically to an empty array', () => {
    const out = resolveCitationOutcome({ parsedSources: undefined, docNamesCount: 12 });
    expect(out.citedSources).toEqual([]);
    expect(out.citationsMissing).toBe(true);
  });

  it('adopts the retry sources when the retry succeeds where the primary attempt did not', () => {
    const out = resolveCitationOutcome({ parsedSources: [], docNamesCount: 8, retrySources: ['ميثاق الحوكمة'] });
    expect(out).toEqual({ citedSources: ['ميثاق الحوكمة'], citationsMissing: false });
  });

  it('still flags citationsMissing (never docNames) when the retry ALSO comes back empty', () => {
    const out = resolveCitationOutcome({ parsedSources: [], docNamesCount: 8, retrySources: [] });
    expect(out).toEqual({ citedSources: [], citationsMissing: true });
  });

  it('ignores a malformed (non-array) sources field the same as empty', () => {
    const out = resolveCitationOutcome({ parsedSources: 'ليس مصفوفة', docNamesCount: 3, retrySources: null });
    expect(out).toEqual({ citedSources: [], citationsMissing: true });
  });

  it('filters out blank entries from a returned sources array', () => {
    const out = resolveCitationOutcome({ parsedSources: ['وثيقة أ', '', 'وثيقة ب'], docNamesCount: 4 });
    expect(out.citedSources).toEqual(['وثيقة أ', 'وثيقة ب']);
  });
});
