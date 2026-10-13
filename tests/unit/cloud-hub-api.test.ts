// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JPEG, uuid } from "../helpers/images";

/**
 * Cloud side of the QR copy: /api/hub/* through the real route handlers (cloud role, local store
 * standing in for Supabase). Only the hub's secret opens them; they store, reissue and delete.
 */
const ORIGIN = "https://lights.example.org";
const SECRET = "h".repeat(48);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-cloudhub-"));
  Object.assign(process.env, {
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    PUBLIC_BASE_URL: ORIGIN,
    HUB_SYNC_SECRET: SECRET,
  });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const routes = {
  put: () => import("@/app/api/hub/photos/route"),
  reissue: () => import("@/app/api/hub/photos/reissue/route"),
  remove: () => import("@/app/api/hub/photos/delete/route"),
  image: () => import("@/app/p/[token]/image/route"),
};

async function put(sessionId: string, secret = SECRET, body: BodyInit = JPEG) {
  const { POST } = await routes.put();
  return POST(
    new Request(`${ORIGIN}/api/hub/photos`, {
      method: "POST",
      body,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "image/jpeg",
        "x-session-id": sessionId,
        "x-frame-id": "starlight-strip",
      },
    }),
  );
}
const json = (secret: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function image(token: string) {
  const { GET } = await routes.image();
  return GET(new Request(`${ORIGIN}/p/${token}/image`), { params: Promise.resolve({ token }) });
}

describe("/api/hub/* on the cloud", () => {
  it("refuses anyone without the hub secret", async () => {
    expect((await put(uuid(), "x".repeat(48))).status).toBe(401);
    expect((await put(uuid(), "")).status).toBe(401);
    const { POST } = await routes.reissue();
    expect(
      (
        await POST(
          new Request(`${ORIGIN}/api/hub/photos/reissue`, json("wrong", { sessionId: uuid() })),
        )
      ).status,
    ).toBe(401);
  });

  it("stores the copy and returns a public guest link that works; repeat = fresh token", async () => {
    const sessionId = uuid();
    const first = await put(sessionId);
    expect(first.status).toBe(201);
    const a = (await first.json()) as { token: string; url: string; expiresAt: string };
    expect(a.url).toBe(`${ORIGIN}/p/${a.token}`);
    expect(JSON.stringify(a)).not.toMatch(/objectPath|tokenHash|\.jpg/);
    expect((await image(a.token)).status).toBe(200);

    const again = await put(sessionId);
    expect(again.status).toBe(200);
    const b = (await again.json()) as { token: string };
    expect(b.token).not.toBe(a.token);
    expect((await image(a.token)).status).toBe(404);
    expect((await image(b.token)).status).toBe(200);
  });

  it("validates the upload like a kiosk upload", async () => {
    expect((await put("not-a-session")).status).toBe(400);
    expect((await put(uuid(), SECRET, new Uint8Array([1, 2, 3]))).status).toBe(400);
  });

  it("reissue: a new link, the old one stops; unknown sessions 404", async () => {
    const sessionId = uuid();
    const a = (await (await put(sessionId)).json()) as { token: string };
    const { POST } = await routes.reissue();
    const res = await POST(
      new Request(`${ORIGIN}/api/hub/photos/reissue`, json(SECRET, { sessionId })),
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as { token: string; url: string };
    expect(b.url).toBe(`${ORIGIN}/p/${b.token}`);
    expect((await image(a.token)).status).toBe(404);
    expect((await image(b.token)).status).toBe(200);
    const unknown = await POST(
      new Request(`${ORIGIN}/api/hub/photos/reissue`, json(SECRET, { sessionId: uuid() })),
    );
    expect(unknown.status).toBe(404);
  });

  it("delete kills the link and is idempotent; afterwards no reissue", async () => {
    const sessionId = uuid();
    const a = (await (await put(sessionId)).json()) as { token: string };
    const { POST } = await routes.remove();
    const send = () =>
      POST(new Request(`${ORIGIN}/api/hub/photos/delete`, json(SECRET, { sessionId })));
    expect((await send()).status).toBe(200);
    expect((await image(a.token)).status).toBe(404);
    expect((await send()).status).toBe(200);
    expect(
      (
        await POST(
          new Request(`${ORIGIN}/api/hub/photos/delete`, json(SECRET, { sessionId: uuid() })),
        )
      ).status,
    ).toBe(200);
    // Deleted here is final: no new link, no second copy.
    const { POST: reissue } = await routes.reissue();
    expect(
      (await reissue(new Request(`${ORIGIN}/api/hub/photos/reissue`, json(SECRET, { sessionId }))))
        .status,
    ).toBe(410);
    expect((await put(sessionId)).status).toBe(410);
  });

  it("a copy whose link expired gets a fresh link on a repeat upload (lost response, hub offline long)", async () => {
    const { getPhotoService } = await import("@/lib/storage/server");
    const sessionId = uuid();
    await getPhotoService().put({
      sessionId,
      kioskId: null,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    const { getBackend } = await import("@/lib/storage/server");
    const row = (await getBackend().photos.findBySessionId(sessionId))!;
    await getBackend().photos.update(row.id, { tokenExpiresAt: "2020-01-01T00:00:00.000Z" });
    const res = await put(sessionId);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect((await image(token)).status).toBe(200);
  });

  it("a kiosk's own photo can never be touched through /api/hub", async () => {
    const { getPhotoService } = await import("@/lib/storage/server");
    const sessionId = uuid();
    const kioskPhoto = await getPhotoService().put({
      sessionId,
      kioskId: uuid(),
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    const { POST } = await routes.remove();
    await POST(new Request(`${ORIGIN}/api/hub/photos/delete`, json(SECRET, { sessionId })));
    expect((await image(kioskPhoto.token)).status).toBe(200);
    expect((await put(sessionId)).status).toBe(409);
  });
});
