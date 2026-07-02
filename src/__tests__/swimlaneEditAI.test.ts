import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===========================================================================
//  P8 — editSwimlaneWithAI is the swimlane counterpart of editMermaidWithAI:
//  a natural-language instruction against an EXISTING SwimlaneSpec, gated by
//  validateSpec with a retry-with-repair-prompt loop, and NO silent
//  deterministic fallback on final failure (unlike generateSwimlane) — a
//  discarded user instruction must surface as a visible error instead.
//
//  Mirrors agentOrchestratorStream.test.ts's mocking shape: replace only
//  GoogleGenAI's constructor, keep every other @google/genai export (Type,
//  ThinkingLevel, …) real.
// ===========================================================================

const state = vi.hoisted(() => ({ calls: 0, script: [] as Array<{ text: string }> }));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: vi.fn(async () => {
          const res = state.script[state.calls] ?? state.script[state.script.length - 1];
          state.calls++;
          return res;
        }),
      },
    })),
  };
});

import { editSwimlaneWithAI, validateSpec, type SwimlaneSpec } from '../../services/swimlaneService';

const validSpec: SwimlaneSpec = {
  title: 'مخطط الاعتماد',
  lanes: [{ id: 'l1', title: 'المدير' }, { id: 'l2', title: 'المالية' }],
  nodes: [
    { id: 'n1', lane: 'l1', label: 'بداية', type: 'start' },
    { id: 'n2', lane: 'l2', label: 'مراجعة', type: 'process' },
    { id: 'n3', lane: 'l1', label: 'نهاية', type: 'end' },
  ],
  edges: [
    { from: 'n1', to: 'n2', kind: 'flow' },
    { from: 'n2', to: 'n3', kind: 'approve' },
  ],
};

// pruneSpec can't repair this — an empty `nodes` array always fails validateSpec.
const invalidSpec = { title: 'x', lanes: [{ id: 'l1', title: 'x' }], nodes: [], edges: [] };

const baseSpec: SwimlaneSpec = {
  title: 'الحالي',
  lanes: [{ id: 'l1', title: 'المدير' }],
  nodes: [{ id: 'n1', lane: 'l1', label: 'بداية', type: 'start' }],
  edges: [],
};

beforeEach(() => { state.calls = 0; state.script = []; });

describe('editSwimlaneWithAI', () => {
  it('returns the spec on the first try when it is already valid (no retry)', async () => {
    state.script = [{ text: JSON.stringify(validSpec) }];
    const out = await editSwimlaneWithAI(baseSpec, 'أضف خطوة موافقة المالية');
    expect(out.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3']);
    expect(out.lanes).toHaveLength(2);
    expect(state.calls).toBe(1);
  });

  it('repairs an invalid first response by retrying, then returns the valid spec', async () => {
    state.script = [{ text: JSON.stringify(invalidSpec) }, { text: JSON.stringify(validSpec) }];
    const out = await editSwimlaneWithAI(baseSpec, 'أضف خطوة موافقة المالية');
    expect(validateSpec(out)).toBeNull();
    expect(out.lanes).toHaveLength(2);
    expect(state.calls).toBe(2);
  });

  it('throws a clear INVALID_SWIMLANE error after all attempts fail — never a silent fallback', async () => {
    state.script = [{ text: JSON.stringify(invalidSpec) }, { text: JSON.stringify(invalidSpec) }, { text: JSON.stringify(invalidSpec) }];
    await expect(editSwimlaneWithAI(baseSpec, 'أضف خطوة موافقة المالية')).rejects.toThrow(/INVALID_SWIMLANE/);
    // exactly MAX_TRIES (3) attempts — no extra retry, no fallback call.
    expect(state.calls).toBe(3);
  });

  it('propagates an abort instead of retrying or throwing INVALID_SWIMLANE', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    state.script = [{ text: JSON.stringify(validSpec) }];
    await expect(editSwimlaneWithAI(baseSpec, 'أي تعديل', { signal: ctrl.signal })).rejects.toThrow(/ABORTED/);
  });
});

describe('validateSpec — accepts a well-formed edited spec', () => {
  it('accepts an edit that adds a lane, node and edge with fresh ids', () => {
    const edited: SwimlaneSpec = {
      ...validSpec,
      lanes: [...validSpec.lanes, { id: 'l3', title: 'قسم جديد' }],
      nodes: [...validSpec.nodes, { id: 'n4', lane: 'l3', label: 'مراجعة إضافية', type: 'process' }],
      edges: [...validSpec.edges, { from: 'n2', to: 'n4', kind: 'flow' }],
    };
    expect(validateSpec(edited)).toBeNull();
  });

  it('accepts an edit that only renames labels/titles, keeping every id stable', () => {
    const edited: SwimlaneSpec = {
      ...validSpec,
      title: 'مخطط الاعتماد المُحدَّث',
      nodes: validSpec.nodes.map(n => (n.id === 'n2' ? { ...n, label: 'مراجعة مالية شاملة' } : n)),
    };
    expect(validateSpec(edited)).toBeNull();
    expect(edited.nodes.map(n => n.id)).toEqual(validSpec.nodes.map(n => n.id));
  });

  it('rejects an edit that removes a lane still referenced by a node', () => {
    const edited: SwimlaneSpec = {
      ...validSpec,
      lanes: validSpec.lanes.filter(l => l.id !== 'l2'), // n2 still has lane: 'l2'
    };
    expect(validateSpec(edited)).toMatch(/unknown lane/);
  });
});
