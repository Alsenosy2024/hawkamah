import React from 'react';
import type { ProgressStep, Language } from '../types';

interface StepTimelineProps {
  steps: ProgressStep[];
  active: boolean;          // generation still running
  language: Language;
  // P17/MINOR-modularity: 'card' (default) is the original bordered box with its
  // own "مراحل التوليد" header — used above an agent reply (GovCopilot). 'bare'
  // drops the outer border/background/header so the row list can be embedded
  // inside a caller's OWN already-bordered/headered section (GovernanceCenter's
  // amber "Generate everything at once" card, which used to hand-roll this same
  // done/running/pending/error row list with its own icon glyphs).
  variant?: 'card' | 'bare';
}

// Pure status → icon-kind mapping, extracted so it's testable without a DOM
// (this repo's vitest environment is `node` — see backButton.test.tsx for the
// same pattern). The actual glyphs stay inline in `icon()` below.
export type StepIconKind = 'done' | 'error' | 'running' | 'pending';
export const stepIconKind = (status: ProgressStep['status']): StepIconKind => {
  if (status === 'done' || status === 'error' || status === 'running') return status;
  return 'pending';
};

// Live step-by-step narrative shown above an agent reply during long-form
// generation (HWK-A2), and (via `variant="bare"`) any other ordered
// stage/step list with a done/running/pending/error status icon. Each row is
// one named stage with a status icon: done → teal check, running → pulsing
// teal dot, pending → hollow dot, error → red ×. It mirrors ThinkingTrace's
// visual language but expresses the "did X ✓, did Y ✓, now doing Z…"
// progression the long /draft run was missing.
const StepTimeline: React.FC<StepTimelineProps> = ({ steps, active, language, variant = 'card' }) => {
  if (!steps.length) return null;
  const ar = language === 'ar';
  const label = ar ? 'مراحل التوليد' : 'Generation steps';

  const icon = (status: ProgressStep['status']) => {
    const kind = stepIconKind(status);
    if (kind === 'done') {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-emerald-600 shrink-0">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    }
    if (kind === 'error') {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-rose-500 shrink-0">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    }
    if (kind === 'running') {
      return <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse duration-1000 shrink-0" />;
    }
    return <span className="inline-block h-2 w-2 rounded-full border border-slate-300 bg-transparent shrink-0" />;
  };

  const rows = (
    <div className="space-y-1.5">
      {steps.map(s => (
        <div key={s.id} className="flex items-center gap-2 text-[11.5px]">
          {icon(s.status)}
          <span className={s.status === 'pending' ? 'text-slate-400' : s.status === 'error' ? 'text-rose-600' : 'text-slate-700'}>
            {s.label}
          </span>
          {s.note && <span className="ms-auto text-[10px] text-slate-400">{s.note}</span>}
        </div>
      ))}
      {active && !steps.some(s => s.status === 'running') && (
        <div className="flex items-center gap-1 ps-0.5">
          <span className="h-1 w-3 rounded-sm bg-emerald-400 animate-pulse" />
        </div>
      )}
    </div>
  );

  if (variant === 'bare') return <div dir={ar ? 'rtl' : 'ltr'}>{rows}</div>;

  return (
    <div dir={ar ? 'rtl' : 'ltr'} className="mb-2 rounded-lg border border-slate-200 bg-white overflow-hidden px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${active ? 'bg-emerald-500 animate-pulse duration-1000' : 'bg-emerald-600'}`} />
        <span className="tracking-wide uppercase text-[10px] font-bold text-slate-500">{label}</span>
      </div>
      {rows}
    </div>
  );
};

export default StepTimeline;
