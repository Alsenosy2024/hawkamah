// ===========================================================================
//  Hawkamah · Ailigent.ai Design System v3 — "The Governance Instrument"
//  Single source of truth for fonts, buttons, cards, inputs, badges, toasts.
//  Brand accent = refined Teal (logo #11A8BC). Neutral = ink/slate. Semantic
//  stays DISTINCT from brand: success=green · warning=amber · danger=red ·
//  info=blue · neutral=slate. (The legacy `emerald-*` utility names render teal
//  via tailwind.config.js, so existing class strings keep working.)
//
//  CSS component classes (.hw-*) are defined in /index.css.
//  Tailwind CDN is used for layout only (flex, grid, gap, px, text-size, etc.)
//  Brand-visual classes MUST come from .hw-* to ensure consistent hover/shadow.
// ===========================================================================

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

/** Build the font-family CSS value used across the whole app. */
export const FONT_STACK = (font?: string): string =>
  `'${font || 'Thmanyah Sans'}', 'Tajawal', 'Inter', sans-serif`;

/**
 * Dynamic stylesheet body that forces the chosen webfont on every visual node.
 * Centralizes what used to be inline in App.tsx so all surfaces stay in sync.
 * Default UI face is Thmanyah Sans (Ailigent brand, Arabic-first). Headings use
 * the same family at heavier weight; the Thmanyah Serif Display face is reserved
 * for opt-in page/hero titles per screen (DESIGN.md §3), not auto-applied here.
 */
export const buildFontCss = (font?: string): string => {
  const chosen = font || 'Thmanyah Sans';
  // When the brand sans is active, headings use the distinctive Thmanyah Serif
  // Display for editorial authority (DESIGN.md §3). A deliberate non-Thmanyah
  // pick keeps headings in that chosen face instead.
  const heading = chosen === 'Thmanyah Sans' ? 'Thmanyah Serif Display' : chosen;
  return `
    body, button, input, select, textarea, p, span, h4, h5, h6, table, th, td, div:not(.font-mono) {
      font-family: '${chosen}', 'Tajawal', 'Inter', sans-serif !important;
    }
    h1, h2, h3 {
      font-family: '${heading}', '${chosen}', 'Tajawal', serif !important;
    }
    .font-black, .font-extrabold {
      font-family: '${chosen}', 'Tajawal', 'Inter', sans-serif !important;
    }
    h1, h2, h3 { letter-spacing: -0.012em; line-height: 1.25; }
    h1 { font-weight: 700 !important; }
  `;
};

export interface ToastVariantStyle {
  icon: string;
  bg: string;
  border: string;
  text: string;
  accent: string;
}

