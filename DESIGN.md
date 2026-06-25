---
name: Hawkamah · Ailigent.ai
description: Arabic-first precision instrument for institutional governance and competency assessment
colors:
  brand-teal: "#11A8BC"
  brand-teal-deep: "#0B8090"
  brand-blue: "#1E6FA8"
  ink: "#122A33"
  slate: "#5C7280"
  bg: "#F7FAFB"
  surface: "#FCFEFE"
  surface-sunk: "#EEF3F5"
  hairline: "#E3EAEE"
  success: "#1E9E6A"
  warning: "#C98A12"
  danger: "#D14343"
typography:
  display:
    fontFamily: "'Thmanyah Serif Display', 'Thmanyah Sans', 'Tajawal', serif"
    fontSize: "clamp(1.9rem, 4vw, 2.75rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "normal"
  headline:
    fontFamily: "'Thmanyah Sans', 'Tajawal', 'Inter', sans-serif"
    fontSize: "clamp(1.35rem, 2.4vw, 1.6rem)"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "'Thmanyah Sans', 'Tajawal', 'Inter', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "'Thmanyah Sans', 'Tajawal', 'Inter', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "'Thmanyah Sans', 'Tajawal', 'Inter', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.01em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
elevation:
  flat: "none"
  hairline: "inset 0 0 0 1px {colors.hairline}"
  raised: "0 1px 2px oklch(0.27 0.03 220 / 0.06), 0 4px 12px oklch(0.27 0.03 220 / 0.07)"
motion:
  duration-fast: "120ms"
  duration-base: "180ms"
  duration-slow: "260ms"
  ease-out: "cubic-bezier(0.22, 1, 0.36, 1)"
components:
  button-primary:
    backgroundColor: "{colors.brand-teal}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.brand-teal-deep}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px"
---

# Design System: Hawkamah · Ailigent.ai

## 1. Overview

**Creative North Star: "The Governance Instrument"**

Hawkamah is a precision instrument for institutional judgment, not a SaaS dashboard. The whole system should feel like a calibrated measuring tool an expert trusts: quiet, exact, legible, and confident. Authority comes from clarity and restraint, never from ornament. Most of the surface is tinted near-white with crisp hairline structure; color is rationed and meaningful. Arabic is the primary design target (RTL native, generous line-height, Thmanyah type carrying the voice), and English is an equal alternate, never a retrofit.

The system runs two registers on one visual language. Operator surfaces (Governance Center, Admin Hub) earn density and power: tight rows, hairline tables, fast interactions, information close together without clutter. Candidate surfaces (interviews, exams, surveys under live proctoring) soften that same language into calm and focus: one task at a time, clear progress, integrity signals that inform rather than threaten. The tokens are shared; only spacing rhythm and copy tone shift between the two.

It explicitly rejects the generic AI-Studio / SaaS-template look it shipped with, consumer "fun" AI styling (playful gradients, mascots, rounded-everything), Bootstrap-era HR dashboards, and any surveillance-state hostility in the proctoring UI. Integrity must read as fair and transparent.

**Key Characteristics:**
- Light theme everywhere; cool near-white grounds, tinted toward the brand hue.
- Restrained color: neutral-dominant with a single teal accent doing the work.
- Hairline-and-tonal structure over shadows and cards.
- Thmanyah type, Arabic-first, with serif display for occasional title weight.
- Fast, small, ease-out motion. Nothing decorative moves.

## 2. Colors: The Refined-Teal Instrument Palette

Restrained strategy: tinted neutrals carry the surface, one teal accent (kept under ~12% of any view) signals action and brand, status colors appear only for meaning. Canonical color space is OKLCH (the values below); the frontmatter carries sRGB hex for Stitch/tooling compatibility. Every neutral is tinted toward the brand hue (~220), never pure gray.

### Primary
- **Ailigent Teal** (`#11A8BC` / `oklch(0.70 0.11 210)`): the brand accent, taken from the logo's bright teal. Primary buttons, active states, links, focus rings, selected items, the "live/PROCTORED" pulse. Used sparingly so it always reads as "act here / this matters".
- **Teal Deep** (`#0B8090` / `oklch(0.56 0.09 210)`): hover and pressed states for teal actions; teal text on light surfaces where contrast needs to climb.

### Secondary
- **Ailigent Blue** (`#1E6FA8` / `oklch(0.55 0.10 245)`): the logo gradient's blue partner. Informational accents, secondary data series, links inside dense operator views, the brand gradient (teal to blue) reserved for the logo lockup and rare hero moments. Not a second "action" color.

### Neutral
- **Ink** (`#122A33` / `oklch(0.27 0.03 220)`): primary text and high-emphasis headings. A dark teal-slate, never `#000`.
- **Slate** (`#5C7280` / `oklch(0.54 0.02 225)`): secondary text, captions, labels, muted metadata. Echoes the logo's "liGENT" steel.
- **Background** (`#F7FAFB` / `oklch(0.98 0.004 220)`): the app canvas, a cool near-white.
- **Surface** (`#FCFEFE` / `oklch(0.995 0.002 220)`): panels, inputs, raised content. Differentiated from the canvas by tone, not by heavy shadow.
- **Surface Sunk** (`#EEF3F5` / `oklch(0.95 0.005 220)`): recessed zones, table header rows, code/scenario blocks, disabled fills.
- **Hairline** (`#E3EAEE` / `oklch(0.92 0.006 220)`): all borders, dividers, table grid lines, the primary structural device.

