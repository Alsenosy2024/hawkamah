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

  it('treats a unit whose parentId is missing from the set as a root (no dangling edge)', () => {
    const out = buildOrgChartMermaid(
      model([
        { id: 'a', name: 'وحدة أ' },
        { id: 'b', name: 'وحدة ب', parentId: 'ghost' }, // parent not present → root
      ]),
      { includeRoles: false },
    );
    expect(out).not.toContain('ghost');
    expect(out.split('\n').filter(l => /-->/.test(l)).length).toBe(0);
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
