@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body { @apply text - slate - 800 antialiased; }
}
@layer components {
  .card { @apply bg - white rounded - xl border border - slate - 200 shadow - sm; }
  .btn { @apply inline - flex items - center justify - center gap - 2 rounded - lg px - 3.5 py - 2 text - sm font - medium transition disabled: opacity - 50 disabled: cursor - not - allowed whitespace - nowrap; }
  .btn - primary { @apply btn bg - brand - 600 text - white hover: bg - brand - 700 shadow - sm; }
  .btn - secondary { @apply btn bg - white text - slate - 700 border border - slate - 300 hover: bg - slate - 50; }
  .btn - danger { @apply btn bg - red - 600 text - white hover: bg - red - 700; }
  .btn - ghost { @apply btn text - slate - 600 hover: bg - slate - 100; }
  .btn - sm { @apply px - 2.5 py - 1.5 text - xs; }
  .input { @apply w - full rounded - lg border border - slate - 300 bg - white px - 3 py - 2 text - sm placeholder: text - slate - 400 focus: border - brand - 500 focus: outline - none focus: ring - 2 focus: ring - brand - 100; }
  .label { @apply block text - xs font - semibold text - slate - 600 mb - 1; }
  .th { @apply px - 4 py - 3 text - left text - xs font - semibold uppercase tracking - wide text - slate - 500 bg - slate - 50 whitespace - nowrap; }
  .td { @apply px - 4 py - 3 text - sm text - slate - 700 whitespace - nowrap; }
}
