// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { feedSize } from "@/lib/wall/rotation";
import { WALL_CONFIG } from "@/config/wall";
import type { WallFeed } from "@/lib/wall/states";
import { defaultCameraEngine } from "@/lib/camera-engine/settings";
import type { CameraEngineStatus } from "@/lib/camera-engine/status";
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

describe("camera engine: the staff setting and the booth's status", () => {
  const admin = async (body: unknown, cookie = staff) => {
    const { POST } = await import("@/app/api/admin/settings/route");
    return POST(post("/api/admin/settings", body, cookie), { params: Promise.resolve({}) });
  };
  // The heartbeat route allows 12 beats a minute per kiosk: this file stays under that, and a
  // beat that is refused fails here rather than as a puzzling assertion later.
  const beat = async (body: unknown) => {
    const { POST } = await import("@/app/api/kiosk/heartbeat/route");
    const res = await POST(post("/api/kiosk/heartbeat", body, kiosk));
    expect(res.status).toBe(200);
    return res;
  };
  const kioskId = async () => {
    const { authenticateKiosk } = await import("@/lib/kiosk-auth/server");
    const auth = await authenticateKiosk(kiosk.slice(kiosk.indexOf("=") + 1));
    return auth.ok ? auth.kioskId! : "";
  };
  const status: CameraEngineStatus = {
    state: "full",
    reason: null,
    permission: "granted",
    sensor: "ok",
    backend: "webgl",
    roll: 3.04,
    pitch: 5.96,
    appliedRoll: 3.04,
    appliedPitch: 4.21,
    strength: 0.706,
    zoom: 1.0749,
    loss: 0.081,
    confidence: 0.988,
    profile: "generic-front",
    profileSource: "assumed",
    locked: false,
    previewMatches: true,
    pitchWarning: false,
    error: null,
  };

  it("is off by default, reaches the booth with the heartbeat, and is audited", async () => {
    const { getBackend } = await import("@/lib/storage/server");
    expect((await (await beat({ queueDepth: 0 })).json()).cameraEngine).toEqual(
      defaultCameraEngine(),
    );
    const auto = { ...defaultCameraEngine(), mode: "auto", rollOffset: -1.5, calibration: 1 };
    const res = await admin({ cameraEngine: auto });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.cameraEngine).toEqual(auto);
    expect((await (await beat({ queueDepth: 0 })).json()).cameraEngine).toEqual(auto);
    const [last] = await getBackend().audit.list({ subjectType: "settings", limit: 1 });
    expect(last).toMatchObject({ action: "update_settings", actorId: staffId });
    expect(JSON.parse(last!.toState!)).toMatchObject({ camera_engine: auto });
    // Another setting saved afterwards leaves it where it is.
    expect((await admin({ pauseWall: false })).status).toBe(200);
    expect((await getBackend().settings.get()).cameraEngine).toEqual(auto);
    expect((await admin({ cameraEngine: defaultCameraEngine() })).status).toBe(200);
  });

  it("refuses anything that is not the whole setting, and anyone who is not staff", async () => {
    const good = defaultCameraEngine();
    for (const bad of [
      null,
      "auto",
      [],
      { mode: "auto" },
      { ...good, mode: "on" },
      { ...good, level: 1 },
      { ...good, rollOffset: 15.1 },
      { ...good, pitchOffset: "3" },
      { ...good, pitchOffset: Number.NaN },
      { ...good, profile: "ipad-mini-4" },
      { ...good, fov: 20 },
      { ...good, calibration: -1 },
      { ...good, calibration: 1.5 },
      { ...good, extra: true },
    ]) {
      const res = await admin({ cameraEngine: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toMatch(/^cameraEngine/);
    }
    expect((await admin({ cameraEngine: good }, kiosk)).status).toBe(401);
    const { getBackend } = await import("@/lib/storage/server");
    expect((await getBackend().settings.get()).cameraEngine).toEqual(good);
  });

  it("stores a booth's status rounded, keeps it when a beat says nothing, drops what it cannot read", async () => {
    const { getBackend } = await import("@/lib/storage/server");
    const id = await kioskId();
    const stored = async () => (await getBackend().kiosks.get(id))!.cameraEngine;
    // A raw sensor reading sent along is not part of the contract and is never stored.
    await beat({ queueDepth: 0, cameraEngine: { ...status, gravity: [0.1, 9.7, 0.4] } });
    expect(await stored()).not.toHaveProperty("gravity");
    expect(await stored()).toEqual({
      ...status,
      roll: 3,
      pitch: 6,
      appliedRoll: 3,
      appliedPitch: 4.2,
      strength: 0.71,
      zoom: 1.07,
      loss: 0.08,
      confidence: 0.99,
    });
    const kept = await stored();
    // Nothing said, or something outside the contract: the last status stays, nothing odd is stored.
    // (Every way a status can be wrong is in tests/unit/camera-engine-status.test.ts.)
    for (const body of [
      { queueDepth: 0 },
      { queueDepth: 0, cameraEngine: { ...status, state: "perfect" } },
      { queueDepth: 0, cameraEngine: { ...status, error: "Sensor <b>text</b> from somewhere" } },
    ]) {
      await beat(body);
      expect(await stored()).toEqual(kept);
    }
    // The staff view carries it; an explicit null (engine off on that booth) clears it.
    const { GET } = await import("@/app/api/admin/kiosks/route");
    const list = (await (
      await GET(new Request(`${ORIGIN}/api/admin/kiosks`, { headers: { cookie: staff } }), {
        params: Promise.resolve({}),
      })
    ).json()) as { kiosks: { id: string; cameraEngine: CameraEngineStatus | null }[] };
    expect(list.kiosks.find((k) => k.id === id)!.cameraEngine).toMatchObject({ state: "full" });
    await beat({ queueDepth: 0, cameraEngine: null });
    expect(await stored()).toBeNull();
  });

  it("writes a failure to the log as a code, never as text", async () => {
    const log = vi.mocked(console.log);
    log.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await beat({
      queueDepth: 0,
      cameraEngine: { ...status, state: "roll-only", reason: "gl-failed", error: "context-lost" },
    });
    const lines = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((c) =>
      String(c[0]),
    );
    const line = lines.find((l) => l.includes("kiosk_camera_engine_failed"));
    expect(line).toBeDefined();
    expect(line).toContain("context-lost");
    expect(line).toContain("roll-only");
    warn.mockRestore();
    error.mockRestore();
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
