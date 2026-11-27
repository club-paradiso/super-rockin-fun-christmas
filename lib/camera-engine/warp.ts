import { CAMERA_ENGINE } from "@/config/camera-engine";
import { get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import { invert, type Mat3 } from "./mat3";
import { isAffine } from "./model";
import type { EngineBackend } from "./status";
import { GlWarper, WarpUnavailableError, type GlCanvas } from "./warp-gl";

/**
 * Draws a corrected picture, with whatever this tablet can draw it with:
 *
 * 1. WebGL 1: any homography, one resampling.
 * 2. 2D canvas: an affine map only (a turn and an enlargement), so roll only. A 2D canvas
 *    transform has no perspective part; faking one is not attempted.
 * 3. Neither: `render` returns null and the caller takes the picture the way it always did.
 *
 * It never throws into the capture. A WebGL failure is tried once more on a fresh context (a
 * context the tablet took away while it slept is the common case); after a second failure the
 * warper reports `canvas2d` and the engine plans roll-only from then on, until the next guest.
 */

export interface WarpInput {
  source: CanvasImageSource;
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  /** Output pixel → source pixel. */
  outToSrc: Mat3;
  /** Makes the canvas the finished picture is handed over in. */
  createCanvas: CanvasFactory;
}

export interface WarperEnv {
  /** Scratch canvases the warper keeps for itself. */
  createCanvas: CanvasFactory;
  /** A canvas for a WebGL context, or null where there is none (tests, old browsers). */
  createGlCanvas: () => GlCanvas | null;
  /** Checks on a finished picture (config/camera-engine.ts `safety`). */
  safety?: typeof CAMERA_ENGINE.safety;
}

export class FrameWarper {
  private gl: GlWarper | null = null;
  /** WebGL failed twice in a row: not tried again until `newSession`. */
  private glGaveUp = false;
  private glProbed = false;
  private scratch: CanvasLike | null = null;
  private probe: CanvasLike | null = null;
  private error: string | null = null;

  constructor(private readonly env: WarperEnv) {}

  /** What a picture would be drawn with right now. */
  backend(): EngineBackend {
    return this.ensureGl() ? "webgl" : "canvas2d";
  }

  lastError(): string | null {
    return this.error;
  }

  /** A new guest: WebGL is tried again, so one lost context does not last all day. */
  newSession(): void {
    if (this.glGaveUp) {
      this.glGaveUp = false;
      this.glProbed = false;
    }
  }

  render(input: WarpInput): { canvas: CanvasLike; backend: EngineBackend } | null {
    if (!isAffine(input.outToSrc) || this.ensureGl()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const gl = this.ensureGl();
        if (!gl) break;
        try {
          return { canvas: this.renderGl(gl, input), backend: "webgl" };
        } catch (err) {
          this.error = err instanceof WarpUnavailableError ? err.code : "gl-error";
          this.dropGl();
        }
      }
      // Two failures: this guest's remaining photos are planned without WebGL.
      this.glGaveUp = true;
    }
    if (!isAffine(input.outToSrc)) return null;
    try {
      return { canvas: this.render2d(input), backend: "canvas2d" };
    } catch {
      this.error = "canvas-failed";
      return null;
    }
  }

  dispose(): void {
    this.dropGl();
    for (const canvas of [this.scratch, this.probe]) if (canvas) canvas.width = canvas.height = 0;
    this.scratch = this.probe = null;
  }

  private ensureGl(): GlWarper | null {
    if (this.gl) return this.gl;
    if (this.glGaveUp) return null;
    // Without a WebGL canvas at all (old browser, test) there is nothing to retry.
    if (this.glProbed && this.error === "no-webgl") return null;
    this.glProbed = true;
    try {
      const canvas = this.env.createGlCanvas();
      if (!canvas) throw new WarpUnavailableError("no-webgl");
      this.gl = new GlWarper(canvas);
    } catch (err) {
      this.error = err instanceof WarpUnavailableError ? err.code : "no-webgl";
      this.gl = null;
    }
    return this.gl;
  }

  private dropGl(): void {
    this.gl?.dispose();
    this.gl = null;
  }

  private renderGl(gl: GlWarper, input: WarpInput): CanvasLike {
    const { srcWidth, srcHeight, outWidth, outHeight } = input;
    // The frame goes through a 2D canvas first, pixel for pixel (no resampling): that is the
    // path the booth has always read the camera by, and a canvas is the one texture source every
    // WebKit uploads right. Uploading a camera <video> straight to WebGL is not relied on.
    if (!this.scratch) this.scratch = this.env.createCanvas(srcWidth, srcHeight);
    if (this.scratch.width !== srcWidth) this.scratch.width = srcWidth;
    if (this.scratch.height !== srcHeight) this.scratch.height = srcHeight;
    get2d(this.scratch).drawImage(input.source, 0, 0, srcWidth, srcHeight);

    const drawn = gl.render(
      this.scratch as unknown as TexImageSource,
      srcWidth,
      srcHeight,
      outWidth,
      outHeight,
      input.outToSrc,
    );
    const out = input.createCanvas(outWidth, outHeight);
    get2d(out).drawImage(drawn as unknown as CanvasImageSource, 0, 0, outWidth, outHeight);
    if (this.cameOutBlack(this.scratch, out)) {
      out.width = out.height = 0;
      throw new WarpUnavailableError("bad-output", "The warped picture came out black");
    }
    return out;
  }

  private render2d(input: WarpInput): CanvasLike {
    const srcToOut = invert(input.outToSrc);
    if (!srcToOut) throw new Error("not invertible");
    const s = srcToOut[8];
    const out = input.createCanvas(input.outWidth, input.outHeight);
    const ctx = get2d(out);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // The whole frame, placed by the map: what falls outside the output is simply not drawn.
    ctx.setTransform(
      srcToOut[0] / s,
      srcToOut[3] / s,
      srcToOut[1] / s,
      srcToOut[4] / s,
      srcToOut[2] / s,
      srcToOut[5] / s,
    );
    ctx.drawImage(input.source, 0, 0, input.srcWidth, input.srcHeight);
    ctx.restore();
    return out;
  }

  /**
   * A picture that is black where the camera's frame was not is a GPU that did not draw (a
   * known way for WebGL to fail without an error). Both are shrunk to a few pixels and
   * compared; where pixels cannot be read back at all, nothing is concluded.
   */
  private cameOutBlack(source: CanvasLike, out: CanvasLike): boolean {
    const safety = this.env.safety ?? CAMERA_ENGINE.safety;
    const sourceLevel = this.meanLevel(source);
    if (sourceLevel === null || sourceLevel < safety.sourceNotBlackLevel) return false;
    const outLevel = this.meanLevel(out);
    return outLevel !== null && outLevel < safety.blackLevel;
  }

  private meanLevel(canvas: CanvasLike): number | null {
    try {
      const size = 8;
      if (!this.probe) this.probe = this.env.createCanvas(size, size);
      const ctx = get2d(this.probe);
      ctx.drawImage(canvas as unknown as CanvasImageSource, 0, 0, size, size);
      const pixels = ctx.getImageData(0, 0, size, size) as ImageData | undefined;
      if (!pixels?.data || pixels.data.length < size * size * 4) return null;
      let sum = 0;
      for (let i = 0; i < pixels.data.length; i += 4)
        sum += (pixels.data[i]! + pixels.data[i + 1]! + pixels.data[i + 2]!) / 3;
      return sum / (size * size);
    } catch {
      return null;
    }
  }
}
