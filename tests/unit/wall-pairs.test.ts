import { describe, expect, it } from "vitest";
import { WALL_CONFIG, type WallTimings } from "@/config/wall";
import { WALL_THEMES } from "@/config/wall-themes";
import { V2_FRAMES } from "@/config/frames/v2";
import { WALL_FIT, slotEnvelope, themeCuts } from "@/lib/wall/fit";
import { isStripShape, stripPairBoxes, wallLayout, type Rect } from "@/lib/wall/layout";
import { rotationOrder, type RotationExposure } from "@/lib/wall/rotation";
import { emptySchedule, photosOnWall, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";

/**
 * Tall strips two to a slot, at most `WALL_CONFIG.maxPhotos` on the wall (2026-11-28, a user
 * request: "세로로 길쭉한 템플릿은 맥시멈 8개까지").
 */

/** The four corners of `r` turned `deg` degrees about (cx, cy). */
function turned(r: Rect, cx: number, cy: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x, r.y + r.height],
    [r.x + r.width, r.y + r.height],
  ].map(([x, y]) => ({
    x: cx + (x! - cx) * Math.cos(a) - (y! - cy) * Math.sin(a),
    y: cy + (x! - cx) * Math.sin(a) + (y! - cy) * Math.cos(a),
  }));
}

describe("a pair of strips in one slot", () => {
  it("never reaches beyond what any single photo of that slot may cover, on every theme", () => {
    for (const theme of WALL_THEMES) {
      for (const { theme: look } of themeCuts(theme)) {
        const { strip } = look.scene;
        for (const place of wallLayout(look.scene).slots) {
          const env = slotEnvelope(place, look);
          const [a, b] = stripPairBoxes(place, strip, look.wideMax);
          // Side by side, apart, centred on the clip, never taller than a strip.
          expect(a.x + a.width).toBeLessThan(b.x);
          expect((a.x + b.x + b.width) / 2).toBeCloseTo(place.x, 6);
          expect(a.height).toBeLessThanOrEqual(strip.height + 1e-9);
          expect(a.width / a.height).toBeCloseTo(strip.width / strip.height, 6);
          // At every swing the wall can give it, about the slot's clip.
          const swing = Math.abs(place.tilt) + WALL_FIT.swingDeg;
          for (const deg of [-swing, swing, place.tilt])
            for (const box of [a, b])
              for (const p of turned(
                { ...box, y: place.y, height: box.height + box.y - place.y },
                place.x,
                place.y,
                deg,
              )) {
                expect(p.x).toBeGreaterThanOrEqual(env.x - 0.5);
                expect(p.x).toBeLessThanOrEqual(env.x + env.width + 0.5);
                expect(p.y).toBeLessThanOrEqual(env.y + env.height + 0.5);
              }
        }
      }
    }
  });

  it("the booth's strip frames are strips; its square and wide frames are not", () => {
    const strip = WALL_THEMES[0]!.scene.strip;
    const shapes = V2_FRAMES.map((f) => ({
      id: f.id,
      strip: isStripShape({ width: f.outputWidth, height: f.outputHeight }, strip),
    }));
    expect(shapes.some((s) => s.strip)).toBe(true);
    expect(shapes.some((s) => !s.strip)).toBe(true);
    for (const f of V2_FRAMES)
      if (isStripShape({ width: f.outputWidth, height: f.outputHeight }, strip))
        expect(f.outputHeight / f.outputWidth).toBeGreaterThan(2.5);
  });
});

const T: WallTimings = { enterMs: 1000, visibleMs: 5000, exitMs: 1000, cooldownMs: 20_000 };
const run = (
  s: WallSchedule,
  from: number,
  to: number,
  input: Omit<Parameters<typeof stepSchedule>[1], "now">,
) => {
  for (let now = from; now <= to; now += 1000) s = stepSchedule(s, { ...input, now });
  return s;
};

