import React from 'react';
import type { ArtifactProgress as Progress, ArtifactSection, Language } from '../types';

interface ArtifactProgressProps {
  progress: Progress | null;
  sections: ArtifactSection[];
  language: Language;
}

const PHASE_LABEL: Record<string, { ar: string; en: string }> = {
  outline:  { ar: 'الهيكلة', en: 'Outline' },
  section:  { ar: 'كتابة الأقسام', en: 'Sections' },
  critique: { ar: 'التقييم الذاتي', en: 'Critique' },
  revise:   { ar: 'التنقيح', en: 'Revision' },
  assemble: { ar: 'التجميع', en: 'Assembly' },
  done:     { ar: 'اكتمل', en: 'Done' },
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

// Live progress for the long-artifact pipeline (outline → sections → critique → assemble).
const ArtifactProgress: React.FC<ArtifactProgressProps> = ({ progress, sections, language }) => {
  if (!progress && !sections.length) return null;
  const ar = language === 'ar';
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : (progress?.phase === 'done' ? 100 : 0);
  const phase = progress ? (PHASE_LABEL[progress.phase] || { ar: progress.phase, en: progress.phase }) : null;

  return (
    <div
      dir={ar ? 'rtl' : 'ltr'}
      className="my-2 rounded-lg border border-slate-200 bg-white p-3 space-y-2.5"
    >
      {/* Header row: title + phase + percentage */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[11px] font-bold text-slate-700 shrink-0">
            {ar ? 'توليد تقرير شامل' : 'Long report generation'}
          </span>
          {phase && (
            <span className="text-xs text-slate-400 truncate">
              {ar ? phase.ar : phase.en}
            </span>
          )}
        </div>
        <span className="text-[11px] font-bold text-emerald-600 tabular-nums shrink-0">{pct}%</span>
      </div>

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
