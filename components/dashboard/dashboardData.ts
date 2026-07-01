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

// ============================================================================
//  V33 — additional analytical transforms (ring · heatmap · timeline).
//  Same rules as above: pure, deterministic, `now` injectable for the tests.
// ============================================================================

export interface CompositionSlice {
  id: ScoreBucket['id'];
  count: number;
  /** Share of the evaluated pool, 0..100 (%), rounded. 0 when the pool is empty. */
  pct: number;
}

export interface TalentComposition {
  /** Per-tier slices, canonical high→optimal→mild→low order preserved. */
  slices: CompositionSlice[];
  /** Total evaluated (assessments carrying a score) — sum of the bucket counts. */
  total: number;
  /** Mean overall match score across scored assessments, 0..100 (%). 0 when empty. */
  avgScore: number;
}

/** Part-to-whole view of the evaluated pool across the 4 match-quality tiers.
 *  Reuses computeScoreBuckets so the ring and the count bars never disagree. */
export function computeTalentComposition(allAssessments: any[] = []): TalentComposition {
  const buckets = computeScoreBuckets(allAssessments);
  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  // Largest-remainder (Hamilton) rounding so the displayed shares always sum to
  // exactly 100% — independent Math.round can otherwise drift to 99%/101%.
  const raw = buckets.map(b => (total > 0 ? (b.count / total) * 100 : 0));
  const pctArr = raw.map(p => Math.floor(p));
  let leftover = total > 0 ? 100 - pctArr.reduce((acc, p) => acc + p, 0) : 0;
  raw
    .map((p, i) => ({ i, frac: p - Math.floor(p) }))
    .sort((x, y) => y.frac - x.frac)
    .forEach(({ i }) => { if (leftover > 0) { pctArr[i] += 1; leftover -= 1; } });
  const slices: CompositionSlice[] = buckets.map((b, i) => ({
    id: b.id,
    count: b.count,
    pct: pctArr[i],
  }));

  const complete = allAssessments.filter(a => a?.reportData?.totalScore !== undefined);
  const avgScore = complete.length > 0
    ? Math.round(complete.reduce((acc, a) => acc + (a.reportData.totalScore || 0), 0) / complete.length)
    : 0;

  return { slices, total, avgScore };
}

export interface HeatmapCell {
  /** Local calendar day this cell represents, as `YYYY-MM-DD`. */
  date: string;
  /** Activity on that day = assessments + logins whose timestamp lands on it. */
  count: number;
}

export interface HeatmapWeek {
  /** Seven cells, index 0..6 = Sunday..Saturday (top → bottom in the grid). */
  days: HeatmapCell[];
}

export interface ActivityHeatmap {
  /** Oldest → newest week columns; length === `weeks`. */
  weeks: HeatmapWeek[];
  /** Busiest single day in the window (drives the colour ramp). */
  maxCount: number;
}

/** Local `YYYY-MM-DD` key — mirrors buildWeeklyEngagement's local-day bucketing. */
const ymdKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** GitHub-style temporal activity grid: 7 weekday rows × `weeks` week columns,
 *  each cell counting assessments + logins on its local day. Deterministic when
 *  `now` is injected. Empty inputs still yield a full grid of zero-count cells. */
export function buildActivityHeatmap(
  allAssessments: any[] = [],
  logins: any[] = [],
  now: Date = new Date(),
  weeks: number = 12,
): ActivityHeatmap {
  const counts: Record<string, number> = {};
  const tally = (rows: any[]) => {
    for (const r of rows) {
      if (!r?.timestamp) continue;
      const d = new Date(r.timestamp);
      if (isNaN(d.getTime())) continue;   // skip malformed timestamps (mirrors buildActivityTimeline)
      const k = ymdKey(d);
      counts[k] = (counts[k] || 0) + 1;
    }
  };
  tally(allAssessments);
  tally(logins);

  // Sunday of the current week, then walk back (weeks-1) weeks for the first column.
  const gridStart = new Date(now);
  gridStart.setHours(0, 0, 0, 0);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay() - (weeks - 1) * 7);

  const out: HeatmapWeek[] = [];
  let maxCount = 0;
  for (let w = 0; w < weeks; w++) {
    const days: HeatmapCell[] = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(gridStart);
      cur.setDate(cur.getDate() + w * 7 + d);
      const count = counts[ymdKey(cur)] || 0;
      if (count > maxCount) maxCount = count;
      days.push({ date: ymdKey(cur), count });
    }
    out.push({ days });
  }
  return { weeks: out, maxCount };
}

/** Bucket a day's count into a 0..4 sequential-ramp step (0 = no activity). */
export function heatmapLevel(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  const q = maxCount / 4;
  if (count <= q) return 1;
  if (count <= 2 * q) return 2;
  if (count <= 3 * q) return 3;
  return 4;
}

export type TimelineKind = 'assessment' | 'approval' | 'login' | 'consultation';

export interface TimelineEvent {
  kind: TimelineKind;
  /** ISO timestamp (normalised) — most recent first after sorting. */
  at: string;
  /** Proper-noun / data label (name, client…) — shown verbatim (locale-neutral). */
  title: string;
  /** Secondary data line (job title, request type, reviewer) — optional. */
  subtitle?: string;
  /** Numeric badge (score %, rating…) — optional. */
  value?: number;
}

/** Merge the most recent significant events across sources into one dated,
 *  newest-first timeline capped at `limit`. Pure + deterministic; `now` gates
 *  out any event dated in the future so the chronology only ever reads back. */
export function buildActivityTimeline(
  allAssessments: any[] = [],
  logins: any[] = [],
  consultationRequests: any[] = [],
  now: Date = new Date(),
  limit: number = 7,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const iso = (t: any): string | null => {
    if (t === undefined || t === null || t === '') return null;
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  for (const a of allAssessments) {
    // Completed assessment (carries a score).
    if (a?.reportData?.totalScore !== undefined) {
      const at = iso(a.timestamp);
      if (at) events.push({
        kind: 'assessment',
        at,
        title: a.userName || a.userEmail || '',
        subtitle: a.jobTitle || '',
        value: a.reportData.totalScore,
      });
    }
    // Human approval (uses the review timestamp when present).
    if (a?.evaluatorReview?.status === 'approved') {
      const at = iso(a.evaluatorReview.reviewedAt ?? a.timestamp);
      if (at) events.push({
        kind: 'approval',
        at,
        title: a.evaluatorReview.reviewerName || '',
        subtitle: a.userName || a.jobTitle || '',
        value: a.evaluatorReview.rating,
      });
    }
  }

  for (const l of logins) {
    const at = iso(l?.timestamp);
    if (at) events.push({
      kind: 'login',
      at,
      title: l.userName || l.userEmail || '',
      subtitle: l.userName && l.userEmail ? l.userEmail : '',
    });
  }

  for (const c of consultationRequests) {
    const at = iso(c?.timestamp);
    if (at) events.push({
      kind: 'consultation',
      at,
      title: c.clientName || '',
      subtitle: c.requestType || c.industry || '',
    });
  }

  const cutoff = now.getTime();
  return events
    .filter(e => new Date(e.at).getTime() <= cutoff)
    .sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())
    .slice(0, limit);
}
