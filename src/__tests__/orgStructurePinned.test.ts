import { describe, it, expect } from 'vitest';
import { orgStructureSectionMarkdown, isOrgStructureDoc } from '../../services/governanceEngine';
import { buildOrgChartMermaid } from '../../services/diagramService';
import type { CompanyGovernanceModel } from '../../types';

// ===========================================================================
//  D5 (V6-AC3, in-app half) — buildOrgChartMermaid is the deterministic org
//  chart used by the stage-7 chart, but the in-app-generated "Org structure"
//  DOCUMENT used to describe the structure as free AI prose — a second,
//  non-deterministic source of truth that could drift from the real chart.
//  orgStructureSectionMarkdown pins the document's structural section to the
//  EXACT SAME deterministic Mermaid, so it can never disagree with the chart.
// ===========================================================================

const baseModel = (): CompanyGovernanceModel => ({
  companyName: 'شركة الاختبار',
  orgUnits: [
    { id: 'u1', name: 'الإدارة العامة', mandate: 'القيادة العليا', provenance: [] },
    { id: 'u2', name: 'إدارة الموارد البشرية', mandate: 'إدارة شؤون الموظفين', parentId: 'u1', provenance: [] },
    { id: 'u3', name: 'إدارة المالية', mandate: 'الشؤون المالية والمحاسبية', parentId: 'u1', provenance: [] },
  ],
  roles: [],
  policies: [],
  procedures: [],
  gaps: [],
} as any);

describe('orgStructureSectionMarkdown — pinned to the deterministic chart', () => {
  it('embeds the EXACT SAME Mermaid buildOrgChartMermaid produces for the chart — byte for byte', () => {
    const model = baseModel();
    const section = orgStructureSectionMarkdown(model);
    const chartMermaid = buildOrgChartMermaid(model);
    expect(section).toContain('```mermaid\n' + chartMermaid + '\n```');
  });

  it('lists every org unit in the units table with its parent and mandate', () => {
    const model = baseModel();
    const section = orgStructureSectionMarkdown(model);
    expect(section).toContain('| الإدارة العامة | — | القيادة العليا |');
    expect(section).toContain('| إدارة الموارد البشرية | الإدارة العامة | إدارة شؤون الموظفين |');
    expect(section).toContain('| إدارة المالية | الإدارة العامة | الشؤون المالية والمحاسبية |');
  });

  it('is deterministic — identical model in, byte-identical section out, across repeated calls', () => {
    const model = baseModel();
    expect(orgStructureSectionMarkdown(model)).toBe(orgStructureSectionMarkdown(model));
  });

  it('changes when the model changes — the section is derived, not cached/stale', () => {
    const model = baseModel();
    const before = orgStructureSectionMarkdown(model);
    const changed: CompanyGovernanceModel = { ...model, orgUnits: [...model.orgUnits, { id: 'u4', name: 'إدارة تقنية المعلومات', mandate: 'الأنظمة', parentId: 'u1', provenance: [] } as any] };
    const after = orgStructureSectionMarkdown(changed);
    expect(after).not.toBe(before);
    expect(after).toContain('إدارة تقنية المعلومات');
  });

  it('never omits a unit even with no orgUnits (falls back to a placeholder row, not an empty table)', () => {
    const empty: CompanyGovernanceModel = { ...baseModel(), orgUnits: [] };
    const section = orgStructureSectionMarkdown(empty);
    expect(section).toContain('| — | — | — |');
  });
});

describe('isOrgStructureDoc — detects the org-structure doc kind/title', () => {
  it('matches the catalog kind "org_structure"', () => {
    expect(isOrgStructureDoc('org_structure', 'أي عنوان')).toBe(true);
  });

  it('matches an Arabic title naming the org structure, even without the catalog kind', () => {
    expect(isOrgStructureDoc(undefined, 'وثيقة الهيكل التنظيمي للشركة')).toBe(true);
  });

  it('matches an English title naming the org structure/chart', () => {
    expect(isOrgStructureDoc(undefined, 'Organizational Structure Report')).toBe(true);
    expect(isOrgStructureDoc(undefined, 'Org Chart Overview')).toBe(true);
  });

  it('does not false-positive on an unrelated doc', () => {
    expect(isOrgStructureDoc('hr_policy', 'دليل سياسات الموارد البشرية')).toBe(false);
    expect(isOrgStructureDoc(undefined, 'التقرير المالي السنوي')).toBe(false);
  });
});
