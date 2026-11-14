import { PHONE_CARD, type WallSceneConfig } from "./layout";

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
  /**
   * The same picture cut for a screen of another shape (D91), e.g. a 2.4:1 board. The wall uses
   * whichever of the theme itself and these is closest to the screen's shape (`fitTheme`).
   */
  variants?: readonly WallThemeLook[];
}

/** What changes when the same theme is cut for another screen shape. */
export type WallThemeLook = Pick<
  WallTheme,
  "background" | "scene" | "liteSlots" | "rope" | "wideMax" | "wordmark" | "emptyTextY"
>;

/**
 * How a variant picture relates to the theme's own picture: a point (x, y) of the theme's
 * picture is at (scale · x − left, scale · (y + top)) in the variant (the variant shows `top` more
 * of the original above, and starts `left` pixels further right).
 */
export interface Recut {
  background: string;
  width: number;
  height: number;
  scale: number;
  left: number;
  top: number;
  /**
   * Where photos hang, in the theme's own picture (before the cut). Default: the theme's slots.
   * Only those whose widest photo stays inside the variant picture are kept.
   */
  slots?: readonly { x: number; tilt: number }[];
}

/**
 * The theme's numbers carried into a recut picture (D91). Pure arithmetic on numbers measured
 * once in Figma: nothing is measured again, so a variant keeps the designer's placement.
 * Photos keep their pixel size (strip, wideMax, phone card); the line, the slots, the wordmark
 * and the empty-wall text move with the picture.
 */
export function recutTheme(theme: WallTheme, cut: Recut): WallThemeLook {
  const { scale, left, top } = cut;
  const x = (v: number) => scale * v - left;
  const y = (v: number) => scale * (v + top);
  const half = Math.max(theme.wideMax, PHONE_CARD.width, theme.scene.strip.width) / 2;
  const slots = (cut.slots ?? theme.scene.slots)
    .map((s) => ({ x: Math.round(x(s.x)), tilt: s.tilt }))
    .filter((s) => s.x - half > 0 && s.x + half < cut.width);
  // Low-spec mode shows at most four: of five, drop the middle one, as the themes do.
  const all = slots.map((_, i) => i);
  const liteSlots = all.length === 5 ? [0, 1, 3, 4] : all.slice(0, 4);
  return {
    background: cut.background,
    scene: {
      width: cut.width,
      height: cut.height,
      line: {
        midX: x(theme.scene.line.midX),
        y0: y(theme.scene.line.y0),
        curve: theme.scene.line.curve / scale,
      },
      strip: theme.scene.strip,
      slots,
    },
    liteSlots,
    rope: theme.rope && {
      ...theme.rope,
      x1: Math.max(0, x(theme.rope.x1)),
      x2: Math.min(cut.width, x(theme.rope.x2)),
    },
    wideMax: theme.wideMax,
    wordmark: theme.wordmark && {
      ...theme.wordmark,
      x: Math.round(x(theme.wordmark.x)),
      y: Math.round(y(theme.wordmark.y)),
    },
    emptyTextY: Math.round(y(theme.emptyTextY)),
  };
}

/**
 * The theme cut for a screen of this shape (width / height): the theme itself or the variant
 * whose picture is closest in shape (by ratio, so 2:1 is as far from 4:1 as 4:1 from 8:1). The
 * scene is still fitted without stretching (D65); this only makes the bands as small as the
 * pictures allow. Null or no variants → the theme as it is.
 */
export function fitTheme(theme: WallTheme, aspect: number | null | undefined): WallTheme {
  if (!aspect || !(aspect > 0) || !theme.variants?.length) return theme;
  const off = (l: WallThemeLook) => Math.abs(Math.log(l.scene.width / l.scene.height / aspect));
  let best: WallThemeLook = theme;
  for (const v of theme.variants) if (off(v) < off(best)) best = v;
  return best === theme ? theme : { ...theme, ...best };
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
  /** Seconds one photo stays fully on the wall before it leaves (D92). */
  showSeconds: number;
  /**
   * Half-life of a photo's share of the wall, in minutes since it was taken (D92): every
   * half-life, it comes up half as often. 0 = off, every photo gets the same share.
   */
  halfLifeMinutes: number;
}

export const ROTATE_MINUTES = { min: 5, max: 120, default: 15 } as const;
export const SHOW_SECONDS = { min: 5, max: 120, default: 14 } as const;
export const HALF_LIFE_MINUTES = { min: 0, max: 1440, default: 0 } as const;

const clampInt = (raw: unknown, r: { min: number; max: number; default: number }) => {
  const n = Number(raw);
  return raw === null || raw === undefined || raw === "" || !Number.isFinite(n)
    ? r.default
    : Math.min(r.max, Math.max(r.min, Math.round(n)));
};

/**
 * Anything stored → a look the wall can use: unknown theme ids are dropped, an unknown active
 * theme becomes the default, minutes are clamped, and a rotation of fewer than two themes is off.
 * A look stored before D92 has no pace: it gets the defaults (14 s, half-life off).
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
  return {
    theme,
    rotate: r.rotate === true && rotation.length >= 2,
    rotateMinutes,
    rotation,
    showSeconds: clampInt(r.showSeconds, SHOW_SECONDS),
    halfLifeMinutes: clampInt(r.halfLifeMinutes, HALF_LIFE_MINUTES),
  };
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
