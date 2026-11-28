// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WallFeed } from "@/lib/wall/states";
import { JPEG, uuid } from "../helpers/images";

/**
 * 「게시 중」 on the review page (2026-11-28, a user request: "미디어월에 올라가있는 사진 전부다
 * 확인하고 내릴 수 있는 것들은 내릴 수 있게"): the list holds exactly what the wall may show,
 * with no time window and paged with `before`, and one bulk hide takes the chosen photos off the
 * wall through the same audited path as the single button, never touching the guest's link.
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;
let booth = "";
let wall = "";
let staff = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-bulkhide-"));
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

async function upload(): Promise<{ id: string; token: string; sessionId: string }> {
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

async function approved() {
  const p = await upload();
  const { POST: consent } = await import("@/app/api/photos/consent/route");
  expect(
    (await consent(json("/api/photos/consent", { sessionId: p.sessionId, consent: true }, booth)))
      .status,
  ).toBe(200);
  const { POST: moderate } = await import("@/app/api/admin/photos/[id]/moderate/route");
  // In `auto` mode with no AI configured nothing is approved for us; staff approve it.
  const { getPhotoService } = await import("@/lib/storage/server");
  if ((await getPhotoService().getById(p.id))!.moderationStatus !== "APPROVED") {
    const res = await moderate(
      json(`/api/admin/photos/${p.id}/moderate`, { action: "approve" }, staff),
      params(p.id),
    );
    expect(res.status).toBe(200);
  }
  return p;
}

async function bulkHide(body: unknown, cookie = staff) {
  const { POST } = await import("@/app/api/admin/photos/bulk-hide/route");
  return POST(json("/api/admin/photos/bulk-hide", body, cookie), {
    params: Promise.resolve({}),
  });
}

async function feedIds(): Promise<string[]> {
  const { GET } = await import("@/app/api/wall/feed/route");
  const res = await GET(
    new Request(`${ORIGIN}/api/wall/feed?slots=12`, { headers: { cookie: wall } }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as WallFeed).photos.map((p) => p.id).sort();
}

const made: { id: string; token: string }[] = [];
let pending = "";

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
  for (let i = 0; i < 5; i++) made.push(await approved());
  pending = (await upload()).id; // no consent: never on the wall
}, 60_000);

describe("「게시 중」: every photo on the wall, and a bulk hide", () => {
  it("lists exactly the wall-eligible photos, newest first, and pages back with `before`", async () => {
    const { moderationSection, onWallCount } = await import("@/lib/ops/admin");
    expect(await onWallCount()).toBe(5);
    const all = await moderationSection("on-wall", 60);
    expect(all.map((p) => p.id).sort()).toEqual(made.map((p) => p.id).sort());
    expect(all.every((p) => p.status === "APPROVED" && p.wallEligible)).toBe(true);
    expect(all.map((p) => p.id)).not.toContain(pending);

    const first = await moderationSection("on-wall", 2);
    const second = await moderationSection("on-wall", 60, first[first.length - 1]!.createdAt);
    expect(first).toHaveLength(2);
    expect(new Set([...first, ...second].map((p) => p.id)).size).toBe(5);
  });

  it("refuses bad bodies and anyone without a staff session", async () => {
    expect((await bulkHide({ ids: [] })).status).toBe(400);
    expect((await bulkHide({ ids: ["not-a-uuid"] })).status).toBe(400);
    expect((await bulkHide({ ids: Array.from({ length: 121 }, () => uuid()) })).status).toBe(400);
    expect((await bulkHide({ ids: [made[0]!.id] }, "")).status).toBe(401);
    expect(await feedIds()).toEqual(made.map((p) => p.id).sort());
  });

  it("hides the chosen photos only, skips what cannot be hidden, keeps guest links", async () => {
    const chosen = [made[0]!.id, made[1]!.id, made[2]!.id];
    const unknown = uuid();
    const res = await bulkHide({ ids: [...chosen, chosen[0], pending, unknown] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hidden: string[]; skipped: string[] };
    expect(body.hidden.sort()).toEqual([...chosen].sort());
    expect(body.skipped.sort()).toEqual([pending, unknown].sort());

    expect(await feedIds()).toEqual([made[3]!.id, made[4]!.id].sort());
    const { getPhotoService } = await import("@/lib/storage/server");
    for (const id of chosen) {
      expect((await getPhotoService().getById(id))!.moderationStatus).toBe("HIDDEN");
      const { GET: audit } = await import("@/app/api/admin/photos/[id]/audit/route");
      const res = await audit(
        new Request(`${ORIGIN}/api/admin/photos/${id}/audit`, { headers: { cookie: staff } }),
        params(id),
      );
      const { events } = (await res.json()) as { events: { action: string; note: string }[] };
      expect(events.some((e) => e.action === "hide" && e.note === "일괄 숨기기")).toBe(true);
    }
    // Hiding is about the wall only: the guest's QR download still works.
    const { GET } = await import("@/app/p/[token]/image/route");
    const guest = await GET(new Request(`${ORIGIN}/p/${made[0]!.token}/image`), {
      params: Promise.resolve({ token: made[0]!.token }),
    });
    expect(guest.status).toBe(200);

    // A second tap on the same photos changes nothing.
    const again = (await (await bulkHide({ ids: chosen })).json()) as { hidden: string[] };
    expect(again.hidden).toEqual([]);
  });
});
