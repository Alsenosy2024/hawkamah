import { describe, it, expect } from 'vitest';
import { resolveOrgChartMermaid, buildOrgChartMermaid, staleOrgChartDiagrams } from '../../services/diagramService';

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

// ===========================================================================
//  D5 — the org chart is editable from TWO surfaces (Stage 7's DiagramChatEditor,
//  which persists an override on the model, and the Build→Diagrams gallery's
//  chat/canvas editors, which only wrote the standalone GovDiagram record). They
//  used to drift apart: a gallery edit never reached the model override, and
//  "Regenerate from structure" cleared the model override but left a stale
//  gallery-saved GovDiagram behind. staleOrgChartDiagrams is the pure helper that
//  finds what needs resyncing after a reset.
// ===========================================================================
type Diag = { id: string; kind: string; mermaid: string };

describe('staleOrgChartDiagrams — what needs resyncing after "Regenerate from structure"', () => {
  const deterministic = 'flowchart TD\n  ceo["الرئيس التنفيذي"]';

  it('flags an orgchart-kind diagram whose mermaid no longer matches the deterministic chart', () => {
    const diagrams: Diag[] = [{ id: 'diag_1', kind: 'orgchart', mermaid: 'flowchart TD\n  x["منقّح يدويًا"]' }];
    expect(staleOrgChartDiagrams(diagrams, deterministic)).toEqual(diagrams);
  });

  it('is a no-op when the saved diagram already matches (nothing to rewrite)', () => {
    const diagrams: Diag[] = [{ id: 'diag_1', kind: 'orgchart', mermaid: deterministic }];
    expect(staleOrgChartDiagrams(diagrams, deterministic)).toEqual([]);
  });

  it('ignores non-orgchart diagrams entirely, even if their mermaid "differs"', () => {
    const diagrams: Diag[] = [{ id: 'diag_1', kind: 'flowchart', mermaid: 'flowchart TD\n  a-->b' }];
    expect(staleOrgChartDiagrams(diagrams, deterministic)).toEqual([]);
  });

  it('handles an empty/undefined diagram list without throwing', () => {
    expect(staleOrgChartDiagrams([], deterministic)).toEqual([]);
    expect(staleOrgChartDiagrams(undefined as unknown as Diag[], deterministic)).toEqual([]);
  });

  it('only flags the diagrams that actually need it out of a mixed set', () => {
    const diagrams: Diag[] = [
      { id: 'diag_1', kind: 'orgchart', mermaid: deterministic },              // already in sync
      { id: 'diag_2', kind: 'orgchart', mermaid: 'flowchart TD\n  stale' },    // needs resync
      { id: 'diag_3', kind: 'raci', mermaid: 'flowchart TD\n  r-->a' },        // not an org chart
    ];
    expect(staleOrgChartDiagrams(diagrams, deterministic).map(d => d.id)).toEqual(['diag_2']);
  });
});
