/** @type {import('tailwindcss').Config} */
// Build-time Tailwind. Class-based dark mode preserved.
//
// DESIGN SYSTEM v3 — "The Governance Instrument" (Ailigent.ai).
// The brand color moved from emerald → refined teal (logo: #11A8BC teal → #1E6FA8
// blue). Rather than rewrite 900+ `emerald-*` utilities across every screen, we
// remap the `emerald` ramp itself to the teal ramp here. Every existing
// `bg-emerald-600`, `text-emerald-600`, `border-emerald-200`, etc. recompiles to
// teal automatically — Tailwind-native, no `!important`.
//
// Semantic colors stay DISTINCT from brand (DESIGN.md §2): success = green,
// warning = amber, danger = red. Those ramps are left at Tailwind defaults so
// status never collides with the teal brand.
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './constants/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Thmanyah Sans'", "'Tajawal'", "'Inter'", 'sans-serif'],
        serif: ["'Thmanyah Serif Display'", "'Thmanyah Sans'", "'Tajawal'", 'serif'],
        display: ["'Thmanyah Serif Display'", "'Thmanyah Sans'", "'Tajawal'", 'serif'],
      },
      colors: {
        // Refined-teal ramp, anchored on the logo. 600 = brand teal (#11A8BC,
        // primary actions / active), 700 = teal-deep (#0B8090, hover / pressed).
        // The legacy `emerald-*` class names keep working but render teal.
        emerald: {
          50:  '#eef8fa',
          100: '#def2f6',
          200: '#bde4ec',
          300: '#94d6e1',
          400: '#65c6d3',
          500: '#3cb8c8',
          600: '#11a8bc',
          700: '#0b8090',
          800: '#0a6775',
          900: '#0b505c',
          950: '#072d35',
        },
        // First-class aliases so new code can name the brand directly.
        brand: {
          50:  '#eef8fa',
          100: '#def2f6',
          200: '#bde4ec',
          300: '#94d6e1',
          400: '#65c6d3',
          500: '#3cb8c8',
          600: '#11a8bc',
          700: '#0b8090',
          800: '#0a6775',
          900: '#0b505c',
          950: '#072d35',
          teal: '#11a8bc',
          'teal-deep': '#0b8090',
          blue: '#1e6fa8',
        },
        ink: '#122a33',
        hairline: '#e3eaee',
      },
    },
  },
  plugins: [],
};
