import { ACTIVITY, ATROUS, COMBINE, DOWN, FINAL, VERTEX } from "./shaders";
import { RetouchError, type FaceJob, type RetouchEngine } from "./types";

/**
 * The filter on WebGL 1: five small shaders on RGBA8 targets (lib/retouch/shaders.ts). One
 * context for the page, made when first needed. Per face it allocates the work textures, runs the
 * stages, reads the result back into the caller's pixels and deletes every texture again, so
 * nothing but the compiled programs outlives a photo.
 */

type GL = WebGLRenderingContext;

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export interface GlCanvas {
  width: number;
  height: number;
  getContext(type: string, attrs?: unknown): unknown;
}

export class GlEngine implements RetouchEngine {
  readonly kind = "webgl" as const;
  private readonly programs: Record<"down" | "atrous" | "activity" | "combine" | "final", Program>;
  private readonly quad: WebGLBuffer;
  private readonly fbo: WebGLFramebuffer;
  private peak = 0;
  private lost = false;

  private constructor(
    private readonly canvas: GlCanvas,
    private readonly gl: GL,
  ) {
    const quad = gl.createBuffer();
    const fbo = gl.createFramebuffer();
    if (!quad || !fbo) throw new RetouchError("engine-failed", "WebGL buffers unavailable");
    this.quad = quad;
    this.fbo = fbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    this.programs = {
      down: this.link(DOWN),
      atrous: this.link(ATROUS),
      activity: this.link(ACTIVITY),
      combine: this.link(COMBINE),
      final: this.link(FINAL),
    };
    (canvas as Partial<HTMLCanvasElement>).addEventListener?.("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
    });
  }

  /** Null where WebGL 1 cannot be had or a shader does not compile (the caller uses the CPU). */
  static create(makeCanvas: () => GlCanvas): GlEngine | null {
    try {
      const canvas = makeCanvas();
      const attrs = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
      };
      const gl = (canvas.getContext("webgl", attrs) ??
        canvas.getContext("experimental-webgl", attrs)) as GL | null;
      if (!gl) return null;
      return new GlEngine(canvas, gl);
    } catch {
      return null;
    }
  }

  private link(fragment: string): Program {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new RetouchError("engine-failed", "shader unavailable");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? "";
        gl.deleteShader(shader);
        throw new RetouchError("engine-failed", `shader compile: ${log.slice(0, 200)}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new RetouchError("engine-failed", "program unavailable");
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "";
      gl.deleteProgram(program);
      throw new RetouchError("engine-failed", `program link: ${log.slice(0, 200)}`);
    }
    return { program, uniforms: new Map() };
  }

  private texture(width: number, height: number, data: ArrayBufferView | null, linear: boolean) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new RetouchError("engine-failed", "texture unavailable");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return texture;
  }

  /** Draws one stage. `target` null = the canvas (flipped so row 0 is its top). */
  private draw(
    which: keyof GlEngine["programs"],
    target: WebGLTexture | null,
    width: number,
    height: number,
    textures: Record<string, WebGLTexture>,
    numbers: Record<string, number | readonly number[]>,
  ): void {
    const gl = this.gl;
    const { program, uniforms } = this.programs[which];
    const location = (name: string) => {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
      return uniforms.get(name) ?? null;
    };
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? this.fbo : null);
    if (target) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new RetouchError("engine-failed", "framebuffer incomplete");
      gl.viewport(0, 0, width, height);
    } else {
      // The top-left corner of the canvas.
      gl.viewport(0, this.canvas.height - height, width, height);
    }
    let unit = 0;
    for (const [name, texture] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(location(name), unit);
      unit++;
    }
    gl.uniform1f(location("uFlip"), target ? 0 : 1);
    for (const [name, value] of Object.entries(numbers)) {
      const loc = location(name);
      if (typeof value === "number") gl.uniform1f(loc, value);
      else if (value.length === 2) gl.uniform2f(loc, value[0]!, value[1]!);
      else if (value.length === 3) gl.uniform3f(loc, value[0]!, value[1]!, value[2]!);
      else gl.uniform4f(loc, value[0]!, value[1]!, value[2]!, value[3]!);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  apply(pixels: Uint8ClampedArray, job: FaceJob): void {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) throw new RetouchError("engine-failed", "context lost");
    const { width: w, height: h, k, lowWidth: lw, lowHeight: lh, steps, level, skin } = job;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (w > limit || h > limit) throw new RetouchError("engine-failed", "cut-out too large");
    if (this.canvas.width < w) this.canvas.width = w;
    if (this.canvas.height < h) this.canvas.height = h;

    const made: WebGLTexture[] = [];
    const keep = <T extends WebGLTexture>(t: T) => (made.push(t), t);
    try {
      const src = keep(
        this.texture(w, h, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length), false),
      );
      const mask = keep(this.texture(lw, lh, job.mask, false));
      const low = () => keep(this.texture(lw, lh, null, true));
      const [c0, c1, c2, c3, c4, act, comb] = [low(), low(), low(), low(), low(), low(), low()];
      const texel = [1 / lw, 1 / lh];

      this.draw("down", c0, lw, lh, { uSrc: src }, { uSrcSize: [w, h], uLowSize: [lw, lh], uK: k });
      const levels = [c0, c1, c2, c3, c4] as const;
      for (let i = 0; i < 4; i++) {
        this.draw(
          "atrous",
          levels[i + 1]!,
          lw,
          lh,
          { uTex: levels[i]! },
          { uTexel: texel, uStep: steps[i]!, uInvSigma2: job.edgeInvSigma2 },
        );
      }
      this.draw("activity", act, lw, lh, { uC0: c0, uC2: c2 }, { uTexel: texel, uStep: steps[1] });
      this.draw(
        "combine",
        comb,
        lw,
        lh,
        { uC0: c0, uC1: c1, uC2: c2, uC3: c3, uC4: c4, uAct: act, uMask: mask },
        {
          uBands: level.bands,
          uKeep: job.keepAbove,
          uGuard: job.textureGuard,
          uUnderEye: level.underEye,
          uRedness: level.redness,
          uRedMargin: job.rednessMargin,
          uSkin: [skin.y, skin.cb, skin.cr],
          uInvChroma: job.invChroma,
          uDark: job.darkGate,
          uStrength: job.strength,
          uContour: [level.contourShade, level.contourLight],
          uRoll: job.contourRollOff,
        },
      );
      this.draw(
        "final",
        null,
        w,
        h,
        { uSrc: src, uComb: comb, uC0: c0 },
        {
          uLowScale: [w / (k * lw), h / (k * lh)],
          uFine: level.fine,
          uLift: level.lift,
          uRoll: job.liftRollOff,
          uMaskView: job.view === "mask" ? 1 : 0,
        },
      );
      // Back into the caller's pixels. readPixels starts at the bottom row: read the top-left
      // region and turn the rows over.
      const out = new Uint8Array(w * h * 4);
      gl.readPixels(0, this.canvas.height - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost())
        throw new RetouchError("engine-failed", "WebGL error");
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        const from = (h - 1 - y) * rowBytes;
        pixels.set(out.subarray(from, from + rowBytes), y * rowBytes);
      }
      for (let p = 3; p < pixels.length; p += 4) pixels[p] = 255;
      this.peak = Math.max(
        this.peak,
        w * h * 4 * 2 + lw * lh * 4 * 8 + this.canvas.width * this.canvas.height * 4,
      );
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const texture of made) gl.deleteTexture(texture);
    }
  }

  peakBytes(): number {
    return this.peak;
  }

  dispose(): void {
    const gl = this.gl;
    for (const { program } of Object.values(this.programs)) gl.deleteProgram(program);
    gl.deleteBuffer(this.quad);
    gl.deleteFramebuffer(this.fbo);
    // Hand the context's memory back now rather than at the next garbage collection.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.width = this.canvas.height = 1;
    this.lost = true;
  }
}
