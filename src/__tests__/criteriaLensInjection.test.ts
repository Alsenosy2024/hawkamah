import { describe, it, expect } from 'vitest';
import { criteriaLensBlock, referenceProjectsBlock } from '../../services/governanceEngine';
import { buildCriteriaLens, type BuildCriterion } from '../../services/governanceFrameworks';

// ===========================================================================
//  D4 — the owner's build-criteria table + general notes used to be smuggled
//  into generation as a synthetic "reference project" (recoReference in
//  GovernanceCenter), which meant its content went through
//  referenceProjectsBlock's `.slice(0, 2500)` EXCERPT truncation — a
//  moderately full criteria table + notes got silently cut. criteriaLensBlock
//  is the fix: its own prompt block, injected directly into
//  generateGovernanceDoc/generateBulkDoc's system prompt, with its OWN cap
//  (6000 chars) independent of the reference-project channel.
//
//  These tests build a REALISTIC table size (large enough to have been cut by
//  the old 2500-char reference-excerpt path) and prove it lands whole.
// ===========================================================================

const rows = (n: number): BuildCriterion[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    criterion: `معيار رقم ${i + 1} — مستوى التفصيل المطلوب لهذا البند`,
    recommendation: `طبّق هذا البند على كل قسم بدقة واذكر المرجع المعياري المناسب له رقم ${i + 1}`,
  }));

describe('criteriaLensBlock — the real D4 injection path', () => {
  it('is empty when nothing is configured (no prompt regression)', () => {
    expect(criteriaLensBlock(undefined, undefined)).toBe('');
    expect(criteriaLensBlock([], '')).toBe('');
  });

  it('a realistic-size table + notes exceeds the OLD reference-excerpt cap (2500) — proving this is a real repro, not a toy input', () => {
    const criteria = rows(25);
    const notes = 'ملاحظات عامة تُطبَّق على كل عنصر من المخرجات: '.repeat(8);
    const raw = buildCriteriaLens(criteria, notes);
    // comfortably between the old 2500-char excerpt cap and the new 6000-char lens cap
    expect(raw.length).toBeGreaterThan(2500);
    expect(raw.length).toBeLessThan(6000);
  });

  it('lands UN-TRUNCATED for that realistic table size (was silently cut before D4)', () => {
    const criteria = rows(25);
    const notes = 'ملاحظات عامة تُطبَّق على كل عنصر من المخرجات: '.repeat(8);
    const raw = buildCriteriaLens(criteria, notes);
    const injected = criteriaLensBlock(criteria, notes);
    // the full block reaches the prompt verbatim — not the old referenceProjectsBlock 2500-char excerpt
    expect(injected).toBe(raw);
    expect(injected).toContain('معيار رقم 1 ');
    expect(injected).toContain('معيار رقم 25 ');
    expect(injected.length).toBeGreaterThan(2500);
  });

  it('is still bounded by its OWN generous cap (6000 chars) for pathological input', () => {
    const criteria = rows(400); // absurdly large table
    const injected = criteriaLensBlock(criteria, '');
    expect(injected.length).toBeLessThanOrEqual(6000);
  });

  it('referenceProjectsBlock (the OLD smuggling channel) truncates at 2500 chars per excerpt — the bug this replaces', () => {
    const bigContent = 'س'.repeat(5000);
    const block = referenceProjectsBlock([
      { id: 'r1', name: 'مشروع', content: bigContent, createdAt: new Date().toISOString() } as any,
    ]);
    // proves the old channel really does cut — criteriaLensBlock deliberately avoids it
    expect(block.length).toBeLessThan(bigContent.length);
  });
});
