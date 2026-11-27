import { describe, expect, it } from "vitest";
import {
  PERF_CODES,
  PERF_KEEP,
  PERF_LABELS,
  PERF_MAX_MS,
  PerfLog,
  cleanPerfReport,
  formatPerfReport,
  isPerfCode,
  type PerfCode,
} from "@/lib/kiosk/perf";

function clock() {
  let t = 1000;
  return { now: () => t, pass: (ms: number) => (t += ms) };
}

describe("booth speed log (속도 기록)", () => {
  it("every code has a staff label and is a short lower-case word", () => {
    for (const code of PERF_CODES) {
      expect(PERF_LABELS[code]).toBeTruthy();
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
    expect(new Set(PERF_CODES).size).toBe(PERF_CODES.length);
  });

  it("records spans and reports count, last, median and max in whole milliseconds", () => {
    const c = clock();
    const log = new PerfLog(c.now);
    for (const ms of [120.4, 80, 300.6]) log.record("compose", ms);
    expect(log.rows()).toEqual([{ code: "compose", count: 3, last: 301, median: 120, max: 301 }]);
  });

  it("start() measures with the injected clock and counts a second stop only once", () => {
    const c = clock();
    const log = new PerfLog(c.now);
    const stop = log.start("upload");
    c.pass(250);
    stop();
    c.pass(999);
    stop();
    expect(log.rows()).toEqual([{ code: "upload", count: 1, last: 250, median: 250, max: 250 }]);
  });

  it("time() measures synchronous work, also when it throws", () => {
    const c = clock();
    const log = new PerfLog(c.now);
    expect(
      log.time("thumbs", () => {
        c.pass(40);
        return "drawn";
      }),
    ).toBe("drawn");
    expect(() =>
      log.time("thumbs", () => {
        c.pass(10);
        throw new Error("canvas");
      }),
    ).toThrow("canvas");
    expect(log.rows()[0]).toMatchObject({ code: "thumbs", count: 2, last: 10, max: 40 });
  });

  it("drops anything that is not a sane duration or a known code", () => {
    const log = new PerfLog(() => 0);
    log.record("compose", -1);
    log.record("compose", Number.NaN);
    log.record("compose", Number.POSITIVE_INFINITY);
    log.record("compose", PERF_MAX_MS + 1);
    log.record("photo_of_guest" as PerfCode, 10);
    expect(log.rows()).toEqual([]);
    expect(log.take()).toBeNull();
  });

  it("keeps a bounded number of samples but counts them all", () => {
    const log = new PerfLog(() => 0);
    for (let i = 1; i <= PERF_KEEP + 10; i++) log.record("capture_grab", i);
    const [row] = log.rows();
    expect(row).toMatchObject({ count: PERF_KEEP + 10, last: PERF_KEEP + 10, max: PERF_KEEP + 10 });
    // The median is over the samples kept (the latest PERF_KEEP), not the first ones.
    expect(row!.median).toBeGreaterThan(10);
  });

  it("take() hands the heartbeat the samples since the last beat, once", () => {
    const log = new PerfLog(() => 0);
    log.record("compose", 100);
    log.record("compose", 300);
    log.record("upload", 50);
    expect(log.take()).toEqual({
      compose: { n: 2, last: 300, max: 300, med: 200 },
      upload: { n: 1, last: 50, max: 50, med: 50 },
    });
    expect(log.take()).toBeNull();
    // The table on the booth keeps everything.
    expect(log.rows().map((r) => r.code)).toEqual(["compose", "upload"]);
    log.record("upload", 70);
    expect(log.take()).toEqual({ upload: { n: 1, last: 70, max: 70, med: 70 } });
  });

  it("rows come in the order of the session, whatever order they were recorded in", () => {
    const log = new PerfLog(() => 0);
    log.record("finish", 1);
    log.record("screen_pick", 1);
    log.record("boot_fonts", 1);
    expect(log.rows().map((r) => r.code)).toEqual(["boot_fonts", "screen_pick", "finish"]);
  });

  it("mirrors each span (start and duration) and survives a mirror that throws", () => {
    const c = clock();
    const seen: [string, number, number][] = [];
    const log = new PerfLog(c.now, (code, start, duration) => {
      seen.push([code, start, duration]);
      throw new Error("no User Timing here");
    });
    c.pass(500);
    log.record("encode", 200);
    expect(seen).toEqual([["encode", 1300, 200]]);
    expect(log.rows()).toHaveLength(1);
  });

  it("tells subscribers about each sample", () => {
    const log = new PerfLog(() => 0);
    let calls = 0;
    const off = log.subscribe(() => calls++);
    const before = log.getVersion();
    log.record("qr", 5);
    expect(calls).toBe(1);
    expect(log.getVersion()).not.toBe(before);
    off();
    log.record("qr", 5);
    expect(calls).toBe(1);
  });
});

describe("what the server accepts from a heartbeat", () => {
  it("keeps known codes with whole sane numbers", () => {
    expect(
      cleanPerfReport({
        compose: { n: 2, last: 300.4, max: 301, med: 200 },
        upload: { n: 1, last: 50, max: 50, med: 50 },
      }),
    ).toEqual({
      compose: { n: 2, last: 300, max: 301, med: 200 },
      upload: { n: 1, last: 50, max: 50, med: 50 },
    });
  });

  it("drops unknown codes, text, huge or negative numbers, and extra fields", () => {
    expect(
      cleanPerfReport({
        token: { n: 1, last: 1, max: 1, med: 1 },
        compose: { n: 1, last: "fast", max: 1, med: 1 },
        encode: { n: 0, last: 1, max: 1, med: 1 },
        upload: { n: 1, last: -5, max: 1, med: 1 },
        qr: { n: 1, last: PERF_MAX_MS + 1, max: 1, med: 1 },
        finish: { n: 1, last: 9, max: 9, med: 9, sessionId: "abc", note: "x" },
      }),
    ).toEqual({ finish: { n: 1, last: 9, max: 9, med: 9 } });
    for (const junk of [null, undefined, "x", 3, [], [{ n: 1 }], {}])
      expect(cleanPerfReport(junk)).toBeNull();
  });

  it("formats one compact line with nothing but codes and numbers", () => {
    const line = formatPerfReport({
      finish: { n: 1, last: 4000, max: 4000, med: 4000 },
      compose: { n: 2, last: 300, max: 301, med: 200 },
    });
    expect(line).toBe("compose=2:300/200/301 finish=1:4000/4000/4000");
    expect(line).toMatch(/^[a-z_=:/ 0-9]+$/);
  });

  it("isPerfCode is exact", () => {
    expect(isPerfCode("compose")).toBe(true);
    expect(isPerfCode("Compose")).toBe(false);
    expect(isPerfCode(1)).toBe(false);
  });
});
