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

export const DEFAULT_PALETTE: Palette = {
  bg: "#0b0b12",
  panel: "#14141e",
  panel2: "#1b1b28",
  panel3: "#222234",
  ink: "#e9e9f2",
  dim: "#9a9ab4",
  muted: "#62627a",
  line: "rgba(255,255,255,.10)",
  accent: "#5ad1ff",
  accent2: "#b98bff",
  accent3: "#ffcf6a",
  good: "#6fe3a3",
  bad: "#ff7a7a",
  warn: "#ffbf6a",
  x: "#ff8a9a",
  y: "#7fe3a0",
  z: "#6ab8ff",
};
