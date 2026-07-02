import React from 'react';
import type { ArtifactSection, Language } from '../types';

// P17/MINOR-modularity: generalized beyond the long-artifact pipeline's own
// `phase` union (outline/section/critique/revise/assemble/done) so
// GovernanceCenter's buildModel/ingest banner — whose phases are a different
// set (ingest/embed/sentiment/entities, build_digest/build_extract/…) — can
// pass its OWN progress object without a cast. Structurally compatible with
// the `ArtifactProgress` type in types.ts (same shape, narrower `phase`).
export interface ProgressLike {
  phase: string;
  current: number;
  total: number;
  label: string;
}

/** One entry in an ordered phase-pill sequence (see the `phases` prop). */
export interface ArtifactPhasePill {
  key: string;
  ar: string;
  en: string;
}

interface ArtifactProgressProps {
  progress: ProgressLike | null;
  sections: ArtifactSection[];
  language: Language;
  /**
   * Overrides the default "توليد تقرير شامل" / "Long report generation"
   * header title. Omitted (default) matches every existing caller exactly.
   */
  title?: { ar: string; en: string };
  /**
   * Ordered phase-pill sequence (done/active/todo, current phase highlighted)
   * rendered under the header — e.g. GovernanceCenter's ingest/build-model
   * banner, which used to hand-roll this same row twice. Omitted (default)
   * renders no pill row and the bare phase-name text instead, matching every
   * existing caller exactly.
   */
  phases?: ArtifactPhasePill[];
}

const PHASE_LABEL: Record<string, { ar: string; en: string }> = {
  outline:  { ar: 'الهيكلة', en: 'Outline' },
  section:  { ar: 'كتابة الأقسام', en: 'Sections' },
  critique: { ar: 'التقييم الذاتي', en: 'Critique' },
  revise:   { ar: 'التنقيح', en: 'Revision' },
  assemble: { ar: 'التجميع', en: 'Assembly' },
  done:     { ar: 'اكتمل', en: 'Done' },
};

// Pure done/active/todo resolver for a phase-pill sequence, extracted so it's
// testable without a DOM (this repo's vitest environment is `node`).
export type PillState = 'done' | 'active' | 'todo';
export const pillState = (pills: ArtifactPhasePill[], idx: number, currentPhase: string): PillState => {
  const order = pills.findIndex(p => p.key === currentPhase);
  if (idx < order) return 'done';
  if (idx === order) return 'active';
  return 'todo';
};

const STATUS_ICON: Record<ArtifactSection['status'], string> = {
  pending: '○', writing: '✍️', done: '✅', failed: '⚠️',
};

// Geometric status indicator — no emoji, pure CSS
const SectionStatusDot: React.FC<{ status: ArtifactSection['status'] }> = ({ status }) => {
  const base = 'shrink-0 w-1.5 h-1.5 rounded-full mt-px';
  if (status === 'done')    return <span className={`${base} bg-green-500`} />;
  if (status === 'writing') return <span className={`${base} bg-blue-400 animate-pulse`} />;
  if (status === 'failed')  return <span className={`${base} bg-rose-500`} />;
  return <span className={`${base} bg-slate-300`} />;
};

// Live progress for the long-artifact pipeline (outline → sections → critique →
// assemble) — and, via `title`/`phases`, GovernanceCenter's ingest/build-model banner.
const ArtifactProgress: React.FC<ArtifactProgressProps> = ({ progress, sections, language, title, phases }) => {
  if (!progress && !sections.length) return null;
  const ar = language === 'ar';
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : (progress?.phase === 'done' ? 100 : 0);
  const phase = progress ? (PHASE_LABEL[progress.phase] || { ar: progress.phase, en: progress.phase }) : null;
  const headerTitle = title ? (ar ? title.ar : title.en) : (ar ? 'توليد تقرير شامل' : 'Long report generation');

  return (
    <div
      dir={ar ? 'rtl' : 'ltr'}
      className="my-2 rounded-lg border border-slate-200 bg-white p-3 space-y-2.5"
    >
      {/* Header row: title + phase + percentage */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[11px] font-bold text-slate-700 shrink-0">
            {headerTitle}
          </span>
          {/* Bare phase-name text is redundant once the pill row below already
              highlights the current phase, so it's suppressed when `phases` is given. */}
          {!phases && phase && (
            <span className="text-xs text-slate-400 truncate">
              {ar ? phase.ar : phase.en}
            </span>
          )}
        </div>
        <span className="text-[11px] font-bold text-emerald-600 tabular-nums shrink-0">{pct}%</span>
      </div>

      {/* Ordered phase-pill sequence, current phase highlighted */}
      {phases && phases.length > 0 && progress && (
        <div className="flex items-center gap-1 flex-wrap">
          {phases.map((p, idx) => {
            const state = pillState(phases, idx, progress.phase);
            return (
              <span key={p.key} className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${state === 'active' ? 'bg-emerald-600 text-white border-emerald-600 animate-pulse' : state === 'done' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                {state === 'done' ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5 inline-block me-0.5"><polyline points="20 6 9 17 4 12" /></svg> : null}{ar ? p.ar : p.en}
              </span>
            );
          })}
        </div>
      )}

      {/* Slim progress bar */}
      <div className="hw-progress">
        <div
          className="hw-progress-bar transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Optional step label */}
      {progress?.label && (
        <p className="text-xs text-slate-500 leading-snug">{progress.label}</p>
      )}

      {/* Section list */}
      {sections.length > 0 && (
        <div className="relative border-t border-slate-100 pt-2">
          {/* text-xs (12px) minimum for Arabic legibility; space-y-1 (4px) for comfortable row gap */}
          <div
            className="space-y-1 max-h-32 overflow-y-auto scrollbar-thin"
            aria-label={ar ? 'قائمة الأقسام' : 'section list'}
          >
            {sections.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 text-xs">
                <SectionStatusDot status={s.status} />
                <span className="shrink-0 text-slate-400 tabular-nums">{i + 1}.</span>
                <span className="truncate text-slate-600">{s.title}</span>
              </div>
            ))}
          </div>
          {/* Bottom fade mask signals overflow content to users */}
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-white to-transparent"
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
};

export default ArtifactProgress;
