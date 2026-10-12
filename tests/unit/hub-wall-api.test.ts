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

describe("exposure report endpoint", () => {
  it("needs an enrolled display, same origin, and photo ids", async () => {
    expect((await report([], [], "")).status).toBe(401);
    expect((await report([], [], kiosk, "https://evil.example")).status).toBe(403);
    expect((await report(["not-an-id"], [])).status).toBe(400);
    expect((await report(Array.from({ length: 51 }, uuid), [])).status).toBe(400);
    expect((await report([], [])).status).toBe(200);
  });
});
