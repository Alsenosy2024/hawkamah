import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasMermaidFence, buildGrounding, exportDoc } from '../../services/copilotClient';
import type { CompanyGovernanceModel } from '../../types';

// ===========================================================================
//  P5 — GovCopilot ↔ Python backend contract.
//
//  D2: the real-company grounding payload (company/org_units/roles/departments)
//      built from the live model, in the minimal shapes the backend's
//      `_grounding_from_body` reads.
//  D5: an empty/failed backend export must be a thrown error, not a silent
//      "success" that leaves the chat/UI claiming the file is ready.
//  D7: mermaid-fence detection — the backend's markdown renderer has no image
//      support, so a diagram-bearing DOCX/PPTX export must bypass it (see
//      GovCopilot.exportAs); this pins the detector in isolation.
// ===========================================================================

describe('hasMermaidFence — detects diagram-bearing markdown (P5/D7)', () => {
  it('detects a ```mermaid fence, case/spacing tolerant', () => {
    expect(hasMermaidFence('```mermaid\ngraph TD; A-->B\n```')).toBe(true);
    expect(hasMermaidFence('```Mermaid\nflowchart LR\n```')).toBe(true);
    expect(hasMermaidFence('```  mermaid\ngraph TD\n```')).toBe(true);
  });
  it('is false for ordinary markdown / other fenced languages / empty input', () => {
    expect(hasMermaidFence('# عنوان\nنص عادي بدون مخططات.')).toBe(false);
    expect(hasMermaidFence('```json\n{"a":1}\n```')).toBe(false);
    expect(hasMermaidFence('')).toBe(false);
  });
});

describe('buildGrounding — the real-company grounding payload (P5/D2)', () => {
  const model = {
    companyName: 'شركة المقاولات',
    orgUnits: [
      { id: 'u1', name: 'المالية', mandate: '', provenance: [] },
      { id: 'u2', name: 'الموارد البشرية', mandate: '', provenance: [] },
    ],
    roles: [
      { id: 'r1', title: 'مدير مالي', unitId: 'u1', purpose: '', responsibilities: [], provenance: [] },
    ],
    policies: [], procedures: [], authorities: [], kpis: [], gaps: [],
  } as unknown as CompanyGovernanceModel;

  it('returns {} for a null/undefined model — the ungrounded path stays unchanged', () => {
    expect(buildGrounding(null)).toEqual({});
    expect(buildGrounding(undefined)).toEqual({});
  });

  it('maps company/org_units/roles to the minimal shapes the backend reads', () => {
    const g = buildGrounding(model);
    expect(g.company).toBe('شركة المقاولات');
    expect(g.org_units).toEqual([
      { id: 'u1', name: 'المالية', parentId: undefined },
      { id: 'u2', name: 'الموارد البشرية', parentId: undefined },
    ]);
    expect(g.roles).toEqual([{ id: 'r1', title: 'مدير مالي', unitId: 'u1' }]);
  });

  it('derives departments from org units when no plan is given', () => {
    const g = buildGrounding(model);
    expect(g.departments).toEqual(['المالية', 'الموارد البشرية']);
  });

  it('plan departments win over org-unit-derived departments (matches the backend\'s own _plan_grounding override)', () => {
    const g = buildGrounding(model, {
      plan: { title: 't', pages: 5, axes: [], departments: ['المشتريات'], components: [], notes: '' },
    });
    expect(g.departments).toEqual(['المشتريات']);
  });

  it('omits every key for a model with no company/units/roles/gaps/assessment', () => {
    const empty = { companyName: '', orgUnits: [], roles: [], policies: [], procedures: [], authorities: [], kpis: [], gaps: [] } as unknown as CompanyGovernanceModel;
    expect(buildGrounding(empty)).toEqual({});
  });
});

describe('exportDoc — an empty/failed backend export must fail loudly (P5/D5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('throws instead of silently "succeeding" on a 0-byte blob', async () => {
    const emptyBlob = new Blob([], { type: 'application/octet-stream' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => emptyBlob }));
    await expect(exportDoc('# doc', 'title', 'docx')).rejects.toThrow(/empty file/);
  });

  it('throws on a non-OK backend response instead of resolving', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(exportDoc('# doc', 'title', 'docx')).rejects.toThrow(/500/);
  });
});
