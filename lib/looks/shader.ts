/**
 * The one shader every look goes through (WebGL1, GLSL ES 1.00). The preview and the saved file
 * both run it with the same LUT and the same uniforms, so their colours cannot differ.
 *
 * Order, per pixel:
 *   0. halation: the glow of the near-white lights around this pixel, added in red-orange,
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
  octaveGain: 0.9,
  /** Brings the layers together to a standard deviation of 1 (measured: raw 0.2919). */
  normalise: 3.43,
  /**
   * Grain gathers in clumps: its amount swells and thins over patches this many times larger than
   * a grain, by this much either way. Even grain is what a noise overlay looks like.
   */
  clumpScale: 0.17,
  clumpDepth: 0.9,
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

/** Shared numbers of the halation arithmetic (shader and reference). */
export const HALATION = {
  /** A light starts to glow when its dimmer of red and green passes this level. */
  threshold: 0.9,
  /** The glow is gathered on rings; the innermost is this share of the long edge away. */
  radius: 0.007,
  /** The rings, as multiples of that radius: two that gather the glow, one that measures the light. */
  rings: [1, 2.2, 5],
  /** How much the second ring counts beside the first. */
  outerWeight: 0.6,
  /**
   * A small light glows; a large bright area (a white backdrop, a window) must not put a red rim
   * on the head in front of it: the booth's own scene is people before a paper backdrop. When this
   * share of the far ring is bright the glow starts to fade, and at the second share it is gone.
   * The price: the edge of a large blown-out lamp does not glow either. Bulbs and string lights do.
   */
  largeFrom: 0.1,
  largeTo: 0.3,
  /** The colour of the glow, as film shows it. */
  colour: [1, 0.3, 0.08],
  /** Eight directions, turned a sixteenth of a turn on every other ring. */
  directions: [
    [1, 0],
    [0.7071, 0.7071],
    [0, 1],
    [-0.7071, 0.7071],
    [-1, 0],
    [-0.7071, -0.7071],
    [0, -1],
    [0.7071, -0.7071],
    [0.9239, 0.3827],
    [0.3827, 0.9239],
    [-0.3827, 0.9239],
    [-0.9239, 0.3827],
    [-0.9239, -0.3827],
    [-0.3827, -0.9239],
    [0.3827, -0.9239],
    [0.9239, -0.3827],
  ],
} as const;

export const HALATION_TAPS = 24;

/**
 * The taps as whole-pixel offsets for a picture of this size: eight per ring. Whole pixels,
 * worked out once on the CPU, so the shader and the reference read exactly the same pixels.
 */
export function halationTaps(width: number, height: number): number[] {
  const radius = Math.max(1, HALATION.radius * Math.max(width, height));
  const taps: number[] = [];
  HALATION.rings.forEach((ring, r) => {
    for (let i = 0; i < 8; i++) {
      const [dx, dy] = HALATION.directions[(r % 2) * 8 + i]!;
      taps.push(Math.round(dx * radius * ring), Math.round(dy * radius * ring));
    }
  });
  return taps;
}

/** The glow at a pixel from what its 24 taps found (each 0–1), before the look's own amount. */
export function halationGlow(found: ArrayLike<number>): number {
  let near = 0;
  let far = 0;
  for (let i = 0; i < 8; i++) near += found[i]! + HALATION.outerWeight * found[8 + i]!;
  for (let i = 16; i < 24; i++) far += found[i]!;
  const large = Math.min(
    1,
    Math.max(0, (far / 8 - HALATION.largeFrom) / (HALATION.largeTo - HALATION.largeFrom)),
  );
  return (near / (8 * (1 + HALATION.outerWeight))) * (1 - large * large * (3 - 2 * large));
}

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
uniform float uHalation;
uniform vec2 uTexel;
uniform vec2 uTaps[24];
varying vec2 vUv;

float glowAt(vec2 uv) {
  vec3 c = texture2D(uImage, uv).rgb;
  return smoothstep(${HALATION.threshold.toFixed(2)}, 1.0, min(c.r, c.g));
}

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
  float clump = 1.0 + ${GRAIN.clumpDepth.toFixed(2)} * valueNoise(cell * ${GRAIN.clumpScale.toFixed(2)} + seed + 59.0);
  return (valueNoise(cell + seed) + ${GRAIN.octaveGain.toFixed(2)} * valueNoise(cell * ${GRAIN.octave.toFixed(2)} + seed.yx + 17.0)) * ${GRAIN.normalise.toFixed(2)} * clump;
}

void main() {
  vec3 shot = texture2D(uImage, vUv).rgb;

  vec3 lit = shot;
  if (uHalation > 0.0) {
    float near = 0.0;
    float far = 0.0;
    for (int i = 0; i < 24; i++) {
      float found = glowAt(vUv + uTaps[i] * uTexel);
      if (i < 8) near += found;
      else if (i < 16) near += ${HALATION.outerWeight.toFixed(2)} * found;
      else far += found;
    }
    float glow = (near / ${(8 * (1 + HALATION.outerWeight)).toFixed(2)}) *
      (1.0 - smoothstep(${HALATION.largeFrom.toFixed(2)}, ${HALATION.largeTo.toFixed(2)}, far / 8.0));
    lit = shot + vec3(${HALATION.colour.map((c) => c.toFixed(2)).join(", ")}) * (uHalation * glow);
  }

  vec2 d = (vUv - 0.5) * 2.0;
  float corner = smoothstep(${GRAIN.vignetteStart.toFixed(2)}, 1.0, dot(d, d) * 0.5);
  vec3 graded = applyLut(lit * pow(1.0 - uVignette * corner, 0.4545));

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
