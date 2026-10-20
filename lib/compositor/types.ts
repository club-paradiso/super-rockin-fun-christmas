/**
 * Data-driven frame definitions. A frame is pure data: the compositor knows how to draw
 * every field here, and nothing about any particular frame is hard-coded in code.
 */

export type Color = string;

export type FrameBackground =
  | { type: "solid"; color: Color }
  /** Top-to-bottom linear fill. Keep it subtle — this is a quiet night, not a poster. */
  | { type: "vertical"; stops: { offset: number; color: Color }[] };

/** Turn by `deg` degrees (clockwise) around `pivot`, or around the shape's own centre. */
export interface Rotation {
  deg: number;
  pivot?: { x: number; y: number };
}

export interface FrameSlot {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  border?: { color: Color; width: number };
  rotation?: Rotation;
}

export type FrameDecoration =
  | {
      type: "text";
      /** Supports the `{date}` token, filled from ComposeContext.dateLabel. */
      text: string;
      x: number;
      y: number;
      size: number;
      color: Color;
      weight?: 400 | 500 | 600 | 700 | 800;
      align?: "left" | "center" | "right";
      letterSpacing?: number;
    }
  | {
      /** A scatter of small stars, placed with a seeded PRNG so output is deterministic. */
      type: "stars";
      seed: number;
      count: number;
      area: { x: number; y: number; width: number; height: number };
      color: Color;
      minRadius: number;
      maxRadius: number;
    }
  | {
      /** A strand of warm bulbs along a straight line. */
      type: "lights";
      from: { x: number; y: number };
      to: { x: number; y: number };
      count: number;
      radius: number;
      colors: Color[];
      wire?: Color;
    }
  | {
      type: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      color: Color;
      /** Top-to-bottom fill across the rectangle; overrides `color`. */
      stops?: { offset: number; color: Color }[];
      radius?: number;
      rotation?: Rotation;
      shadow?: { color: Color; blur: number; offsetY: number };
    }
  | {
      /**
       * A bundled asset (same origin, so it works offline), drawn at this box. Decorations
       * exported from the Figma file (wordmarks, script titles, sparkles) are SVGs under
       * public/frames/. The kiosk loads them before composing (lib/compositor/assets.ts).
       */
      type: "image";
      src: string;
      x: number;
      y: number;
      width: number;
      height: number;
      opacity?: number;
      /** The event wordmark. Checked for size, position and contrast (tests/unit/frames). */
      brand?: { color: Color; on: Color };
    }
  | {
      /**
       * Draw photo `slot` here. A frame that lists photo layers controls the stacking itself
       * (a clothesline crossing the photo above it); without them every photo is drawn first.
       */
      type: "photo";
      slot: number;
    };

export interface FrameDefinition {
  id: string;
  name: string;
  /** Short Korean label shown on the kiosk frame picker. */
  label: string;
  outputWidth: number;
  outputHeight: number;
  background: FrameBackground;
  slots: FrameSlot[];
  /**
   * Drawn in order after the background. Photos go first unless the list places them itself
   * with `photo` layers (then every slot appears exactly once).
   */
  decorations: FrameDecoration[];
}

/** Minimal image description the compositor needs. */
export interface ComposeImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface ComposeContext {
  dateLabel: string;
  /** Loaded `image` decorations by src. A missing one is skipped, never guessed. */
  assets?: ReadonlyMap<string, ComposeImage>;
}
