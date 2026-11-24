import { PHONE_CARD, wallLayout, type Rect, type SceneLayout, type SlotPlace } from "./layout";
import { WALL_LIGHT, clipReach, type WallTheme, type WallThemeLook } from "./themes";

/**
 * Screen-adaptive fit for the media wall (D110). The scene is still never stretched (D65), but
 * instead of fitting the WHOLE picture into the screen (bands whenever the shapes differ), the wall
 * fits what matters, the hung photos and the wordmark, and lets the picture fill the rest of the
 * screen, cropping only scenery. Pure: the same screen always gets the same plan.
 *
 * For every cut of the theme (the theme and its D91 variants) and every run of neighbouring slots,
 * the planner works out how large the photos could hang on this screen and keeps the plan that puts
 * the most photo area on screen. A 16:9 TV therefore hangs fewer, larger photos than a 32:9 LED;
 * a portrait screen hangs two. What the picture cannot cover (only when the photos need more room
 * than a cover crop leaves) is filled by the renderer with a soft, blurred copy of the same picture.
 */
export const WALL_FIT = {
  /** Fewest photos a screen hangs (when the theme has that many slots). */
  minSlots: 2,
  /** Room kept between the photos and the screen edge, as a share of the screen's short side. */
  margin: 0.03,
  /** Swing of a photo while it settles (wall-hang keyframes peak at 9°): it must stay on screen. */
  swingDeg: 9,
  /**
   * The plan on screen keeps winning unless another is this much better, so a window being resized
   * does not flip between two near-equal plans (each flip restarts the photo rotation).
   */
  stickiness: 1.08,
  /**
   * The logo (public/frames/v2/logo-*.svg, 170 × 40): width per unit of height, and the paper
   * tag's padding around it for a `label` theme, as a share of the logo's height.
   */
  logo: { aspect: 170 / 40, labelPad: { x: 0.5, y: 0.3 } },
  /**
   * Bands cost: score × coverage^bandWeight (coverage = share of the screen the picture covers).
   */
  bandWeight: 4,
  /**
   * Cropping the designer's picture costs: score × shown^cropWeight (shown = share of the picture
   * on screen). This is what makes a cut drawn for this shape (D91) win at that shape.
   */
  cropWeight: 1.2,
  /**
   * How much each extra photo counts against size: score = photos^slotWeight · scale². 1 would be
   * plain photo area (fewer, larger photos win too easily); more keeps more guests on the wall.
   */
  slotWeight: 1.5,
  /**
   * When covering the screen needs at most this much more than the margin allows, the margin
   * gives way (the photos still fit inside the screen): a hairline band is worse than a tighter edge.
   */
  snap: 1.06,
} as const;

export interface FitScreen {
  width: number;
  height: number;
}

export interface WallFitPlan {
  /** Stable id of the plan: cut + slots. */
  key: string;
  /** The theme as cut for this screen (the theme itself or one of its variants). */
  theme: WallTheme;
  /** -1 = the theme's own picture, else the index in `variants`. */
  cut: number;
  /** Slot indexes of `theme.scene.slots` that hang photos, left to right. */
  slotIndexes: number[];
  layout: SceneLayout;
  /** Screen px per scene px. */
  scale: number;
  /** Where the scene's top-left corner lands on screen. */
  offset: { x: number; y: number };
  /** What must stay visible (photos at full swing, wordmark), in scene px. */
  safe: Rect;
  /**
   * The logo's box in scene px (label padding included), centred on the screen: top centre of
   * what the wall shows, never outside the picture. Null for a theme without one.
   */
  mark: Rect | null;
  /** The part of the scene that is on screen, in scene px. */
  visible: Rect;
  /** Screen px the picture leaves uncovered on each side (the renderer fills them). */
  bands: { left: number; right: number; top: number; bottom: number };
  /** Share of the screen the picture covers (1 = no band). */
  coverage: number;
}

const union = (rects: Rect[]): Rect => {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};

