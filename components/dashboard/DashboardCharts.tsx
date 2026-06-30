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
} from 'recharts';
import { Language } from '../../types';
import {
  DashboardKpis,
  RiasecDatum,
  RiasecKey,
  ScoreBucket,
  EngagementPoint,
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
