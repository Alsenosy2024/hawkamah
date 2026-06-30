import { describe, it, expect } from 'vitest';
import { perDocGuidanceLens } from '../../services/governanceEngine';

// ===========================================================================
//  V24 — per-document AI guidance. The owner can attach free-text instructions
//  to a SINGLE document in the catalog; they must be woven into THAT document's
//  prompt as a mandatory directive, and be a strict no-op when empty (so docs
//  without guidance see no prompt change / regression).
// ===========================================================================

describe('perDocGuidanceLens — per-doc guidance → injectable directive', () => {
  it('is empty when there is nothing to inject (no prompt change)', () => {
    expect(perDocGuidanceLens('')).toBe('');
    expect(perDocGuidanceLens(undefined)).toBe('');
    expect(perDocGuidanceLens('   \n  ')).toBe('');
  });

  it('renders the guidance text as a labeled, mandatory directive', () => {
    const block = perDocGuidanceLens('ركّز على الامتثال لـ SDAIA');
    expect(block).toContain('ركّز على الامتثال لـ SDAIA');
    // a labeled, obey-this directive scoped to this document
    expect(block).toContain('توجيهات خاصة بهذه الوثيقة');
    expect(block).toContain('إلزامية');
  });

  it('trims surrounding whitespace from the guidance', () => {
    const block = perDocGuidanceLens('  اربط بسياسة المشتريات  ');
    expect(block).toContain('اربط بسياسة المشتريات');
    expect(block).not.toContain('  اربط');
  });
});