describe("scheduler with pairs", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "w"];
  const base = { ready: new Set(ids), timings: T, ordering: "fair" as const };

  it("two strips share a slot; a photo that is not a strip hangs alone", () => {
    const s = run(emptySchedule(3), 0, 2000, {
      ...base,
      eligible: ["a", "b", "w", "c", "d"],
      pairable: new Set(["a", "b", "c", "d"]),
    });
    expect(s.slots.map((x) => [x.photoId, x.partner ?? null])).toEqual([
      ["a", "b"],
      ["w", null],
      ["c", "d"],
    ]);
    expect(photosOnWall(s)).toEqual(["a", "b", "w", "c", "d"]);
  });

  it(`never more than ${WALL_CONFIG.maxPhotos} photos at once`, () => {
    const s = run(emptySchedule(5), 0, 4000, {
      ...base,
      eligible: ids,
      pairable: new Set(ids),
    });
    expect(photosOnWall(s)).toHaveLength(WALL_CONFIG.maxPhotos);
    expect(s.slots.filter((x) => x.partner)).toHaveLength(WALL_CONFIG.maxPhotos - 5);
    const capped = run(emptySchedule(5), 0, 4000, {
      ...base,
      eligible: ids,
      pairable: new Set(ids),
      maxPhotos: 6,
    });
    expect(photosOnWall(capped)).toHaveLength(6);
  });

  it("without `pairable` nothing pairs (the wall before this change)", () => {
    const s = run(emptySchedule(3), 0, 2000, { ...base, eligible: ids });
    expect(s.slots.every((x) => !x.partner)).toBe(true);
  });

  it("a hidden photo leaves at once; its partner stays where it hangs", () => {
    let s = run(emptySchedule(1), 0, 2000, {
      ...base,
      eligible: ["a", "b"],
      pairable: new Set(["a", "b"]),
    });
    expect(s.slots[0]).toMatchObject({ photoId: "a", partner: "b" });
    s = stepSchedule(s, { ...base, now: 3000, eligible: ["b"], pairable: new Set(["b"]) });
    expect(s.slots[0]).toMatchObject({ photoId: "b", phase: "VISIBLE" });
    expect(s.slots[0]!.partner).toBeUndefined();
    s = stepSchedule(s, { ...base, now: 4000, eligible: [], pairable: new Set() });
    expect(photosOnWall(s)).toEqual([]);
  });

  it("a pair leaves together and both rest", () => {
    const s = run(emptySchedule(1), 0, 8000, {
      ...base,
      eligible: ["a", "b"],
      pairable: new Set(["a", "b"]),
    });
    expect(s.lastShown.a).toBe(s.lastShown.b);
    expect(s.lastShown.a).toBeDefined();
  });
});

describe("fairness with pairs (real WALL_CONFIG timings)", { timeout: 120_000 }, () => {
  it("all strips, N=60 S=5, 3 h: 8 up at once, no starvation, even counts, cooldown", () => {
    const n = 60;
    const slots = 5;
    const end = 3 * 3600_000;
    const all = Array.from({ length: n }, (_, i) => `p${i}`);
    const iso = (ms: number) => new Date(Date.UTC(2026, 11, 1) + ms).toISOString();
    const photos = all.map((id, i) => ({ id, createdAt: iso(-3_600_000 + i) }));
    const exposures = new Map<string, RotationExposure>();
    const shown = new Map<string, number[]>();
    let s = emptySchedule(slots);
    let order: string[] = [];
    let unreported: string[] = [];
    let prev = new Set<string>();
    let most = 0;
    for (let now = 0; now <= end; now += WALL_CONFIG.tickMs) {
      if (now % WALL_CONFIG.pollMs === 0) {
        for (const id of unreported) {
          const old = exposures.get(id);
          exposures.set(id, { shownCount: (old?.shownCount ?? 0) + 1, lastShownAt: iso(now) });
        }
        unreported = [];
        order = rotationOrder({ eligible: photos, exposures, showNow: [] }).slice(0, 40);
        // The feed keeps what is on screen (lib/wall/server.ts `withOnWall`).
        for (const id of prev) if (!order.includes(id)) order.push(id);
      }
      s = stepSchedule(s, {
        now,
        eligible: order,
        ready: new Set(order),
        timings: WALL_CONFIG,
        ordering: "fair",
        pairable: new Set(all),
      });
      const up = photosOnWall(s);
      most = Math.max(most, up.length);
      for (const id of up)
        if (!prev.has(id)) {
          unreported.push(id);
          shown.set(id, [...(shown.get(id) ?? []), now]);
        }
      prev = new Set(up);
    }
    const counts = all.map((id) => shown.get(id)?.length ?? 0);
    let minRepeat = Infinity;
    for (const t of shown.values())
      for (let k = 1; k < t.length; k++) minRepeat = Math.min(minRepeat, t[k]! - t[k - 1]!);
    expect(most).toBe(WALL_CONFIG.maxPhotos);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(minRepeat).toBeGreaterThanOrEqual(WALL_CONFIG.cooldownMs);
  });
});
