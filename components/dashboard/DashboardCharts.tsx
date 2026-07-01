import React, { useState, useRef, useLayoutEffect } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LineChart,
  Line,
  LabelList,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
  Cell,
} from 'recharts';
import { Language } from '../../types';
import {
  DashboardKpis,
  RiasecDatum,
  RiasecKey,
  ScoreBucket,
  EngagementPoint,
  TalentComposition,
  ActivityHeatmap as ActivityHeatmapData,
  TimelineEvent,
  heatmapLevel,
} from './dashboardData';

// ============================================================================
//  Dashboard charts — Recharts v3, redesigned for RTL + accessibility.
//  ---------------------------------------------------------------------------
//  Recharts does NOT auto-mirror for RTL, so axes / legends / labels are
//  reversed and bidi-isolated by hand here. Colour is never the only channel:
//  every series/bucket also carries a text label, and the two line series add
//  dash-pattern + marker-shape redundancy. Palette is the Hawkamah teal brand
//  (literal hexes mirror the --hw-* tokens in index.css; SVG fills want a
//  concrete colour). Red/green is avoided throughout.
// ============================================================================

// Brand / ink palette — literal mirrors of the index.css --hw-* tokens.
// Data marks use the deeper --hw-brand-hover (≈4.66:1 on white) rather than the
// brighter --hw-brand (≈2.85:1) so chart marks clear WCAG 1.4.11 (3:1 non-text).
const BRAND = '#0b8090';        // --hw-brand-hover (accessible brand teal for marks)
const BRAND_PRESSED = '#0a6775'; // --hw-brand-pressed
const BRAND_BLUE = '#1e6fa8';   // --hw-brand-blue
const INK = '#122a33';          // --hw-text
const MUTED = '#5c7280';        // --hw-text-muted
const GRID = '#e3eaee';         // --hw-border
const AMBER = '#8a5e0c';        // warning ink (allowed: not red/green)

// First-Strong Isolate … Pop Directional Isolate — keeps Latin/number tokens
// from being visually reordered by the bidi algorithm inside SVG <text>.
const ISO = (s: string | number): string => '⁨' + s + '⁩';

/**
 * MeasuredChart — gates ResponsiveContainer mount until the parent box has a
 * positive measured size, eliminating Recharts v3's `width(-1)/height(-1)`
 * first-paint warning inside a `min-w-0` grid/flex cell.
 */
const MeasuredChart: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = size.w > 0 && size.h > 0;
  return (
    <div ref={ref} className={className}>
      {ready ? (
        <ResponsiveContainer width={size.w} height={size.h}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      ) : null}
    </div>
  );
};

// A faint chart-card chrome shared by every panel.
const ChartCard: React.FC<{ title: React.ReactNode; badge: string; className?: string; children: React.ReactNode }> = ({ title, badge, className, children }) => (
  <div className={`bg-white border border-slate-200 p-4 rounded-lg space-y-3 ${className || ''}`}>
    <div className="flex justify-between items-center border-b border-slate-100 pb-2">
      <h4 className="text-xs font-bold text-slate-700">{title}</h4>
      <span className="hw-badge-neutral text-[9px]">{badge}</span>
    </div>
    {children}
  </div>
);

// ────────────────────────────────────────────────────────────────────────────
//  1) KPI cards — Label → Value → (Gap vs target | Timeframe). Value largest.
// ────────────────────────────────────────────────────────────────────────────

interface KpiCardSpec {
  label: string;
  value: number;
  suffix?: string;       // e.g. '%'
  unit?: string;         // e.g. 'employee'
  target?: number;       // present only where a target is meaningful
  timeframe: string;
}

