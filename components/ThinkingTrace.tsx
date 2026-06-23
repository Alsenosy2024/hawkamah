import React, { useState, useEffect, useRef } from 'react';
import type { ThinkingStep, Language } from '../types';

interface ThinkingTraceProps {
  thoughts: ThinkingStep[];
  active: boolean;          // still streaming reasoning
  language: Language;
}

// Collapsible "chain of thought" panel shown above an agent reply.
// Auto-expanded while reasoning streams, auto-collapses when the answer starts.
const ThinkingTrace: React.FC<ThinkingTraceProps> = ({ thoughts, active, language }) => {
  const [open, setOpen] = useState(true);
  const userToggled = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-collapse once thinking finishes (unless the user manually toggled).
  useEffect(() => {
    if (!userToggled.current) setOpen(active);
  }, [active]);

  // Keep the latest thought in view while streaming.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [thoughts, open]);

  if (!thoughts.length && !active) return null;

  const label = language === 'ar' ? 'خطوات التفكير' : 'Chain of thought';
  const count = thoughts.length;

  return (
    <div dir="rtl" className="mb-2 rounded-xl border border-emerald-200 bg-emerald-50/70 overflow-hidden">
      <button
        type="button"
        onClick={() => { userToggled.current = true; setOpen(o => !o); }}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] font-extrabold text-emerald-700 hover:bg-emerald-100/70 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <span className={active ? 'animate-pulse' : ''}>🧠</span>
          {label}
          {count > 0 && <span className="text-emerald-400 font-bold">({count})</span>}
          {active && <span className="text-emerald-400 font-medium">{language === 'ar' ? '… يفكّر' : '… thinking'}</span>}
        </span>
        <span className="text-emerald-400">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div ref={bodyRef} className="max-h-44 overflow-y-auto px-3 pb-2 space-y-1.5 scrollbar-thin">
          {thoughts.map((t, i) => (
            <div key={t.id} className="flex gap-1.5 text-[10.5px] text-emerald-900/80 leading-relaxed">
              <span className="shrink-0 text-emerald-400 font-bold">{i + 1}.</span>
              <span className="whitespace-pre-wrap">{t.text}</span>
            </div>
          ))}
          {active && (
            <div className="flex items-center gap-1 pt-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-ping [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-200 animate-ping [animation-delay:300ms]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ThinkingTrace;