// ===========================================================================
//  UI tokens — import `UI` everywhere, never hardcode button/card/input/tab.
//  .hw-btn classes from index.css: proper hover-lift, shadow-glow, transitions.
// ===========================================================================

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const UI = {

  // ─── Buttons ───────────────────────────────────────────────────────────
  // Base: hw-btn (transition + layout). Variant adds color + hover effects.
  // Append Tailwind layout classes as needed: `UI.btnPrimary + ' w-full'`

  btnPrimary:
    'hw-btn hw-btn-primary',
  btnPrimarySm:
    'hw-btn hw-btn-sm hw-btn-primary',
  btnPrimaryLg:
    'hw-btn hw-btn-lg hw-btn-primary',
  btnPrimaryXl:
    'hw-btn hw-btn-xl hw-btn-primary',

  btnGhost:
    'hw-btn hw-btn-ghost',
  btnGhostSm:
    'hw-btn hw-btn-sm hw-btn-ghost',

  btnSubtle:
    'hw-btn hw-btn-subtle',
  btnSubtleSm:
    'hw-btn hw-btn-sm hw-btn-subtle',

  btnDanger:
    'hw-btn hw-btn-danger',
  btnDangerGhost:
    'hw-btn hw-btn-sm hw-btn-danger-ghost',
  btnDangerXs:
    'hw-btn hw-btn-xs hw-btn-danger-ghost',

  // ─── Surfaces ─────────────────────────────────────────────────────────
  card:
    'hw-card',
  cardHover:
    'hw-card hw-card-hover',
  cardInteractive:
    'hw-card hw-card-hover hw-card-interactive',

  // neutral section frame (replaces the rainbow per-section accent borders)
  sectionFrame:
    'hw-card-section rounded-xl p-4',
  // brand-accented frame for the ONE highlighted section per screen
  sectionAccent:
    'hw-card-accent rounded-xl p-4',

  // ─── Inputs ───────────────────────────────────────────────────────────
  input:
    'hw-input',
  textarea:
    'hw-textarea',

  // ─── Tabs ─────────────────────────────────────────────────────────────
  // Pill tabs (stage nav, top-level) — wrap in `.hw-tabs-pill` div
  tabPill:        'hw-tab-pill',
  tabPillActive:  'hw-tab-pill hw-tab-active',

  // Underline tabs (section content switchers) — wrap in `.hw-tabs-line` div
  tabActive: 'hw-tab-line hw-tab-active',
  tabIdle:   'hw-tab-line',

  // ─── Selectable cards ────────────────────────────────────────────────
  cardSelected:
    'hw-card hw-card-selected',
  cardUnselected:
    'hw-card hw-card-hover hw-card-interactive',

  // ─── Accent helpers ──────────────────────────────────────────────────
  accentText: 'text-emerald-600 dark:text-emerald-400',
  accentBg:   'bg-emerald-600',
  ring: 'focus:outline-none focus:ring-2 focus:ring-emerald-500/40',

} as const;

// ===========================================================================
//  Badge helpers
// ===========================================================================

const BADGE_STYLES: Record<BadgeVariant, string> = {
  brand:   'hw-badge hw-badge-brand',
  success: 'hw-badge hw-badge-success',
  warning: 'hw-badge hw-badge-warning',
  danger:  'hw-badge hw-badge-danger',
  info:    'hw-badge hw-badge-info',
  neutral: 'hw-badge hw-badge-neutral',
};

/** Pill badge classes for a semantic variant. */
export const badge = (variant: BadgeVariant = 'neutral'): string =>
  BADGE_STYLES[variant];

/** Severity → semantic badge (low=emerald, medium/high=amber, critical=rose). */
export const severityBadge = (sev: Severity): string => {
  const map: Record<Severity, BadgeVariant> = {
    low:      'success',
    medium:   'warning',
    high:     'warning',
    critical: 'danger',
  };
  return badge(map[sev]);
};

// ===========================================================================
//  Toast variants — Tornix-quality glass card, emerald-led
// ===========================================================================

export const TOAST_VARIANTS: Record<ToastVariant, ToastVariantStyle> = {
  success: {
    icon: '✅',
    bg: 'bg-white dark:bg-slate-800',
    border: 'border-emerald-300 dark:border-emerald-700',
    text: 'text-slate-800 dark:text-slate-100',
    accent: 'bg-emerald-500',
  },
  error: {
    icon: '❌',
    bg: 'bg-white dark:bg-slate-800',
    border: 'border-rose-300 dark:border-rose-700',
    text: 'text-slate-800 dark:text-slate-100',
    accent: 'bg-rose-500',
  },
  warning: {
    icon: '⚠️',
    bg: 'bg-white dark:bg-slate-800',
    border: 'border-amber-300 dark:border-amber-700',
    text: 'text-slate-800 dark:text-slate-100',
    accent: 'bg-amber-500',
  },
  info: {
    icon: 'ℹ️',
    bg: 'bg-white dark:bg-slate-800',
    border: 'border-sky-300 dark:border-sky-700',
    text: 'text-slate-800 dark:text-slate-100',
    accent: 'bg-sky-500',
  },
};
