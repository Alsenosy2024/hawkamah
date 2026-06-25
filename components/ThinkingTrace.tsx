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
    <div dir="rtl" className="mb-2 rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Header toggle */}
      <button
        type="button"
        onClick={() => { userToggled.current = true; setOpen(o => !o); }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-slate-50 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-600"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {/* Status dot: pulse teal when active, solid teal when done */}
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
              active
                ? 'bg-emerald-500 animate-pulse duration-1000'
                : 'bg-emerald-600'
            }`}
          />
          <span className="tracking-wide uppercase text-[10px] font-bold text-slate-500">
            {label}
          </span>
          {count > 0 && (
            <span className="text-[10px] font-medium text-slate-400">
              {count}
            </span>
          )}
          {active && (
            <span className="text-[10px] font-normal text-emerald-600">
              {language === 'ar' ? 'يفكّر…' : 'thinking…'}
            </span>
          )}
        </span>
        {/* Chevron icon */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          className={`shrink-0 text-slate-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Body */}
      {open && (
        <div
          ref={bodyRef}
          className="max-h-44 overflow-y-auto border-t border-slate-100 px-3 py-2 space-y-1.5"
        >
          {thoughts.map((t, i) => (
            <div key={t.id} className="flex gap-2 font-mono text-[10.5px] text-slate-600 leading-relaxed">
              <span className="shrink-0 w-5 text-start text-emerald-600 font-medium select-none">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="whitespace-pre-wrap text-slate-700">{t.text}</span>
            </div>
          ))}
          {active && (
            <div className="flex items-center gap-1 pt-0.5 ps-7">
              <span className="h-1 w-3 rounded-sm bg-emerald-400 animate-pulse" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ThinkingTrace;
