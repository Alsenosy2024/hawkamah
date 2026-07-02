import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompanyGovernanceModel } from '../../types';

// ===========================================================================
//  P18 — two diagram-gallery audit findings, both pure-service-layer:
//
//  1) GovDiagram.sourceRef was declared in types.ts but never populated, and any
//     [مصدر N] markers the model emitted were silently stripped — no grounding
//     was traceable. buildProvenance() (diagramService + swimlaneService) turns
//     the model sections actually serialized into the prompt into a compact
//     «مبني على: …» line the gallery now shows.
//
//  2) generateMermaid / generateSwimlane called the AI unconditionally even when
//     the model section a diagram kind depends on was empty (e.g. RACI with zero
//     authorities) — unlike the org chart's own deterministic empty-state. Both
//     now short-circuit with a thrown `INSUFFICIENT_DATA: …` before any network
//     call, mirroring the org-chart guard.
//
//  vitest runs in node (no DOM), so mermaid.parse can't run here (see
//  mermaidSanitize.test.ts) — these tests exercise the guard/provenance logic
//  itself, not the AI-generated Mermaid's validity.
// ===========================================================================

const gj = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock('../../services/agentOrchestrator', () => gj);

import { generateMermaid, buildProvenance } from '../../services/diagramService';
import { generateSwimlane, buildProvenance as buildSwimlaneProvenance } from '../../services/swimlaneService';

const baseModel = (overrides: Partial<CompanyGovernanceModel> = {}): CompanyGovernanceModel => ({
  companyName: 'شركة الاختبار',
  orgUnits: [{ id: 'u1', name: 'الإدارة العامة', mandate: 'القيادة العليا' }],
  roles: [{ id: 'r1', title: 'المدير العام', unitId: 'u1', purpose: 'القيادة', responsibilities: [] }],
  policies: [],
  procedures: [],
  authorities: [],
  kpis: [],
  gaps: [],
  ...overrides,
} as any);

beforeEach(() => { vi.clearAllMocks(); });

// ---- buildProvenance (diagramService) --------------------------------------
describe('diagramService.buildProvenance — «مبني على» line', () => {
  it('lists only the non-empty model sections, in Arabic', () => {
    const model = baseModel({
      policies: [{ id: 'p1', title: 'سياسة الإجازات', domain: 'حوكمة', status: 'approved' }] as any,
      authorities: [{ id: 'a1', decision: 'اعتماد الميزانية', roleId: 'r1', level: 'approve' }] as any,
    });
    const line = buildProvenance(model, true);
    expect(line).toContain('1 وحدة تنظيمية');
    expect(line).toContain('1 دور');
    expect(line).toContain('1 سياسة');
    expect(line).toContain('1 صلاحية');
    expect(line).not.toMatch(/مؤشر/); // kpis empty → omitted, not "0 مؤشر"
  });

  it('reports English counts when ar=false', () => {
    expect(buildProvenance(baseModel(), false)).toBe('1 org units, 1 roles');
  });

  it('is an empty string for a fully empty model (nothing to report)', () => {
    const model = baseModel({ orgUnits: [], roles: [] });
    expect(buildProvenance(model, true)).toBe('');
  });
});

// ---- generateMermaid guard --------------------------------------------------
describe('generateMermaid — empty-section guard (P18)', () => {
  it('skips the AI call for a RACI diagram with zero authorities', async () => {
    const model = baseModel({ authorities: [] });
    await expect(generateMermaid(model, 'raci', { language: 'ar' })).rejects.toThrow(/INSUFFICIENT_DATA/);
    expect(gj.generateJson).not.toHaveBeenCalled();
  });

  it('skips a state diagram with zero policies AND zero procedures', async () => {
    const model = baseModel({ policies: [], procedures: [] });
    await expect(generateMermaid(model, 'state', { language: 'ar' })).rejects.toThrow(/INSUFFICIENT_DATA/);
    expect(gj.generateJson).not.toHaveBeenCalled();
  });

  it('skips a flowchart with zero procedures AND zero authorities', async () => {
    const model = baseModel({ procedures: [], authorities: [] });
    await expect(generateMermaid(model, 'flowchart', { language: 'en' })).rejects.toThrow(/INSUFFICIENT_DATA/);
    expect(gj.generateJson).not.toHaveBeenCalled();
  });

  it('does NOT guard the org chart — it stays deterministic even for an empty model', async () => {
    const model = baseModel({ orgUnits: [], roles: [] });
    const res = await generateMermaid(model, 'orgchart', { language: 'ar' });
    expect(res.mermaid).toContain('flowchart TD');
    expect(gj.generateJson).not.toHaveBeenCalled();
  });

  it('proceeds to the AI (does not throw) once the required section has data', async () => {
    gj.generateJson.mockResolvedValue({ title: 'مصفوفة الصلاحيات', mermaid: 'flowchart LR\n  a --> b' });
    const model = baseModel({ authorities: [{ id: 'a1', decision: 'اعتماد', roleId: 'r1', level: 'approve' }] as any });
    const onProgress = vi.fn();
    await expect(generateMermaid(model, 'raci', { language: 'ar', onProgress })).resolves.toBeTruthy();
    expect(gj.generateJson).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({ attempt: 1, maxTries: 3 });
  });
});

