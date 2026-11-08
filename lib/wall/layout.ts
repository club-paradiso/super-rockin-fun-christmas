/**
 * The wall scene as numbers: the Figma background (window, line, wordmark) and the five places a
 * strip hangs (config/wall.ts `scene`). Pure, so tests can check every slot against the picture.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WallSceneConfig {
  width: number;
  height: number;
  line: { midX: number; y0: number; curve: number };
  strip: { width: number; height: number; drop: number };
  slots: readonly { x: number; tilt: number }[];
}

export interface SlotPlace {
  /** Clip position on the line (top centre of the strip). */
  x: number;
  y: number;
  /** Tilt in degrees, around the clip. */
  tilt: number;
  /** Box the photo is fitted into (object-contain), hanging below the clip. */
  box: Rect;
}

export interface SceneLayout {
  width: number;
  height: number;
  slots: SlotPlace[];
}

/** Height of the line at x (the Figma curve: highest in the middle, dipping to the sides). */
export function lineYAt(line: WallSceneConfig["line"], x: number): number {
  return line.y0 - line.curve * (x - line.midX) ** 2;
}

/** Every slot, or only `only` (low-spec mode), in left-to-right order. */
export function wallLayout(scene: WallSceneConfig, only?: readonly number[]): SceneLayout {
  const { strip } = scene;
  const slots = scene.slots
    .filter((_, i) => !only || only.includes(i))
    .map(({ x, tilt }) => {
      const y = lineYAt(scene.line, x);
      return {
        x,
        y,
        tilt,
        box: {
          x: x - strip.width / 2,
          y: y + strip.drop,
          width: strip.width,
          height: strip.height,
        },
      };
    });
  return { width: scene.width, height: scene.height, slots };
}

/** "3840x1080" → {width, height}; null for anything else (sizes 320–16384 px). */
export function parseCanvas(raw: string | null | undefined) {
  const m = /^\s*(\d{3,5})\s*[xX×]\s*(\d{3,5})\s*$/.exec(raw ?? "");
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const ok = (n: number) => n >= 320 && n <= 16384;
  return ok(width) && ok(height) ? { width, height } : null;
}

/**
 * A guest's own phone photo (D66) hangs as a card, not a strip: a 1:3 strip box would shrink a
 * landscape phone photo to a stamp. The card is centred on the same clip, wider than a strip and
 * no taller, so it never reaches a neighbour (slots are ≥ 510 px apart in the Figma scene) and
 * stays inside the scene. The photo is fitted inside (never cropped: the guest chose the crop).
 */
export const PHONE_CARD = { width: 340, photoHeight: 380, margin: 16, caption: 46 } as const;

export function phoneCardBox(place: SlotPlace): Rect {
  const height = PHONE_CARD.margin + PHONE_CARD.photoHeight + PHONE_CARD.caption;
  return { x: place.x - PHONE_CARD.width / 2, y: place.box.y, width: PHONE_CARD.width, height };
}
