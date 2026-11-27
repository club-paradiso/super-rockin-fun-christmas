// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { feedSize } from "@/lib/wall/rotation";
import { WALL_CONFIG } from "@/config/wall";
import type { WallFeed } from "@/lib/wall/states";
import { JPEG, uuid } from "../helpers/images";

/**
 * Fair rotation through the real hub routes (FTL_ROLE=hub, local backend): ordered feed, on-screen
 * photos kept, exposure reports, and staff show-now.
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-hubwall-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const post = (url: string, body: unknown, cookie?: string, origin = ORIGIN) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

let kiosk = "";
let staff = "";
let staffId = "";
const approved: string[] = [];

async function feed(on: string[] = []): Promise<WallFeed> {
  const { GET } = await import("@/app/api/wall/feed/route");
  const res = await GET(
    new Request(`${ORIGIN}/api/wall/feed${on.length ? `?on=${on.join(",")}` : ""}`, {
      headers: { cookie: kiosk },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as WallFeed;
}
async function report(shown: string[], onWall: string[], cookie = kiosk, origin = ORIGIN) {
  const { POST } = await import("@/app/api/wall/shown/route");
  return POST(post("/api/wall/shown", { shown, onWall }, cookie, origin));
}
async function showNow(id: string, cookie = staff) {
  const { POST } = await import("@/app/api/admin/photos/[id]/show-now/route");
  return POST(post(`/api/admin/photos/${id}/show-now`, {}, cookie), {
    params: Promise.resolve({ id }),
  });
}

/**
 * Stored photo → consent YES → staff approve. Goes through PhotoService directly: the upload
 * route's per-kiosk rate limit (30/min) would stop a test that needs 34 photos.
 */
async function approvedPhoto(): Promise<string> {
  const { getPhotoService } = await import("@/lib/storage/server");
  const service = getPhotoService();
  const { token } = await service.put({
    sessionId: uuid(),
    kioskId: null,
    frameId: "starlight-strip",
    mime: "image/jpeg",
    data: JPEG,
  });
  const resolved = await service.resolve(token);
  if (!resolved.ok) throw new Error("store failed");
  await service.setWallConsent(token, true, null);
  const result = await service.moderate(resolved.row.id, "approve", staffId, null);
  if (!result.ok) throw new Error(result.reason);
  return resolved.row.id;
}

beforeAll(async () => {
  const { POST: enroll } = await import("@/app/api/kiosk/enroll/route");
  kiosk = cookieOf(await enroll(post("/api/kiosk/enroll", { secret: ENROLL, label: "벽+부스" })));
  const { addPinStaffMember } = await import("@/lib/ops/staff-admin");
  staffId = (await addPinStaffMember("검수자", "482913", null)).userId;
  const { POST: pin } = await import("@/app/api/admin/auth/pin/route");
  staff = cookieOf(await pin(post("/api/admin/auth/pin", { userId: staffId, pin: "482913" })));
  for (let i = 0; i < feedSize(WALL_CONFIG.slots) + 4; i++) approved.push(await approvedPhoto());
}, 60_000);

describe("fair feed on the hub", () => {
  it("is ordered, capped at the feed size, and starts with the oldest never-shown photo", async () => {
    const f = await feed();
    expect(f.mode).toBe("live");
    expect(f.ordering).toBe("fair");
    expect(f.photos).toHaveLength(feedSize(WALL_CONFIG.slots));
    expect(f.photos.map((p) => p.id)).toEqual(approved.slice(0, f.photos.length));
    expect(JSON.stringify(f)).not.toMatch(/objectPath|tokenHash|kioskId|\.jpg/);
  });

  it("a reported photo moves to the back, but stays listed while it is on screen", async () => {
    const first = approved[0]!;
    expect((await report([first], [first])).status).toBe(200);
    const moved = await feed();
    expect(moved.photos.map((p) => p.id)).not.toContain(first);
    expect(moved.photos[0]!.id).toBe(approved[1]);
    const kept = await feed([first]);
    expect(kept.photos.at(-1)!.id).toBe(first);
  });

  it("on-screen ids that are not eligible are never echoed back", async () => {
    const stranger = uuid();
    const f = await feed([stranger]);
    expect(f.photos.map((p) => p.id)).not.toContain(stranger);
  });
});

