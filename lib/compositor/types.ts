/**
 * Data-driven frame definitions. A frame is pure data: the compositor knows how to draw
 * every field here, and nothing about any particular frame is hard-coded in code.
 */

export type Color = string;

export type FrameBackground =
  | { type: "solid"; color: Color }
  /** Top-to-bottom linear fill. Keep it subtle — this is a quiet night, not a poster. */
  | { type: "vertical"; stops: { offset: number; color: Color }[] };

export interface FrameSlot {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  border?: { color: Color; width: number };
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
      radius?: number;
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
  /** Drawn after the photos, in order. */
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
}
