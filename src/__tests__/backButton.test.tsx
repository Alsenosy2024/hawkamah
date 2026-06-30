import { describe, it, expect } from 'vitest';
import { backGlyph } from '../../components/BackButton';

// ===========================================================================
//  V23 — shared "back" (رجوع) affordance. vitest runs in node here (no DOM, no
//  @types/react), so we can't render the component — but the only language-
//  sensitive logic is the MANUALLY-swapped directional chevron, which is a pure
//  helper. The whole point is that the glyph is NOT CSS-mirrored: it must flip
//  with the language so "back" always points toward the start of the line.
//  Arabic reads right-to-left ⇒ → ; English left-to-right ⇒ ← .
// ===========================================================================

describe('backGlyph', () => {
  it('points right (→) in Arabic — RTL: back is toward the start of the line', () => {
    expect(backGlyph(true)).toBe('→');
  });

  it('points left (←) in English — LTR: back is toward the start of the line', () => {
    expect(backGlyph(false)).toBe('←');
  });

  it('never renders the same glyph for both languages (it is genuinely swapped, not mirrored)', () => {
    expect(backGlyph(true)).not.toBe(backGlyph(false));
  });
});
