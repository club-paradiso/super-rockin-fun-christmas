// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WallFeed } from "@/lib/wall/states";
import { JPEG, uuid } from "../helpers/images";

/**
 * Phase 4 proof (DoD 2): a photo reaches the media wall only when the guest said yes AND staff
 * approved it, and only while the wall is open. Every state a photo can reach is built through
 * the real hub routes (booth upload, booth consent, staff moderation), then every way the wall
 * can ask for something is tried: the feed (with the ids echoed back as "on screen"), the image
 * route, exposure reports, staff show-now, and the switches. The guest's own download is checked
 * to be independent of all of it.
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-nevershown-"));
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

const json = (url: string, body: unknown, cookie: string) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let booth = "";
let wall = "";
let staff = "";

interface Made {
  id: string;
  token: string;
  sessionId: string;
}
type Step =
  | "yes"
  | "no"
  | "approve"
  | "reject"
  | "hide"
  | "unhide"
  | "reopen"
  | "delete"
  | "pause-submissions";

async function upload(): Promise<Made> {
  const { POST } = await import("@/app/api/photos/route");
  const sessionId = uuid();
  const res = await POST(
    new Request(`${ORIGIN}/api/photos`, {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "x-session-id": sessionId,
        "x-frame-id": "starlight-strip",
        origin: ORIGIN,
        cookie: booth,
      },
      body: JPEG,
    }),
  );
  expect(res.status).toBe(201);
  const { token } = (await res.json()) as { token: string };
  const { getPhotoService } = await import("@/lib/storage/server");
  const found = await getPhotoService().resolve(token);
  if (!found.ok) throw new Error("upload not stored");
  return { id: found.row.id, token, sessionId };
}

async function settings(body: unknown) {
  const { POST } = await import("@/app/api/admin/settings/route");
  const res = await POST(json("/api/admin/settings", body, staff), { params: Promise.resolve({}) });
  expect(res.status).toBe(200);
}

/** Runs one guest or staff step the way the booth / admin would; returns the HTTP status. */
async function step(p: Made, s: Step): Promise<number> {
  if (s === "yes" || s === "no") {
    const { POST } = await import("@/app/api/photos/consent/route");
    const res = await POST(
      json("/api/photos/consent", { sessionId: p.sessionId, consent: s === "yes" }, booth),
    );
    return res.status;
  }
  if (s === "pause-submissions") {
    await settings({ pauseSubmissions: true });
    return 200;
  }
  const { POST } = await import("@/app/api/admin/photos/[id]/moderate/route");
  const res = await POST(
    json(
      `/api/admin/photos/${p.id}/moderate`,
      s === "delete" ? { action: s, confirm: "DELETE" } : { action: s },
      staff,
    ),
    params(p.id),
  );
  return res.status;
}

/**
 * Every state, by the path that leads to it. `wall` = may be on the wall. Steps marked with a
 * status are refused on purpose (an illegal move must change nothing).
 */
const CASES: { name: string; steps: (Step | [Step, number])[]; wall: boolean }[] = [
  { name: "left without answering", steps: [], wall: false },
  { name: "said no", steps: ["no"], wall: false },
  { name: "said yes, waiting for staff", steps: ["yes"], wall: false },
  { name: "said yes, then no", steps: ["yes", "no"], wall: false },
  { name: "said yes, rejected", steps: ["yes", "reject"], wall: false },
  { name: "rejected, then reopened", steps: ["yes", "reject", "reopen"], wall: false },
  { name: "approved", steps: ["yes", "approve"], wall: true },
  { name: "approved, then hidden", steps: ["yes", "approve", "hide"], wall: false },
  { name: "hidden, then shown again", steps: ["yes", "approve", "hide", "unhide"], wall: true },
  { name: "approved, then deleted", steps: ["yes", "approve", "delete"], wall: false },
  { name: "said no; staff tried to approve", steps: ["no", ["approve", 409]], wall: false },
  { name: "no answer; staff tried to approve", steps: [["approve", 409]], wall: false },
  {
    name: "deleted; staff tried to unhide",
    steps: ["yes", "delete", ["unhide", 410]],
    wall: false,
  },
];
const made = new Map<string, Made>();
const eligible = () => CASES.filter((c) => c.wall).map((c) => made.get(c.name)!.id);
const all = () => CASES.map((c) => made.get(c.name)!.id);