const KpiCard: React.FC<{ spec: KpiCardSpec; language: Language }> = ({ spec, language }) => {
  const ar = language === 'ar';
  const hasTarget = typeof spec.target === 'number';
  const gap = hasTarget ? spec.value - (spec.target as number) : 0;
  const onTarget = gap >= 0;

  return (
    <div className="bg-white p-4 text-start">
      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">{spec.label}</div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums" style={{ color: INK }}>
          <bdi>{spec.value}{spec.suffix || ''}</bdi>
        </span>
        {spec.unit && <span className="text-[11px] font-medium text-slate-400">{spec.unit}</span>}
      </div>

      {hasTarget ? (
        <div className="mt-1.5 flex items-center gap-1 text-[10px] font-bold" style={{ color: onTarget ? BRAND_PRESSED : AMBER }}>
          <span aria-hidden="true">{onTarget ? '▲' : '▼'}</span>
          <span>
            <bdi>{onTarget ? '+' : '−'}{Math.abs(gap)}</bdi>{' '}
            {ar ? 'نقطة' : 'pts'}{' '}
            {ar ? 'عن المستهدف' : 'vs target'}{' '}
            <bdi>{spec.target}{spec.suffix || ''}</bdi>
          </span>
        </div>
      ) : (
        <div className="mt-1.5 text-[10px] font-medium text-slate-400">{spec.timeframe}</div>
      )}
    </div>
  );
};

