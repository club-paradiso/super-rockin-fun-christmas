/**
 * The one shader every look goes through (WebGL1, GLSL ES 1.00). The preview and the saved file
 * both run it with the same LUT and the same uniforms, so their colours cannot differ.
 *
 * Order, per pixel:
 *   1. corner falloff (as a lens would do it, before the "film"),
 *   2. the 3D LUT, read from a 2D strip with all eight neighbours fetched and mixed by hand
 *      (NEAREST texture: no reliance on the GPU's own filtering, so every GPU gives one answer),
 *   3. strength: a mix of the photo as shot and the graded one,
 *   4. grain: most in the mid-tones, least in black and white, placed in photo coordinates (not
 *      screen pixels) and seeded per photo, so it is the same grain at any size and never a
 *      repeating tile.
 *
 * lib/looks/reference.ts is the same arithmetic in TypeScript.
 */

export const LOOK_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Shared numbers of the grain and falloff arithmetic (shader and reference). */
export const GRAIN = {
  /** Second layer of grain: this many times finer, this much weaker. */
  octave: 2.3,
  octaveGain: 0.6,
  /** Brings the two layers together to a standard deviation of 1 (measured: raw 0.2498). */
  normalise: 4.0,
  /** Grain that black and white still get, as a share of the mid-tone amount. */
  floor: 0.15,
  /**
   * Where the grain peaks: luminance is raised to this power first, so the peak sits at
   * 0.5^(1/0.75) ≈ 0.40, a little under mid-grey. Sources disagree on where film grain shows most
   * (Kodak: shadows; others: mid-tones to highlights); below the middle with both ends faded is
   * what they share (docs/research/color-market-research.md).
   */
  peak: 0.75,
  /** Corner falloff starts here (0 = centre, 1 = corner, squared distance). */
  vignetteStart: 0.2,
} as const;

export const LOOK_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uImage;
uniform sampler2D uLut;
uniform float uLutSize;
uniform float uStrength;
uniform float uVignette;
uniform float uGrainAmount;
uniform float uGrainChroma;
uniform float uGrainFade;
uniform vec2 uGrainCells;
uniform vec2 uSeed;
varying vec2 vUv;

vec3 lutAt(float r, float g, float b) {
  float n = uLutSize;
  return texture2D(uLut, vec2((b * n + r + 0.5) / (n * n), (g + 0.5) / n)).rgb;
}

vec3 applyLut(vec3 c) {
  float top = uLutSize - 1.0;
  vec3 p = clamp(c, 0.0, 1.0) * top;
  vec3 i0 = min(floor(p), top - 1.0);
  vec3 i1 = i0 + 1.0;
  vec3 f = p - i0;
  vec3 x00 = mix(lutAt(i0.r, i0.g, i0.b), lutAt(i1.r, i0.g, i0.b), f.r);
  vec3 x10 = mix(lutAt(i0.r, i1.g, i0.b), lutAt(i1.r, i1.g, i0.b), f.r);
  vec3 x01 = mix(lutAt(i0.r, i0.g, i1.b), lutAt(i1.r, i0.g, i1.b), f.r);
  vec3 x11 = mix(lutAt(i0.r, i1.g, i1.b), lutAt(i1.r, i1.g, i1.b), f.r);
  return mix(mix(x00, x10, f.g), mix(x01, x11, f.g), f.b);
}

// Dave Hoskins' hash without sine (the same on every GPU that has highp floats).
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) - 0.5;
}

float grainAt(vec2 cell, vec2 seed) {
  return (valueNoise(cell + seed) + ${GRAIN.octaveGain.toFixed(2)} * valueNoise(cell * ${GRAIN.octave.toFixed(2)} + seed.yx + 17.0)) * ${GRAIN.normalise.toFixed(2)};
}

void main() {
  vec3 shot = texture2D(uImage, vUv).rgb;

  vec2 d = (vUv - 0.5) * 2.0;
  float corner = smoothstep(${GRAIN.vignetteStart.toFixed(2)}, 1.0, dot(d, d) * 0.5);
  vec3 graded = applyLut(shot * pow(1.0 - uVignette * corner, 0.4545));

  vec3 color = mix(shot, graded, uStrength);

  if (uGrainAmount > 0.0) {
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float tone = pow(clamp(lum, 0.0, 1.0), ${GRAIN.peak.toFixed(2)});
    float mid = clamp(4.0 * tone * (1.0 - tone), 0.0, 1.0);
    float weight = ${GRAIN.floor.toFixed(2)} + ${(1 - GRAIN.floor).toFixed(2)} * mid;
    vec2 cell = vUv * uGrainCells;
    float g = grainAt(cell, uSeed);
    vec3 grain = vec3(g);
    if (uGrainChroma > 0.0) {
      vec3 own = vec3(grainAt(cell, uSeed + 41.0), g, grainAt(cell, uSeed + 83.0));
      grain = mix(grain, own, uGrainChroma);
    }
    color += grain * (uGrainAmount * uGrainFade * uStrength * weight);
  }

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
