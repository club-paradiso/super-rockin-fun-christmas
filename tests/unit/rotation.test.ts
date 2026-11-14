import { describe, expect, it } from "vitest";
import { WALL_CONFIG, type WallTimings } from "@/config/wall";
import { ageWeight, feedSize, rotationOrder, type RotationExposure } from "@/lib/wall/rotation";
import { emptySchedule, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";

/**
 * Fair rotation (docs/ARCHITECTURE.md 1.7): the ordering function, the scheduler's show-now
 * behaviour, and long simulations that check the numeric criteria F1–F6 with the real config.
 */

const iso = (ms: number) => new Date(Date.UTC(2026, 11, 1) + ms).toISOString();
const exp = (shownCount: number, lastAtMs: number): RotationExposure => ({
  shownCount,
  lastShownAt: iso(lastAtMs),
});

describe("rotationOrder", () => {
  const photos = [
    { id: "old", createdAt: iso(0) },
    { id: "mid", createdAt: iso(1000) },
    { id: "new", createdAt: iso(2000) },
    { id: "x", createdAt: iso(3000) },
  ];

  it("never-shown photos first, in capture order", () => {
    expect(rotationOrder({ eligible: photos, exposures: new Map(), showNow: [] })).toEqual([
      "old",
      "mid",
      "new",
      "x",
    ]);
  });

  it("then fewest exposures, then shown longest ago", () => {
    const exposures = new Map([
      ["old", exp(3, 10)],
      ["mid", exp(1, 50)],
      ["new", exp(1, 20)],
    ]);
    expect(rotationOrder({ eligible: photos, exposures, showNow: [] })).toEqual([
      "x",
      "new",
      "mid",
      "old",
    ]);
  });

  it("show-now requests go first, oldest request first; unknown ids are ignored", () => {
    const exposures = new Map([["mid", exp(9, 0)]]);
    expect(
      rotationOrder({ eligible: photos, exposures, showNow: ["mid", "ghost", "new", "mid"] }),
    ).toEqual(["mid", "new", "old", "x"]);
  });

  it("feed size keeps every slot busy between polls", () => {
    expect(feedSize(5)).toBe(30);
    expect(feedSize(12)).toBe(48);
  });
});

const T: WallTimings = { enterMs: 1000, visibleMs: 5000, exitMs: 1000, cooldownMs: 20_000 };
const onWall = (s: WallSchedule) => s.slots.map((x) => x.photoId);

describe("half-life (D89)", () => {
  const MIN = 60_000;
  const at = (min: number) => Date.UTC(2026, 11, 1) + min * MIN;

  it("a photo's share halves every half-life and is 1 when the half-life is off", () => {
    expect(ageWeight(at(0), at(0), 30 * MIN)).toBe(1);
    expect(ageWeight(at(0), at(30), 30 * MIN)).toBeCloseTo(0.5);
    expect(ageWeight(at(0), at(90), 30 * MIN)).toBeCloseTo(0.125);
    expect(ageWeight(at(0), at(90), 0)).toBe(1);
    expect(ageWeight(at(0), at(90), undefined)).toBe(1);
    // A clock that is behind the photo never makes it worth more than a new one.
    expect(ageWeight(at(10), at(0), 30 * MIN)).toBe(1);
    // Very old photos keep a share: nothing is ever starved.
    expect(ageWeight(at(0), at(100_000), 30 * MIN)).toBeGreaterThan(0);
  });

  const photos = [
    { id: "old", createdAt: new Date(at(0)).toISOString() },
    { id: "new", createdAt: new Date(at(60)).toISOString() },
    { id: "never", createdAt: new Date(at(61)).toISOString() },
  ];
  const exposures = new Map([
    ["old", { shownCount: 2, lastShownAt: new Date(at(50)).toISOString() }],
    ["new", { shownCount: 3, lastShownAt: new Date(at(62)).toISOString() }],
  ]);

  it("off: the order is the fair order, whatever the clock says", () => {
    const fair = rotationOrder({ eligible: photos, exposures, showNow: [] });
    expect(fair).toEqual(["never", "old", "new"]);
    expect(
      rotationOrder({ eligible: photos, exposures, showNow: [], halfLifeMs: 0, nowMs: at(600) }),
    ).toEqual(fair);
  });

  it("on: a newer photo is due again before an older one with fewer showings", () => {
    // old is two half-lives older than new: 2 showings count as 2 / (1/4) = 8 against 3.
    expect(
      rotationOrder({
        eligible: photos,
        exposures,
        showNow: [],
        halfLifeMs: 30 * MIN,
        nowMs: at(60),
      }),
    ).toEqual(["never", "new", "old"]);
  });

  it("on: show-now and never-shown photos still come first", () => {
    expect(
      rotationOrder({
        eligible: photos,
        exposures,
        showNow: ["old"],
        halfLifeMs: 30 * MIN,
        nowMs: at(600),
      }),
    ).toEqual(["old", "never", "new"]);
  });

  it("newest ordering: showings follow the shares, and the old photos still come up", () => {
    // Twelve photos on one slot, so the 10 s rest never decides who is next.
    const T2: WallTimings = { enterMs: 1000, visibleMs: 5000, exitMs: 1000, cooldownMs: 10_000 };
    const share = [1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25];
    const ids = share.map((_, i) => `p${i}`);
    const weights = new Map(ids.map((id, i) => [id, share[i]!]));
    const count = (w?: Map<string, number>) => {
      const shown = new Map(ids.map((id) => [id, 0]));
      let s: WallSchedule = emptySchedule(1);
      for (let now = 0; now <= 8 * 3600_000; now += 1000) {
        const next = stepSchedule(s, {
          now,
          eligible: ids,
          ready: new Set(ids),
          timings: T2,
          ordering: "newest",
          weights: w,
        });
        const id = next.slots[0]!.photoId;
        if (id && id !== s.slots[0]!.photoId) shown.set(id, shown.get(id)! + 1);
        s = next;
      }
      return ids.map((id) => shown.get(id)!);
    };
    const even = count();
    expect(Math.max(...even) - Math.min(...even)).toBeLessThanOrEqual(1);

    const w = count(weights);
    const mean = (from: number) => w.slice(from, from + 4).reduce((a, b) => a + b, 0) / 4;
    expect(Math.min(...w)).toBeGreaterThan(0);
    expect(mean(0) / mean(4)).toBeGreaterThan(1.9);
    expect(mean(0) / mean(4)).toBeLessThan(2.1);
    expect(mean(0) / mean(8)).toBeGreaterThan(3.8);
    expect(mean(0) / mean(8)).toBeLessThan(4.2);
    // Photos with the same share are still treated alike.
    for (const from of [0, 4, 8])
      expect(
        Math.max(...w.slice(from, from + 4)) - Math.min(...w.slice(from, from + 4)),
      ).toBeLessThanOrEqual(1);
  });

  it("a photo that joins late starts level: no burst of turns to catch up", () => {
    const T2: WallTimings = { enterMs: 1000, visibleMs: 5000, exitMs: 1000, cooldownMs: 10_000 };
    const early = ["a", "b", "c", "d", "e", "f"];
    let s: WallSchedule = emptySchedule(1);
    const seen: string[] = [];
    for (let now = 0; now <= 3600_000; now += 1000) {
      const eligible = now < 1800_000 ? early : [...early, "late"];
      const next = stepSchedule(s, {
        now,
        eligible,
        ready: new Set(eligible),
        timings: T2,
        ordering: "newest",
      });
      const id = next.slots[0]!.photoId;
      if (id && id !== s.slots[0]!.photoId && now >= 1800_000) seen.push(id);
      s = next;
    }
    const late = seen.filter((id) => id === "late").length;
    const a = seen.filter((id) => id === "a").length;
    expect(late).toBeGreaterThan(0);
    expect(Math.abs(late - a)).toBeLessThanOrEqual(1);
  });

  it("switching the half-life off, or changing it, forgets the turns counted under it", () => {
    const T2: WallTimings = { enterMs: 1000, visibleMs: 5000, exitMs: 1000, cooldownMs: 10_000 };
    const ids = ["a", "b", "c", "d", "e", "old"];
    // "old" is ten half-lives behind the others.
    const weights = new Map(ids.map((id) => [id, id === "old" ? 2 ** -10 : 1]));
    const after = (second: { weights?: Map<string, number>; sharesKey?: number }) => {
      let s: WallSchedule = emptySchedule(1);
      const shown = new Map(ids.map((id) => [id, 0]));
      for (let now = 0; now <= 62 * 60_000; now += 1000) {
        const first = now < 2 * 60_000;
        const next = stepSchedule(s, {
          now,
          eligible: ids,
          ready: new Set(ids),
          timings: T2,
          ordering: "newest",
          ...(first ? { weights, sharesKey: 10 } : second),
        });
        const id = next.slots[0]!.photoId;
        if (!first && id && id !== s.slots[0]!.photoId) shown.set(id, shown.get(id)! + 1);
        s = next;
      }
      return ids.map((id) => shown.get(id)!);
    };
    // Off: every photo, the old one included, gets the same number of turns again at once.
    const off = after({});
    expect(Math.max(...off) - Math.min(...off)).toBeLessThanOrEqual(1);
    // A different half-life under which all six are equal: the same.
    const changed = after({ weights: new Map(ids.map((id) => [id, 1])), sharesKey: 600 });
    expect(Math.max(...changed) - Math.min(...changed)).toBeLessThanOrEqual(1);
  });

  it("the time a photo stays up follows the timing it is given", () => {
    const stay = (visibleMs: number) => {
      let s: WallSchedule = emptySchedule(1);
      let from = -1;
      for (let now = 0; now <= 200_000; now += 1000) {
        s = stepSchedule(s, {
          now,
          eligible: ["a"],
          ready: new Set(["a"]),
          timings: { enterMs: 1000, visibleMs, exitMs: 1000, cooldownMs: 0 },
        });
        if (s.slots[0]!.phase === "VISIBLE" && from < 0) from = now;
        if (s.slots[0]!.phase === "EXIT" && from >= 0) return now - from;
      }
      return -1;
    };
    expect(stay(8000)).toBe(8000);
    expect(stay(60_000)).toBe(60_000);
  });
});

describe("scheduler with fair ordering", () => {
  it("takes the first usable photo in the server's order", () => {
    const s = stepSchedule(emptySchedule(2), {
      now: 0,
      eligible: ["b", "a"],
      ready: new Set(["a", "b"]),
      timings: T,
      ordering: "fair",
    });
    expect(onWall(s)).toEqual(["b", null]);
  });

  it("show-now: pushes the longest-visible photo out, then takes its place", () => {
    let s = emptySchedule(2);
    const base = { ready: new Set(["a", "b", "c"]), timings: T, ordering: "fair" as const };
    for (let now = 0; now <= 3000; now += 1000)
      s = stepSchedule(s, { ...base, now, eligible: ["a", "b", "c"] });
    expect(onWall(s)).toEqual(["a", "b"]);
    s = stepSchedule(s, {
      ...base,
      now: 4000,
      eligible: ["c", "a", "b"],
      showNow: new Set(["c"]),
    });
    expect(s.slots[0]!.phase).toBe("EXIT"); // a was visible longest
    expect(s.slots[1]!.phase).toBe("VISIBLE");
    for (let now = 5000; now <= 6000; now += 1000)
      s = stepSchedule(s, { ...base, now, eligible: ["c", "a", "b"], showNow: new Set(["c"]) });
    expect(onWall(s)).toEqual(["c", "b"]);
  });

  it("show-now ignores the cooldown and never pushes out another show-now photo", () => {
    let s = emptySchedule(1);
    const base = { ready: new Set(["a", "b"]), timings: T, ordering: "fair" as const };
    for (let now = 0; now <= 7000; now += 1000)
      s = stepSchedule(s, { ...base, now, eligible: ["a"] });
    expect(onWall(s)).toEqual([null]); // a is resting
    s = stepSchedule(s, { ...base, now: 8000, eligible: ["a"], showNow: new Set(["a"]) });
    expect(onWall(s)).toEqual(["a"]);
    for (let now = 9000; now <= 11_000; now += 1000)
      s = stepSchedule(s, {
        ...base,
        now,
        eligible: ["a", "b"],
        showNow: new Set(["a", "b"]),
      });
    expect(onWall(s)).toEqual(["a"]); // b waits; a is not cut short
  });
});

// ── simulation ─────────────────────────────────────────────────────────────────────────────

/** Small seeded PRNG so every run is the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimEvent {
  at: number;
  kind: "approve" | "hide" | "showNow";
  id: string;
}

interface SimResult {
  /** photo id → appearance start times (ms). */
  appearances: Map<string, number[]>;
  /** id → [eligible from, eligible until (null = still)]. */
  eligibleSpan: Map<string, [number, number | null]>;
  /** hide time → time the photo was last on a slot. */
  hiddenGoneAfter: number[];
  showNowDelays: number[];
  /** Hides of a photo that was on screen at that moment. */
  hidesOnWall: number;
  firstShowDelays: { delay: number; waitingAhead: number }[];
  maxFeed: number;
}