describe("show-now", () => {
  it("staff only, approved + consented only, unknown → 404", async () => {
    expect((await showNow(approved[5]!, kiosk)).status).toBe(401);
    expect((await showNow(uuid())).status).toBe(404);
    const { getPhotoService } = await import("@/lib/storage/server");
    await getPhotoService().moderate(approved[6]!, "hide", staffId, null);
    const hidden = await showNow(approved[6]!);
    expect(hidden.status).toBe(409);
    expect(((await hidden.json()) as { error: string }).error).toBe("not_on_wall");
  });

  it("puts the photo first and flags it; audited; cleared once it is on screen", async () => {
    const target = approved.at(-1)!; // last in line
    expect((await showNow(target)).status).toBe(200);
    const f = await feed();
    expect(f.photos[0]!.id).toBe(target);
    expect(f.showNow).toEqual([target]);

    const { getBackend } = await import("@/lib/storage/server");
    const [event] = await getBackend().audit.list({
      subjectType: "photo",
      subjectId: target,
      limit: 1,
    });
    expect(event).toMatchObject({ action: "wall_show_now", actorId: staffId });

    await report([], [target]);
    expect((await feed()).showNow).toEqual([]);
  });

  it("PAUSE WALL sends nothing, show-now included", async () => {
    const { getBackend } = await import("@/lib/storage/server");
    await showNow(approved[3]!);
    await getBackend().settings.update({ pauseWall: true }, staffId);
    const f = await feed([approved[3]!]);
    expect([f.mode, f.photos, f.showNow]).toEqual(["paused", [], []]);
    await getBackend().settings.update({ pauseWall: false }, staffId);
  });
});

describe("opening hours on the hub", () => {
  async function settings(body: unknown, cookie = staff) {
    const { POST } = await import("@/app/api/admin/settings/route");
    return POST(post("/api/admin/settings", body, cookie), { params: Promise.resolve({}) });
  }
  async function image(id: string) {
    const { GET } = await import("@/app/api/wall/photos/[id]/image/route");
    return GET(
      new Request(`${ORIGIN}/api/wall/photos/${id}/image`, { headers: { cookie: kiosk } }),
      {
        params: Promise.resolve({ id }),
      },
    );
  }

  it("staff only; refuses nonsense hours and forces", async () => {
    expect((await settings({ wallForce: "off" }, "")).status).toBe(401);
    expect((await settings({ wallForce: "sometimes" })).status).toBe(400);
    expect((await settings({ wallHours: { start: "17:00", end: "17:00" } })).status).toBe(400);
    expect((await settings({ wallHours: { start: "5pm", end: "10pm" } })).status).toBe(400);
  });

  it("closed (staff off): no photo ids and no images reach the wall; on again: back", async () => {
    expect((await image(approved[0]!)).status).toBe(200);
    expect((await settings({ wallForce: "off" })).status).toBe(200);
    const closed = await feed();
    expect([closed.mode, closed.photos, closed.showNow]).toEqual(["closed", [], []]);
    expect((await image(approved[0]!)).status).toBe(404);
    expect((await settings({ wallForce: "auto" })).status).toBe(200);
    expect((await feed()).mode).toBe("live");
  });

  it("outside the hours the wall is told when it opens again", async () => {
    const { localHHMM } = await import("@/lib/wall/hours");
    // A one-minute window an hour from now is certainly not now.
    const later = new Date(Date.now() + 3_600_000);
    const start = localHHMM(later, WALL_CONFIG.timeZone);
    const end = localHHMM(new Date(later.getTime() + 60_000), WALL_CONFIG.timeZone);
    expect((await settings({ wallHours: { start, end } })).status).toBe(200);
    expect(await feed()).toMatchObject({ mode: "closed", photos: [], opensAt: start });
    expect((await settings({ wallForce: "on" })).status).toBe(200);
    expect((await feed()).mode).toBe("live");
    expect((await settings({ wallForce: "auto", wallHours: null })).status).toBe(200);
    expect((await feed()).mode).toBe("live");
  });
});

describe("wall heartbeat metrics", () => {
  it("stores frame rate and memory; drops values that make no sense", async () => {
    const { POST } = await import("@/app/api/kiosk/heartbeat/route");
    const { getBackend } = await import("@/lib/storage/server");
    const { authenticateKiosk } = await import("@/lib/kiosk-auth/server");
    const auth = await authenticateKiosk(kiosk.slice(kiosk.indexOf("=") + 1));
    const id = auth.ok ? auth.kioskId! : "";
    const beat = (body: unknown) => POST(post("/api/kiosk/heartbeat", body, kiosk));
    expect((await beat({ queueDepth: 0, frameRate: 58.73, memoryMb: 210 })).status).toBe(200);
    expect(await getBackend().kiosks.get(id)).toMatchObject({ frameRate: 58.7, memoryMb: 210 });
    await beat({ queueDepth: 0, frameRate: 9999, memoryMb: -1 });
    expect(await getBackend().kiosks.get(id)).toMatchObject({ frameRate: null, memoryMb: null });
  });
});

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

describe("exposure report endpoint", () => {
  it("needs an enrolled display, same origin, and photo ids", async () => {
    expect((await report([], [], "")).status).toBe(401);
    expect((await report([], [], kiosk, "https://evil.example")).status).toBe(403);
    expect((await report(["not-an-id"], [])).status).toBe(400);
    expect((await report(Array.from({ length: 51 }, uuid), [])).status).toBe(400);
    expect((await report([], [])).status).toBe(200);
  });
});
