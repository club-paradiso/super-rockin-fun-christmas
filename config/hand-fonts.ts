/**
 * The ten handwriting fonts for "Christmas Village '26" on the film 4컷 and polaroid 1컷 frames
 * (Figma component set 895:1405 「Hand/손글씨 랜덤 10종」, the source of truth). Every font is
 * bundled with the app (@fontsource, OFL-1.1 or Apache-2.0), so the booth draws it offline.
 *
 * Sizes and strokes are for a 600 px wide frame, chosen in Figma so the text is about 360 px wide
 * in every font. The stroke is drawn in the text colour (a thicker pen for the thin fonts).
 */
export interface HandFont {
  /** Stored with the session; never shown to a guest. */
  id: string;
  /** The number of the variant in the Figma component set (글씨체=N). */
  figma: number;
  family: string;
  weight: 400 | 700;
  size: number;
  stroke: number;
}

export const HAND_TEXT = "Christmas Village '26";

export const HAND_FONTS: readonly HandFont[] = [
  { id: "caveat", figma: 1, family: "Caveat", weight: 700, size: 49, stroke: 0 },
  {
    id: "nothing-you-could-do",
    figma: 3,
    family: "Nothing You Could Do",
    weight: 400,
    size: 37,
    stroke: 1.4,
  },
  { id: "reenie-beanie", figma: 4, family: "Reenie Beanie", weight: 400, size: 51, stroke: 1.1 },
  {
    id: "permanent-marker",
    figma: 13,
    family: "Permanent Marker",
    weight: 400,
    size: 34,
    stroke: 0,
  },
  {
    id: "gloria-hallelujah",
    figma: 15,
    family: "Gloria Hallelujah",
    weight: 400,
    size: 36,
    stroke: 0,
  },
  { id: "square-peg", figma: 20, family: "Square Peg", weight: 400, size: 63, stroke: 0.9 },
  { id: "rock-salt", figma: 25, family: "Rock Salt", weight: 400, size: 27, stroke: 0.7 },
  {
    id: "shadows-into-light",
    figma: 26,
    family: "Shadows Into Light",
    weight: 400,
    size: 47,
    stroke: 0.6,
  },
  {
    id: "covered-by-your-grace",
    figma: 27,
    family: "Covered By Your Grace",
    weight: 400,
    size: 48,
    stroke: 0,
  },
  { id: "give-you-glory", figma: 31, family: "Give You Glory", weight: 400, size: 40, stroke: 1.2 },
];

/** The option-screen preview shows the next font this often (ms). */
export const HAND_PREVIEW_MS = 1200;

/** The date stamp of the polaroid 3컷 frame (Figma 836:1681, orange VT323). */
export const STAMP_FONT = "VT323";

export function getHandFont(id: string | null | undefined): HandFont | null {
  return HAND_FONTS.find((f) => f.id === id) ?? null;
}

/**
 * One of the ten, never the one the previous session had. `random` is in [0, 1): the reducer
 * receives it in the action so the choice stays a pure, testable function.
 */
export function pickHandFont(previous: string | null, random: number): HandFont {
  const pool = HAND_FONTS.filter((f) => f.id !== previous);
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 0.999999) : 0;
  return pool[Math.floor(r * pool.length)]!;
}
