import { describe, it, expect } from 'vitest';
import { buildOrgChartMermaid, detectMermaidType } from '../../services/diagramService';

// ===========================================================================
//  PRD V6 — the org structure must be built DETERMINISTICALLY from the company's
//  real units (model.orgUnits), not the AI: the owner reported it came out wrong
//  (units the model invented), self-contradictory across sections, and different
//  on every run unless he manually injected a file. buildOrgChartMermaid replaces
//  the AI path for the orgchart kind. These tests pin the three acceptance
//  criteria at the string level (vitest runs in node — no DOM — but the builder
//  is pure, so its full output is observable).
// ===========================================================================

type Unit = { id: string; name?: string; parentId?: string };
type Role = { id: string; title?: string; unitId?: string };
const model = (orgUnits: Unit[], roles: Role[] = [], companyName = 'شركة كلمة') =>
  ({ orgUnits, roles, companyName } as any);

const COMPANY = model(
  [
    { id: 'u_ceo', name: 'الرئيس التنفيذي' },
    { id: 'u_fin', name: 'الإدارة المالية', parentId: 'u_ceo' },
    { id: 'u_hr', name: 'الموارد البشرية', parentId: 'u_ceo' },
    { id: 'u_pay', name: 'الرواتب', parentId: 'u_fin' },
  ],
  [
    { id: 'r_cfo', title: 'المدير المالي', unitId: 'u_fin' },
    { id: 'r_hrm', title: 'مدير الموارد البشرية', unitId: 'u_hr' },
  ],
);

describe('buildOrgChartMermaid — deterministic (same input → same output)', () => {
  it('produces byte-identical output across repeated runs with the same model', () => {
    const a = buildOrgChartMermaid(COMPANY);
    const b = buildOrgChartMermaid(COMPANY);
    const c = buildOrgChartMermaid(model(COMPANY.orgUnits, COMPANY.roles, COMPANY.companyName));
    expect(a).toBe(b);
    expect(a).toBe(c); // a fresh model object with identical contents → identical chart
  });

  it('is a valid flowchart header (renders, never falls back to raw code)', () => {
    expect(detectMermaidType(buildOrgChartMermaid(COMPANY))).toBe('flowchart');
    expect(buildOrgChartMermaid(COMPANY).startsWith('flowchart TD')).toBe(true);
  });
});

