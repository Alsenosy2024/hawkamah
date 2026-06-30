import { describe, it, expect } from 'vitest';
import { locateQuoteInText, normalizeQuote } from '../../services/commentAnchor';

// ===========================================================================
//  V21 — inline highlight-and-comment anchoring. These pin the PURE text-quote
//  matcher that re-locates a highlighted span across the two renderings of a
//  governance document (the Markdown client review screen vs. the owner canvas
//  iframe). The DOM glue (ranges, <mark> wrapping) is exercised in the browser;
//  here we lock the whitespace-tolerant, prefix/suffix-disambiguated matching.
// ===========================================================================

describe('normalizeQuote', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeQuote('  مجلس   الإدارة\n  يجتمع ')).toBe('مجلس الإدارة يجتمع');
  });
  it('is empty for whitespace-only input', () => {
    expect(normalizeQuote('   \n\t ')).toBe('');
  });
});

describe('locateQuoteInText', () => {
  const text = 'يجتمع مجلس الإدارة مرة كل ثلاثة أشهر على الأقل لمراجعة الأداء.';

  it('finds an exact quote and returns its raw offsets', () => {
    const hit = locateQuoteInText(text, { quote: 'مجلس الإدارة' });
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('مجلس الإدارة');
  });

  it('tolerates whitespace differences between capture and render', () => {
    // Quote captured with collapsed spaces still matches multi-space rendered text.
    const rendered = 'يجتمع مجلس   الإدارة مرة';
    const hit = locateQuoteInText(rendered, { quote: 'مجلس الإدارة' });
    expect(hit).not.toBeNull();
    expect(normalizeQuote(rendered.slice(hit!.start, hit!.end))).toBe('مجلس الإدارة');
  });

  it('returns null when the quote is absent', () => {
    expect(locateQuoteInText(text, { quote: 'لجنة المخاطر' })).toBeNull();
  });

  it('returns null for an empty quote', () => {
    expect(locateQuoteInText(text, { quote: '   ' })).toBeNull();
  });

  it('disambiguates a repeated quote using prefix/suffix', () => {
    const repeated = 'السياسة معتمدة. السياسة معتمدة. السياسة معتمدة.';
    // Target the SECOND occurrence via its surrounding context.
    const firstIdx = repeated.indexOf('السياسة');
    const secondIdx = repeated.indexOf('السياسة', firstIdx + 1);
    const hit = locateQuoteInText(repeated, {
      quote: 'السياسة',
      prefix: 'السياسة معتمدة. ',
      suffix: ' معتمدة. السياسة',
    });
    expect(hit).not.toBeNull();
    expect(hit!.start).toBe(secondIdx);
  });

  it('falls back to the first occurrence when context is missing', () => {
    const repeated = 'بند بند بند';
    const hit = locateQuoteInText(repeated, { quote: 'بند' });
    expect(hit!.start).toBe(0);
  });
});
