// ===========================================================================
//  Hawkamah Design System v2.0 — Tornix-quality tokens
//  Single source of truth for fonts, buttons, cards, inputs, badges, toasts.
//  Brand accent = Emerald (Ailigent green). Neutral = slate. Semantic only:
//  success=emerald · warning=amber · danger=rose · info=sky · neutral=slate.
//
//  CSS component classes (.hw-*) are defined in /index.css.
//  Tailwind CDN is used for layout only (flex, grid, gap, px, text-size, etc.)
//  Brand-visual classes MUST come from .hw-* to ensure consistent hover/shadow.
// ===========================================================================

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

/** Build the font-family CSS value used across the whole app. */
export const FONT_STACK = (font?: string): string =>
  `'${font || 'Alexandria'}', 'Tajawal', 'Inter', sans-serif`;

/**
 * Dynamic stylesheet body that forces the chosen webfont on every visual node.
 * Centralizes what used to be inline in App.tsx so all surfaces stay in sync.
 * Headings keep heavier weight + tighter tracking for a premium hierarchy.
 */
export const buildFontCss = (font?: string): string => {
  const chosen = font || 'Alexandria';
  return `
    body, button, input, select, textarea, p, span, h4, h5, h6, table, th, td, div:not(.font-mono) {
      font-family: '${chosen}', 'Tajawal', 'Inter', sans-serif !important;
    }
    /* Distinct heading face → real typographic hierarchy (independent of body font) */
    h1, h2, h3,
    .font-black, .font-extrabold {
      font-family: 'Alexandria', '${chosen}', 'Tajawal', sans-serif !important;
    }
    h1, h2, h3 { letter-spacing: -0.018em; line-height: 1.2; }
    h1 { font-weight: 800 !important; }
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