export const KpiCards: React.FC<{ kpis: DashboardKpis; language: Language }> = ({ kpis, language }) => {
  const ar = language === 'ar';
  const cumulative = ar ? 'إجمالي تراكمي' : 'Cumulative total';
  const specs: KpiCardSpec[] = [
    { label: ar ? 'الموظفون الخاضعون للتقييم' : 'Evaluated employees', value: kpis.totalCandidates, unit: ar ? 'موظف' : 'employees', timeframe: cumulative },
    { label: ar ? 'متوسط ملاءمة الجدارات' : 'Avg. competency match', value: kpis.avgScore, suffix: '%', target: 75, timeframe: cumulative },
    { label: ar ? 'معدل الاعتماد البشري' : 'Human approval rate', value: kpis.approvalRatio, suffix: '%', target: 80, timeframe: cumulative },
    { label: ar ? 'زيارات تسجيل الدخول' : 'Access logins', value: kpis.totalLogins, unit: ar ? 'جلسة' : 'sessions', timeframe: cumulative },
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden">
      {specs.map((spec, i) => <KpiCard key={i} spec={spec} language={language} />)}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  Custom axis ticks (RTL-aware, bidi-isolated).
// ────────────────────────────────────────────────────────────────────────────

// Right-/left-anchored category label for the horizontal RIASEC bars.
const CategoryTick: React.FC<any> = ({ x, y, payload, anchor }) => (
  <text x={x} y={y} dy={4} textAnchor={anchor} fontSize={11} fontWeight={700} fill={INK}>
    {payload?.value}
  </text>
);

// Two-line column label for the match-quality bars: word + (isolated range).
const QualityTick: React.FC<any> = ({ x, y, payload, rangeByName }) => {
  const word = payload?.value ?? '';
  const range = rangeByName?.[word] ?? '';
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fontSize={10} fontWeight={700} fill={INK}>{word}</text>
      <text x={0} y={0} dy={25} textAnchor="middle" fontSize={9} fill={MUTED}>{ISO(range)}</text>
    </g>
  );
};

// Numeric day label (M/D) isolated so "6/30" never flips to "30/6" in RTL.
const DayTick: React.FC<any> = ({ x, y, payload }) => (
  <text x={x} y={y} dy={14} textAnchor="middle" fontSize={9} fontWeight={700} fill={MUTED}>
    {ISO(payload?.value)}
  </text>
);

// ────────────────────────────────────────────────────────────────────────────
//  2) RIASEC — donut → horizontal bars (precise comparison, single hue, labelled).
// ────────────────────────────────────────────────────────────────────────────

const RIASEC_LABELS: Record<RiasecKey, { ar: string; en: string }> = {
  R: { ar: 'واقعي', en: 'Realistic' },
  I: { ar: 'بحثي', en: 'Investigative' },
  A: { ar: 'فني', en: 'Artistic' },
  S: { ar: 'اجتماعي', en: 'Social' },
  E: { ar: 'مبادر', en: 'Enterprising' },
  C: { ar: 'تقليدي', en: 'Conventional' },
};

export const RiasecBarChart: React.FC<{ data: RiasecDatum[]; language: Language }> = ({ data, language }) => {
  const ar = language === 'ar';
  // Sort descending so the dominant interests read first — easy comparison.
  const rows = [...data]
    .sort((a, b) => b.value - a.value)
    .map(d => ({
      // Trait name + bidi-isolated Latin key, e.g. "مبادر ⁨(E)⁩".
      label: `${RIASEC_LABELS[d.key][ar ? 'ar' : 'en']} ${ISO('(' + d.key + ')')}`,
      value: d.value,
    }));

  return (
    <ChartCard
      title={<>{ar ? 'توزيع سمات هولاند المهنية ' : 'RIASEC interest types '}<bdi>(RIASEC)</bdi></>}
      badge={ar ? 'أعمدة' : 'Bars'}
    >
      <MeasuredChart className="h-64 w-full min-w-0">
        <BarChart layout="vertical" data={rows} margin={{ top: 4, right: ar ? 12 : 36, left: ar ? 36 : 12, bottom: 4 }} barCategoryGap={10}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={GRID} />
          <XAxis type="number" hide reversed={ar} domain={[0, 'dataMax']} />
          <YAxis
            type="category"
            dataKey="label"
            width={118}
            orientation={ar ? 'right' : 'left'}
            tickLine={false}
            axisLine={false}
            tick={<CategoryTick anchor={ar ? 'start' : 'end'} />}
          />
          <Tooltip
            formatter={(value: any) => [`${value} ${ar ? 'نقطة' : 'pts'}`, ar ? 'تراكمي' : 'Total']}
            cursor={{ fill: 'rgba(17,168,188,0.06)' }}
          />
          <Bar dataKey="value" fill={BRAND} radius={[4, 4, 4, 4]} maxBarSize={20}>
            <LabelList dataKey="value" position={ar ? 'left' : 'right'} offset={8} fontSize={11} fontWeight={700} fill={INK} />
          </Bar>
        </BarChart>
      </MeasuredChart>
      <p className="text-[10px] text-slate-500 leading-relaxed text-center">
        {ar
          ? 'تراكم نقاط جدارات هولاند والاهتمامات المهنية للموظفين — مرتبة تنازلياً لتسهيل المقارنة.'
          : 'Accumulated RIASEC interest points across employees — sorted for precise comparison.'}
      </p>
    </ChartCard>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  3) Match-quality — vertical bars, RTL category order, value labels, one hue.
// ────────────────────────────────────────────────────────────────────────────

export const MatchQualityChart: React.FC<{ buckets: ScoreBucket[]; language: Language }> = ({ buckets, language }) => {
  const ar = language === 'ar';
  const META: Record<ScoreBucket['id'], { ar: string; en: string; range: string }> = {
    low: { ar: 'تطوير', en: 'Needs dev', range: '<55%' },
    mild: { ar: 'مقبولة', en: 'Fair', range: '55–69%' },
    optimal: { ar: 'جيدة', en: 'Good', range: '70–84%' },
    high: { ar: 'فائقة', en: 'Excellent', range: '85%+' },
  };
  const countOf = (id: ScoreBucket['id']) => buckets.find(b => b.id === id)?.count ?? 0;
  // Worst → best so, with the RTL-reversed x-axis, quality climbs right→left.
  const order: ScoreBucket['id'][] = ['low', 'mild', 'optimal', 'high'];
  const data = order.map(id => ({ name: META[id][ar ? 'ar' : 'en'], count: countOf(id) }));
  const rangeByName: Record<string, string> = {};
  order.forEach(id => { rangeByName[META[id][ar ? 'ar' : 'en']] = META[id].range; });

  return (
    <ChartCard
      title={ar ? 'تصنيف نسب كفاءة التطابق والملاءمة' : 'Competency match score ranges'}
      badge={ar ? 'أعمدة' : 'Bar'}
    >
      <MeasuredChart className="h-64 w-full min-w-0">
        <BarChart data={data} margin={{ top: 18, right: 8, left: 8, bottom: 22 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID} />
          <XAxis
            dataKey="name"
            reversed={ar}
            interval={0}
            tickLine={false}
            height={40}
            tick={<QualityTick rangeByName={rangeByName} />}
          />
          <YAxis hide allowDecimals={false} />
          <Tooltip
            formatter={(value: any) => [`${value} ${ar ? 'موظف' : 'employees'}`, ar ? 'العدد' : 'Count']}
            labelFormatter={(label: any) => `${label} ${ISO('(' + (rangeByName[label] || '') + ')')}`}
            cursor={{ fill: 'rgba(17,168,188,0.06)' }}
          />
          <Bar dataKey="count" fill={BRAND} radius={[6, 6, 0, 0]} maxBarSize={64}>
            <LabelList dataKey="count" position="top" fontSize={12} fontWeight={800} fill={INK} />
          </Bar>
        </BarChart>
      </MeasuredChart>
      <p className="text-[10px] text-slate-500 leading-relaxed text-center">
        {ar
          ? 'توزيع الموظفين على فئات جودة الملاءمة — كل عمود يحمل عدده ومداه الرقمي.'
          : 'Talent distribution across match-quality tiers — each column is labelled with its count and range.'}
      </p>
    </ChartCard>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  4) Engagement — line, RTL x-axis, reversed legend, dash + marker redundancy.
// ────────────────────────────────────────────────────────────────────────────

const CircleDot: React.FC<any> = ({ cx, cy }) => {
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={3} fill={BRAND} stroke="#fff" strokeWidth={1} />;
};

const SquareDot: React.FC<any> = ({ cx, cy }) => {
  if (cx == null || cy == null) return null;
  return <rect x={cx - 3} y={cy - 3} width={6} height={6} fill={BRAND_BLUE} stroke="#fff" strokeWidth={1} />;
};

export const EngagementChart: React.FC<{ data: EngagementPoint[]; language: Language }> = ({ data, language }) => {
  const ar = language === 'ar';
  return (
    <ChartCard
      className="lg:col-span-2"
      title={<>{ar ? 'وتيرة تفاعل الموظفين وعمليات الدخول — آخر ' : '7-day employee engagement & logins — last '}<bdi>7</bdi>{ar ? ' أيام' : ' days'}</>}
      badge={ar ? 'خطي' : 'Line'}
    >
      <MeasuredChart className="h-56 w-full min-w-0">
        <LineChart data={data} margin={{ top: 10, right: 16, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID} />
          <XAxis dataKey="label" reversed={ar} tickLine={false} tick={<DayTick />} />
          <YAxis allowDecimals={false} orientation={ar ? 'right' : 'left'} tick={{ fontSize: 9, fontWeight: 700, fill: MUTED }} tickLine={false} axisLine={false} />
          <Tooltip labelFormatter={(label: any) => ISO(label)} />
          {/* direction:rtl flips the legend so the primary series reads first on the right. */}
          <Legend iconType="plainline" wrapperStyle={{ fontSize: '10px', fontWeight: 700, direction: ar ? 'rtl' : 'ltr' }} />
          <Line
            type="monotone"
            dataKey="assessments"
            name={ar ? 'جلسات التقييم المنجزة' : 'Assessments completed'}
            stroke={BRAND}
            strokeWidth={3}
            dot={<CircleDot />}
            activeDot={{ r: 6 }}
          />
          <Line
            type="monotone"
            dataKey="logins"
            name={ar ? 'عمليات ولوج الموظفين' : 'Employee access logins'}
            stroke={BRAND_BLUE}
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={<SquareDot />}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </MeasuredChart>
    </ChartCard>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  5) Competency progress bars → bullet charts (value + target + quality bands).
// ────────────────────────────────────────────────────────────────────────────

export interface BulletDatum {
  ar: string;
  en: string;
  value: number;
  target: number;
}

// Qualitative bands (0–60 / 60–80 / 80–100). Greys + a faint teal tint — no red/green.
const BANDS = [
  { width: 60, bg: '#eef3f5' }, // weak  — --hw-surface-muted
  { width: 20, bg: '#dfe9ed' }, // fair
  { width: 20, bg: '#cfe6ec' }, // strong — faint teal tint
];

const BulletRow: React.FC<{ datum: BulletDatum; language: Language }> = ({ datum, language }) => {
  const ar = language === 'ar';
  const gap = datum.value - datum.target;
  const onTarget = gap >= 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-bold text-slate-700">{ar ? datum.ar : datum.en}</span>
        <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-black tabular-nums">
          <bdi>{datum.value}%</bdi>
        </span>
      </div>

      {/* Bullet track: quality bands behind, value bar from the start origin,
          target marker as a high-contrast ink tick. Logical insets flip in RTL. */}
      <div className="relative h-3" role="img"
        aria-label={ar
          ? `القيمة ${datum.value}% مقابل المستهدف ${datum.target}%`
          : `Value ${datum.value}% versus target ${datum.target}%`}>
        <div className="absolute inset-0 rounded-full overflow-hidden flex">
          {BANDS.map((b, i) => <div key={i} style={{ width: b.width + '%', background: b.bg }} />)}
          <div className="absolute top-0 bottom-0 rounded-full" style={{ insetInlineStart: 0, width: datum.value + '%', background: BRAND }} />
        </div>
        <div className="absolute -top-1 -bottom-1" style={{ insetInlineStart: `calc(${datum.target}% - 1px)`, width: 2, background: INK }} aria-hidden="true" />
      </div>

      <div className="flex items-center gap-2 text-[10px] font-bold">
        <span className="text-slate-400">{ar ? 'المستهدف' : 'Target'} <bdi>{datum.target}%</bdi></span>
        <span style={{ color: onTarget ? BRAND_PRESSED : AMBER }}>
          <span aria-hidden="true">{onTarget ? '▲' : '▼'}</span>{' '}
          {onTarget
            ? (ar ? 'ضمن المستهدف' : 'On target')
            : <><bdi>{Math.abs(gap)}</bdi> {ar ? 'نقطة دون المستهدف' : 'pts below'}</>}
        </span>
      </div>
    </div>
  );
};

export const CompetencyBullets: React.FC<{ title: string; rows: BulletDatum[]; language: Language }> = ({ title, rows, language }) => {
  const ar = language === 'ar';
  return (
    <div className="bg-white p-4 rounded-lg border border-slate-200 text-start space-y-3">
      <div className="border-b border-slate-100 pb-2">
        <h4 className="text-xs font-bold text-slate-700">{title}</h4>
      </div>
      <div className="space-y-4">
        {rows.map((d, i) => <BulletRow key={i} datum={d} language={language} />)}
      </div>
      {/* Band legend — qualitative scale behind every bullet. */}
      <div className="flex items-center gap-3 pt-1 text-[9px] font-bold text-slate-400">
        {[
          { sw: BANDS[0].bg, t: ar ? 'ضعيف' : 'Weak' },
          { sw: BANDS[1].bg, t: ar ? 'متوسط' : 'Fair' },
          { sw: BANDS[2].bg, t: ar ? 'قوي' : 'Strong' },
        ].map((b, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2 rounded-sm" style={{ background: b.sw, border: `1px solid ${GRID}` }} />
            {b.t}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 ms-auto">
          <span className="inline-block w-0.5 h-3" style={{ background: INK }} />
          {ar ? 'المستهدف' : 'Target'}
        </span>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  6) Talent composition — concentric RING (RadialBar), share per match tier.
//     Single teal family, 4 distinguishable steps, thin white arc dividers.
// ────────────────────────────────────────────────────────────────────────────

// Teal-family ramp for the 4 match-quality tiers (deep → faint), anchored on the
// brand tokens. Four distinguishable steps; touching arcs get a white divider.
const TIER_RAMP: Record<ScoreBucket['id'], string> = {
  high: BRAND_PRESSED,  // '#0a6775' — deepest
  optimal: BRAND,       // '#0b8090'
  mild: '#4ea9b6',      // mid teal
  low: '#a9d6de',       // faint teal
};

const TIER_META: Record<ScoreBucket['id'], { ar: string; en: string; range: string }> = {
  high: { ar: 'فائقة', en: 'Excellent', range: '85%+' },
  optimal: { ar: 'جيدة', en: 'Good', range: '70–84%' },
  mild: { ar: 'مقبولة', en: 'Fair', range: '55–69%' },
  low: { ar: 'تطوير', en: 'Needs dev', range: '<55%' },
};

export const TalentCompositionRing: React.FC<{ composition: TalentComposition; language: Language }> = ({ composition, language }) => {
  const ar = language === 'ar';
  const { slices, total, avgScore } = composition;

  // Best → worst so the deepest teal ring reads first.
  const order: ScoreBucket['id'][] = ['high', 'optimal', 'mild', 'low'];
  const rows = order.map(id => {
    const s = slices.find(x => x.id === id);
    return { id, count: s?.count ?? 0, pct: s?.pct ?? 0, fill: TIER_RAMP[id] };
  });

  const title = ar ? 'التكوين النسبي لجودة ملاءمة الكوادر' : 'Talent pool composition by match tier';

  return (
    <ChartCard className="lg:col-span-2" title={title} badge={ar ? 'حلقي' : 'Ring'}>
      {total === 0 ? (
        <div className="h-48 w-full min-w-0 flex items-center justify-center text-center px-4">
          <p className="text-xs text-slate-400 font-medium leading-relaxed">
            {ar ? 'لا توجد تقييمات مكتملة بعد لعرض التكوين النسبي للكوادر.' : 'No completed assessments yet to compose the ring.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
          {/* Ring + centred total / average readout. */}
          <div className="relative">
            <MeasuredChart className="h-56 w-full min-w-0">
              <RadialBarChart
                data={rows}
                cx="50%"
                cy="50%"
                innerRadius="38%"
                outerRadius="100%"
                startAngle={90}
                endAngle={ar ? 450 : -270}
                barCategoryGap={2}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar dataKey="pct" background={{ fill: '#eef3f5' }} cornerRadius={3}>
                  {rows.map((r, i) => <Cell key={i} fill={r.fill} stroke="#fff" strokeWidth={2} />)}
                </RadialBar>
              </RadialBarChart>
            </MeasuredChart>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-2xl font-bold tabular-nums leading-none" style={{ color: INK }}><bdi>{total}</bdi></span>
              <span className="text-[9px] font-bold text-slate-500 mt-0.5">{ar ? 'مُقيَّم' : 'evaluated'}</span>
              <span className="text-[11px] font-bold mt-1" style={{ color: BRAND_PRESSED }}>
                <bdi>{avgScore}%</bdi> {ar ? 'متوسط' : 'avg'}
              </span>
            </div>
          </div>

          {/* Legend + description on the companion side. */}
          <div className="space-y-3">
            <ul className="space-y-1.5 text-[11px] font-bold" style={{ direction: ar ? 'rtl' : 'ltr' }}>
              {rows.map(r => (
                <li key={r.id} className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ background: r.fill, border: `1px solid ${GRID}` }} aria-hidden="true" />
                  <span className="text-slate-600">
                    {ar ? TIER_META[r.id].ar : TIER_META[r.id].en} <bdi className="text-slate-400 font-medium">{ISO('(' + TIER_META[r.id].range + ')')}</bdi>
                  </span>
                  <span className="text-slate-500 ms-auto tabular-nums">
                    <bdi>{r.count}</bdi> · <bdi>{r.pct}%</bdi>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              {ar
                ? 'حصة كل فئة جودة من إجمالي الكوادر المُقيَّمة — عرض نسبي حلقي يكمّل أعمدة أعداد الملاءمة.'
                : 'Each tier’s share of the evaluated pool — a proportional ring companion to the match-quality counts.'}
            </p>
          </div>
        </div>
      )}
    </ChartCard>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  7) Activity heatmap — custom CSS grid (7 weekday rows × N week columns).
//     Single-hue teal sequential ramp; 1px GRID border keeps steps separable.
// ────────────────────────────────────────────────────────────────────────────

// Sequential teal ramp (index 0 = none → 4 = busiest), anchored on BRAND_PRESSED.
// Lightness is spread wide so adjacent steps stay perceptibly distinct (each cell
// also carries its exact count via title/aria-label — never colour-only).
const HEAT_RAMP = ['#eef3f5', '#b3dde4', '#6fbccb', '#2e94a4', BRAND_PRESSED];

const WEEKDAYS: { ar: string; en: string }[] = [
  { ar: 'أحد', en: 'Sun' },
  { ar: 'إثن', en: 'Mon' },
  { ar: 'ثلا', en: 'Tue' },
  { ar: 'أرب', en: 'Wed' },
  { ar: 'خمي', en: 'Thu' },
  { ar: 'جمع', en: 'Fri' },
  { ar: 'سبت', en: 'Sat' },
];

const HEAT_CELL = 13; // px — fixed so the grid scrolls rather than squishes.

export const ActivityHeatmap: React.FC<{ data: ActivityHeatmapData; language: Language }> = ({ data, language }) => {
  const ar = language === 'ar';
  const { weeks, maxCount } = data;
  // Visual column order: newest at the reading start (right in AR / left in EN).
  const cols = ar ? [...weeks].reverse() : weeks;

  const monthFmt = new Intl.DateTimeFormat(ar ? 'ar-EG' : 'en-US', { month: 'short' });
  const dateFmt = new Intl.DateTimeFormat(ar ? 'ar-EG' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Month label above the column where the month first changes (visual order).
  let lastMonth = -1;
  const monthLabels = cols.map(col => {
    const first = new Date(col.days[0].date + 'T00:00:00');
    const m = first.getMonth();
    if (m !== lastMonth) { lastMonth = m; return monthFmt.format(first); }
    return '';
  });

  const title = ar ? 'خريطة النشاط الزمني — التقييمات وعمليات الدخول' : 'Temporal activity heatmap — assessments & logins';

  return (
    <ChartCard className="lg:col-span-2" title={title} badge={ar ? 'خريطة حرارية' : 'Heatmap'}>
      <div dir={ar ? 'rtl' : 'ltr'} className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1 min-w-max">
          {/* Month labels row — a weekday gutter, then one slot per week column. */}
          <div className="flex gap-1">
            <div style={{ width: 30 }} className="shrink-0" aria-hidden="true" />
            {monthLabels.map((m, i) => (
              <div key={i} style={{ width: HEAT_CELL }} className="shrink-0 text-[8px] font-bold text-slate-400 text-start whitespace-nowrap overflow-visible">
                {m}
              </div>
            ))}
          </div>

          {/* Body — weekday gutter, then one flex column per week. */}
          <div className="flex gap-1">
            <div className="shrink-0 flex flex-col gap-1" style={{ width: 30 }} aria-hidden="true">
              {WEEKDAYS.map((w, i) => (
                <div key={i} style={{ height: HEAT_CELL }} className="text-[8px] font-bold text-slate-400 leading-none flex items-center justify-end">
                  {ar ? w.ar : w.en}
                </div>
              ))}
            </div>

            {cols.map((col, ci) => (
              <div key={ci} className="shrink-0 flex flex-col gap-1">
                {col.days.map((cell, di) => {
                  const lvl = heatmapLevel(cell.count, maxCount);
                  const localDate = dateFmt.format(new Date(cell.date + 'T00:00:00'));
                  const label = ar ? `${localDate}: ${cell.count} نشاط` : `${localDate}: ${cell.count} events`;
                  return (
                    <div
                      key={di}
                      role="img"
                      title={label}
                      aria-label={label}
                      style={{ width: HEAT_CELL, height: HEAT_CELL, background: HEAT_RAMP[lvl], border: `1px solid ${GRID}` }}
                      className="rounded-[2px] shrink-0"
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Ramp legend — أقل → أكثر / Less → More. */}
      <div className="flex items-center gap-1.5 pt-1 text-[9px] font-bold text-slate-400" style={{ direction: ar ? 'rtl' : 'ltr' }}>
        <span>{ar ? 'أقل' : 'Less'}</span>
        {HEAT_RAMP.map((c, i) => (
          <span key={i} className="inline-block rounded-[2px]" style={{ width: 11, height: 11, background: c, border: `1px solid ${GRID}` }} aria-hidden="true" />
        ))}
        <span>{ar ? 'أكثر' : 'More'}</span>
      </div>
    </ChartCard>
  );
};

// ────────────────────────────────────────────────────────────────────────────
//  8) Activity timeline — vertical spine of the most-recent discrete events.
//     Spine on the reading-start side; content flows via logical insets.
// ────────────────────────────────────────────────────────────────────────────

const TIMELINE_META: Record<TimelineEvent['kind'], { ar: string; en: string }> = {
  assessment: { ar: 'تقييم مكتمل', en: 'Assessment completed' },
  approval: { ar: 'اعتماد بشري', en: 'Human approval' },
  login: { ar: 'تسجيل دخول', en: 'Access login' },
  consultation: { ar: 'طلب استشارة', en: 'Consultation request' },
};

export const ActivityTimeline: React.FC<{ events: TimelineEvent[]; language: Language }> = ({ events, language }) => {
  const ar = language === 'ar';
  const title = ar ? 'أحدث الأحداث والنشاط' : 'Recent activity timeline';
  const dateFmt = new Intl.DateTimeFormat(ar ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const badgeFor = (e: TimelineEvent): string => {
    if (typeof e.value !== 'number') return '';
    if (e.kind === 'assessment') return `${e.value}%`;
    if (e.kind === 'approval') return `★${e.value}`;
    return `${e.value}`;
  };

  return (
    <ChartCard title={title} badge={ar ? 'زمني' : 'Timeline'}>
      {events.length === 0 ? (
        <div className="h-40 flex items-center justify-center text-center px-4">
          <p className="text-xs text-slate-400 font-medium">
            {ar ? 'لا يوجد نشاط حديث بعد.' : 'No recent activity yet.'}
          </p>
        </div>
      ) : (
        <ol dir={ar ? 'rtl' : 'ltr'} className="relative space-y-4">
          {/* Spine — on the reading-start side (right in AR, left in EN). */}
          <span className="absolute top-1 bottom-1 w-px bg-slate-200" style={{ insetInlineStart: 5 }} aria-hidden="true" />
          {events.map((e, i) => {
            const badge = badgeFor(e);
            const when = dateFmt.format(new Date(e.at));
            return (
              <li key={i} className="relative" style={{ paddingInlineStart: 22 }}>
                <span className="absolute top-1 w-2.5 h-2.5 rounded-full ring-2 ring-white" style={{ insetInlineStart: 0, background: BRAND }} aria-hidden="true" />
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-bold text-slate-700">{ar ? TIMELINE_META[e.kind].ar : TIMELINE_META[e.kind].en}</span>
                  {badge && (
                    <span className="text-[10px] font-black tabular-nums px-1.5 py-0.5 rounded shrink-0" style={{ background: '#eef3f5', color: BRAND_PRESSED }}>
                      <bdi>{badge}</bdi>
                    </span>
                  )}
                </div>
                {(e.title || e.subtitle) && (
                  <div className="text-[11px] text-slate-500 truncate">
                    {e.title && <bdi>{e.title}</bdi>}{e.title && e.subtitle ? ' — ' : ''}{e.subtitle && <bdi>{e.subtitle}</bdi>}
                  </div>
                )}
                <div className="text-[9px] font-bold text-slate-400 mt-0.5">
                  <bdi>{when}</bdi>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </ChartCard>
  );
};
