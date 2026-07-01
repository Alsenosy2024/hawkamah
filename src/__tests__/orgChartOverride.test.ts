import { describe, it, expect } from 'vitest';
import { resolveOrgChartMermaid, buildOrgChartMermaid } from '../../services/diagramService';

// ===========================================================================
//  V29 — the org chart gained a natural-language + attachments editor
//  (DiagramChatEditor). The AI-edited Mermaid is stored on the model as an
//  OVERRIDE (`orgChartMermaid`). resolveOrgChartMermaid is the single pure
//  source that the read-only view, the interactive canvas and the PNG/SVG
//  export all read from: PREFER the override when present & non-blank, else
//  fall back to the deterministic buildOrgChartMermaid(orgUnits). These tests
//  pin exactly that contract (the resolver is pure — its output is observable
//  in node with no DOM).
// ===========================================================================

type Unit = { id: string; name?: string; parentId?: string };
type Role = { id: string; title?: string; unitId?: string };
const model = (
  orgUnits: Unit[],
  extra: { roles?: Role[]; companyName?: string; orgChartMermaid?: string } = {},
) => ({ orgUnits, roles: extra.roles ?? [], companyName: extra.companyName ?? 'شركة كلمة', orgChartMermaid: extra.orgChartMermaid } as any);

const UNITS: Unit[] = [
  { id: 'u_ceo', name: 'الرئيس التنفيذي' },
  { id: 'u_fin', name: 'الإدارة المالية', parentId: 'u_ceo' },
  { id: 'u_hr', name: 'الموارد البشرية', parentId: 'u_ceo' },
];

describe('resolveOrgChartMermaid — prefers the override, else the deterministic chart', () => {
  it('falls back to buildOrgChartMermaid when there is no override', () => {
    const m = model(UNITS);
    expect(resolveOrgChartMermaid(m)).toBe(buildOrgChartMermaid(m));
  });

  it('returns the override verbatim (trimmed) when one is present', () => {
    const override = 'flowchart TD\n  a["الرئيس"] --> b["المالية"]';
    const m = model(UNITS, { orgChartMermaid: `\n${override}\n  ` });
    const out = resolveOrgChartMermaid(m);
    expect(out).toBe(override);               // preferred + trimmed
    expect(out).not.toBe(buildOrgChartMermaid(m)); // and NOT the deterministic derivation
  });

  it('ignores a blank / whitespace-only override (treats it as absent)', () => {
    const deterministic = buildOrgChartMermaid(model(UNITS));
    expect(resolveOrgChartMermaid(model(UNITS, { orgChartMermaid: '' }))).toBe(deterministic);
    expect(resolveOrgChartMermaid(model(UNITS, { orgChartMermaid: '   \n\t ' }))).toBe(deterministic);
  });

  it('is a no-op passthrough that survives a round-trip (override in → same override out)', () => {
    const edited = 'flowchart LR\n  x["A"] --> y["B"]';
    const first = resolveOrgChartMermaid(model(UNITS, { orgChartMermaid: edited }));
    // persisting `first` back as the override must resolve to the identical string (stable)
    const second = resolveOrgChartMermaid(model(UNITS, { orgChartMermaid: first }));
    expect(second).toBe(first);
    expect(second).toBe(edited);
  });

  it('tolerates a null/undefined model without throwing (empty deterministic chart)', () => {
    expect(() => resolveOrgChartMermaid(null)).not.toThrow();
    expect(() => resolveOrgChartMermaid(undefined)).not.toThrow();
    expect(resolveOrgChartMermaid(null)).toBe(buildOrgChartMermaid({ orgUnits: [] }));
  });
});