async function feed(on: string[] = []): Promise<WallFeed> {
  const { GET } = await import("@/app/api/wall/feed/route");
  const res = await GET(
    new Request(`${ORIGIN}/api/wall/feed?slots=12&on=${on.join(",")}`, {
      headers: { cookie: wall },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as WallFeed;
}
async function wallImage(id: string) {
  const { GET } = await import("@/app/api/wall/photos/[id]/image/route");
  return GET(
    new Request(`${ORIGIN}/api/wall/photos/${id}/image`, { headers: { cookie: wall } }),
    params(id),
  );
}

beforeAll(async () => {
  const { POST: enroll } = await import("@/app/api/kiosk/enroll/route");
  const enrolled = (label: string) =>
    enroll(
      new Request(`${ORIGIN}/api/kiosk/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ secret: ENROLL, label }),
      }),
    ).then(cookieOf);
  booth = await enrolled("부스");
  wall = await enrolled("미디어월");
  const { addPinStaffMember } = await import("@/lib/ops/staff-admin");
  const staffId = (await addPinStaffMember("검수자", "482913", null)).userId;
  const { POST: pin } = await import("@/app/api/admin/auth/pin/route");
  staff = cookieOf(
    await pin(
      new Request(`${ORIGIN}/api/admin/auth/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ userId: staffId, pin: "482913" }),
      }),
    ),
  );
  for (const c of CASES) {
    const p = await upload();
    made.set(c.name, p);
    for (const s of c.steps) {
      const [action, expected] = Array.isArray(s) ? s : [s, 200];
      expect(await step(p, action), `${c.name}: ${action}`).toBe(expected);
    }
  }
}, 60_000);

describe("only 'yes' + staff approval ever reaches the wall", () => {
  it("the stored state of every case is what its path says", async () => {
    const { getPhotoService } = await import("@/lib/storage/server");
    for (const c of CASES) {
      const row = (await getPhotoService().getById(made.get(c.name)!.id))!;
      const onWall = row.moderationStatus === "APPROVED" && row.wallConsent && !row.deletedAt;
      expect(onWall, c.name).toBe(c.wall);
    }
  });

  it("feed: exactly the eligible photos, even when the wall claims all of them are on screen", async () => {
    const f = await feed(all());
    expect(f.mode).toBe("live");
    expect(f.photos.map((p) => p.id).sort()).toEqual(eligible().sort());
    expect(JSON.stringify(f)).not.toMatch(/objectPath|tokenHash|token|kioskId|\.jpg/);
  });

  it("image: 200 only for eligible photos; every other case answers like an unknown id", async () => {
    for (const c of CASES) {
      const res = await wallImage(made.get(c.name)!.id);
      expect(res.status, c.name).toBe(c.wall ? 200 : 404);
    }
    const unknown = await wallImage(uuid());
    expect(unknown.status).toBe(404);
  });

  it("an exposure report naming ineligible photos changes nothing", async () => {
    const { POST } = await import("@/app/api/wall/shown/route");
    const others = all().filter((id) => !eligible().includes(id));
    const res = await POST(json("/api/wall/shown", { shown: others, onWall: others }, wall));
    expect(res.status).toBeLessThan(500);
    expect((await feed(others)).photos.map((p) => p.id).sort()).toEqual(eligible().sort());
  });

  it("staff show-now cannot push an ineligible photo onto the wall", async () => {
    const { POST } = await import("@/app/api/admin/photos/[id]/show-now/route");
    for (const c of CASES.filter((x) => !x.wall)) {
      const id = made.get(c.name)!.id;
      const res = await POST(json(`/api/admin/photos/${id}/show-now`, {}, staff), params(id));
      expect([404, 409], c.name).toContain(res.status);
    }
    const f = await feed();
    expect(f.showNow.every((id) => eligible().includes(id))).toBe(true);
    expect(f.photos.map((p) => p.id).sort()).toEqual(eligible().sort());
  });

  it.each([
    ["PAUSE WALL", { pauseWall: true }, { pauseWall: false }, "paused"],
    ["SHOW HOLDING SCREEN", { showHoldingScreen: true }, { showHoldingScreen: false }, "holding"],
    ["staff turned the wall off", { wallForce: "off" }, { wallForce: "auto" }, "closed"],
  ] as const)("%s: no ids and no images, not even approved ones", async (_, on, off, mode) => {
    await settings(on);
    const f = await feed(all());
    expect([f.mode, f.photos, f.showNow]).toEqual([mode, [], []]);
    for (const id of eligible()) expect((await wallImage(id)).status).toBe(404);
    await settings(off);
    expect((await feed()).photos.map((p) => p.id).sort()).toEqual(eligible().sort());
  });

  it("PAUSE SUBMISSIONS: new 'yes' answers are refused, the wall itself keeps running", async () => {
    const p = await upload();
    await settings({ pauseSubmissions: true });
    expect(await step(p, "yes")).toBe(409);
    expect(await step(p, "approve")).toBe(409);
    expect((await feed()).photos.map((x) => x.id).sort()).toEqual(eligible().sort());
    expect((await wallImage(p.id)).status).toBe(404);
    await settings({ pauseSubmissions: false });
  });
});

describe("the guest's own download does not depend on the wall", () => {
  it("every case except a deleted photo still downloads; deleted is the same 404 as unknown", async () => {
    const { GET } = await import("@/app/p/[token]/image/route");
    const get = (token: string) =>
      GET(new Request(`${ORIGIN}/p/${token}/image`), { params: Promise.resolve({ token }) });
    for (const c of CASES) {
      const deleted = c.steps.some((s) => (Array.isArray(s) ? s[0] : s) === "delete");
      const res = await get(made.get(c.name)!.token);
      expect(res.status, c.name).toBe(deleted ? 404 : 200);
    }
    expect((await get("x".repeat(43))).status).toBe(404);
  });
});
