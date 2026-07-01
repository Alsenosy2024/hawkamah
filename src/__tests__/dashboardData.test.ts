import { describe, it, expect } from 'vitest';
import {
  computeKpis,
  computeRiasec,
  computeScoreBuckets,
  buildWeeklyEngagement,
  riasecValue,
  RIASEC_ORDER,
  computeTalentComposition,
  buildActivityHeatmap,
  heatmapLevel,
  buildActivityTimeline,
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

// ===========================================================================
//  V33 additions — talent-composition ring, activity heatmap, timeline.
// ===========================================================================

describe('computeTalentComposition', () => {
  it('returns zeroed shares and average on empty input', () => {
    const c = computeTalentComposition([]);
    expect(c.total).toBe(0);
    expect(c.avgScore).toBe(0);
    expect(c.slices.map(s => s.id)).toEqual(['high', 'optimal', 'mild', 'low']);
    expect(c.slices.every(s => s.count === 0 && s.pct === 0)).toBe(true);
  });

  it('computes per-tier share and the overall average of scored assessments', () => {
    const data = [90, 80, 60, 40].map(s => a({ reportData: { totalScore: s } }));
    const c = computeTalentComposition(data);
    expect(c.total).toBe(4);
    const byId = Object.fromEntries(c.slices.map(s => [s.id, s]));
    expect(byId.high.count).toBe(1);     // 90
    expect(byId.optimal.count).toBe(1);  // 80
    expect(byId.mild.count).toBe(1);     // 60
    expect(byId.low.count).toBe(1);      // 40
    expect(byId.high.pct).toBe(25);      // 1/4
    expect(c.avgScore).toBe(68);         // round((90+80+60+40)/4) = round(67.5) = 68
  });

  it('rounds shares by largest remainder so they always total 100%', () => {
    // 1 each in high/optimal/mild → 33.33% each; naive rounding would sum to 99%.
    const data = [90, 80, 60].map(s => a({ reportData: { totalScore: s } }));
    const c = computeTalentComposition(data);
    expect(c.slices.reduce((acc, s) => acc + s.pct, 0)).toBe(100);
    expect(c.slices.filter(s => s.count > 0).every(s => s.pct === 34 || s.pct === 33)).toBe(true);
    expect(c.slices.find(s => s.id === 'low')?.pct).toBe(0); // no leftover leaks into empty tiers
  });
});

describe('buildActivityHeatmap', () => {
  const NOW = new Date('2026-06-30T12:00:00');

  it('builds a weeks×7 grid whose last column contains today', () => {
    const h = buildActivityHeatmap([], [], NOW, 12);
    expect(h.weeks).toHaveLength(12);
    expect(h.weeks.every(w => w.days.length === 7)).toBe(true);
    expect(h.maxCount).toBe(0);
    const lastWeek = h.weeks[11];
    expect(lastWeek.days.some(d => d.date === '2026-06-30')).toBe(true);
  });

  it('counts assessments + logins on their local day and tracks the max', () => {
    const onJun30 = new Date('2026-06-30T09:00:00').toISOString();
    const onJun29 = new Date('2026-06-29T20:00:00').toISOString();
    const h = buildActivityHeatmap(
      [{ timestamp: onJun30 }, { timestamp: onJun30 }, { timestamp: onJun29 }],
      [{ timestamp: onJun30 }],
      NOW,
      12,
    );
    const cellFor = (date: string) => h.weeks.flatMap(w => w.days).find(d => d.date === date);
    expect(cellFor('2026-06-30')?.count).toBe(3); // 2 assessments + 1 login
    expect(cellFor('2026-06-29')?.count).toBe(1);
    expect(h.maxCount).toBe(3);
  });

  it('skips malformed timestamps instead of counting a NaN day', () => {
    const h = buildActivityHeatmap(
      [{ timestamp: '2026-06-30T09:00:00' }, { timestamp: 'not-a-date' }],
      [{ timestamp: 'also-bad' }, { timestamp: null }],
      NOW,
      12,
    );
    const allDates = h.weeks.flatMap(w => w.days.map(d => d.date));
    expect(allDates.includes('NaN-NaN-NaN')).toBe(false);
    const cellFor = (date: string) => h.weeks.flatMap(w => w.days).find(d => d.date === date);
    expect(cellFor('2026-06-30')?.count).toBe(1); // only the valid entry counts
    expect(h.maxCount).toBe(1);
  });
});

describe('heatmapLevel', () => {
  it('returns 0 for no activity or an empty window', () => {
    expect(heatmapLevel(0, 10)).toBe(0);
    expect(heatmapLevel(5, 0)).toBe(0);
  });

  it('buckets counts into 1..4 quartile steps of the max', () => {
    expect(heatmapLevel(1, 8)).toBe(1);
    expect(heatmapLevel(2, 8)).toBe(1);
    expect(heatmapLevel(4, 8)).toBe(2);
    expect(heatmapLevel(6, 8)).toBe(3);
    expect(heatmapLevel(8, 8)).toBe(4);
  });
});

describe('buildActivityTimeline', () => {
  const NOW = new Date('2026-06-30T12:00:00');
  const at = (iso: string) => new Date(iso).toISOString();

  it('returns an empty list when there is nothing to show', () => {
    expect(buildActivityTimeline([], [], [], NOW)).toEqual([]);
  });

  it('merges every source, sorts newest-first, and maps each event', () => {
    const assessments = [{
      userName: 'A', jobTitle: 'Eng',
      timestamp: at('2026-06-28T10:00:00'),
      reportData: { totalScore: 88 },
      evaluatorReview: { status: 'approved', reviewerName: 'R', rating: 5, reviewedAt: at('2026-06-29T10:00:00') },
    }];
    const logins = [{ userName: 'L', userEmail: 'l@x.io', timestamp: at('2026-06-27T10:00:00') }];
    const consults = [{ clientName: 'C', requestType: 'audit', timestamp: at('2026-06-30T08:00:00') }];

    const tl = buildActivityTimeline(assessments, logins, consults, NOW, 10);
    expect(tl.map(e => e.kind)).toEqual(['consultation', 'approval', 'assessment', 'login']);
    expect(tl[0]).toMatchObject({ kind: 'consultation', title: 'C', subtitle: 'audit' });
    expect(tl.find(e => e.kind === 'assessment')?.value).toBe(88);
    expect(tl.find(e => e.kind === 'approval')?.value).toBe(5);
  });

  it('caps the number of events to the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      userName: 'U' + i,
      timestamp: new Date(2026, 5, i + 1, 10).toISOString(),
    }));
    expect(buildActivityTimeline([], many, [], NOW, 6)).toHaveLength(6);
  });

  it('excludes events dated after `now`', () => {
    const future = [{ userName: 'F', timestamp: at('2026-07-05T10:00:00') }];
    expect(buildActivityTimeline([], future, [], NOW)).toEqual([]);
  });
});
