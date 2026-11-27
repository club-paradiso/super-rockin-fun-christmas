import { describe, expect, it } from "vitest";
import { grabFrame } from "@/lib/camera";
import { coverCrop } from "@/lib/compositor/geometry";
import {
  DEG,
  IDENTITY,
  apply,
  chain,
  invert,
  project,
  rotX,
  rotZ,
  type Mat3,
} from "@/lib/camera-engine/mat3";
import {
  correctionRays,
  intrinsicsFor,
  outputToSource,
  rectification,
} from "@/lib/camera-engine/model";
import { planCorrection, type PlanInput } from "@/lib/camera-engine/plan";
import { cssMatrix3d, previewLayout } from "@/lib/camera-engine/preview";
import { FrameWarper } from "@/lib/camera-engine/warp";
import { warpPixels, type Pixels } from "@/lib/camera-engine/warp-cpu";
import { normalizedMap, type GlCanvas } from "@/lib/camera-engine/warp-gl";
import { COMBINED } from "../helpers/camera-engine";
import { FakeCanvas, fakeCanvasFactory } from "../helpers/fake-canvas";

// ── Synthetic scenes ───────────────────────────────────────────────────────────────────────
// A scene is a brightness for every direction a level camera could look in (tan of the angle
// right, tan of the angle down). A tilted camera's picture of it is rendered exactly, per
// pixel, from the camera model; the engine's correction is then judged against a level
// camera's picture of the same scene.

type Scene = (x: number, y: number) => number;

const checkerboard: Scene = (x, y) => ((Math.floor(x * 6) + Math.floor(y * 6)) & 1 ? 215 : 45);
/** Smooth everywhere: resampling it loses almost nothing, so comparisons can be strict. */
const waves: Scene = (x, y) =>
  128 + 60 * Math.sin(x * 9) * Math.cos(y * 7) + 40 * Math.sin((x + y) * 5);

const W = 320;
const H = 180;
const FOV = 60;
const K = intrinsicsFor(W, H, FOV);

/** The picture a camera with this tilt takes of the scene. */
function shoot(scene: Scene, roll: number, pitch: number, width = W, height = H): Pixels {
  const k = intrinsicsFor(width, height, FOV);
  // Pixel → ray in the tilted camera → the same ray in level coordinates.
  const toLevel = chain(rotX(pitch * DEG), rotZ(-roll * DEG));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const ray = apply(toLevel, [(i + 0.5 - k.cx) / k.f, (j + 0.5 - k.cy) / k.f, 1]);
      const v = scene(ray[0] / ray[2], ray[1] / ray[2]);
      data.set([v, v, v, 255], (j * width + i) * 4);
    }
  return { data, width, height };
}

const at = (p: { data: ArrayLike<number> }, width: number, x: number, y: number) =>
  p.data[(y * width + x) * 4]!;

function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>, width: number, inset: number) {
  const height = a.length / 4 / width;
  let sum = 0;
  let n = 0;
  for (let j = inset; j < height - inset; j++)
    for (let i = inset; i < width - inset; i++) {
      sum += Math.abs(a[(j * width + i) * 4]! - b[(j * width + i) * 4]!);
      n++;
    }
  return sum / n;
}

describe("the reference warp", () => {
  it("copies a picture through the identity, pixel for pixel", () => {
    const src = shoot(checkerboard, 4, 7);
    expect(Array.from(warpPixels(src, W, H, IDENTITY))).toEqual(Array.from(src.data));
  });

  it("mirrors and crops like the uncorrected capture", () => {
    const src = shoot(waves, 0, 0);
    const crop = coverCrop(W, H, 4 / 3);
    const out = warpPixels(src, 240, 180, outputToSource(IDENTITY, crop, 240, 180, true));
    for (const [x, y] of [
      [0, 0],
      [100, 60],
      [239, 179],
    ] as const)
      expect(at({ data: out }, 240, x, y)).toBe(at(src, W, crop.x + (239 - x), y));
  });

  it("clamps at the edge instead of reading outside", () => {
    const src: Pixels = { data: new Uint8ClampedArray([10, 10, 10, 255]), width: 1, height: 1 };
    const out = warpPixels(src, 3, 3, [1, 0, -50, 0, 1, 80, 0, 0, 1]);
    expect(Array.from(out.filter((_, i) => i % 4 === 0))).toEqual(new Array(9).fill(10));
  });
});

