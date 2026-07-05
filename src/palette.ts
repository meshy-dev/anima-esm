// Default color palette for the figure framework. Every visual element the
// framework draws itself (caption pill, progress bar, buttons, export menu,
// opaque export background) reads from a palette. Pass a custom palette to
// <Figure palette={...}> to theme it; otherwise the default is used.

export type Palette = {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  ink: string;
  dim: string;
  muted: string;
  line: string;
  accent: string;
  accent2: string;
  accent3: string;
  good: string;
  bad: string;
  warn: string;
  x: string;
  y: string;
  z: string;
};

// Meshy design system (~/meshy-design-system), dark-mode tokens. Values copied
// from references/design-tokens.md — keep in sync if the design system changes.
// Keys not defined by the design system (accent3, x/y/z axes) reuse semantic
// highlights by the same visual principle (a 3rd warm accent; red/green/blue axes).
export const DEFAULT_PALETTE: Palette = {
  bg: "#0e0e0e",      // --color-bg-strong
  panel: "#181818",    // --color-bg-base
  panel2: "#1e1e1e",   // --color-bg-sub
  panel3: "#303030",   // --color-bg-shade
  ink: "#ffffff",      // --color-label-title
  dim: "#9b9b9b",      // --color-label-soft
  muted: "#696969",    // --color-label-muted
  line: "#ffffff1a",   // --color-bg-translucent-strong (10% white)
  accent: "#c5f955",   // --color-accent-base (lime)
  accent2: "#ff3e8f",  // --color-accent-support-base (pink)
  accent3: "#f5ad57",  // --color-semantic-warning-highlight (3rd accent)
  good: "#69ee77",     // --color-semantic-success-highlight
  bad: "#f55959",      // --color-semantic-error-highlight
  warn: "#f5ad57",     // --color-semantic-warning-highlight
  x: "#f55959",        // --color-semantic-error-highlight (axis red)
  y: "#69ee77",        // --color-semantic-success-highlight (axis green)
  z: "#6c99f2",        // --color-semantic-info-highlight (axis blue)
};