/**
 * Everything one slot can ever cover: the widest photo it may hold (strip, 2×2 / landscape frame,
 * phone card), the clip above the line, the tilt and the settling swing about the clip, and the
 * shadow, which falls down and to the right (WALL_LIGHT).
 */
export function slotEnvelope(place: SlotPlace, theme: WallTheme, lite = false): Rect {
  const { strip } = theme.scene;
  const width = Math.max(theme.wideMax, PHONE_CARD.width, strip.width);
  const phoneHeight = PHONE_CARD.margin + PHONE_CARD.photoHeight + PHONE_CARD.caption;
  const below = strip.drop + Math.max(strip.height, phoneHeight);
  const swing = ((Math.abs(place.tilt) + (lite ? 0 : WALL_FIT.swingDeg)) * Math.PI) / 180;
  // A box hanging from its top centre, turned by `swing`: its bottom corners reach this far out.
  const reach = (width / 2) * Math.cos(swing) + below * Math.sin(swing);
  const { x: sx, y: sy, blur } = WALL_LIGHT.photo;
  const top = place.y - Math.max(clipReach(theme.hang), 24);
  return {
    x: place.x - reach,
    y: top,
    width: 2 * reach + sx + blur,
    height: place.y + below + sy + blur - top,
  };
}

/**
 * The logo's box (scene px), label padding included, centred on `centerX` (default: the theme's
 * own `x`).
 */
export function wordmarkBox(theme: WallTheme, centerX?: number): Rect | null {
  const mark = theme.wordmark;
  if (!mark) return null;
  const { aspect, labelPad } = WALL_FIT.logo;
  const pad = mark.tone === "label" ? labelPad : { x: 0, y: 0 };
  const width = mark.size * (aspect + 2 * pad.x);
  const height = mark.size * (1 + 2 * pad.y);
  return { x: (centerX ?? mark.x) - width / 2, y: mark.y - mark.size * pad.y, width, height };
}

/** The theme and each of its cuts (D91), as full themes. */
export function themeCuts(theme: WallTheme): { cut: number; theme: WallTheme }[] {
  return [
    { cut: -1, theme },
    ...(theme.variants ?? []).map((v: WallThemeLook, i) => ({
      cut: i,
      theme: { ...theme, ...v },
    })),
  ];
}

/** Runs of `size` neighbouring slots out of `allowed` (indexes, left to right). */
function runs(allowed: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + size <= allowed.length; i++) out.push(allowed.slice(i, i + size));
  return out;
}