describe("undoing a known tilt on a synthetic picture", () => {
  // The whole frame is corrected in place (no crop, no zoom), with the bare rotation: the
  // result must be the level camera's picture wherever the tilted camera saw that part.
  const undo = (roll: number, pitch: number): Mat3 =>
    invert(rectification(K, correctionRays(roll, roll, pitch, false)))!;

  it("gives back the level picture for every tilt of the combined matrix", () => {
    for (const scene of [waves, checkerboard])
      for (const [roll, pitch] of [...COMBINED, [15, 0], [0, 25], [0, -25]] as [number, number][]) {
        const tilted = shoot(scene, roll, pitch);
        const corrected = warpPixels(tilted, W, H, undo(roll, pitch));
        const level = shoot(scene, 0, 0);
        // Compared where the tilted camera saw the scene (not where the edge was clamped).
        const back = undo(roll, pitch);
        let sum = 0;
        let n = 0;
        for (let j = 0; j < H; j++)
          for (let i = 0; i < W; i++) {
            const s = project(back, i + 0.5, j + 0.5);
            if (s.x < 2 || s.x > W - 2 || s.y < 2 || s.y > H - 2) continue;
            sum += Math.abs(at({ data: corrected }, W, i, j) - at(level, W, i, j));
            n++;
          }
        expect(n).toBeGreaterThan(W * H * 0.2);
        // Smooth scene: nearly exact. Checkerboard: only its edges differ after resampling.
        expect(sum / n).toBeLessThan(scene === waves ? 1.5 : 14);
      }
  });

  it("stands plumb lines up: columns of the corrected picture are one brightness again", () => {
    // Plumb stripes, like door frames: a level camera sees each column in one brightness.
    const stripes: Scene = (x) => (Math.floor(x * 7 + 100) & 1 ? 220 : 40);
    const [roll, pitch] = [6, 14];
    const tilted = shoot(stripes, roll, pitch);
    const back = undo(roll, pitch);
    const corrected = warpPixels(tilted, W, H, back);
    /** Share of columns that hold one brightness over the rows the tilted camera saw. */
    const plumb = (data: ArrayLike<number>, valid: (x: number, y: number) => boolean) => {
      let one = 0;
      let all = 0;
      for (let x = 30; x < W - 30; x++) {
        let lo = 255;
        let hi = 0;
        let rows = 0;
        for (let y = 20; y < H - 20; y++) {
          if (!valid(x, y)) continue;
          rows++;
          lo = Math.min(lo, data[(y * W + x) * 4]!);
          hi = Math.max(hi, data[(y * W + x) * 4]!);
        }
        if (rows < 40) continue;
        all++;
        if (hi - lo < 60) one++;
      }
      return one / all;
    };
    const seen = (x: number, y: number) => {
      const s = project(back, x + 0.5, y + 0.5);
      return s.x > 2 && s.x < W - 2 && s.y > 2 && s.y < H - 2;
    };
    // The few columns that are not are the ones a stripe's edge runs down.
    const after = plumb(corrected, seen);
    expect(after).toBeGreaterThan(0.85);
    // The tilted picture's stripes lean and converge: far fewer of its columns stay in one.
    expect(plumb(tilted.data, () => true)).toBeLessThan(after - 0.2);
  });

  it("turns a rolled horizon level: rows of the corrected picture stop changing side to side", () => {
    const horizon: Scene = (_x, y) => (y > 0.05 ? 200 : 50);
    const tilted = shoot(horizon, 12, 0);
    const corrected = warpPixels(tilted, W, H, undo(12, 0));
    const rowSpread = (data: ArrayLike<number>, y: number) => {
      let lo = 255;
      let hi = 0;
      for (let x = 60; x < W - 60; x++) {
        lo = Math.min(lo, data[(y * W + x) * 4]!);
        hi = Math.max(hi, data[(y * W + x) * 4]!);
      }
      return hi - lo;
    };
    const mixedRows = (data: ArrayLike<number>) => {
      let n = 0;
      for (let y = 20; y < H - 20; y++) if (rowSpread(data, y) > 60) n++;
      return n;
    };
    expect(mixedRows(tilted.data)).toBeGreaterThan(20);
    expect(mixedRows(corrected)).toBeLessThanOrEqual(2);
  });
});

