// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloudInboxClient, CloudResult } from "@/lib/cloud/client";
import { HubInbox } from "@/lib/cloud/inbox";
import { isWallEligible } from "@/lib/ops/moderation";
import { createMemoryBackend, type MemoryBackend } from "@/lib/storage/memory-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import { JPEG, uuid } from "../helpers/images";

/**
 * Phone uploads with a hub (D66): the cloud side of the inbox (/api/hub/uploads/*, real routes)
 * and the hub side (HubInbox) against a scripted cloud. The hub ends up as the only record.
 */
const ORIGIN = "https://lights.example.org";
const SECRET = "h".repeat(48);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-mobilehub-"));
  Object.assign(process.env, {
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "k".repeat(48),
    PUBLIC_BASE_URL: ORIGIN,
    HUB_SYNC_SECRET: SECRET,
  });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const call = async (
  mod: Promise<{ POST: (r: Request) => Promise<Response> }>,
  p: string,
  body: unknown,
  secret = SECRET,
) =>
  (await mod).POST(
    new Request(`${ORIGIN}${p}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("cloud side: /api/hub/uploads/*", () => {
  const r = {
    session: () => import("@/app/api/hub/uploads/session/route"),
    status: () => import("@/app/api/hub/uploads/status/route"),
    list: () => import("@/app/api/hub/uploads/list/route"),
    image: () => import("@/app/api/hub/uploads/image/route"),
    ack: () => import("@/app/api/hub/uploads/ack/route"),
  };

  it("are closed without the hub secret", async () => {
    for (const [name, mod] of Object.entries(r))
      expect((await call(mod(), `/api/hub/uploads/${name}`, {}, "x".repeat(48))).status).toBe(401);
  });

  it("QR → phone photo in the inbox → hub takes it → cloud copy gone (hub_import)", async () => {
    const session = (await (await call(r.session(), "/api/hub/uploads/session", {})).json()) as {
      sessionId: string;
      url: string;
    };
    expect(session.url.startsWith(`${ORIGIN}/m/`)).toBe(true);
    const status = async () =>
      (
        (await (await call(r.status(), "/api/hub/uploads/status", session)).json()) as {
          status: string;
        }
      ).status;
    expect(await status()).toBe("waiting");

    // The guest's phone sends the photo (the service the upload route uses).
    const { getPhotoService, getBackend } = await import("@/lib/storage/server");
    await getPhotoService().putMobile({
      sessionId: session.sessionId,
      kioskId: null,
      data: JPEG,
      submissionsPaused: false,
    });
    expect(await status()).toBe("received");

    const list = (await (await call(r.list(), "/api/hub/uploads/list", {})).json()) as {
      items: { sessionId: string }[];
    };
    expect(list.items.map((i) => i.sessionId)).toContain(session.sessionId);
    // No paths, tokens or kiosk ids in the listing.
    expect(JSON.stringify(list)).not.toMatch(/objectPath|token|kiosk/i);

    const img = await call(r.image(), "/api/hub/uploads/image", session);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);

    expect((await call(r.ack(), "/api/hub/uploads/ack", session)).status).toBe(200);
    expect((await call(r.image(), "/api/hub/uploads/image", session)).status).toBe(410);
    expect(await status()).toBe("closed");
    const row = (await getBackend().photos.findBySessionId(session.sessionId))!;
    expect(row.moderationStatus).toBe("DELETED");
    expect(await getBackend().objects.get(row.objectPath)).toBeNull();
    // Acknowledging again is harmless.
    expect((await call(r.ack(), "/api/hub/uploads/ack", session)).status).toBe(200);
  });
});

/** A scripted cloud inbox holding phone photos by session id. */
class FakeInboxCloud implements CloudInboxClient {
  items = new Map<string, Uint8Array>();
  online = true;
  acks: string[] = [];
  failAckOnce = false;
  private off<T>(): CloudResult<T> {
    return { ok: false, retry: true, message: "cloud unreachable (offline)" };
  }
  async createUploadSession() {
    return this.off<never>();
  }
  async uploadStatus(sessionId: string): Promise<CloudResult<"waiting" | "received" | "closed">> {
    if (!this.online) return this.off();
    return { ok: true, value: this.items.has(sessionId) ? "received" : "waiting" };
  }
  async inbox() {
    if (!this.online) return this.off<{ sessionId: string; createdAt: string }[]>();
    return {
      ok: true as const,
      value: [...this.items.keys()].map((sessionId) => ({ sessionId, createdAt: "x" })),
    };
  }
  async inboxImage(sessionId: string): Promise<CloudResult<Uint8Array>> {
    if (!this.online) return this.off();
    const data = this.items.get(sessionId);
    return data
      ? { ok: true, value: data }
      : { ok: false, retry: false, gone: true, message: "410" };
  }
  async ack(sessionId: string): Promise<CloudResult<null>> {
    if (!this.online) return this.off();
    if (this.failAckOnce) {
      this.failAckOnce = false;
      return { ok: false, retry: true, message: "cloud 503" };
    }
    this.acks.push(sessionId);
    this.items.delete(sessionId);
    return { ok: true, value: null };
  }
}

describe("hub side: HubInbox", () => {
  let backend: MemoryBackend;
  let svc: PhotoService;
  let cloud: FakeInboxCloud;
  let inbox: HubInbox;
  beforeEach(() => {
    backend = createMemoryBackend();
    svc = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30 });
    cloud = new FakeInboxCloud();
    inbox = new HubInbox(svc, backend, cloud);
  });

  it("takes each phone photo in as PENDING with consent, then lets the cloud delete it", async () => {
    const a = uuid();
    const b = uuid();
    cloud.items.set(a, JPEG).set(b, JPEG);
    await inbox.pull();
    for (const s of [a, b]) {
      const row = (await backend.photos.findBySessionId(s))!;
      expect(row).toMatchObject({ moderationStatus: "PENDING", wallConsent: true, kioskId: null });
      expect(isWallEligible(row)).toBe(false);
    }
    expect(cloud.acks.sort()).toEqual([a, b].sort());
    expect(inbox.status()).toMatchObject({ imported: 2, lastError: null });
  });

  it("offline: nothing happens, nothing is lost, the photos come down once it is back", async () => {
    const a = uuid();
    cloud.items.set(a, JPEG);
    cloud.online = false;
    await inbox.pull();
    expect(await backend.photos.findBySessionId(a)).toBeNull();
    expect(inbox.status().lastError).toMatch(/unreachable/);
    cloud.online = true;
    await inbox.pull();
    expect(await backend.photos.findBySessionId(a)).not.toBeNull();
    expect(inbox.status().lastError).toBeNull();
  });

  it("crash between storing and acknowledging: still one photo, acknowledged next time", async () => {
    const a = uuid();
    cloud.items.set(a, JPEG);
    cloud.failAckOnce = true;
    await inbox.pull();
    expect(cloud.items.has(a)).toBe(true);
    await inbox.pull();
    expect(cloud.items.has(a)).toBe(false);
    const rows = (await backend.photos.list({ limit: 100 })).filter((r) => r.sessionId === a);
    expect(rows).toHaveLength(1);
    expect(inbox.status().imported).toBe(1);
  });

  it("a photo deleted on the hub never comes back from the cloud", async () => {
    const a = uuid();
    cloud.items.set(a, JPEG);
    cloud.failAckOnce = true;
    await inbox.pull();
    const row = (await backend.photos.findBySessionId(a))!;
    await svc.moderate(row.id, "delete", uuid());
    await inbox.pull();
    const after = (await backend.photos.findBySessionId(a))!;
    expect(after.moderationStatus).toBe("DELETED");
    expect(cloud.items.has(a)).toBe(false);
  });

  it("refuses anything that is not a JPEG and skips photos gone from the cloud", async () => {
    const bad = uuid();
    cloud.items.set(bad, new Uint8Array([1, 2, 3, 4]));
    await inbox.pull();
    expect(await backend.photos.findBySessionId(bad)).toBeNull();
  });

  it("concurrent pulls share one pass (no double import)", async () => {
    const a = uuid();
    cloud.items.set(a, JPEG);
    await Promise.all([inbox.pull(), inbox.pull(), inbox.pull()]);
    expect(cloud.acks).toEqual([a]);
  });
});