// ---- swimlaneService.buildProvenance ---------------------------------------
describe('swimlaneService.buildProvenance — «مبني على» line', () => {
  it('reports units/roles/procedures/authorities but never policies/kpis (not in its digest)', () => {
    const model = baseModel({
      procedures: [{ id: 'p1', title: 'إجراء الشراء', unitId: 'u1', steps: ['طلب', 'اعتماد'] }] as any,
      authorities: [{ id: 'a1', decision: 'اعتماد الشراء', roleId: 'r1', level: 'approve' }] as any,
      policies: [{ id: 'pol1', title: 'سياسة', domain: 'حوكمة', status: 'approved' }] as any,
    });
    const line = buildSwimlaneProvenance(model, true);
    expect(line).toContain('1 إجراء');
    expect(line).toContain('1 صلاحية');
    expect(line).not.toMatch(/سياسة/);
  });

  it('is an empty string for a fully empty model', () => {
    expect(buildSwimlaneProvenance(baseModel({ orgUnits: [], roles: [] }), true)).toBe('');
  });
});

// ---- generateSwimlane guard + staged progress -------------------------------
describe('generateSwimlane — empty-section guard (P18)', () => {
  it('throws INSUFFICIENT_DATA when there are no authorities and no procedures', async () => {
    const model = baseModel({ authorities: [], procedures: [] });
    await expect(generateSwimlane(model, { language: 'ar' })).rejects.toThrow(/INSUFFICIENT_DATA/);
    expect(gj.generateJson).not.toHaveBeenCalled();
  });

  it('proceeds to the AI when procedures are present even with zero authorities', async () => {
    gj.generateJson.mockResolvedValue({
      title: 'مسار الاعتماد',
      lanes: [{ id: 'l1', title: 'القسم' }],
      nodes: [{ id: 'n1', lane: 'l1', label: 'بداية', type: 'start' }],
      edges: [],
    });
    const model = baseModel({ authorities: [], procedures: [{ id: 'p1', title: 'إجراء', unitId: 'u1', steps: ['خطوة'] }] as any });
    const res = await generateSwimlane(model, { language: 'ar' });
    expect(gj.generateJson).toHaveBeenCalledTimes(1);
    expect(res.title).toBe('مسار الاعتماد');
  });

  it('reports staged progress (attempt N of 3) on every retry of an invalid spec', async () => {
    // an empty `lanes` array is invalid (validateSpec rejects it), so every one
    // of the 3 tries is exhausted — a deterministic way to observe every attempt.
    gj.generateJson.mockResolvedValue({ title: 'x', lanes: [], nodes: [], edges: [] });
    const model = baseModel({ procedures: [{ id: 'p1', title: 'إجراء', unitId: 'u1', steps: ['خطوة'] }] as any });
    const progress: { attempt: number; maxTries: number }[] = [];
    await generateSwimlane(model, { language: 'ar', onProgress: p => progress.push(p) });
    expect(progress).toEqual([
      { attempt: 1, maxTries: 3 },
      { attempt: 2, maxTries: 3 },
      { attempt: 3, maxTries: 3 },
    ]);
    expect(gj.generateJson).toHaveBeenCalledTimes(3);
  });
});