describe("a plan on a synthetic picture", () => {
  const plan = (roll: number, pitch: number, over: Partial<PlanInput> = {}) =>
    planCorrection({
      srcWidth: W,
      srcHeight: H,
      aspect: 4 / 3,
      tilt: { roll, pitch },
      confidence: 1,
      level: true,
      perspective: true,
      portraitGuard: true,
      fovLongDeg: FOV,
      fovAssumed: false,
      backend: "webgl",
      ...over,
    });
  const [OW, OH] = [240, 180];
  const render = (src: Pixels, p: ReturnType<typeof plan>, mirror = false) =>
    warpPixels(src, OW, OH, outputToSource(p.inverse, coverCrop(W, H, 4 / 3), OW, OH, mirror));

  it("a rolled camera's photo comes out as the level camera's, enlarged about the middle", () => {
    for (const roll of [3, -5, 10]) {
      const p = plan(roll, 0);
      const got = render(shoot(waves, roll, 0), p);
      // What a level camera with the plan's zoom would have taken.
      const crop = coverCrop(W, H, 4 / 3);
      const zoomed: Mat3 = [
        crop.width / OW / p.zoom,
        0,
        W / 2 - crop.width / 2 / p.zoom,
        0,
        crop.height / OH / p.zoom,
        H / 2 - crop.height / 2 / p.zoom,
        0,
        0,
        1,
      ];
      const want = warpPixels(shoot(waves, 0, 0), OW, OH, zoomed);
      expect(meanAbsDiff(got, want, OW, 2)).toBeLessThan(2);
    }
  });

  it("has no clamped border: every output pixel differs from a flat edge smear", () => {
    // A scene with detail everywhere: a clamped (invented) region would be rows or columns of
    // one repeated value along the picture's edge.
    for (const [roll, pitch] of COMBINED) {
      const got = render(shoot(waves, roll, pitch), plan(roll, pitch));
      for (const y of [0, OH - 1]) {
        let run = 0;
        for (let x = 1; x < OW; x++)
          run = got[(y * OW + x) * 4] === got[(y * OW + x - 1) * 4] ? run + 1 : 0;
        expect(run).toBeLessThan(OW / 4);
      }
    }
  });

  it("keeps people's proportions: a circle in the middle and circles at the edges stay round", () => {
    // Discs as the camera saw them (in the source picture). After the plan, each one's
    // spread along its long axis over its short axis is the stretch Portrait Guard limits.
    const discs: [number, number][] = [
      [W / 2, H / 2],
      [W / 2 - 62, H / 2 - 40],
      [W / 2 + 62, H / 2 + 40],
      [W / 2 + 62, H / 2 - 40],
      [W / 2, H / 2 + 52],
    ];
    const radius = 16;
    const picture = (cx: number, cy: number): Pixels => {
      const data = new Uint8ClampedArray(W * H * 4);
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const v = Math.hypot(i + 0.5 - cx, j + 0.5 - cy) <= radius ? 255 : 0;
          data.set([v, v, v, 255], (j * W + i) * 4);
        }
      return { data, width: W, height: H };
    };
    const stretchOf = (data: Uint8ClampedArray) => {
      let m = 0;
      let mx = 0;
      let my = 0;
      for (let j = 0; j < OH; j++)
        for (let i = 0; i < OW; i++) {
          const v = data[(j * OW + i) * 4]!;
          m += v;
          mx += v * i;
          my += v * j;
        }
      const [cx, cy] = [mx / m, my / m];
      let xx = 0;
      let yy = 0;
      let xy = 0;
      for (let j = 0; j < OH; j++)
        for (let i = 0; i < OW; i++) {
          const v = data[(j * OW + i) * 4]!;
          xx += v * (i - cx) ** 2;
          yy += v * (j - cy) ** 2;
          xy += v * (i - cx) * (j - cy);
        }
      const mean = (xx + yy) / 2;
      const diff = Math.hypot((xx - yy) / 2, xy);
      return Math.sqrt((mean + diff) / (mean - diff));
    };
    for (const fov of [60, 95])
      for (const [roll, pitch] of [
        [0, 12],
        [-5, 10],
        [10, -15],
      ] as const) {
        const p = plan(roll, pitch, { fovLongDeg: fov });
        expect(Math.abs(p.appliedPitch)).toBeGreaterThan(1);
        discs.forEach(([cx, cy], index) => {
          const stretch = stretchOf(render(picture(cx, cy), p));
          // The guard's own limits, plus what a 16-pixel disc can be measured to.
          expect(stretch).toBeLessThan((index === 0 ? 1.05 : 1.1) + 0.02);
        });
        // The disc in the middle keeps its shape almost exactly (the conformal anchor).
        expect(stretchOf(render(picture(W / 2, H / 2), p))).toBeLessThan(1.02);
      }
  });

  it("without Portrait Guard the same tilt does stretch the middle", () => {
    const off = plan(0, 20, { portraitGuard: false, fovLongDeg: 95 });
    const on = plan(0, 20, { fovLongDeg: 95 });
    expect(off.portraitAnisotropy).toBeGreaterThan(on.portraitAnisotropy);
  });
});

