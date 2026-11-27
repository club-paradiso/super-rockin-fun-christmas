import type { Mat3 } from "./mat3";

/** WebGL is missing, the context was lost, or the shader would not build. */
export class WarpUnavailableError extends Error {
  constructor(
    /** A short code for the staff status and the server log. */
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WarpUnavailableError";
  }
}

/** What the renderer draws into; a real <canvas> in the browser. */
export interface GlCanvas {
  width: number;
  height: number;
  getContext(type: "webgl", options?: WebGLContextAttributes): WebGLRenderingContext | null;
  addEventListener?(type: string, listener: () => void): void;
}

/** GLSL ES 1.00 (WebGL 1): no extensions, no float textures, nothing Safari 15 lacks. */
export const WARP_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vOut;
void main() {
  // Output position as 0–1 with y down, like the picture's own rows.
  vOut = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/**
 * Inverse mapping: each output pixel asks the homography where in the source it comes from. The
 * division by the third coordinate is done here, per pixel; done per vertex it would be an
 * affine approximation and straight lines would bend.
 */
export const WARP_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uImage;
uniform mat3 uMap;
varying vec2 vOut;
void main() {
  vec3 p = uMap * vec3(vOut, 1.0);
  gl_FragColor = vec4(texture2D(uImage, p.xy / p.z).rgb, 1.0);
}`;

/**
 * `outToSrc` in pixels → the same map between 0–1 coordinates, as the nine numbers of a GLSL
 * mat3 (column order). Working in 0–1 keeps the numbers small for the shader's floats.
 */
export function normalizedMap(
  outToSrc: Mat3,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const m = outToSrc;
  // N_src · M · N_out⁻¹ with N_src = diag(1/sw, 1/sh, 1), N_out⁻¹ = diag(ow, oh, 1).
  const r = [
    (m[0] * outWidth) / srcWidth,
    (m[1] * outHeight) / srcWidth,
    m[2] / srcWidth,
    (m[3] * outWidth) / srcHeight,
    (m[4] * outHeight) / srcHeight,
    m[5] / srcHeight,
    m[6] * outWidth,
    m[7] * outHeight,
    m[8],
  ];
  return new Float32Array([r[0]!, r[3]!, r[6]!, r[1]!, r[4]!, r[7]!, r[2]!, r[5]!, r[8]!]);
}

/**
 * Draws one picture through one homography. One instance owns one WebGL 1 context, one program
 * and one texture, and is reused for every photo: nothing is allocated per shot but the upload.
 */
export class GlWarper {
  readonly canvas: GlCanvas;
  private gl: WebGLRenderingContext;
  private program!: WebGLProgram;
  private texture!: WebGLTexture;
  private uImage: WebGLUniformLocation | null = null;
  private uMap: WebGLUniformLocation | null = null;
  private lost = false;
  maxTextureSize = 0;

  constructor(canvas: GlCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      // The result is copied with drawImage right after drawing; keeping the buffer makes that
      // copy safe on every browser.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new WarpUnavailableError("no-webgl", "WebGL is not available");
    this.gl = gl;
    canvas.addEventListener?.("webglcontextlost", () => {
      this.lost = true;
    });
    try {
      this.setUp(gl);
    } catch (err) {
      // Nothing will ever draw with this context: give it back before reporting.
      try {
        (gl.getExtension?.("WEBGL_lose_context") as WEBGL_lose_context | null)?.loseContext();
      } catch {
        // Already lost.
      }
      throw err;
    }
  }

  private setUp(gl: WebGLRenderingContext): void {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new WarpUnavailableError("shader", "Could not create a shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new WarpUnavailableError(
          "shader",
          `Shader did not compile: ${gl.getShaderInfoLog(shader)}`,
        );
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new WarpUnavailableError("shader", "Could not create a program");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, WARP_VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, WARP_FRAGMENT_SHADER));
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new WarpUnavailableError(
        "shader",
        `Program did not link: ${gl.getProgramInfoLog(program)}`,
      );
    this.program = program;
    this.uImage = gl.getUniformLocation(program, "uImage");
    this.uMap = gl.getUniformLocation(program, "uMap");

    // One triangle that covers the whole target.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) throw new WarpUnavailableError("gl-error", "Could not create a texture");
    this.texture = texture;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  }

  /**
   * Draws `source` (`srcWidth` × `srcHeight`) into an `outWidth` × `outHeight` picture. The
   * result is in `this.canvas` until the next call.
   */
  render(
    source: TexImageSource,
    srcWidth: number,
    srcHeight: number,
    outWidth: number,
    outHeight: number,
    outToSrc: Mat3,
  ): GlCanvas {
    const gl = this.gl;
    if (this.lost || gl.isContextLost())
      throw new WarpUnavailableError("context-lost", "WebGL context was lost");
    const limit = this.maxTextureSize;
    if (srcWidth > limit || srcHeight > limit || outWidth > limit || outHeight > limit)
      throw new WarpUnavailableError("too-large", `Over this GPU's ${limit} px`);

    if (this.canvas.width !== outWidth) this.canvas.width = outWidth;
    if (this.canvas.height !== outHeight) this.canvas.height = outHeight;
    gl.viewport(0, 0, outWidth, outHeight);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    // The browser must hand over the picture's own numbers, not a colour-managed version.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // A stream is rarely a power of two: WebGL 1 then needs clamping and no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.uniform1i(this.uImage, 0);
    gl.uniformMatrix3fv(
      this.uMap,
      false,
      normalizedMap(outToSrc, srcWidth, srcHeight, outWidth, outHeight),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new WarpUnavailableError("gl-error", `WebGL error ${error}`);
    return this.canvas;
  }

  /** Gives the GPU memory and the context back (older WebKit allows only a few per page). */
  dispose(): void {
    const gl = this.gl;
    try {
      gl.deleteTexture(this.texture);
      gl.deleteProgram(this.program);
      (gl.getExtension?.("WEBGL_lose_context") as WEBGL_lose_context | null)?.loseContext();
    } catch {
      // A lost context has nothing left to give back.
    }
  }
}
