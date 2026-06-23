// "اسأل حوكمتك" — semantic Q&A grounded in the governance model + ingested
// source chunks. Retrieves the most relevant chunks, hands them + a compact
// model snapshot to the LLM, and streams a cited answer.

import { streamChat, type StreamCallbacks } from './agentOrchestrator';
import { retrieve, chunksToProvenance } from './governanceService';
import type { CompanyGovernanceModel, DocChunk, Language, ProvenanceRef } from '../types';

function snapshot(m: CompanyGovernanceModel): string {
  return [
    `الشركة: ${m.companyName}`,
    `الوحدات: ${(m.orgUnits || []).map(u => u.name).join('، ') || '—'}`,
    `الأدوار: ${(m.roles || []).map(r => r.title).join('، ') || '—'}`,
    `السياسات: ${(m.policies || []).map(p => `${p.title}[${p.domain}]`).join('، ') || '—'}`,
    `الإجراءات: ${(m.procedures || []).map(p => p.title).join('، ') || '—'}`,
    `الصلاحيات: ${(m.authorities || []).map(a => `${a.decision}→${a.level}`).join('، ') || '—'}`,
    `المؤشرات: ${(m.kpis || []).map(k => k.name).join('، ') || '—'}`,
    `الفجوات المفتوحة: ${(m.gaps || []).filter(g => !g.resolved).map(g => g.area).join('، ') || '—'}`,
  ].join('\n');
}

export interface AskParams {
  question: string;
  model: CompanyGovernanceModel;
  chunks: DocChunk[];
  language?: Language;
  signal?: AbortSignal;
}

export interface AskResult { sources: ProvenanceRef[]; }

/** Stream a grounded answer; returns the provenance refs used. */
export async function askGovernance(p: AskParams, cb: StreamCallbacks): Promise<AskResult> {
  const ar = (p.language || 'ar') === 'ar';
  const rc = await retrieve(p.question, p.chunks, 6, p.signal);
  const refs = chunksToProvenance(rc);
  const evidence = rc.length
    ? rc.map((r, n) => `[مصدر ${n + 1}] (${r.chunk.docName} › ${r.chunk.headingPath})\n${r.chunk.text.slice(0, 700)}`).join('\n\n')
    : '(لا أدلة مسترجعة — أجب من النموذج فقط، وصرّح إن كانت المعلومة غير متوفرة.)';

  const sys = [
    ar
      ? 'أنت خبير حوكمة يجيب فقط بالاستناد إلى نموذج حوكمة الشركة والأدلة المسترجعة. لا تخترع. استشهد بصيغة [مصدر N]. إن لم تتوفر المعلومة، قُلها صراحةً واقترح أين تُستكمل.'
      : 'You answer strictly from the governance model and retrieved evidence. Cite as [مصدر N]. If missing, say so.',
    '=== نموذج حوكمة الشركة ===',
    snapshot(p.model),
    '=== الأدلة المسترجعة ===',
    evidence,
  ].join('\n');

  await streamChat(
    { systemInstruction: sys, history: [], message: p.question, signal: p.signal, temperature: 0.3 },
    cb,
  );
  return { sources: refs };
}
