import { describe, it, expect } from 'vitest';
import { buildCriteriaLens, type BuildCriterion } from '../../services/governanceFrameworks';
import { recommendationsDirective } from '../../services/artifactService';

// ===========================================================================
//  V17 — build criteria/recommendations table + a general-notes box applied
//  across a bulk run. These tests pin the PURE logic: the owner's table + notes
//  must turn into a directive that actually reaches the section prompts (so a
//  bulk generation "applies those recommendations"), and must be a strict no-op
//  when nothing is configured (no prompt regression for everyone else).
// ===========================================================================

const rows = (...r: [string, string][]): BuildCriterion[] =>
  r.map(([criterion, recommendation], i) => ({ id: `c${i}`, criterion, recommendation }));

describe('buildCriteriaLens — table + notes → one injectable directive', () => {
  it('is empty when there is nothing to inject (no prompt change)', () => {
    expect(buildCriteriaLens([], '')).toBe('');
    expect(buildCriteriaLens(undefined, undefined)).toBe('');
    // a half-filled / whitespace-only table is still nothing
    expect(buildCriteriaLens(rows(['', '']), '   ')).toBe('');
  });

  it('renders each criterion with its recommendation', () => {
    const block = buildCriteriaLens(rows(['مستوى التفصيل', 'صفحة واحدة لكل إجراء']), '');
    expect(block).toContain('مستوى التفصيل');
    expect(block).toContain('صفحة واحدة لكل إجراء');
    // a labeled, obey-this directive (mirrors standardsLens)
    expect(block).toContain('معايير وتوصيات البناء');
    expect(block).toContain('إلزامية');
  });

  it('includes the general notes box and marks them batch-wide', () => {
    const block = buildCriteriaLens([], 'استخدم مصطلحات قطاع المقاولات');
    expect(block).toContain('استخدم مصطلحات قطاع المقاولات');
    expect(block).toContain('طبّقها على كل عنصر');
  });

  it('drops empty rows but keeps the filled ones', () => {
    const block = buildCriteriaLens(rows(['RACI', 'أضِف مصفوفة لكل إجراء'], ['', '']), '');
    expect(block).toContain('RACI');
    // exactly one numbered row survived
    expect((block.match(/^\s*\d+\./gm) || []).length).toBe(1);
  });

  it('keeps a criterion that has no recommendation yet', () => {
    const block = buildCriteriaLens(rows(['الاتساق مع COSO', '']), '');
    expect(block).toContain('الاتساق مع COSO');
  });
});

describe('recommendationsDirective — the artifact-generator prompt tail', () => {
  it('is empty for empty/whitespace input', () => {
    expect(recommendationsDirective('')).toBe('');
    expect(recommendationsDirective('   \n  ')).toBe('');
    expect(recommendationsDirective(undefined)).toBe('');
  });

  it('appends the directive (trimmed) so it merges into a section prompt', () => {
    const out = recommendationsDirective('  التزم بمعايير البناء  ');
    expect(out).toBe('\n\nالتزم بمعايير البناء');
  });

  it('a buildCriteriaLens block flows through into a section prompt verbatim', () => {
    const block = buildCriteriaLens(rows(['SLA', 'حدّد مدة قصوى لكل خطوة']), 'اربط كل سياسة بمعيار ISO');
    const sectionPrompt = `اكتب القسم ١.${recommendationsDirective(block)}`;
    expect(sectionPrompt).toContain('حدّد مدة قصوى لكل خطوة');
    expect(sectionPrompt).toContain('اربط كل سياسة بمعيار ISO');
  });
});