/**
 * Mirrors components/wall/wall-app.tsx against lib/wall/server.ts: every poll the wall gets the
 * hub's order (top `feedSize` + what is on screen) and then reports what went up since the last
 * report. Images are treated as instantly ready; one scheduler step per second.
 */
function simulate(opts: {
  initial: number;
  slots: number;
  durationMs: number;
  events?: SimEvent[];
}): SimResult {
  const { pollMs, tickMs } = WALL_CONFIG;
  const timings: WallTimings = WALL_CONFIG;
  const events = [...(opts.events ?? [])].sort((a, b) => a.at - b.at);
  const created = new Map<string, number>();
  const eligible = new Set<string>();
  const exposures = new Map<string, RotationExposure>();
  const showNowQueue: { id: string; at: number }[] = [];
  const result: SimResult = {
    appearances: new Map(),
    eligibleSpan: new Map(),
    hiddenGoneAfter: [],
    showNowDelays: [],
    hidesOnWall: 0,
    firstShowDelays: [],
    maxFeed: 0,
  };
  const approve = (id: string, at: number) => {
    const waitingAhead = [...eligible].filter((p) => !exposures.has(p)).length;
    created.set(id, at);
    eligible.add(id);
    result.eligibleSpan.set(id, [at, null]);
    pending.set(id, { at, waitingAhead });
  };
  const pending = new Map<string, { at: number; waitingAhead: number }>();
  for (let i = 0; i < opts.initial; i++) {
    const id = `p${i}`;
    created.set(id, -opts.initial + i);
    eligible.add(id);
    result.eligibleSpan.set(id, [0, null]);
  }

  let schedule = emptySchedule(opts.slots);
  let feed: { ids: string[]; showNow: Set<string> } = { ids: [], showNow: new Set() };
  let unreported: string[] = [];
  let prevOnWall: string[] = [];
  const hides: { id: string; at: number }[] = [];
  const waitingShowNow = new Map<string, number>();

  for (let now = 0; now <= opts.durationMs; now += tickMs) {
    while (events.length && events[0]!.at <= now) {
      const e = events.shift()!;
      if (e.kind === "approve") approve(e.id, now);
      // "@onwall": hide whatever is on screen first, so F6 is exercised every time.
      const hideId = e.id === "@onwall" ? prevOnWall[0] : e.id;
      if (e.kind === "hide" && hideId && eligible.delete(hideId)) {
        result.eligibleSpan.get(hideId)![1] = now;
        hides.push({ id: hideId, at: now });
      }
      if (e.kind === "showNow" && eligible.has(e.id) && !waitingShowNow.has(e.id)) {
        showNowQueue.push({ id: e.id, at: now });
        waitingShowNow.set(e.id, now);
      }
    }
    if (now % pollMs === 0) {
      // GET /api/wall/feed?on=… (lib/wall/server.ts)
      const photos = [...eligible].map((id) => ({ id, createdAt: iso(created.get(id)!) }));
      const showNow = showNowQueue.map((r) => r.id).filter((id) => eligible.has(id));
      const order = rotationOrder({ eligible: photos, exposures, showNow });
      const ids = order.slice(0, feedSize(opts.slots));
      for (const id of prevOnWall) if (eligible.has(id) && !ids.includes(id)) ids.push(id);
      feed = { ids, showNow: new Set(showNow) };
      result.maxFeed = Math.max(result.maxFeed, ids.length);
      // POST /api/wall/shown (MemoryWallRepository.report)
      for (const id of unreported) {
        const old = exposures.get(id);
        exposures.set(id, { shownCount: (old?.shownCount ?? 0) + 1, lastShownAt: iso(now) });
      }
      const done = new Set([...unreported, ...prevOnWall]);
      for (let i = showNowQueue.length - 1; i >= 0; i--)
        if (done.has(showNowQueue[i]!.id)) showNowQueue.splice(i, 1);
      unreported = [];
    }
    // The wall only learns about a hide from its next poll, so it steps on its last feed.
    schedule = stepSchedule(schedule, {
      now,
      eligible: feed.ids,
      ready: new Set(feed.ids),
      timings,
      ordering: "fair",
      showNow: feed.showNow,
    });
    const ids = schedule.slots.map((s) => s.photoId).filter((id): id is string => !!id);
    for (const slot of schedule.slots) {
      const id = slot.photoId;
      if (!id || slot.phase !== "ENTER" || prevOnWall.includes(id)) continue;
      unreported.push(id);
      const list = result.appearances.get(id) ?? [];
      list.push(now);
      result.appearances.set(id, list);
      const p = pending.get(id);
      if (p) {
        result.firstShowDelays.push({ delay: now - p.at, waitingAhead: p.waitingAhead });
        pending.delete(id);
      }
    }
    // A show-now request is met as soon as the photo is on screen (already there counts).
    for (const id of ids) {
      const sn = waitingShowNow.get(id);
      if (sn === undefined) continue;
      result.showNowDelays.push(now - sn);
      waitingShowNow.delete(id);
    }
    for (const h of hides) if (ids.includes(h.id)) result.hiddenGoneAfter.push(now - h.at);
    result.hidesOnWall = hides.length;
    prevOnWall = ids;
  }
  return result;
}