### Status (meaning only, never decoration)
- **Success / Clear** (`#1E9E6A` / `oklch(0.64 0.12 160)`): integrity >= 85, correct, passed.
- **Warning / Review** (`#C98A12` / `oklch(0.70 0.11 75)`): integrity >= 70, needs review.
- **Danger / Fail** (`#D14343` / `oklch(0.60 0.16 25)`): integrity < 70, proctor alerts, destructive actions. Always paired with an icon and text, never color alone.

## 3. Typography

Two families, both Thmanyah, loaded locally from `public/fonts/thmanyah/`. The fallback stack is `'Thmanyah Sans', 'Tajawal', 'Inter', sans-serif`. Hierarchy is built on scale and weight contrast (ratio >= 1.25 between steps), not on many sizes.

- **Display** (`Thmanyah Serif Display`, 700, `clamp(1.9rem, 4vw, 2.75rem)`): page-level titles and rare hero headings only. The serif gives the system its one note of editorial authority. Use sparingly; most screens lead with Headline.
- **Headline** (`Thmanyah Sans`, 700): section titles, screen headers, the question prompt in assessments.
- **Title** (`Thmanyah Sans`, 600): card and panel titles, answer options, form group headers.
- **Body** (`Thmanyah Sans`, 400, line-height 1.7): all prose, scenario text, answers. The generous line-height is required for Arabic legibility. Cap measure at 65-75ch.
- **Label** (`Thmanyah Sans`, 500, 0.8125rem, slight tracking): metadata, chips, table headers, eyebrow labels. Latin labels may uppercase; Arabic never does.

RTL is the default writing direction; use logical properties (`margin-inline`, `padding-inline`, `inset-inline`) throughout so the English (LTR) mode mirrors correctly.

## 4. Elevation

Precision-instrument means mostly flat. Depth is communicated through tonal layering (Background < Surface, with Surface Sunk recessed) and hairline borders, not stacked shadows. There is exactly one real shadow token, `raised`, reserved for elements that genuinely float above the page: popovers, dropdowns, the proctor alert banner, modals (used rarely). Cards do not get shadows; they get a hairline. Nested cards are banned. When something needs to separate from its surroundings, try (in order): tone, hairline, spacing, then finally `raised`.

## 5. Components

Component philosophy: **refined and exact**. Tight radii (`sm` 4px for inputs/chips, `md` 8px for buttons, `lg` 12px for panels), hairline borders, fast feedback, no bounce.

- **Button (primary)**: teal fill, surface-white text, `md` radius, `10px 20px` padding. Hover deepens to Teal Deep; focus shows a teal ring; active nudges 1px. The only filled-teal element in most views.
- **Button (ghost / secondary)**: transparent fill, hairline border, ink text. The default for non-primary actions so teal stays rare.
- **Input / Select / Textarea**: surface fill, hairline border, `md` radius, ink text, slate placeholder. Focus replaces the hairline with a teal border plus a soft teal ring. Errors use Danger border plus an icon and message.
- **Panel** (replaces "card"): surface fill, hairline border, `lg` radius, `xl` padding. Used only when grouping genuinely needs an edge; prefer plain spacing and hairlines otherwise. Never nest panels.
- **Table / data rows** (operator density): hairline row separators, Surface Sunk header row, comfortable but tight row height, right-aligned numerics, no zebra fills.
- **Integrity chip** (proctoring): pill, status-colored (Success/Warning/Danger by score band), with a small pulse dot when live. States: connecting, live + score, camera-only, ended.
- **Alert banner** (proctoring): the one place Danger goes prominent. Top-center, `raised`, Danger fill, names the violation and the question. Firm, not hostile; auto-dismisses.
- **Progress / stepper** (candidate flow): thin teal progress on hairline track; "Question N / total" always visible.
- **Logo lockup**: the Ailigent teal-to-blue gradient mark on light backgrounds. Place at `public/images/ailigent-logo.svg` (or `.png`); it is the only sanctioned use of the teal-to-blue gradient.

## 6. Do's and Don'ts

**Do**
- Let neutrals and hairlines carry structure; spend teal like it is expensive.
- Design Arabic-first with logical properties; verify both RTL and LTR.
- Keep operator screens dense but calm; keep candidate screens focused and reassuring.
- Pair every status color with an icon and text (accessibility and clarity).
- Use the serif display for occasional title weight, sans for everything functional.
- Keep motion fast, small, and ease-out; respect `prefers-reduced-motion`.

**Don't**
- No `#000` / `#fff`; no untinted grays.
- No side-stripe accent borders, gradient text, glassmorphism, or hero-metric template blocks.
- No identical card grids or nested cards; reach for cards last, not first.
- No decorative gradients; the teal-to-blue gradient is for the logo only.
- No modal as a first thought; exhaust inline and progressive alternatives.
- No surveillance-hostile proctoring UI; integrity informs, it does not threaten.
- No em dashes in UI copy.
