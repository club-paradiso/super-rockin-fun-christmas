// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CloudClient, CloudLink, CloudResult } from "@/lib/cloud/client";
import { CloudSync } from "@/lib/cloud/sync";
import { JPEG, uuid } from "../helpers/images";

/**
 * The hub's routes with a cloud configured (FTL_ROLE=hub + CLOUD_BASE_URL). The HTTP client is
 * replaced by an in-memory cloud, injected through the same process-wide slot getCloudSync() uses.
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;
let online = true;
const live = new Map<string, string>();
let n = 0;
const removed: string[] = [];
const expired = new Set<string>(); // the cloud's retention deleted these copies
const down = <T>(): CloudResult<T> => ({ ok: false, retry: true, message: "cloud unreachable" });
const gone = <T>(): CloudResult<T> => ({ ok: false, retry: false, gone: true, message: "410" });
const issue = (s: string): CloudLink => {
  const token = `cloud-${++n}`;
  live.set(s, token);
  return { token, url: `https://cloud.example.org/p/${token}`, expiresAt: "2026-12-25T00:00:00Z" };
};
const client: CloudClient = {
  put: async (p) =>
    !online ? down() : expired.has(p.sessionId) ? gone() : { ok: true, value: issue(p.sessionId) },
  reissue: async (s) =>
    !online
      ? down()
      : expired.has(s)
        ? gone()
        : live.has(s)
          ? { ok: true, value: issue(s) }
          : { ok: false, retry: false, message: "404" },
  remove: async (s) => {
    if (!online) return down();
    live.delete(s);
    removed.push(s);
    return { ok: true, value: null };
  },
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-hubcloud-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
    CLOUD_BASE_URL: "https://cloud.example.org",
    HUB_SYNC_SECRET: "y".repeat(40),
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { getBackend } = await import("@/lib/storage/server");
  (globalThis as { __ftlCloudSync?: CloudSync }).__ftlCloudSync = new CloudSync(
    getBackend(),
    client,
  );
});
afterAll(async () => {
  const { resetCloudSyncForTests } = await import("@/lib/cloud/server");
  resetCloudSyncForTests();
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function enroll(label: string) {
  const { POST } = await import("@/app/api/kiosk/enroll/route");
  return cookieOf(await POST(post("/api/kiosk/enroll", { secret: ENROLL, label })));
}
async function upload(cookie: string, sessionId = uuid()) {
  const { POST } = await import("@/app/api/photos/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/photos`, {
      method: "POST",
      body: JPEG,
      headers: {
        "content-type": "image/jpeg",
        "x-session-id": sessionId,
        "x-frame-id": "starlight-strip",
        origin: ORIGIN,
        cookie,
      },
    }),
  );
  return { res, sessionId, body: (await res.json()) as Record<string, unknown> };
}
async function askQr(cookie: string, sessionId: string) {
  const { POST } = await import("@/app/api/photos/qr/route");
  return POST(post("/api/photos/qr", { sessionId }, cookie));
}
async function rowFor(sessionId: string) {
  const { getBackend } = await import("@/lib/storage/server");
  return (await getBackend().photos.findBySessionId(sessionId))!;
}

let kiosk = "";
let staff = "";
let staffId = "";
beforeAll(async () => {
  kiosk = await enroll("부스");
  const { addPinStaffMember } = await import("@/lib/ops/staff-admin");
  staffId = (await addPinStaffMember("책임자", "482913", null)).userId;
  const { POST } = await import("@/app/api/admin/auth/pin/route");
  staff = cookieOf(await POST(post("/api/admin/auth/pin", { userId: staffId, pin: "482913" })));
});

describe("hub upload with a cloud", () => {
  it("online: the QR is the cloud's guest link, never the hub's own", async () => {
    online = true;
    const { res, body, sessionId } = await upload(kiosk);
    expect(res.status).toBe(201);
    expect(body.url).toMatch(/^https:\/\/cloud\.example\.org\/p\/cloud-\d+$/);
    expect(body.url).toBe(`https://cloud.example.org/p/${live.get(sessionId)}`);
    expect((await rowFor(sessionId)).cloud?.state).toBe("SYNCED");
  });

  it("cloud down: 202 QR pending, the photo is on the hub and wall consent works", async () => {
    online = false;
    const { res, body, sessionId } = await upload(kiosk);
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ qr: "pending", wallSubmissions: "open" });
    expect(body.url).toBeUndefined();
    expect((await rowFor(sessionId)).cloud?.state).toBe("PENDING");

    const { POST: consent } = await import("@/app/api/photos/consent/route");
    const c = await consent(post("/api/photos/consent", { sessionId, consent: true }, kiosk));
    expect(await c.json()).toMatchObject({ moderationStatus: "PENDING" });

    expect((await askQr(kiosk, sessionId)).status).toBe(202);
    online = true;
    const ready = await askQr(kiosk, sessionId);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { url: string }).url).toMatch(/cloud\.example\.org\/p\//);
    expect((await rowFor(sessionId)).cloud?.state).toBe("SYNCED");
  });

  it("the QR endpoint answers only the kiosk that took the photo", async () => {
    online = true;
    const { sessionId } = await upload(kiosk);
    const other = await enroll("다른 부스");
    expect((await askQr(other, sessionId)).status).toBe(404);
    expect((await askQr("", sessionId)).status).toBe(401);
    expect((await askQr(kiosk, uuid())).status).toBe(404);
  });
});

describe("staff actions reach the cloud copy", () => {
  it("delete on the hub removes the cloud copy", async () => {
    online = true;
    const { sessionId } = await upload(kiosk);
    const row = await rowFor(sessionId);
    const { POST } = await import("@/app/api/admin/photos/[id]/moderate/route");
    const res = await POST(
      post(`/api/admin/photos/${row.id}/moderate`, { action: "delete", confirm: "DELETE" }, staff),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect(res.status).toBe(200);
    expect(removed).toContain(sessionId);
    expect(live.has(sessionId)).toBe(false);
    expect((await rowFor(sessionId)).cloud?.state).toBe("DELETED");
  });

  it("QR 다시 보여주기 shows a fresh cloud link (audited on the hub); 503 while offline", async () => {
    online = true;
    const { sessionId, body } = await upload(kiosk);
    const row = await rowFor(sessionId);
    const { POST } = await import("@/app/api/admin/photos/[id]/rotate-token/route");
    const call = () =>
      POST(post(`/api/admin/photos/${row.id}/rotate-token`, {}, staff), {
        params: Promise.resolve({ id: row.id }),
      });
    const res = await call();
    expect(res.status).toBe(200);
    const again = (await res.json()) as { url: string };
    expect(again.url).toMatch(/cloud\.example\.org\/p\//);
    expect(again.url).not.toBe(body.url);
    const { getBackend } = await import("@/lib/storage/server");
    const [event] = await getBackend().audit.list({
      subjectType: "photo",
      subjectId: row.id,
      limit: 1,
    });
    expect(event).toMatchObject({ action: "rotate_token", actorId: staffId });

    online = false;
    const offline = await call();
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: "cloud_unavailable" });
    online = true;

    // The cloud keeps copies for a shorter time than the hub: say so instead of "try again".
    live.delete(sessionId);
    expired.add(sessionId);
    const late = await call();
    expect(late.status).toBe(410);
    expect(await late.json()).toEqual({ error: "cloud_gone" });
    expect((await rowFor(sessionId)).cloud?.state).toBe("DELETED");
  });
});