describe("the preview shows what the photo gets", () => {
  it("writes a homography as a CSS matrix3d in column order", () => {
    expect(cssMatrix3d([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(
      "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
    );
    expect(cssMatrix3d([2, 0, 10, 0, 2, 20, 0, 0, 2])).toBe(
      "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,5,10,0,1)",
    );
    expect(cssMatrix3d([1, 2, 3, 4, 5, 6, 0.001, 0.002, 1])).toBe(
      "matrix3d(1,4,0,0.001,2,5,0,0.002,0,0,1,0,3,6,0,1)",
    );
    // Small perspective terms are never written in exponent form.
    expect(cssMatrix3d([1, 0, 0, 0, 1, 0, 1.5e-7, 0, 1])).not.toMatch(/e-/);
  });

  it("with no correction is the cover crop and the mirror the booth always had", () => {
    const layout = previewLayout(IDENTITY, 1280, 720, 400, 300, true)!;
    // A 16:9 stream in a 4:3 box: full height, the sides hang out evenly.
    expect(layout.height).toBeCloseTo(300, 9);
    expect(layout.width).toBeCloseTo(533.333, 2);
    expect(layout.left).toBeCloseTo(-66.667, 2);
    expect(layout.top).toBeCloseTo(0, 9);
    expect(layout.transform).toBe(
      `matrix3d(-1,0,0,0,0,1,0,0,0,0,1,0,${(533.3333333333).toFixed(10)},0,0,1)`,
    );
    expect(previewLayout(IDENTITY, 0, 720, 400, 300, true)).toBeNull();
    expect(previewLayout(IDENTITY, 1280, 720, 0, 0, true)).toBeNull();
  });

  it("puts every source pixel where the capture samples it, mirrored or not", () => {
    for (const [srcW, srcH] of [
      [1280, 720],
      [720, 1280],
    ] as const)
      for (const mirror of [true, false])
        for (const [roll, pitch] of COMBINED) {
          const plan = planCorrection({
            srcWidth: srcW,
            srcHeight: srcH,
            aspect: 4 / 3,
            tilt: { roll, pitch },
            confidence: 1,
            level: true,
            perspective: true,
            portraitGuard: true,
            fovLongDeg: 60,
            fovAssumed: false,
            backend: "webgl",
          });
          const [boxW, boxH] = [400, 300];
          const [outW, outH] = [960, 720];
          const crop = coverCrop(srcW, srcH, 4 / 3);
          const capture = outputToSource(plan.inverse, crop, outW, outH, mirror);
          const layout = previewLayout(plan.correction, srcW, srcH, boxW, boxH, mirror)!;
          // Parse the CSS transform back into a homography on the element's own pixels.
          const n = layout.transform.slice(9, -1).split(",").map(Number);
          const css: Mat3 = [n[0]!, n[4]!, n[12]!, n[1]!, n[5]!, n[13]!, n[3]!, n[7]!, n[15]!];
          const back = invert(css)!;
          const s = layout.width / srcW;
          for (const [u, v] of [
            [0.5, 0.5],
            [0.05, 0.1],
            [0.95, 0.9],
            [0.3, 0.8],
          ] as const) {
            // The same spot in the photo and in the preview box.
            const photo = project(capture, u * outW, v * outH);
            const local = project(back, u * boxW - layout.left, v * boxH - layout.top);
            expect(local.x / s).toBeCloseTo(photo.x, 3);
            expect(local.y / s).toBeCloseTo(photo.y, 3);
          }
        }
  });
});

describe("the shader's matrix", () => {
  it("is the pixel map between 0–1 coordinates, in column order", () => {
    const m: Mat3 = [0.9, 0.05, 20, -0.04, 1.1, 10, 1e-4, -2e-4, 1];
    const n = normalizedMap(m, 1280, 720, 960, 720);
    const asRows: Mat3 = [n[0]!, n[3]!, n[6]!, n[1]!, n[4]!, n[7]!, n[2]!, n[5]!, n[8]!];
    for (const [u, v] of [
      [0, 0],
      [1, 1],
      [0.3, 0.7],
    ] as const) {
      const direct = project(m, u * 960, v * 720);
      const viaShader = project(asRows, u, v);
      expect(viaShader.x).toBeCloseTo(direct.x / 1280, 5);
      expect(viaShader.y).toBeCloseTo(direct.y / 720, 5);
    }
  });
});

describe("FrameWarper: what draws the picture, and what happens when it cannot", () => {
  const rollOnly = () => {
    const plan = planCorrection({
      srcWidth: 1280,
      srcHeight: 720,
      aspect: 4 / 3,
      tilt: { roll: 5, pitch: 0 },
      confidence: 1,
      level: true,
      perspective: true,
      portraitGuard: true,
      fovLongDeg: 55,
      fovAssumed: true,
      backend: "canvas2d",
    });
    return outputToSource(plan.inverse, coverCrop(1280, 720, 4 / 3), 960, 720, true);
  };
  const perspective: Mat3 = [1, 0, 160, 0, 1, 0, 0, 1e-4, 1];
  const source = {} as CanvasImageSource;

  it("without WebGL draws a roll with a 2D transform of the whole frame", () => {
    const { factory, created } = fakeCanvasFactory();
    const warper = new FrameWarper({ createCanvas: factory, createGlCanvas: () => null });
    expect(warper.backend()).toBe("canvas2d");
    const outToSrc = rollOnly();
    const result = warper.render({
      source,
      srcWidth: 1280,
      srcHeight: 720,
      outWidth: 960,
      outHeight: 720,
      outToSrc,
      createCanvas: factory,
    })!;
    expect(result.backend).toBe("canvas2d");
    const canvas = created.at(-1)!;
    expect([canvas.width, canvas.height]).toEqual([960, 720]);
    const [a, b, c, d, e, f] = canvas.callsTo("setTransform")[0]!.args as number[];
    // The transform is source → output: the inverse of the sampling matrix.
    const inv = invert(outToSrc)!;
    [a, c, e, b, d, f].forEach((v, i) => expect(v).toBeCloseTo(inv[i]! / inv[8], 9));
    // Mirrored and turned: a reflection, so the determinant is negative.
    expect(a! * d! - b! * c!).toBeLessThan(0);
    expect(canvas.callsTo("drawImage")[0]!.args).toEqual([source, 0, 0, 1280, 720]);
  });

  it("without WebGL has no way to draw a perspective, and says so by returning nothing", () => {
    const { factory } = fakeCanvasFactory();
    const warper = new FrameWarper({ createCanvas: factory, createGlCanvas: () => null });
    expect(
      warper.render({
        source,
        srcWidth: 1280,
        srcHeight: 720,
        outWidth: 960,
        outHeight: 720,
        outToSrc: perspective,
        createCanvas: factory,
      }),
    ).toBeNull();
    expect(warper.lastError()).toBe("no-webgl");
  });

  /** A canvas whose WebGL context can be made to fail in chosen ways. */
  function glCanvas(behaviour: { lost?: boolean; error?: number; compile?: boolean }) {
    const calls: string[] = [];
    const gl = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "isContextLost") return () => behaviour.lost === true;
          if (prop === "getError") return () => behaviour.error ?? 0;
          if (prop === "NO_ERROR") return 0;
          if (prop === "getShaderParameter" || prop === "getProgramParameter")
            return () => behaviour.compile !== false;
          if (prop === "getParameter") return () => 4096;
          if (prop === "getExtension") return () => null;
          if (/^[A-Z_0-9]+$/.test(prop)) return 1;
          return (...args: unknown[]) => {
            calls.push(prop);
            return prop.startsWith("create") || prop.startsWith("get") ? {} : args.length;
          };
        },
      },
    ) as unknown as WebGLRenderingContext;
    const canvas: GlCanvas = { width: 0, height: 0, getContext: () => gl };
    return { canvas, calls };
  }

  const input = (factory: ReturnType<typeof fakeCanvasFactory>["factory"], outToSrc: Mat3) => ({
    source,
    srcWidth: 1280,
    srcHeight: 720,
    outWidth: 960,
    outHeight: 720,
    outToSrc,
    createCanvas: factory,
  });

  it("with WebGL draws any homography: frame → 2D canvas → texture → picture", () => {
    const { factory, created } = fakeCanvasFactory();
    const good = glCanvas({});
    const warper = new FrameWarper({ createCanvas: factory, createGlCanvas: () => good.canvas });
    expect(warper.backend()).toBe("webgl");
    const result = warper.render(input(factory, perspective))!;
    expect(result.backend).toBe("webgl");
    expect([good.canvas.width, good.canvas.height]).toEqual([960, 720]);
    expect(good.calls).toContain("texImage2D");
    expect(good.calls).toContain("uniformMatrix3fv");
    expect(good.calls).toContain("drawArrays");
    // The scratch copy of the frame is pixel for pixel, and reused for the next photo.
    const scratch = created[0]!;
    expect([scratch.width, scratch.height]).toEqual([1280, 720]);
    expect(scratch.callsTo("drawImage")[0]!.args).toEqual([source, 0, 0, 1280, 720]);
    const before = created.length;
    warper.render(input(factory, perspective));
    // One new canvas per photo (the picture itself), nothing else.
    expect(created.length).toBe(before + 1);
    expect((result.canvas as FakeCanvas).callsTo("drawImage")[0]!.args[0]).toBe(good.canvas);
  });

  it("tries a failed WebGL once more on a fresh context, then plans without it", () => {
    const { factory } = fakeCanvasFactory();
    let made = 0;
    const warper = new FrameWarper({
      createCanvas: factory,
      createGlCanvas: () => {
        made++;
        return glCanvas({ lost: true }).canvas;
      },
    });
    expect(warper.render(input(factory, perspective))).toBeNull();
    expect(made).toBe(2);
    expect(warper.lastError()).toBe("context-lost");
    expect(warper.backend()).toBe("canvas2d");
    // The roll still gets drawn, by the 2D canvas; no third context is made for it.
    expect(warper.render(input(factory, rollOnly()))!.backend).toBe("canvas2d");
    expect(made).toBe(2);
    // The next guest: WebGL is tried again.
    warper.newSession();
    expect(warper.render(input(factory, perspective))).toBeNull();
    expect(made).toBe(4);
  });

  it("recovers when only the first context was lost", () => {
    const { factory } = fakeCanvasFactory();
    let made = 0;
    const warper = new FrameWarper({
      createCanvas: factory,
      createGlCanvas: () => glCanvas({ lost: made++ === 0 }).canvas,
    });
    expect(warper.render(input(factory, perspective))!.backend).toBe("webgl");
    expect(made).toBe(2);
  });

  it("treats a GL error and a shader that will not build as WebGL not working", () => {
    for (const [behaviour, code] of [
      [{ error: 1285 }, "gl-error"],
      [{ compile: false }, "shader"],
    ] as const) {
      const { factory } = fakeCanvasFactory();
      const warper = new FrameWarper({
        createCanvas: factory,
        createGlCanvas: () => glCanvas(behaviour).canvas,
      });
      expect(warper.render(input(factory, perspective))).toBeNull();
      expect(warper.lastError()).toBe(code);
      expect(warper.render(input(factory, rollOnly()))!.backend).toBe("canvas2d");
    }
  });

  it("throws away a picture that came out black where the camera's frame was not", () => {
    // A canvas whose pixels can be read: the frame is bright, the "warped" picture is black.
    const level = new Map<object, number>();
    const factory = (w: number, h: number) => {
      const canvas = new FakeCanvas(w, h);
      const ctx = canvas.getContext() as unknown as Record<string, unknown>;
      let shows = 0;
      ctx.drawImage = (src: object) => {
        shows = src === source ? 200 : (level.get(src) ?? 0);
        level.set(canvas, shows);
      };
      ctx.getImageData = (_x: number, _y: number, cw: number, ch: number) => ({
        data: new Uint8ClampedArray(cw * ch * 4).fill(shows),
      });
      return canvas;
    };
    const black = glCanvas({});
    const warper = new FrameWarper({ createCanvas: factory, createGlCanvas: () => black.canvas });
    expect(warper.render(input(factory, perspective))).toBeNull();
    expect(warper.lastError()).toBe("bad-output");
    expect(warper.backend()).toBe("canvas2d");
  });
});