/** The plan for one cut and one set of slots on this screen. */
function planFor(
  theme: WallTheme,
  cut: number,
  slotIndexes: number[],
  screen: FitScreen,
  lite: boolean,
): WallFitPlan {
  const { width: W, height: H } = screen;
  const scene = theme.scene;
  const layout = wallLayout(scene, slotIndexes);
  const photos = union(layout.slots.map((p) => slotEnvelope(p, theme, lite)));
  // The logo goes to the top centre of the screen; what matters is centred on screen, so it is
  // planned above the middle of the photos.
  const planned = wordmarkBox(theme, photos.x + photos.width / 2);
  const safe = union([photos, ...(planned ? [planned] : [])]);

  const m = WALL_FIT.margin * Math.min(W, H);
  const fit = Math.min((W - 2 * m) / safe.width, (H - 2 * m) / safe.height);
  const contain = Math.min(W / scene.width, H / scene.height);
  const cover = Math.max(W / scene.width, H / scene.height);
  // Never zoomed past covering the screen: beyond that the photos would only grow by cropping the
  // designer's scenery (and blowing up the picture's pixels).
  const tight = Math.min(W / safe.width, H / safe.height);
  const snaps = cover <= fit * WALL_FIT.snap && cover <= tight;
  const scale = snaps ? cover : Math.min(Math.max(fit, contain), cover);

  // Centre what matters; then slide so the picture covers every edge it can reach.
  const place = (screenLen: number, sceneLen: number, safeStart: number, safeLen: number) => {
    const drawn = sceneLen * scale;
    if (drawn <= screenLen) return (screenLen - drawn) / 2;
    const centred = screenLen / 2 - scale * (safeStart + safeLen / 2);
    return Math.min(0, Math.max(screenLen - drawn, centred));
  };
  const x = place(W, scene.width, safe.x, safe.width);
  const y = place(H, scene.height, safe.y, safe.height);

  const drawnW = scene.width * scale;
  const drawnH = scene.height * scale;
  const bands = {
    left: Math.max(0, x),
    right: Math.max(0, W - (x + drawnW)),
    top: Math.max(0, y),
    bottom: Math.max(0, H - (y + drawnH)),
  };
  const coverage = (Math.min(W, drawnW) * Math.min(H, drawnH)) / (W * H);
  const vx = Math.max(0, -x / scale);
  const vy = Math.max(0, -y / scale);
  // Top centre of the screen, kept inside the picture (only matters next to a band).
  let mark: Rect | null = null;
  if (planned) {
    const half = planned.width / 2;
    const centre = Math.min(Math.max((W / 2 - x) / scale, half), scene.width - half);
    mark = { ...planned, x: centre - half };
  }
  return {
    key: `${cut}:${slotIndexes.join(",")}`,
    theme,
    cut,
    slotIndexes,
    layout,
    scale,
    offset: { x, y },
    safe,
    mark,
    visible: {
      x: vx,
      y: vy,
      width: Math.min(scene.width - vx, W / scale),
      height: Math.min(scene.height - vy, H / scale),
    },
    bands,
    coverage,
  };
}

/** How good a plan is: photos and their size, against bands and against cropping the picture. */
function score(plan: WallFitPlan): number {
  const k = plan.slotIndexes.length;
  const { scene } = plan.theme;
  const shown = (plan.visible.width * plan.visible.height) / (scene.width * scene.height);
  return (
    k ** WALL_FIT.slotWeight *
    plan.scale ** 2 *
    plan.coverage ** WALL_FIT.bandWeight *
    shown ** WALL_FIT.cropWeight
  );
}

/**
 * The best plan for this theme on this screen. `prefer` is the key of the plan on screen now: it
 * wins near-ties (`WALL_FIT.stickiness`). Ties then go to more photos, then to the theme's own cut,
 * then to the run closest to the middle of the picture. Null for a screen with no size.
 */
export function planWallFit(
  theme: WallTheme,
  screen: FitScreen,
  { lite = false, prefer = null }: { lite?: boolean; prefer?: string | null } = {},
): WallFitPlan | null {
  const W = screen.width;
  const H = screen.height;
  if (!(W > 0) || !(H > 0)) return null;
  const s: FitScreen = { width: W, height: H };

  let best: { plan: WallFitPlan; value: number; tie: number[] } | null = null;
  for (const { cut, theme: look } of themeCuts(theme)) {
    const all = look.scene.slots.map((_, i) => i);
    const allowed = lite ? look.liteSlots.filter((i) => i < all.length) : all;
    if (!allowed.length) continue;
    const fewest = Math.min(WALL_FIT.minSlots, allowed.length);
    for (let size = allowed.length; size >= fewest; size--) {
      for (const run of runs(allowed, size)) {
        const plan = planFor(look, cut, run, s, lite);
        let value = score(plan);
        if (prefer && plan.key === prefer) value *= WALL_FIT.stickiness;
        const mid = (plan.safe.x + plan.safe.width / 2) / look.scene.width;
        // Higher is better, compared in order after `value`.
        const tie = [size, cut === -1 ? 1 : 0, -Math.abs(mid - 0.5)];
        const better =
          !best ||
          value > best.value * (1 + 1e-9) ||
          (Math.abs(value - best.value) <= best.value * 1e-9 && compare(tie, best.tie) > 0);
        if (better) best = { plan, value, tie };
      }
    }
  }
  return best?.plan ?? null;
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};
