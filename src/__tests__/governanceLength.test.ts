import { describe, it, expect } from 'vitest';
import { parseTargetPages, resolveLengthTarget } from '../../services/governanceChat';
import { draftPacing } from '../../services/generationProgress';

// ===========================================================================
//  V4 — the requested page-count is honored (single source of truth).
//
//  The user states a length in free Arabic/English text. Historically that
//  number was ignored (hard-coded density bands → "10 pages" became ~105).
//  parseTargetPages must extract the count so every generation path can honor
//  the SAME target, and must return undefined when no count is stated (so vague
//  requests keep their legacy density — no regression). These tests pin that
//  contract plus the downstream budget math.
// ===========================================================================

describe('parseTargetPages — extracts a stated length, Arabic + English', () => {
  it('Arabic digits before a page word', () => {
    expect(parseTargetPages('اكتب لي سياسة في 10 صفحات')).toBe(10);
    expect(parseTargetPages('عايز وثيقة من 5 صفحات')).toBe(5);
    expect(parseTargetPages('تقرير 25 صفحة')).toBe(25);
  });

  it('Arabic-Indic and Persian digits are normalized', () => {
    expect(parseTargetPages('وثيقة من ١٥ صفحة')).toBe(15);   // U+0660s
    expect(parseTargetPages('۲۰ صفحة')).toBe(20);            // U+06F0s
  });

  it('spelled Arabic cardinals (the exact reported case: "عشر صفحات")', () => {
    expect(parseTargetPages('أول حاجة طلبت منه عشر صفحات')).toBe(10);
    expect(parseTargetPages('اعمل لي خمس صفحات')).toBe(5);
    expect(parseTargetPages('ثلاثة صفحات تكفي')).toBe(3);
    expect(parseTargetPages('عشرين صفحة')).toBe(20);
  });

  it('Arabic dual "صفحتين/صفحتان" means two pages', () => {
    expect(parseTargetPages('اكتب صفحتين فقط')).toBe(2);
    expect(parseTargetPages('صفحتان كحد أقصى')).toBe(2);
  });

  it('English forms: "10 pages", "25-page", "1 page"', () => {
    expect(parseTargetPages('write me a 10 pages policy')).toBe(10);
    expect(parseTargetPages('a 25-page governance report')).toBe(25);
    expect(parseTargetPages('just 1 page please')).toBe(1);
  });

  it('returns undefined when NO page count is requested (legacy density preserved)', () => {
    expect(parseTargetPages('اكتب لي سياسة كاملة ومفصّلة')).toBeUndefined();
    expect(parseTargetPages('write a complete strategy')).toBeUndefined();
    expect(parseTargetPages('')).toBeUndefined();
    expect(parseTargetPages(undefined)).toBeUndefined();
    expect(parseTargetPages(null)).toBeUndefined();
  });

  it('does NOT pick up unrelated numbers (years, standards, page references)', () => {
    expect(parseTargetPages('خطة 2025 وفق ISO 9001')).toBeUndefined();
    expect(parseTargetPages('according to ISO 27001 and COBIT 2019')).toBeUndefined();
    // "page 3 of the contract" is a reference, not a length request.
    expect(parseTargetPages('انظر صفحة 3 من العقد')).toBeUndefined();
  });

  it('clamps out-of-range values to undefined', () => {
    expect(parseTargetPages('9999 صفحة')).toBeUndefined(); // > 3 digits, no match
    expect(parseTargetPages('0 صفحات')).toBeUndefined();   // below 1
  });
});

describe('resolveLengthTarget — a stated count drives a bounded budget', () => {
  it('a 10-page target yields a modest, NOT runaway, token ceiling', () => {
    const lt = resolveLengthTarget(10);
    expect(lt.pages).toBe(10);
    expect(lt.maxOutputTokens).toBeLessThan(32768);          // far below the old flat 32k
    expect(lt.maxOutputTokens).toBeGreaterThan(3072);
    expect(lt.sections).toBeGreaterThanOrEqual(3);
    expect(lt.sections).toBeLessThanOrEqual(16);
    expect(lt.wordsPerSection).toBeGreaterThan(0);
  });

  it('more pages ⇒ more tokens (monotonic) but capped at the model max', () => {
    expect(resolveLengthTarget(5).maxOutputTokens)
      .toBeLessThan(resolveLengthTarget(20).maxOutputTokens);
    expect(resolveLengthTarget(120).maxOutputTokens).toBe(32768);
  });

  it('clamps absurd inputs into the supported range', () => {
    expect(resolveLengthTarget(0).pages).toBe(1);
    expect(resolveLengthTarget(9999).pages).toBe(120);
  });
});

describe('draftPacing — fallback progress is proportional to the scoped target', () => {
  it('a small target advances faster and reports fewer steps than a large one', () => {
    const small = draftPacing(10);
    const large = draftPacing(100);
    expect(small.intervalMs).toBeLessThan(large.intervalMs);
    expect(small.total).toBeLessThan(large.total);
    expect(small.stages).toEqual(['outline', 'drafting', 'critique', 'revising']);
  });

  it('no target ⇒ the prior default cadence (12s) and a sane total', () => {
    const none = draftPacing(undefined);
    expect(none.intervalMs).toBe(12000);
    expect(none.total).toBeGreaterThan(0);
  });
});