/** Per-slot cycle with 1 s scheduler steps: 1.5 s enter → 2 s, 14 s → 14 s, 1.5 s → 2 s. */
const CYCLE_MS = 18_000;
const P = WALL_CONFIG.pollMs;

/** F3: longest wait between two showings of a photo that stays eligible. */
const f3Bound = (n: number, slots: number) =>
  Math.max(Math.ceil(n / slots) * CYCLE_MS, CYCLE_MS + WALL_CONFIG.cooldownMs) + CYCLE_MS + P;

/** `FTL_SIM_REPORT=1 npx vitest run tests/unit/rotation.test.ts` prints the measured values. */
function report(label: string, values: Record<string, number | string>) {
  if (process.env.FTL_SIM_REPORT) console.log(`[sim] ${label}`, JSON.stringify(values));
}

function gaps(times: number[], from: number, to: number) {
  const points = [from, ...times, to];
  return points.slice(1).map((t, i) => t - points[i]!);
}

// Long virtual runs: allow time on a busy CI runner.
describe("fairness simulation (real WALL_CONFIG timings)", { timeout: 180_000 }, () => {
  it("timings used by the criteria match config/wall.ts", () => {
    expect([WALL_CONFIG.enterMs, WALL_CONFIG.visibleMs, WALL_CONFIG.exitMs]).toEqual([
      1500, 14_000, 1500,
    ]);
    expect([WALL_CONFIG.pollMs, WALL_CONFIG.tickMs, WALL_CONFIG.cooldownMs]).toEqual([
      5000, 1000, 60_000,
    ]);
  });

  it.each([
    { n: 500, slots: 6, hours: 12 },
    { n: 50, slots: 5, hours: 12 },
    { n: 7, slots: 6, hours: 2 },
    // The clothesline's real photo counts (D61): 16:9 → 3, 32:9 → 8, 4:1 → 9.
    { n: 300, slots: 3, hours: 5 },
    { n: 1260, slots: 8, hours: 5 },
    { n: 1260, slots: 9, hours: 5 },
  ])(
    "steady wall, N=$n S=$slots, $hours h: F3 no starvation, F4 even, F5 cooldown",
    ({ n, slots, hours }) => {
      const end = hours * 3600_000;
      const r = simulate({ initial: n, slots, durationMs: end });
      const bound = f3Bound(n, slots);
      let maxGap = 0;
      let minRepeat = Infinity;
      const counts: number[] = [];
      for (let i = 0; i < n; i++) {
        const times = r.appearances.get(`p${i}`) ?? [];
        counts.push(times.length);
        // Window edges: first appearance after start, and the open gap at the end.
        maxGap = Math.max(maxGap, ...gaps(times, 0, end));
        for (let k = 1; k < times.length; k++)
          minRepeat = Math.min(minRepeat, times[k]! - times[k - 1]!);
      }
      report(`steady N=${n} S=${slots} ${hours}h`, {
        maxGapS: maxGap / 1000,
        boundS: bound / 1000,
        minCount: Math.min(...counts),
        maxCount: Math.max(...counts),
        minRepeatS: minRepeat / 1000,
      });
      expect(Math.min(...counts)).toBeGreaterThan(0);
      expect(maxGap).toBeLessThanOrEqual(bound); // F3
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1); // F4
      expect(minRepeat).toBeGreaterThanOrEqual(WALL_CONFIG.cooldownMs); // F5
      expect(r.maxFeed).toBeLessThanOrEqual(feedSize(slots) + slots);
    },
  );

  it("N=5000 S=6, 9 h: every photo shown, no starvation, even counts", () => {
    const n = 5000;
    const slots = 6;
    const end = 9 * 3600_000;
    const r = simulate({ initial: n, slots, durationMs: end });
    const bound = f3Bound(n, slots);
    let maxGap = 0;
    const counts: number[] = [];
    for (let i = 0; i < n; i++) {
      const times = r.appearances.get(`p${i}`) ?? [];
      counts.push(times.length);
      maxGap = Math.max(maxGap, ...gaps(times, 0, end));
    }
    report("steady N=5000 S=6 9h", {
      maxGapS: maxGap / 1000,
      boundS: bound / 1000,
      minCount: Math.min(...counts),
      maxCount: Math.max(...counts),
    });
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(maxGap).toBeLessThanOrEqual(bound);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  }, 120_000);

  it("busy evening, 6 h: F1 show-now, F2 first showing, F6 hidden photos leave", () => {
    const rand = rng(2026);
    const slots = 6;
    const end = 6 * 3600_000;
    const events: SimEvent[] = [];
    let id = 0;
    // A new approval every 20–100 s (≈ 70 per hour, above the plan's 20 groups/h per booth).
    for (let t = 30_000; t < end; t += 20_000 + Math.floor(rand() * 80_000))
      events.push({ at: t, kind: "approve", id: `n${id++}` });
    const approved = events.map((e) => e.id);
    // Staff "지금 띄우기" about every 7 minutes, hides about every 15 minutes.
    // 421 s apart, so requests land at every offset between two polls.
    for (let t = 120_000; t < end; t += 421_000)
      events.push({ at: t, kind: "showNow", id: approved[Math.floor((rand() * t) / 100_000)]! });
    for (let t = 300_000; t < end; t += 900_000)
      events.push({ at: t, kind: "hide", id: approved[Math.floor((rand() * t) / 100_000)]! });
    // 601 s apart, so the hides land at every offset between two polls.
    for (let t = 450_000; t < end; t += 601_000)
      events.push({ at: t, kind: "hide", id: "@onwall" });

    const r = simulate({ initial: 40, slots, durationMs: end, events });

    const firsts = r.firstShowDelays.map((d) => d.delay).sort((a, b) => a - b);
    report("busy evening 6h", {
      approvals: r.firstShowDelays.length,
      showNow: r.showNowDelays.length,
      showNowMaxS: Math.max(...r.showNowDelays) / 1000,
      firstShowP50S: firsts[Math.floor(firsts.length * 0.5)]! / 1000,
      firstShowP95S: firsts[Math.floor(firsts.length * 0.95)]! / 1000,
      firstShowMaxS: firsts.at(-1)! / 1000,
      hiddenGoneMaxS: (Math.max(0, ...r.hiddenGoneAfter) + 1000) / 1000,
      hidesOnWall: r.hidesOnWall,
    });
    // F1: show-now on screen within 10 s.
    expect(r.showNowDelays.length).toBeGreaterThan(30);
    expect(Math.max(...r.showNowDelays)).toBeLessThanOrEqual(10_000);
    // F2: first showing within ceil((waiting + 1) / S) × cycle + poll + 2 s; ≤ 30 s when ≤ S wait.
    expect(r.firstShowDelays.length).toBeGreaterThan(300);
    for (const { delay, waitingAhead } of r.firstShowDelays) {
      expect(delay).toBeLessThanOrEqual(
        Math.ceil((waitingAhead + 1) / slots) * CYCLE_MS + P + 2000,
      );
      if (waitingAhead <= slots) expect(delay).toBeLessThanOrEqual(30_000);
    }
    // Plan target: 95% of first showings within 90 s.
    const sorted = r.firstShowDelays.map((d) => d.delay).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.95)]!).toBeLessThanOrEqual(90_000);
    // F6: a hidden photo is off the wall within one poll (it is gone on the step after the
    // last tick it was seen, hence + 1 s).
    expect(r.hidesOnWall).toBeGreaterThan(30);
    expect(Math.max(0, ...r.hiddenGoneAfter) + 1000).toBeLessThanOrEqual(P + 1000);
  });

  it("edge cases: no photos, one photo", () => {
    expect(simulate({ initial: 0, slots: 6, durationMs: 600_000 }).appearances.size).toBe(0);
    const one = simulate({ initial: 1, slots: 6, durationMs: 600_000 });
    const times = one.appearances.get("p0")!;
    for (let k = 1; k < times.length; k++)
      expect(times[k]! - times[k - 1]!).toBeGreaterThanOrEqual(WALL_CONFIG.cooldownMs);
  });
});
