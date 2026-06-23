/** @type {import('tailwindcss').Config} */
// Build-time Tailwind (replaces the prior cdn.tailwindcss.com runtime JIT).
// Default theme + class-based dark mode — replicates the old inline
// `tailwind.config = { darkMode: 'class' }` exactly so appearance is unchanged.
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
    extend: {},
  },
  plugins: [],
};
