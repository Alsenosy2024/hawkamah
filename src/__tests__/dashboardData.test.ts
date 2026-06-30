import { describe, it, expect } from 'vitest';
import {
  computeKpis,
  computeRiasec,
  computeScoreBuckets,
  buildWeeklyEngagement,
  riasecValue,
  RIASEC_ORDER,
} from '../../components/dashboard/dashboardData';

// ===========================================================================
//  V28 dashboard makeover — the analytics aggregation was lifted out of
//  AdminPanel into pure helpers so the maths is observable without a DOM.
//  These tests pin behaviour 1:1 with the legacy inline computation, incl.
//  the historical fallback placeholders shown when no data exists yet.
// ===========================================================================

const a = (over: any = {}) => ({ reportData: {}, ...over });

describe('computeKpis', () => {
  it('falls back to legacy placeholders on empty input', () => {
    expect(computeKpis([], [])).toEqual({
      totalCandidates: 0, avgScore: 74, approvalRatio: 80, totalLogins: 18,
    });
  });

  it('averages totalScore over completed assessments and rounds', () => {
    const data = [
      a({ reportData: { totalScore: 80 } }),
      a({ reportData: { totalScore: 91 } }),
      a({ reportData: {} }),            // incomplete — excluded from avg
    ];
    const k = computeKpis(data, [{}, {}, {}]);
    expect(k.totalCandidates).toBe(3);
    expect(k.avgScore).toBe(86);       // round((80+91)/2) = 85.5 -> 86
    expect(k.totalLogins).toBe(3);
  });

  it('computes approval ratio as a rounded percentage of all assessments', () => {
    const data = [
      a({ evaluatorReview: { status: 'approved' } }),
      a({ evaluatorReview: { status: 'pending' } }),
      a({ evaluatorReview: { status: 'approved' } }),
    ];
    expect(computeKpis(data, [{}]).approvalRatio).toBe(67); // round(2/3*100)
  });
});

describe('computeRiasec', () => {
  it('returns the canonical R-I-A-S-E-C order', () => {
    expect(computeRiasec([]).map(d => d.key)).toEqual(RIASEC_ORDER);
  });

  it('uses the fallback profile when no assessment carries a riasec block', () => {
    const byKey = Object.fromEntries(computeRiasec([]).map(d => [d.key, d.value]));
    expect(byKey).toEqual({ R: 45, I: 78, A: 30, S: 62, E: 85, C: 50 });
  });

  it('sums riasec values across assessments and ignores ones without it', () => {
    const data = [
      a({ reportData: { riasec: { R: 1, I: 2, A: 3, S: 4, E: 5, C: 6 } } }),
      a({ reportData: { riasec: { R: 10, E: 5 } } }), // missing keys treated as 0
      a({ reportData: {} }),                          // no riasec — skipped
    ];
    const r = computeRiasec(data);
    expect(riasecValue(r, 'R')).toBe(11);
    expect(riasecValue(r, 'E')).toBe(10);
    expect(riasecValue(r, 'C')).toBe(6);
  });
});

describe('computeScoreBuckets', () => {
  it('classifies scores into high/optimal/mild/low by the documented thresholds', () => {
    const data = [85, 84, 70, 69, 55, 54, 90].map(s => a({ reportData: { totalScore: s } }));
    const byId = Object.fromEntries(computeScoreBuckets(data).map(b => [b.id, b.count]));
    expect(byId).toEqual({ high: 2, optimal: 2, mild: 2, low: 1 });
  });

  it('returns all-zero buckets (not a fallback) when there are no scores', () => {
    expect(computeScoreBuckets([]).every(b => b.count === 0)).toBe(true);
  });
});

describe('buildWeeklyEngagement', () => {
  const NOW = new Date('2026-06-30T12:00:00');

  it('produces 7 oldest→newest day points with M/D labels', () => {
    const pts = buildWeeklyEngagement([], [], NOW);
    expect(pts).toHaveLength(7);
    expect(pts[6].label).toBe('6/30');          // today is last
    expect(pts[0].label).toBe('6/24');          // 6 days earlier is first
  });

  it('counts assessments and logins on their matching calendar day', () => {
    const onJun30 = new Date('2026-06-30T09:00:00').toISOString();
    const onJun24 = new Date('2026-06-24T22:00:00').toISOString();
    const pts = buildWeeklyEngagement(
      [{ timestamp: onJun30 }, { timestamp: onJun30 }, { timestamp: onJun24 }],
      [{ timestamp: onJun30 }],
      NOW,
    );
    expect(pts[6]).toEqual({ label: '6/30', assessments: 2, logins: 1 });
    expect(pts[0]).toEqual({ label: '6/24', assessments: 1, logins: 0 });
  });
});
