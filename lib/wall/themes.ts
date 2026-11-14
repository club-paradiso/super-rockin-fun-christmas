import type { WallSceneConfig } from "./layout";

/**
 * Media-wall themes (D85). A theme is DATA: one bundled background picture and the numbers that
 * say where photos hang in it. The renderer (components/wall) never knows a theme by name; adding
 * one means a picture in public/wall/themes/ and an entry in config/wall-themes.ts.
 *
 * Pure: which theme is on the wall at a given moment is decided here from the staff setting
 * (`WallLook`) and the clock, on the server, so every display shows the same one.
 */

export interface WallTheme {
  id: string;
  /** Staff-facing name (Korean), as labelled in Figma. */
  name: string;
  /** One line for staff: what the scene is. */
  note: string;
  /** Where the picture comes from: the Figma frame, so a designer can find the source. */
  source: string;
  /**
   * `current`: a STUDIO SHALOM scene from Figma SS 03. `legacy`: the FOLLOW THE LIGHTS night
   * scene, kept selectable but never the default and never part of a rotation by default.
   */
  status: "current" | "legacy";
  /** 3840 × 1080, bundled (no request leaves the venue). */
  background: string;
  /** 640 × 180 thumbnail for the staff picker. */
  preview: string;
  /** Shown behind the picture while it loads, or if it fails to load: the static fallback. */
  fallbackColor: string;
  /** Whether the picture is light or dark where photos hang (picks the photo shadow). */
  tone: "light" | "dark";
  scene: WallSceneConfig;
  /** Low-spec mode shows only these slot indexes. */
  liteSlots: readonly number[];
  /**
   * How a photo is held. `clip`: a clip picture is drawn at the hang point (the line is in the
   * background picture, or drawn by `rope`). `in-picture`: the picture already has pegs at the
   * slot positions; nothing is drawn and the photo's top edge meets the peg.
   */
  hang: WallClip | { kind: "in-picture" };
  /** A twine line drawn by the app along `scene.line`, for pictures that have no line. */
  rope: { x1: number; x2: number; color: string; width: number } | null;
  /**
   * Widest box for a photo that is not a 1:3 strip (2×2, landscape frames). Never wider than the
   * slot spacing minus a gap, so neighbours cannot touch.
   */
  wideMax: number;
  /**
   * The STUDIO SHALOM wordmark as real text, where no photo can reach it: `x` is its centre, `y`
   * its top. `ink` / `cream` = the text colour on a calm part of the picture; `label` = ink on a
   * paper tag, for a picture with no calm spot. Null = the picture already carries the wordmark
   * (legacy scene).
   */
  wordmark: { x: number; y: number; size: number; tone: "ink" | "cream" | "label" } | null;
  /** Baseline of the "empty wall" line of text. */
  emptyTextY: number;
  /** Ambient animation. None of the current themes animate: a still picture is the design. */
  motion: "none";
}

/**
 * A clip picture and where it sits: drawn `width` × `height` scene px, centred on the hang point
 * at `centerX`, with the line `lineY` px below its top (for a peg, through its notch).
 */
export interface WallClip {
  kind: "clip";
  image: string;
  width: number;
  height: number;
  centerX: number;
  lineY: number;
}

/** How far a clip reaches above the line (scene px); 0 for a picture with its own pegs. */
export function clipReach(hang: WallTheme["hang"]): number {
  return hang.kind === "clip" ? hang.lineY : 0;
}

/** Staff setting: which theme, and whether the wall changes background by itself. */
export interface WallLook {
  theme: string;
  rotate: boolean;
  /** Minutes each background stays up while rotating. */
  rotateMinutes: number;
  /** The themes staff put in the rotation, in order. */
  rotation: string[];
}

export const ROTATE_MINUTES = { min: 5, max: 120, default: 15 } as const;

/**
 * Anything stored → a look the wall can use: unknown theme ids are dropped, an unknown active
 * theme becomes the default, minutes are clamped, and a rotation of fewer than two themes is off.
 */
export function normalizeLook(
  raw: unknown,
  themes: readonly WallTheme[],
  defaultId: string,
): WallLook {
  const known = new Set(themes.map((t) => t.id));
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const theme = typeof r.theme === "string" && known.has(r.theme) ? r.theme : defaultId;
  const rotation = [
    ...new Set(
      (Array.isArray(r.rotation) ? r.rotation : []).filter(
        (id): id is string => typeof id === "string" && known.has(id),
      ),
    ),
  ];
  const minutes = Number(r.rotateMinutes);
  const rotateMinutes = Number.isFinite(minutes)
    ? Math.min(ROTATE_MINUTES.max, Math.max(ROTATE_MINUTES.min, Math.round(minutes)))
    : ROTATE_MINUTES.default;
  return { theme, rotate: r.rotate === true && rotation.length >= 2, rotateMinutes, rotation };
}

/**
 * The theme on the wall at `nowMs`. Rotation is a function of the clock alone (which block of
 * `rotateMinutes` we are in), so every display, and a display that reloads, agrees.
 */
export function activeThemeId(look: WallLook, nowMs: number): string {
  if (!look.rotate || look.rotation.length < 2) return look.theme;
  const block = Math.floor(nowMs / (look.rotateMinutes * 60_000));
  return look.rotation[block % look.rotation.length]!;
}
