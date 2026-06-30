// V23 — Shared "back" (رجوع) affordance for in-app sub-views.
//
// Many sub-views (the org-chart model canvas, the diagram editor, the document
// canvas, library/reference forms, …) are entered by flipping local state with
// no browser-level route, so they previously lacked a consistent, visible way
// back. This is the single component for that, factored out of the hand-rolled
// pattern already in GovernanceCenter's top header:
//   hw-btn hw-btn-sm hw-btn-ghost  +  a chevron that is MANUALLY swapped per
//   language (NOT CSS-mirrored). Arabic reads right-to-left so "back" points to
//   the right (→); English points left (←).
// Presentational and dependency-free (just React) so it can drop into any header.
import React from 'react';

/**
 * The directional back glyph, swapped per language to stay correct under RTL.
 * Arabic (RTL): back points → ; English (LTR): back points ←.
 * Exported standalone so it can be unit-tested in node (vitest has no DOM here).
 */
export const backGlyph = (ar: boolean): string => (ar ? '→' : '←');

interface BackButtonProps {
  /** Close/navigate handler — returns to the prior in-app view. */
  onClick: () => void;
  /** Arabic-first language flag (true ⇒ Arabic, glyph →). */
  ar: boolean;
  /** Visible label; defaults to رجوع / Back. Ignored by the icon-only `xs` variant. */
  label?: string;
  /** title + aria-label (esp. for the icon-only `xs` variant); defaults to العودة / Go back. */
  titleLabel?: string;
  /** 'sm' (default) = chevron + label; 'xs' = icon-only chevron for tight/modal headers. */
  size?: 'sm' | 'xs';
  /** Extra classes appended to the button. */
  className?: string;
}

const BackButton: React.FC<BackButtonProps> = ({ onClick, ar, label, titleLabel, size = 'sm', className = '' }) => {
  const glyph = backGlyph(ar);
  const title = titleLabel ?? (ar ? 'العودة' : 'Go back');

  // Icon-only variant — a bare chevron for tight / modal headers. The label is
  // intentionally dropped; the accessible name lives on title + aria-label.
  if (size === 'xs') {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        className={`hw-btn hw-btn-xs hw-btn-ghost shrink-0 whitespace-nowrap ${className}`.trim()}
      >
        {glyph}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`hw-btn hw-btn-sm hw-btn-ghost shrink-0 whitespace-nowrap ${className}`.trim()}
    >
      {glyph} {label ?? (ar ? 'رجوع' : 'Back')}
    </button>
  );
};

export default BackButton;