describe("capture with and without the engine", () => {
  const options = { aspect: 4 / 3, mirror: true, maxWidth: 960 };
  const source = {} as CanvasImageSource;

  it("is untouched without a corrector: the same calls as ever", () => {
    const { factory, created } = fakeCanvasFactory();
    grabFrame(source, 1280, 720, options, factory, () => 1);
    expect(created).toHaveLength(1);
    expect(created[0]!.calls.map((c) => c.name)).toEqual([
      "save",
      "translate",
      "scale",
      "drawImage",
      "restore",
    ]);
  });

  it("hands the corrector the crop, the size and the mirror of the uncorrected path", () => {
    const { factory } = fakeCanvasFactory();
    const picture = new FakeCanvas(960, 720);
    const seen: unknown[] = [];
    const frame = grabFrame(
      source,
      1280,
      720,
      {
        ...options,
        correct: (input) => {
          seen.push(input);
          return picture;
        },
      },
      factory,
      () => 42,
    );
    expect(frame.canvas).toBe(picture);
    expect([frame.width, frame.height, frame.mirrored, frame.capturedAt]).toEqual([
      960,
      720,
      true,
      42,
    ]);
    expect(seen[0]).toMatchObject({
      source,
      srcWidth: 1280,
      srcHeight: 720,
      aspect: 4 / 3,
      crop: { x: 160, y: 0, width: 960, height: 720 },
      width: 960,
      height: 720,
      mirror: true,
    });
  });

  it("takes the picture the usual way when the corrector declines or throws", () => {
    for (const correct of [
      () => null,
      () => {
        throw new Error("engine fell over");
      },
    ]) {
      const { factory, created } = fakeCanvasFactory();
      const frame = grabFrame(source, 1280, 720, { ...options, correct }, factory, () => 1);
      expect(frame.canvas).toBe(created[0]);
      expect(created[0]!.callsTo("drawImage")[0]!.args).toEqual([
        source,
        160,
        0,
        960,
        720,
        0,
        0,
        960,
        720,
      ]);
    }
  });
});
