// B4 — Shared portal spinner (loading / generating / submitting / saving).
//
// One centered spinner + message, used for every transient state across the query
// flows (token loading, question generation, answer submission). Replaces the two
// divergent versions (the survey's bare inline spinner vs the employee portal's
// card spinner) with a single consistent treatment.
import React from 'react';

interface Props {
  message: string;
}

const PortalSpinner: React.FC<Props> = ({ message }) => (
  <div className="flex flex-col items-center gap-3 text-slate-400 dark:text-slate-500">
    <div className="w-7 h-7 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
    <span className="text-sm">{message}</span>
  </div>
);

export default PortalSpinner;
