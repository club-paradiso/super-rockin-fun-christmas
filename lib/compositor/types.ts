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
  /**
   * The photo's outline inside this box. "ellipse" clips to the inscribed ellipse (Figma
   * `📷 SAGE OVAL`, the lace frame). Default "rect".
   */
  shape?: "rect" | "ellipse";
  /**
   * A shadow cast onto the photo from its own edge (Figma INNER_SHADOW: the polaroid's window).
   * `blur` and `offsetY` are in frame units, as Figma gives them.
   */
  innerShadow?: { color: Color; blur: number; offsetY: number };
}

/**
 * A colour treatment applied to the guest's photo itself (the camera always shoots in colour).
 * Done with per-pixel arithmetic (lib/compositor/tone.ts), never `ctx.filter`, so the iPad mini 4
 * (Safari 15), the preview, the saved file and the wall copy all get the same pixels.
 */
export type PhotoTone = "mono" | "sepia" | "flash" | "film";

export type FrameDecoration =
  | {
      type: "text";
      /**
       * Supports the `{date}` token (ComposeContext.dateLabel) and `{stamp}` (the shooting day as
       * `'YY MM DD`, ComposeContext.stampLabel).
       */
      text: string;
      x: number;
      y: number;
      size: number;
      color: Color;
      weight?: 400 | 500 | 600 | 700 | 800;
      align?: "left" | "center" | "right";
      letterSpacing?: number;
      /** A bundled family other than the brand font (it must be in lib/compositor/fonts.ts). */
      font?: string;
      /** "middle": `y` is the vertical centre of the text box (Figma text layers). */
      baseline?: "alphabetic" | "middle";
      rotation?: Rotation;
      /** A soft halo in the text colour family (the polaroid date stamp). */
      glow?: { color: Color; blur: number };
    }
  | {
      /**
       * "Christmas Village '26" in one of the ten handwriting fonts (config/hand-fonts.ts). The
       * font is chosen per session (ComposeContext.handFont); the heart and the underline follow
       * the measured width of the text (Figma 895:1405, 880:1717, 877:1664).
       */
      type: "hand";
      text: string;
      /** Top-left of the Figma text layer, and its rotation about that corner. */
      x: number;
      y: number;
      deg: number;
      /** The text box height in Figma: the text is centred on half of it. */
      boxHeight: number;
      /** Font sizes in config/hand-fonts.ts are for a 600 px wide frame; this multiplies them. */
      scale: number;
      color: Color;
      /**
       * Hand-drawn heart: its layer's top-left is (`dx` after the end of the text, `dy`) in the
       * text's own axes; `deg` is its own clockwise turn on the frame; `pad` is the SVG's stroke
       * margin around the layer.
       */
      heart?: {
        src: string;
        dx: number;
        dy: number;
        padX: number;
        padY: number;
        width: number;
        height: number;
        deg: number;
      };
      /**
       * Hand-drawn underline, level on the frame (not turned with the text): it starts at (`dx`,
       * `dy`) in the text's axes and ends `trimEnd` before the end of the text.
       */
      underline?: {
        src: string;
        dx: number;
        dy: number;
        trimEnd: number;
        padX: number;
        padY: number;
        height: number;
      };
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
      rotation?: Rotation;
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
  /** The same label for the English booth screens. */
  labelEn: string;
  /** The same label for the Chinese (Simplified) booth screens (D89). */
  labelZh: string;
  outputWidth: number;
  outputHeight: number;
  background: FrameBackground;
  slots: FrameSlot[];
  /**
   * Drawn in order after the background. Photos go first unless the list places them itself
   * with `photo` layers (then every slot appears exactly once).
   */
  decorations: FrameDecoration[];
  /** Colour treatment of every photo in this frame (film 3컷: 흑백 or 세피아; polaroid 3컷: 플래시). */
  photoTone?: PhotoTone;
}

/** Minimal image description the compositor needs. */
export interface ComposeImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface ComposeContext {
  dateLabel: string;
  /** The shooting day for `{stamp}`, as `'26 12 24` (server clock, Asia/Seoul). */
  stampLabel?: string;
  /** The session's handwriting font id (config/hand-fonts.ts) for `hand` decorations. */
  handFont?: string;
  /** Loaded `image` decorations by src. A missing one is skipped, never guessed. */
  assets?: ReadonlyMap<string, ComposeImage>;
}
