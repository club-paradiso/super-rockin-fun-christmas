import { lutToStrip, type Lut3D } from "./cube";
import { grainGeometry, seedOffsets } from "./reference";
import { halationTaps, LOOK_FRAGMENT_SHADER, LOOK_VERTEX_SHADER } from "./shader";
import type { LookRenderParams } from "./types";

/** WebGL is missing, the context was lost, or the shader would not build. */
export class LookUnavailableError extends Error {}

/** What the renderer draws into; a real <canvas> in the browser. */
export interface GlCanvas {
  width: number;
  height: number;
  getContext(type: "webgl", options?: WebGLContextAttributes): WebGLRenderingContext | null;
  addEventListener?(type: string, listener: () => void): void;
}

const UNIFORMS = [
  "uImage",
  "uLut",
  "uLutSize",
  "uStrength",
  "uVignette",
  "uGrainAmount",
  "uGrainChroma",
  "uGrainFade",
  "uGrainCells",
  "uSeed",
  "uHalation",
  "uTexel",
  "uTaps[0]",
] as const;

/**
 * Draws one photo through one look. One instance owns one WebGL1 context and is reused for every
 * photo, preview and final alike (older WebKit allows only a few contexts per page).
 *
 * The source must already be at the size it will be shown (the compositor resamples in 2D first),
 * so the shader maps pixel to pixel and the look never changes sharpness.
 */
export class LookRenderer {
  readonly canvas: GlCanvas;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private imageTexture: WebGLTexture;
  private lutTextures = new Map<string, { texture: WebGLTexture; size: number }>();
  private lost = false;

  constructor(canvas: GlCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      // The compositor copies the result with drawImage right after drawing; keeping the buffer
      // makes that copy safe on every browser, at no visible cost for still pictures.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new LookUnavailableError("WebGL is not available");
    this.gl = gl;
    canvas.addEventListener?.("webglcontextlost", () => {
      this.lost = true;
    });

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new LookUnavailableError("Could not create a shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new LookUnavailableError(`Shader did not compile: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new LookUnavailableError("Could not create a program");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, LOOK_VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, LOOK_FRAGMENT_SHADER));
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new LookUnavailableError(`Program did not link: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    for (const name of UNIFORMS) this.uniforms.set(name, gl.getUniformLocation(program, name));

    // One triangle that covers the whole target.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) throw new LookUnavailableError("Could not create a texture");
    this.imageTexture = texture;
  }

  /** The LUT as a texture, uploaded once per look. */
  private lutTexture(key: string, lut: Lut3D) {
    const known = this.lutTextures.get(key);
    if (known) return known;
    const gl = this.gl;
    const strip = lutToStrip(lut);
    const texture = gl.createTexture();
    if (!texture) throw new LookUnavailableError("Could not create a LUT texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      strip.width,
      strip.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      strip.data,
    );
    this.clampNearest();
    const entry = { texture, size: lut.size };
    this.lutTextures.set(key, entry);
    return entry;
  }

  private clampNearest() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Draws `source` (already `width` × `height`) through the LUT. The result is in `this.canvas`
   * until the next call. `lutKey` names the LUT so its texture is uploaded only once.
   */
  render(
    source: TexImageSource,
    width: number,
    height: number,
    lutKey: string,
    lut: Lut3D,
    params: LookRenderParams,
  ): GlCanvas {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) throw new LookUnavailableError("WebGL context was lost");
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (width > limit || height > limit)
      throw new LookUnavailableError(`Photo ${width}×${height} is over this GPU's ${limit} px`);

    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);

    const table = this.lutTexture(lutKey, lut);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    // The browser must hand over the picture's own numbers, not a colour-managed version.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.clampNearest();

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, table.texture);

    const u = (name: (typeof UNIFORMS)[number]) => this.uniforms.get(name) ?? null;
    const grain = grainGeometry(width, height, params.grainSize);
    const [seedX, seedY] = seedOffsets(params.seed);
    gl.uniform1i(u("uImage"), 0);
    gl.uniform1i(u("uLut"), 1);
    gl.uniform1f(u("uLutSize"), table.size);
    gl.uniform1f(u("uStrength"), params.strength);
    gl.uniform1f(u("uVignette"), params.vignette);
    gl.uniform1f(u("uGrainAmount"), params.grainAmount);
    gl.uniform1f(u("uGrainChroma"), params.grainChroma);
    gl.uniform1f(u("uGrainFade"), grain.fade);
    gl.uniform2f(u("uGrainCells"), grain.cellsX, grain.cellsY);
    gl.uniform2f(u("uSeed"), seedX, seedY);
    gl.uniform1f(u("uHalation"), params.halation);
    gl.uniform2f(u("uTexel"), 1 / width, 1 / height);
    gl.uniform2fv(u("uTaps[0]"), new Float32Array(halationTaps(width, height)));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new LookUnavailableError(`WebGL error ${error}`);
    return this.canvas;
  }

  /**
   * Gives the GPU memory back, and the context itself: older WebKit allows only a few WebGL
   * contexts per page, so a renderer that is replaced after a failure must not keep its own.
   */
  dispose(): void {
    const gl = this.gl;
    try {
      for (const { texture } of this.lutTextures.values()) gl.deleteTexture(texture);
      gl.deleteTexture(this.imageTexture);
      gl.deleteProgram(this.program);
      (gl.getExtension?.("WEBGL_lose_context") as WEBGL_lose_context | null)?.loseContext();
    } catch {
      // A lost context has nothing left to give back.
    }
    this.lutTextures.clear();
  }
}
