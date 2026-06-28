import { describe, it, expect } from 'vitest';
import { suggestJobTitles, suggestJobTitleLines } from '../../services/jobTitleSuggestions';

// ===========================================================================
//  A1 — industry → job-title suggestions.
//
//  `GovProject.industry` is FREE TEXT (manual entry or AI-extracted, Arabic OR
//  English), so the matcher must key off keywords across both languages with
//  hamza/alef/yaa normalization — not an enum. Unknown/blank sectors must return
//  [] so the setup modal keeps its original empty-textarea + placeholder behavior
//  (PRD A1 AC #4). These tests pin that contract.
// ===========================================================================

describe('suggestJobTitles — known sectors return a relevant, well-formed list', () => {
  it('real-estate (Arabic "عقاري") yields the PRD-style titles', () => {
    const out = suggestJobTitles('عقاري');
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out.length).toBeLessThanOrEqual(8); // PRD asks for 5–8
    const ar = out.map(t => t.ar);
    expect(ar).toContain('مدير مشاريع');
    expect(ar).toContain('مهندس موقع');
    expect(ar).toContain('محاسب');
  });

  it('real-estate (English "Real Estate") matches the same sector', () => {
    expect(suggestJobTitles('Real Estate Development').length).toBeGreaterThanOrEqual(5);
    expect(suggestJobTitles('property management').length).toBeGreaterThanOrEqual(5);
  });

  it('every suggestion carries a non-empty Arabic AND English label', () => {
    for (const sector of ['عقاري', 'الطاقة', 'بنك', 'مستشفى', 'تعليم', 'مقاولات', 'logistics', 'manufacturing']) {
      const out = suggestJobTitles(sector);
      expect(out.length, `sector=${sector}`).toBeGreaterThan(0);
      for (const titleObj of out) {
        expect(titleObj.ar.trim(), `ar for ${sector}`).not.toBe('');
        expect(titleObj.en.trim(), `en for ${sector}`).not.toBe('');
      }
    }
  });

  it('distinct sectors produce distinct title sets (energy ≠ healthcare)', () => {
    const energy = suggestJobTitles('قطاع الطاقة والنفط').map(t => t.en).join('|');
    const health = suggestJobTitles('مستشفى ورعاية صحية').map(t => t.en).join('|');
    expect(energy).not.toBe(health);
    expect(energy).toContain('Electrical Engineer');
    expect(health).toContain('Nurse');
  });
});

describe('suggestJobTitles — robust free-text matching', () => {
  it('normalizes hamza/alef variants ("إنشاءات" → construction)', () => {
    const withHamza = suggestJobTitles('شركة إنشاءات');
    const withoutHamza = suggestJobTitles('شركة انشاءات');
    expect(withHamza.length).toBeGreaterThan(0);
    expect(withHamza).toEqual(withoutHamza); // alef-hamza normalized to bare alef
    expect(withHamza.map(t => t.en)).toContain('Civil Engineer');
  });

  it('is case-insensitive for English ("ENERGY" === "energy")', () => {
    expect(suggestJobTitles('ENERGY')).toEqual(suggestJobTitles('energy'));
  });

  it('falls back to specialization when industry is blank', () => {
    expect(suggestJobTitles('', 'تطوير عقاري').length).toBeGreaterThanOrEqual(5);
    expect(suggestJobTitles(undefined, 'software').length).toBeGreaterThanOrEqual(5);
  });

  it('prefers telecom over generic technology for "اتصالات"', () => {
    expect(suggestJobTitles('شركة اتصالات').map(t => t.en)).toContain('Network Engineer');
  });

  it('matches common Arabic broken plurals (مطاعم/فنادق/مدارس/مصانع), not just singular roots', () => {
    expect(suggestJobTitles('سلسلة مطاعم').map(t => t.en)).toContain('Hotel Manager');   // hospitality
    expect(suggestJobTitles('إدارة فنادق').length).toBeGreaterThanOrEqual(5);              // hospitality
    expect(suggestJobTitles('مجموعة مدارس').map(t => t.en)).toContain('Teacher');          // education
    expect(suggestJobTitles('شركة مصانع').map(t => t.en)).toContain('Production Manager'); // manufacturing
  });

  it('matches the idiomatic "القطاع العام" phrasing for government', () => {
    expect(suggestJobTitles('القطاع العام').length).toBeGreaterThanOrEqual(5);
  });
});

describe('suggestJobTitles — unknown/blank sector keeps original empty behavior (AC #4)', () => {
  it('returns [] for blank / undefined industry', () => {
    expect(suggestJobTitles('')).toEqual([]);
    expect(suggestJobTitles(undefined)).toEqual([]);
    expect(suggestJobTitles('   ')).toEqual([]);
    expect(suggestJobTitles(undefined, undefined)).toEqual([]);
  });

  it('returns [] for an unrecognised sector (no crash, no generic invention)', () => {
    expect(suggestJobTitles('عام / غير محدد')).toEqual([]); // the app's default "unspecified"
    expect(suggestJobTitles('zzqq unknown sector 12345')).toEqual([]);
  });
});

describe('suggestJobTitleLines — language projection for the textarea seed', () => {
  it('returns Arabic strings when language=ar, English when language=en', () => {
    const ar = suggestJobTitleLines('عقاري', undefined, 'ar');
    const en = suggestJobTitleLines('عقاري', undefined, 'en');
    expect(ar).toContain('مدير مشاريع');
    expect(en).toContain('Project Manager');
    expect(ar.length).toBe(en.length);
  });

  it('returns [] (no lines) for unknown sector so the textarea stays empty', () => {
    expect(suggestJobTitleLines('', '', 'ar')).toEqual([]);
    expect(suggestJobTitleLines('unknownxyz', undefined, 'en')).toEqual([]);
  });
});
