import { describe, expect, it } from "vitest";
import { CLOCK_KEY, clockOffset, createServerClock } from "@/lib/kiosk/clock";
import { formatStampLabel } from "@/lib/compositor/compose";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

describe("the booth's clock comes from the server, never the tablet", () => {
  it("offset = server time − the middle of the round trip", () => {
    expect(clockOffset("2026-12-24T03:00:00.000Z", 1000, 1200)).toBe(
      Date.parse("2026-12-24T03:00:00.000Z") - 1100,
    );
    expect(clockOffset("not a date", 0, 1)).toBeNull();
    expect(clockOffset("2026-12-24T03:00:00Z", 10, 5)).toBeNull();
  });

  it("a tablet a day behind still stamps the server's day (Asia/Seoul)", () => {
    const server = Date.parse("2026-12-24T15:30:00Z"); // 00:30 on the 25th in Seoul
    const tablet = server - 24 * 3600_000; // the tablet thinks it is the 24th, 00:30
    const clock = createServerClock(
      { serverIso: new Date(server).toISOString(), at: tablet },
      memoryStorage(),
      () => tablet,
    );
    expect(formatStampLabel(new Date(tablet))).toBe("'26 12 24");
    expect(formatStampLabel(clock.now())).toBe("'26 12 25");
  });

  it("each heartbeat updates the offset; the offset survives a reload offline", () => {
    let tablet = 1_000_000;
    const storage = memoryStorage();
    const clock = createServerClock({}, storage, () => tablet);
    expect(clock.offsetMs()).toBeNull();
    clock.update(new Date(tablet + 5000 + 50).toISOString(), tablet, tablet + 100);
    expect(clock.offsetMs()).toBe(5000);
    expect(storage.data[CLOCK_KEY]).toBe("5000");
    tablet += 60_000;
    const reloaded = createServerClock({}, storage, () => tablet);
    expect(reloaded.now().getTime()).toBe(tablet + 5000);
  });

  it("without any reading the tablet clock is all there is (and nothing breaks)", () => {
    const clock = createServerClock({}, null, () => 42);
    expect(clock.now().getTime()).toBe(42);
  });
});
