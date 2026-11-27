// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 속도 기록 (lib/kiosk/perf.ts) through the real heartbeat route (hub, local backend): what the
 * server logs from a booth's speed report, and what it refuses to. Its own file: the heartbeat is
 * rate limited per booth, and other heartbeat tests need their share of that limit.
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;
let kiosk = "";

const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-perf-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { POST: enroll } = await import("@/app/api/kiosk/enroll/route");
  const res = await enroll(post("/api/kiosk/enroll", { secret: ENROLL, label: "속도 기록" }));
  kiosk = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(kiosk).toContain("=");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("속도 기록 in the heartbeat", () => {
  it("logs known codes and whole numbers; drops everything else; needs an enrolled booth", async () => {
    const { POST } = await import("@/app/api/kiosk/heartbeat/route");
    const log = vi.mocked(console.log);
    const perfLines = () =>
      log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "kiosk_perf");
    const before = perfLines().length;
    const beat = (body: unknown, cookie = kiosk) =>
      POST(post("/api/kiosk/heartbeat", body, cookie));

    expect(
      (
        await beat({
          queueDepth: 0,
          perfProfile: "legacy",
          perf: {
            compose: { n: 2, last: 812.4, max: 900, med: 850 },
            finish: { n: 1, last: 4100, max: 4100, med: 4100 },
            // Not a code the booth has: dropped, whatever it carries.
            selfie: { n: 1, last: 1, max: 1, med: 1, data: "data:image/jpeg;base64,AAAA" },
            upload: { n: 1, last: "soon", max: 1, med: 1 },
          },
        })
      ).status,
    ).toBe(200);
    const lines = perfLines().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      profile: "legacy",
      perf: "compose=2:812/850/900 finish=1:4100/4100/4100",
    });
    expect(JSON.stringify(lines[0])).not.toContain("data:");

    // Nothing usable: no line at all. An unknown profile is logged as the usual one.
    await beat({ queueDepth: 0, perf: { selfie: { n: 1, last: 1, max: 1, med: 1 } } });
    await beat({ queueDepth: 0, perf: "fast" });
    await beat({ queueDepth: 0 });
    expect(perfLines().slice(before)).toHaveLength(1);
    await beat({
      queueDepth: 0,
      perfProfile: "<script>",
      perf: { qr: { n: 1, last: 3, max: 3, med: 3 } },
    });
    expect(perfLines().slice(before)[1]).toMatchObject({ profile: "modern", perf: "qr=1:3/3/3" });

    // No kiosk session: refused before anything is read.
    expect((await beat({ perf: { qr: { n: 1, last: 3, max: 3, med: 3 } } }, "")).status).toBe(401);
    expect(perfLines().slice(before)).toHaveLength(2);
  });
});
