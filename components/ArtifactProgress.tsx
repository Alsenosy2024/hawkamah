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

// Live progress for the long-artifact pipeline (outline → sections → critique → assemble).
const ArtifactProgress: React.FC<ArtifactProgressProps> = ({ progress, sections, language }) => {
  if (!progress && !sections.length) return null;
  const ar = language === 'ar';
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : (progress?.phase === 'done' ? 100 : 0);
  const phase = progress ? (PHASE_LABEL[progress.phase] || { ar: progress.phase, en: progress.phase }) : null;

  return (
    <div dir="rtl" className="my-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 space-y-2">
      <div className="flex items-center justify-between text-[10px] font-extrabold text-emerald-700">
        <span className="flex items-center gap-1.5">
          📑 {ar ? 'توليد تقرير شامل' : 'Long report generation'}
          {phase && <span className="text-emerald-400">— {ar ? phase.ar : phase.en}</span>}
        </span>
        <span className="text-emerald-500">{pct}%</span>
      </div>

      {progress?.label && (
        <p className="text-[10px] text-emerald-900/70 font-medium">{progress.label}</p>
      )}

      <div className="h-1.5 w-full rounded-full bg-emerald-100 overflow-hidden">
        <div className="h-full bg-emerald-600 transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>

      {sections.length > 0 && (
        <div className="grid grid-cols-1 gap-0.5 max-h-32 overflow-y-auto scrollbar-thin pt-1">
          {sections.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1.5 text-[10px] text-emerald-900/80">
              <span className="shrink-0">{STATUS_ICON[s.status]}</span>
              <span className="shrink-0 text-emerald-400 font-bold">{i + 1}.</span>
              <span className="truncate">{s.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ArtifactProgress;
