// ============================================================================
//  Dashboard analytics — pure data transforms
//  ---------------------------------------------------------------------------
//  Extracted out of AdminPanel's analytics tab so the aggregation logic is
//  testable in isolation (vitest runs in node — no DOM — and these are pure).
//  Behaviour is preserved 1:1 from the original inline computation, including
//  the historical fallback placeholders used when no real data exists yet.
// ============================================================================

export type RiasecKey = 'R' | 'I' | 'A' | 'S' | 'E' | 'C';

export interface RiasecDatum {
  key: RiasecKey;
  value: number;
}

export interface ScoreBucket {
  /** high ≥85 · optimal 70–84 · mild 55–69 · low <55 */
  id: 'high' | 'optimal' | 'mild' | 'low';
  count: number;
}

export interface EngagementPoint {
  /** Short numeric day label, e.g. "6/30" (locale-independent digits). */
  label: string;
  assessments: number;
  logins: number;
}

export interface DashboardKpis {
  totalCandidates: number;
  /** Mean overall competency-match score, 0..100 (%). */
  avgScore: number;
  /** Share of assessments approved by a human evaluator, 0..100 (%). */
  approvalRatio: number;
  totalLogins: number;
}

/** RIASEC order is canonical (Holland's hexagon): R-I-A-S-E-C. */
export const RIASEC_ORDER: RiasecKey[] = ['R', 'I', 'A', 'S', 'E', 'C'];

/** Placeholder profile shown when no assessment carries a `riasec` block yet,
 *  so an empty dashboard still reads sensibly. Mirrors the legacy default. */
const RIASEC_FALLBACK: Record<RiasecKey, number> = { R: 45, I: 78, A: 30, S: 62, E: 85, C: 50 };

/** Local-day bucket key, e.g. "Jun 06" — matches the legacy slice(4, 10). */
const dayKey = (d: Date): string => d.toDateString().slice(4, 10);

export function computeKpis(allAssessments: any[] = [], logins: any[] = []): DashboardKpis {
  const totalCandidates = allAssessments.length;

  const complete = allAssessments.filter(a => a?.reportData?.totalScore !== undefined);
  const avgScore = complete.length > 0
    ? Math.round(complete.reduce((acc, a) => acc + (a.reportData.totalScore || 0), 0) / complete.length)
    : 74; // legacy fallback default

  const approved = allAssessments.filter(a => a?.evaluatorReview?.status === 'approved').length;
  const approvalRatio = totalCandidates > 0
    ? Math.round((approved / totalCandidates) * 100)
    : 80; // legacy fallback default

  const totalLogins = logins.length || 18; // legacy fallback default

  return { totalCandidates, avgScore, approvalRatio, totalLogins };
}

export function computeRiasec(allAssessments: any[] = []): RiasecDatum[] {
  const sums: Record<RiasecKey, number> = { R: 0, I: 0, A: 0, S: 0, E: 0, C: 0 };
  let processed = 0;

  for (const a of allAssessments) {
    const r = a?.reportData?.riasec;
    if (r) {
      sums.R += r.R || 0;
      sums.I += r.I || 0;
      sums.A += r.A || 0;
      sums.S += r.S || 0;
      sums.E += r.E || 0;
      sums.C += r.C || 0;
      processed++;
    }
  }

  const src = processed === 0 ? RIASEC_FALLBACK : sums;
  return RIASEC_ORDER.map(key => ({ key, value: src[key] }));
}

export function computeScoreBuckets(allAssessments: any[] = []): ScoreBucket[] {
  let high = 0, optimal = 0, mild = 0, low = 0;

  for (const a of allAssessments) {
    const score = a?.reportData?.totalScore;
    if (score !== undefined) {
      if (score >= 85) high++;
      else if (score >= 70) optimal++;
      else if (score >= 55) mild++;
      else low++;
    }
  }

  return [
    { id: 'high', count: high },
    { id: 'optimal', count: optimal },
    { id: 'mild', count: mild },
    { id: 'low', count: low },
  ];
}

/** Last 7 calendar days (oldest → newest) of assessment + login counts.
 *  `now` is injectable so the transform is deterministic under test. */
export function buildWeeklyEngagement(
  allAssessments: any[] = [],
  logins: any[] = [],
  now: Date = new Date(),
): EngagementPoint[] {
  const points: EngagementPoint[] = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    const key = dayKey(d);

    const assessments = allAssessments.filter(
      a => a?.timestamp && dayKey(new Date(a.timestamp)) === key,
    ).length;
    const loginsOnDay = logins.filter(
      l => l?.timestamp && dayKey(new Date(l.timestamp)) === key,
    ).length;

    points.push({ label, assessments, logins: loginsOnDay });
  }

  return points;
}

/** Look up a single trait's accumulated value (used by the export summary). */
export function riasecValue(data: RiasecDatum[], key: RiasecKey): number {
  return data.find(d => d.key === key)?.value ?? 0;
}