describe('buildOrgChartMermaid — grounded in model.orgUnits (invents nothing)', () => {
  it('emits exactly one node per real unit and nothing else', () => {
    const out = buildOrgChartMermaid(COMPANY, { includeRoles: false });
    // every unit name present
    for (const u of COMPANY.orgUnits) expect(out).toContain(u.name);
    // one node declaration per unit (u0..u3), no extra invented nodes
    const nodeDecls = out.split('\n').filter(l => /^\s+u\d+\[/.test(l));
    expect(nodeDecls.length).toBe(COMPANY.orgUnits.length);
  });

  it('wires parent → child edges straight from parentId', () => {
    const out = buildOrgChartMermaid(COMPANY, { includeRoles: false });
    // u0=ceo, u1=fin, u2=hr, u3=pay  → ceo→fin, ceo→hr, fin→pay
    expect(out).toContain('u0 --> u1');
    expect(out).toContain('u0 --> u2');
    expect(out).toContain('u1 --> u3');
    // exactly 3 edges (one per non-root unit) — no invented links
    const edges = out.split('\n').filter(l => /-->/.test(l));
    expect(edges.length).toBe(3);
  });

  it('treats a unit whose parentId is missing from the set as a root (no dangling edge to the ghost parent)', () => {
    const out = buildOrgChartMermaid(
      model([
        { id: 'a', name: 'وحدة أ' },
        { id: 'b', name: 'وحدة ب', parentId: 'ghost' }, // parent not present → root
      ]),
      { includeRoles: false },
    );
    expect(out).not.toContain('ghost');                       // never references the missing parent
    // both are roots → joined under ONE synthesized head; every edge originates from it (none dangling)
    const edges = out.split('\n').filter(l => /-->/.test(l));
    expect(edges.length).toBe(2);
    expect(edges.every(l => /^\s+org_root -->/.test(l))).toBe(true);
  });

  it('ignores a self-referential parentId instead of drawing a self-loop', () => {
    const out = buildOrgChartMermaid(model([{ id: 'a', name: 'وحدة', parentId: 'a' }]), { includeRoles: false });
    expect(out).not.toMatch(/u0 --> u0/);
  });
});

describe('buildOrgChartMermaid — roles & edge cases', () => {
  it('attaches roles under their unit by unitId when includeRoles is on (default)', () => {
    const out = buildOrgChartMermaid(COMPANY);
    expect(out).toContain('المدير المالي');
    expect(out).toContain('مدير الموارد البشرية');
    // dotted role edges from the owning unit
    expect(out).toMatch(/u1 -\.-> r0/); // CFO under finance (u1)
    expect(out).toMatch(/u2 -\.-> r1/); // HRM under HR (u2)
  });

  it('drops a role whose unitId is not a real unit (no orphan node)', () => {
    const out = buildOrgChartMermaid(model([{ id: 'u', name: 'وحدة' }], [{ id: 'r', title: 'دور يتيم', unitId: 'nope' }]));
    expect(out).not.toContain('دور يتيم');
  });

  it('falls back to a single company node when there are no units', () => {
    expect(buildOrgChartMermaid(model([], [], 'منشأة بلا هيكل'))).toBe('flowchart TD\n  org_root["منشأة بلا هيكل"]');
    expect(buildOrgChartMermaid(model([]))).toContain('org_root[');
  });

  it('sanitizes label-breaking characters out of unit names', () => {
    const out = buildOrgChartMermaid(model([{ id: 'a', name: 'إدارة [المالية] | "العليا"' }]), { includeRoles: false });
    expect(out).not.toMatch(/\[[^"\]]*\[/);     // no nested opening bracket inside a node label
    expect(out).not.toContain('"العليا"');       // inner double-quotes neutralized
    expect(detectMermaidType(out)).toBe('flowchart');
  });
});

// ===========================================================================
//  V22 — real org models have MANY parentless top-level departments, so the
//  builder used to emit a flat row of DISCONNECTED mini-trees with no single
//  head. When the model isn't already single-rooted, the builder now collapses
//  every top-level unit under ONE synthesized root (the CEO/company), giving a
//  proper top-down hierarchy. Existing multi-level nesting (parentId) is kept.
// ===========================================================================
describe('buildOrgChartMermaid — synthesized single root (collapses multiple parentless tops)', () => {
  const THREE_DEPTS = model(
    [
      { id: 'd1', name: 'إدارة المشتريات' },                  // top-level → u0
      { id: 'd2', name: 'الإدارة المالية' },                  // top-level → u1
      { id: 'd3', name: 'الموارد البشرية' },                  // top-level → u2
      { id: 'd1a', name: 'الشراء والتوريد', parentId: 'd1' }, // sub-unit → u3 (existing nesting)
    ],
    [{ id: 'r_ceo', title: 'الرئيس التنفيذي', unitId: 'd0' }],
  );

  it('adds ONE synthesized root with an edge to each former top-level unit, still flowchart TD', () => {
    const out = buildOrgChartMermaid(THREE_DEPTS, { includeRoles: false });
    expect(out.startsWith('flowchart TD')).toBe(true);
    // exactly one synthesized root node declaration
    expect(out.split('\n').filter(l => /^\s+org_root\[/.test(l)).length).toBe(1);
    // an edge from the root to each of the 3 parentless departments (d1=u0, d2=u1, d3=u2)
    expect(out).toContain('org_root --> u0');
    expect(out).toContain('org_root --> u1');
    expect(out).toContain('org_root --> u2');
    // existing multi-level nesting preserved (d1 → d1a), and the root is NOT linked to a sub-unit
    expect(out).toContain('u0 --> u3');
    expect(out).not.toContain('org_root --> u3');
  });

  it('labels the synthesized root from a CEO-type role title when the model has one', () => {
    const out = buildOrgChartMermaid(THREE_DEPTS, { includeRoles: false });
    expect(out).toMatch(/org_root\["الرئيس التنفيذي"\]/);
  });

  it('falls back to companyName, then the literal CEO label, for the synthesized root', () => {
    const named = model([{ id: 'a', name: 'أ' }, { id: 'b', name: 'ب' }], [], 'مجموعة كلمة');
    expect(buildOrgChartMermaid(named, { includeRoles: false })).toMatch(/org_root\["مجموعة كلمة"\]/);

    const unnamed = model([{ id: 'a', name: 'أ' }, { id: 'b', name: 'ب' }], [], '');
    expect(buildOrgChartMermaid(unnamed, { includeRoles: false })).toMatch(/org_root\["الرئيس التنفيذي"\]/);
  });

  it('does NOT synthesize a root when the model already has exactly one top-level unit', () => {
    // COMPANY has a single parentless unit (u_ceo) → unchanged single-rooted tree
    expect(buildOrgChartMermaid(COMPANY, { includeRoles: false })).not.toContain('org_root');
  });

  it('synthesizes a single head even when every unit sits in a cycle (zero real roots)', () => {
    const cyclic = model([
      { id: 'a', name: 'أ', parentId: 'b' },
      { id: 'b', name: 'ب', parentId: 'a' },
    ]);
    const out = buildOrgChartMermaid(cyclic, { includeRoles: false });
    expect(out.split('\n').filter(l => /^\s+org_root\[/.test(l)).length).toBe(1);
  });

  it('stays byte-identical across runs with the synthesized root (determinism preserved)', () => {
    expect(buildOrgChartMermaid(THREE_DEPTS)).toBe(buildOrgChartMermaid(THREE_DEPTS));
  });
});
