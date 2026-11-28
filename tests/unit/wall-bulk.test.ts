// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuid } from "../helpers/images";

/**
 * 「게시 중」: taking many photos down from the wall at once, through the real route handlers and
 * the local backend (hub), with kiosk and staff auth on. No AI provider: staff approve by hand.
 */
const ORIGIN = "https://booth.example.org";
const PASSWORD = "shared-enroll-password-for-tests";
const CRON = "c".repeat(40);
let dir: string;
let photo: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-wall-bulk-"));
  Object.assign(process.env, {
    // The hub: one process, local files, PIN staff login next to the shared password.
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: PASSWORD,
    CRON_SECRET: CRON,
    PUBLIC_BASE_URL: ORIGIN,
  });
  // A synthetic picture (flat colour). No photograph of a person is used anywhere in the tests.
  photo = new Uint8Array(
    await sharp({ create: { width: 600, height: 1800, channels: 3, background: "#b98" } })
      .jpeg()
      .toBuffer(),
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const noParams = { params: Promise.resolve({}) };
const json = (url: string, body: unknown, cookie?: string, extra: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

async function enroll(label = "booth") {
  const { POST } = await import("@/app/api/kiosk/enroll/route");
  const res = await POST(json("/api/kiosk/enroll", { secret: PASSWORD, label }));
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
let staff: string;
async function staffLogin() {
  const { POST } = await import("@/app/api/admin/auth/password/route");
  const res = await POST(
    json("/api/admin/auth/password", { password: PASSWORD }, undefined, {
      "x-forwarded-for": "203.0.113.9",
    }),
  );
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("ftl_admin="))!
    .split(";")[0]!;
}
async function shoot(kiosk: string, frameId = "navy-strip") {
  const sessionId = uuid();
  const { POST } = await import("@/app/api/photos/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/photos`, {
      method: "POST",
      body: photo as BodyInit,
      headers: {
        "content-type": "image/jpeg",
        "x-session-id": sessionId,
        "x-frame-id": frameId,
        origin: ORIGIN,
        cookie: kiosk,
      },
    }),
  );
  expect(res.status).toBe(201);
  const { getPhotoService } = await import("@/lib/storage/server");
  const row = (await getPhotoService().list({ limit: 200 })).find(
    (r) => r.sessionId === sessionId,
  )!;
  return { sessionId, id: row.id };
}
async function consent(kiosk: string, sessionId: string) {
  const { POST } = await import("@/app/api/photos/consent/route");
  const res = await POST(json("/api/photos/consent", { sessionId, consent: true }, kiosk));
  expect(res.status).toBe(200);
}
async function moderate(id: string, action: string) {
  const { POST } = await import("@/app/api/admin/photos/[id]/moderate/route");
  const res = await POST(json(`/api/admin/photos/${id}/moderate`, { action }, staff), {
    params: Promise.resolve({ id }),
  });
  expect(res.status).toBe(200);
}
async function bulk(body: unknown, cookie = staff, extra: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/admin/photos/bulk/route");
  return POST(json("/api/admin/photos/bulk", body, cookie, extra), noParams);
}
const row = async (id: string) =>
  (await (await import("@/lib/storage/server")).getPhotoService().getById(id))!;
/** A booth photo a person approved for the wall. */
async function onWall() {
  const p = await shoot(kiosk);
  await consent(kiosk, p.sessionId);
  await moderate(p.id, "approve");
  return p.id;
}

let kiosk: string;
beforeAll(async () => {
  kiosk = await enroll("booth");
  staff = await staffLogin();
});

