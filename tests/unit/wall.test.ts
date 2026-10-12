import { describe, expect, it } from "vitest";
import type { WallTimings } from "@/config/wall";
import { emptySchedule, photoPhase, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";
import { WALL_PHOTO_NEXT, wallScreenState } from "@/lib/wall/states";

const T: WallTimings = { enterMs: 1000, visibleMs: 5000, exitMs: 1000, cooldownMs: 20_000 };

function run(
  state: WallSchedule,
  from: number,
  to: number,
  eligible: string[],
  ready = new Set(eligible),
) {
  let s = state;
  for (let now = from; now <= to; now += 1000)
    s = stepSchedule(s, { now, eligible, ready, timings: T });
  return s;
}
const onWall = (s: WallSchedule) => s.slots.map((x) => x.photoId).filter(Boolean);

describe("wall scheduler", () => {
  it("fills one slot per tick, newest first, never the same photo twice at once", () => {
    let s = emptySchedule(3);
    s = stepSchedule(s, {
      now: 0,
      eligible: ["c", "b", "a"],
      ready: new Set(["a", "b", "c"]),
      timings: T,
    });
    expect(onWall(s)).toEqual(["c"]);
    s = run(s, 1000, 2000, ["c", "b", "a"]);
    expect(onWall(s)).toEqual(["c", "b", "a"]);
    s = run(s, 3000, 4000, ["c", "b", "a"]);
    expect(new Set(onWall(s)).size).toBe(onWall(s).length);
  });

  it("runs ENTER → VISIBLE → EXIT → COOLDOWN in order", () => {
    const seen: (string | null)[] = [];
    let s = emptySchedule(1);
    for (let now = 0; now <= 9000; now += 1000) {
      s = stepSchedule(s, { now, eligible: ["a"], ready: new Set(["a"]), timings: T });
      const phase = photoPhase(s, "a", now, T);
      if (seen.at(-1) !== phase) seen.push(phase);
    }
    expect(seen).toEqual(["ENTER", "VISIBLE", "EXIT", "COOLDOWN"]);
    expect(WALL_PHOTO_NEXT.EXIT).toBe("COOLDOWN");
  });

  it("a photo in COOLDOWN does not return until the cooldown is over", () => {
    let s = run(emptySchedule(1), 0, 8000, ["a"]);
    expect(photoPhase(s, "a", 8000, T)).toBe("COOLDOWN");
    s = run(s, 9000, 20_000, ["a"]);
    expect(onWall(s)).toEqual([]);
    s = run(s, 21_000, 30_000, ["a"]);
    expect(onWall(s)).toEqual(["a"]);
  });

  it("prefers never-shown photos, then the one that has rested longest", () => {
    let s = run(emptySchedule(1), 0, 8000, ["a"]);
    s = run(s, 9000, 9000, ["b", "a"]);
    expect(onWall(s)).toEqual(["b"]);
  });

  it("a photo the server stops listing leaves on the very next step, in any phase", () => {
    for (const at of [0, 2000, 6500]) {
      let s = run(emptySchedule(2), 0, at, ["a", "b"]);
      expect(onWall(s)).toContain("a");
      s = stepSchedule(s, { now: at + 1, eligible: ["b"], ready: new Set(["b"]), timings: T });
      expect(onWall(s)).not.toContain("a");
      expect(photoPhase(s, "a", at + 1, T)).toBeNull();
    }
  });

  it("an empty feed (paused, holding, revoked, offline too long) clears the wall at once", () => {
    let s = run(emptySchedule(3), 0, 3000, ["a", "b", "c"]);
    s = stepSchedule(s, { now: 3500, eligible: [], ready: new Set(), timings: T });
    expect(onWall(s)).toEqual([]);
    expect(s.lastShown).toEqual({});
  });

  it("only shows photos whose image is loaded", () => {
    const s = run(emptySchedule(2), 0, 3000, ["a", "b"], new Set(["b"]));
    expect(onWall(s)).toEqual(["b"]);
  });
});

describe("wall screen state", () => {
  const base = { booted: true, online: true, maintenance: false, approvedCount: 0 };
  it("BOOT, MAINTENANCE, OFFLINE, EMPTY, ACTIVE", () => {
    expect(wallScreenState({ ...base, booted: false })).toBe("BOOT");
    expect(wallScreenState({ ...base, maintenance: true, online: false })).toBe("MAINTENANCE");
    expect(wallScreenState({ ...base, online: false })).toBe("OFFLINE");
    expect(wallScreenState(base)).toBe("EMPTY");
    expect(wallScreenState({ ...base, approvedCount: 2 })).toBe("ACTIVE");
  });
});
