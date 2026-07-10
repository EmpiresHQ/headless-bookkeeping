/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens (spec 2026-07-08-spa-ux-redesign-design.md).
        // Dark theme later = swap these values; never hardcode hex in components.
        bg: '#F2F3F1',
        surface: '#FFFFFF',
        ink: { DEFAULT: '#191C1A', 2: '#6E756F', 3: '#8A9089' },
        line: '#EEF0EC',
        accent: { DEFAULT: '#0E5A3C', deep: '#0E3B2C' },
        signal: '#3DDC97',
        ok: { DEFAULT: '#14713F', bg: '#E3F2E9' },
        warn: { DEFAULT: '#8A5A00', bg: '#FDF0D3', deep: '#6D4A05' },
        err: { DEFAULT: '#A83A2C', bg: '#FBE9E5' },
        alert: '#E8590C',
        // Promoted one-offs (Plan 06 Task 2 — previously sanctioned inline):
        tint: '#E3EFE8', // accent-tinted wash: accent chips, icon tiles
        fill: '#E9EBE7', // neutral control fill: secondary buttons, search field
        track: '#E5E7E3', // segmented-control track
        chevron: '#C2C7C1', // disclosure chevrons, checkbox borders
        handle: '#D4D7D1', // sheet drag handle
      },
    },
  },
  plugins: [],
};