describe("POST /api/admin/photos/bulk", () => {
  it("takes every chosen photo down (HIDDEN), one audit event each, and puts them back", async () => {
    const ids = [await onWall(), await onWall(), await onWall()];
    const res = await bulk({ action: "hide", ids });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: ids, failed: [] });
    for (const id of ids) expect((await row(id)).moderationStatus).toBe("HIDDEN");
    const { getBackend } = await import("@/lib/storage/server");
    for (const id of ids) {
      const events = await getBackend().audit.list({
        subjectType: "photo",
        subjectId: id,
        limit: 5,
      });
      expect(events[0]).toMatchObject({ fromState: "APPROVED", toState: "HIDDEN" });
    }
    const back = await bulk({ action: "unhide", ids });
    expect((await back.json()).done).toEqual(ids);
    for (const id of ids) expect((await row(id)).moderationStatus).toBe("APPROVED");
  });

  it("reports a photo that is not on the wall instead of forcing it", async () => {
    const up = await onWall();
    const pending = await shoot(kiosk);
    await consent(kiosk, pending.sessionId);
    const res = await bulk({ action: "hide", ids: [up, pending.id] });
    expect(await res.json()).toEqual({
      done: [up],
      failed: [{ id: pending.id, reason: "invalid_transition" }],
    });
    expect((await row(pending.id)).moderationStatus).toBe("PENDING");
  });

  it("offers only hide and unhide: never approve, reject or delete in bulk", async () => {
    const id = await onWall();
    for (const action of ["approve", "reject", "delete", "reopen", "", null])
      expect((await bulk({ action, ids: [id], confirm: "DELETE" })).status, String(action)).toBe(
        400,
      );
    expect((await row(id)).moderationStatus).toBe("APPROVED");
  });

  it("refuses bad input and more than 200 ids", async () => {
    expect((await bulk({ action: "hide", ids: [] })).status).toBe(400);
    expect((await bulk({ action: "hide", ids: ["not-a-uuid"] })).status).toBe(400);
    expect((await bulk({ action: "hide" })).status).toBe(400);
    const many = Array.from({ length: 201 }, () => uuid());
    expect((await bulk({ action: "hide", ids: many })).status).toBe(413);
  });

  it("is a staff action: no session, a booth cookie or another origin cannot do it", async () => {
    const id = await onWall();
    expect((await bulk({ action: "hide", ids: [id] }, "")).status).toBe(401);
    expect((await bulk({ action: "hide", ids: [id] }, kiosk)).status).toBe(401);
    expect(
      (await bulk({ action: "hide", ids: [id] }, staff, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await row(id)).moderationStatus).toBe("APPROVED");
  });
});

describe("wallSection (「게시 중」)", () => {
  it("lists every wall photo newest first, a page at a time, and nothing else", async () => {
    const { wallSection } = await import("@/lib/ops/admin");
    const hidden = await onWall();
    await bulk({ action: "hide", ids: [hidden] });
    const pending = await shoot(kiosk);
    await consent(kiosk, pending.sessionId);
    const all = await wallSection({ limit: 200 });
    expect(all.photos.every((p) => p.wallEligible && p.status === "APPROVED")).toBe(true);
    expect(all.photos.map((p) => p.id)).not.toContain(hidden);
    expect(all.photos.map((p) => p.id)).not.toContain(pending.id);
    expect(all.total).toBe(all.photos.length);

    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await wallSection({ before, limit: 2 });
      seen.push(...page.photos.map((p) => p.id));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual(all.photos.map((p) => p.id));
  });

  it("never skips photos taken in the same millisecond at a page boundary", async () => {
    const { wallSection } = await import("@/lib/ops/admin");
    // Five photos stored at one instant: every page boundary falls inside the tie.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - (Date.now() % 1000)));
    const tied: string[] = [];
    try {
      for (let i = 0; i < 5; i++) tied.push(await onWall());
    } finally {
      vi.useRealTimers();
    }
    const all = await wallSection({ limit: 200 });
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let before: string | undefined;
      for (let i = 0; i < 100; i++) {
        const page = await wallSection({ before, limit });
        seen.push(...page.photos.map((p) => p.id));
        if (!page.nextBefore) break;
        before = page.nextBefore;
      }
      expect(new Set(seen).size, `limit ${limit}`).toBe(seen.length);
      expect([...seen].sort(), `limit ${limit}`).toEqual(all.photos.map((p) => p.id).sort());
      for (const id of tied) expect(seen).toContain(id);
    }
  });

  it("ignores a cursor it did not make", async () => {
    const { wallSection } = await import("@/lib/ops/admin");
    const all = await wallSection({ limit: 200 });
    for (const before of ["2026-12-24T12:00:00.000Z", "x~y", "<script>", ""])
      expect((await wallSection({ before, limit: 200 })).photos.map((p) => p.id)).toEqual(
        all.photos.map((p) => p.id),
      );
  });
});
