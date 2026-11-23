/**
 * A synthetic test chart, drawn by arithmetic (no photo, nobody's face): the colours a look must
 * not get wrong. The snapshot tests grade it, and the comparison page shows it as a sample.
 *
 *   row 1  twelve skin tones, very light to very deep
 *   row 2  the Christmas problem colours: decoration red, LED red, pine, LED green, bulb amber,
 *          yellow, blue, magenta
 *   row 3  greys from black to white
 *   row 4  every hue at full strength
 */

/** Reference skin colours (sRGB 0–255), light to deep. Their OKLCh hues span 40°–70°. */
export const SKIN_TONES: readonly (readonly [number, number, number])[] = [
  [255, 224, 196],
  [241, 194, 167],
  [234, 189, 170],
  [236, 200, 160],
  [224, 172, 138],
  [198, 144, 108],
  [186, 132, 94],
  [172, 128, 90],
  [141, 96, 66],
  [110, 72, 50],
  [84, 54, 40],
  [60, 38, 30],
];

export const PROBLEM_COLOURS: readonly (readonly [number, number, number])[] = [
  [200, 30, 40], // decoration red
  [255, 0, 0], // LED red, one channel clipped
  [30, 90, 50], // pine
  [0, 255, 0], // LED green
  [255, 200, 120], // warm bulb
  [255, 235, 60], // yellow
  [40, 70, 200], // blue
  [230, 40, 160], // magenta
];

export const CHART_WIDTH = 240;
export const CHART_HEIGHT = 160;

function hueToRgb(h: number): [number, number, number] {
  const k = (n: number) => (n + h * 6) % 6;
  const f = (n: number) => Math.round(255 * (1 - Math.max(0, Math.min(k(n), 4 - k(n), 1))));
  return [f(5), f(3), f(1)];
}

/** The chart as RGBA pixels, `CHART_WIDTH` × `CHART_HEIGHT`. */
export function drawChart(): Uint8ClampedArray {
  const w = CHART_WIDTH;
  const h = CHART_HEIGHT;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let rgb: readonly [number, number, number];
      if (y < 64) rgb = SKIN_TONES[Math.floor((x * SKIN_TONES.length) / w)]!;
      else if (y < 112) rgb = PROBLEM_COLOURS[Math.floor((x * PROBLEM_COLOURS.length) / w)]!;
      else if (y < 136) {
        const v = Math.round((x / (w - 1)) * 255);
        rgb = [v, v, v];
      } else rgb = hueToRgb(x / w);
      const p = (y * w + x) * 4;
      out[p] = rgb[0];
      out[p + 1] = rgb[1];
      out[p + 2] = rgb[2];
      out[p + 3] = 255;
    }
  return out;
}
