import { RETOUCH_CONFIG } from "@/config/retouch";
import { ACTIVITY_GAIN, BIAS, ENCODE, MASK_TINT, MASK_TINT_WEIGHT, REDNESS_CAP } from "./cpu";
import { CB_SCALE, CR_SCALE, LUMA } from "./skin";

/**
 * GLSL ES 1.00 (WebGL 1) for the same five stages as lib/retouch/cpu.ts. No extensions, no float
 * textures: every target is RGBA8, which every WebGL 1 device has. Loops have constant bounds
 * and textures are read at texel centres, as WebGL 1 requires for non-power-of-two sizes.
 */

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
const vec3 LUMA = vec3(${LUMA.map(f).join(", ")});
`;

export const VERTEX = `
attribute vec2 aPos;
uniform float uFlip;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  // Row 0 of every texture is the top of the picture. On the canvas, clip y = +1 is the top.
  if (uFlip > 0.5) vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const MAX_DOWNSCALE = RETOUCH_CONFIG.face.maxDownscale;

export const DOWN = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uLowSize;
uniform float uK;
void main() {
  vec2 base = floor(vUv * uLowSize) * uK;
  vec3 sum = vec3(0.0);
  for (int j = 0; j < ${MAX_DOWNSCALE}; j++) {
    if (float(j) >= uK) break;
    for (int i = 0; i < ${MAX_DOWNSCALE}; i++) {
      if (float(i) >= uK) break;
      vec2 p = min(base + vec2(float(i), float(j)), uSrcSize - 1.0) + 0.5;
      sum += texture2D(uSrc, p / uSrcSize).rgb;
    }
  }
  vec3 c = sum / (uK * uK);
  gl_FragColor = vec4(c, dot(c, LUMA));
}
`;

const KERNEL = `
float kern(float i) {
  float a = abs(i);
  return a < 0.5 ? 6.0 : (a < 1.5 ? 4.0 : 1.0);
}
`;

export const ATROUS = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uStep;
uniform float uInvSigma2;
${KERNEL}
void main() {
  float centre = texture2D(uTex, vUv).a;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 o = vec2(float(i), float(j));
      vec4 t = texture2D(uTex, vUv + o * uStep * uTexel);
      float d = t.a - centre;
      float w = kern(o.x) * kern(o.y) * exp(-d * d * uInvSigma2);
      sum += w * t.rgb;
      total += w;
    }
  }
  vec3 c = sum / total;
  gl_FragColor = vec4(c, dot(c, LUMA));
}
`;

export const ACTIVITY = `${HEAD}
uniform sampler2D uC0;
uniform sampler2D uC2;
uniform vec2 uTexel;
uniform float uStep;
void main() {
  float sum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 uv = vUv + vec2(float(i), float(j)) * uStep * uTexel;
      sum += abs(texture2D(uC0, uv).a - texture2D(uC2, uv).a);
    }
  }
  gl_FragColor = vec4(sum / 25.0 * ${f(ACTIVITY_GAIN)}, 0.0, 0.0, 1.0);
}
`;

export const COMBINE = `${HEAD}
uniform sampler2D uC0;
uniform sampler2D uC1;
uniform sampler2D uC2;
uniform sampler2D uC3;
uniform sampler2D uC4;
uniform sampler2D uAct;
uniform sampler2D uMask;
uniform vec4 uBands;
uniform vec4 uKeep;
uniform float uGuard;
uniform float uUnderEye;
uniform float uRedness;
uniform float uRedMargin;
uniform vec3 uSkin;      // y, cb, cr of this face
uniform vec2 uInvChroma; // 1 / (tolerance × sigma) for cb, cr
uniform vec2 uDark;      // dark gate, in luma
uniform float uStrength;
uniform vec2 uContour;   // contour light: shade, highlight
uniform vec2 uRoll;      // the highlight fades out between these values of the brightest channel

vec3 take(vec3 d, float share, float keep) {
  float q = max(abs(d.r), max(abs(d.g), abs(d.b))) / keep;
  return d * (share / (1.0 + q * q));
}

void main() {
  vec4 c0 = texture2D(uC0, vUv);
  vec4 c1 = texture2D(uC1, vUv);
  vec4 c2 = texture2D(uC2, vUv);
  vec4 c3 = texture2D(uC3, vUv);
  vec4 c4 = texture2D(uC4, vUv);
  vec4 mask = texture2D(uMask, vUv);

  vec3 c = take(c0.rgb - c1.rgb, uBands.x, uKeep.x)
         + take(c1.rgb - c2.rgb, uBands.y, uKeep.y)
         + take(c2.rgb - c3.rgb, uBands.z, uKeep.z)
         + take(c3.rgb - c4.rgb, uBands.w, uKeep.w);

  float a = texture2D(uAct, vUv).r / ${f(ACTIVITY_GAIN)} / uGuard;
  c *= 1.0 / (1.0 + a * a);

  if (mask.g > 0.0 && uUnderEye > 0.0) {
    vec3 e = c2.rgb - c4.rgb;
    float el = dot(e, LUMA);
    if (el < 0.0) {
      float q = el / uKeep.w;
      c += e * (mask.g * uUnderEye / (1.0 + q * q));
    }
  }

  if (uRedness > 0.0) {
    float excess = min(${f(REDNESS_CAP)}, (c2.r - c2.a) * ${f(CR_SCALE)} + 0.5 - uSkin.z - uRedMargin);
    if (excess > 0.0) {
      float pull = uRedness * excess;
      c.r += 1.402 * pull;
      c.g -= 0.714 * pull;
    }
  }

  float brightest = max(c2.r, max(c2.g, c2.b));
  float gain = mask.a * uContour.y * (1.0 - smoothstep(uRoll.x, uRoll.y, brightest)) - mask.b * uContour.x;
  c -= c2.rgb * gain;

  vec2 dc = (vec2((c1.b - c1.a) * ${f(CB_SCALE)} + 0.5, (c1.r - c1.a) * ${f(CR_SCALE)} + 0.5) - uSkin.yz) * uInvChroma;
  float conf = exp(-0.5 * dot(dc, dc)) * smoothstep(uDark.x, uDark.y, c1.a);
  gl_FragColor = vec4(c * ${f(ENCODE)} + ${BIAS}, mask.r * conf * uStrength);
}
`;

export const FINAL = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uComb;
uniform sampler2D uC0;
uniform vec2 uLowScale;
uniform float uFine;
uniform float uLift;
uniform vec2 uRoll;
uniform float uMaskView;
void main() {
  vec3 src = texture2D(uSrc, vUv).rgb;
  vec2 low = vUv * uLowScale;
  vec4 comb = texture2D(uComb, low);
  vec4 c0 = texture2D(uC0, low);
  float m = comb.a;
  vec3 result;
  if (uMaskView > 0.5) {
    result = mix(src, vec3(${MASK_TINT.map(f).join(", ")}), m * ${f(MASK_TINT_WEIGHT)});
  } else {
    result = src - m * ((comb.rgb - ${BIAS}) / ${f(ENCODE)} + uFine * (src - c0.rgb));
    result *= 1.0 + m * uLift * (1.0 - smoothstep(uRoll.x, uRoll.y, c0.a));
  }
  gl_FragColor = vec4(result, 1.0);
}
`;
