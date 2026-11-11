// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { JPEG, MP4, WEBM, uuid } from "../helpers/images";

/**
 * Session video (D72) through the real route handlers on the local backend: the kiosk attaches
 * it, the guest link serves it, the hub pushes it to a cloud copy. Kiosk routes read only the
 * kiosk cookie; hub routes only the bearer secret.
 */
const ORIGIN = "https://lights.example.org";
const ENROLL = "enroll-secret-for-tests-only";
const HUB = "h".repeat(48);
let dir: string;
let kiosk = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-video-"));
  Object.assign(process.env, {
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
    PUBLIC_BASE_URL: ORIGIN,
    HUB_SYNC_SECRET: HUB,
    PHOTO_LINK_TTL_HOURS: "72",
    PHOTO_RETENTION_DAYS: "30",
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  kiosk = await enroll("영상 부스");
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

async function enroll(label: string) {
  const { POST } = await import("@/app/api/kiosk/enroll/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/kiosk/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ secret: ENROLL, label }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

/** A booth photo on the server; returns its session id and guest token. */
async function photo(cookie = kiosk) {
  const sessionId = uuid();
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
  return { sessionId, token: ((await res.json()) as { token: string }).token };
}

async function sendVideo(
  sessionId: string,
  opts: {
    cookie?: string | null;
    body?: BodyInit;
    type?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const { POST } = await import("@/app/api/photos/video/route");
  const cookie = opts.cookie === undefined ? kiosk : opts.cookie;
  return POST(
    new Request(`${ORIGIN}/api/photos/video`, {
      method: "POST",
      body: opts.body ?? WEBM,
      headers: {
        "content-type": opts.type ?? "video/webm",
        "x-session-id": sessionId,
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...opts.headers,
      },
      ...(opts.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
  );
}

async function guest(
  token: string,
  kind: "video" | "image",
  init: RequestInit = {},
  query = "",
): Promise<Response> {
  const request = new Request(`${ORIGIN}/p/${token}/${kind}${query}`, init);
  const ctx = { params: Promise.resolve({ token }) };
  if (kind === "image") return (await import("@/app/p/[token]/image/route")).GET(request, ctx);
  const mod = await import("@/app/p/[token]/video/route");
  return init.method === "HEAD" ? mod.HEAD(request, ctx) : mod.GET(request, ctx);
}

async function page(token: string) {
  const { default: Page } = await import("@/app/p/[token]/page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
}

const rowFor = async (sessionId: string) => {
  const { getBackend } = await import("@/lib/storage/server");
  return (await getBackend().photos.findBySessionId(sessionId))!;
};

/** Every file under the data dir's objects folder (to prove what is and is not on disk). */
async function objectFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else out.push(e.name);
    }
  };
  await walk(path.join(dir, "objects"));
  return out;
}

describe("POST /api/photos/video (kiosk)", () => {
  it("reads only the kiosk cookie: no cookie, a forged one, or the hub secret are all 401", async () => {
    const { sessionId } = await photo();
    expect((await sendVideo(sessionId, { cookie: null })).status).toBe(401);
    expect((await sendVideo(sessionId, { cookie: "ftl_kiosk=v1.forged.1.2.sig" })).status).toBe(
      401,
    );
    expect(
      (await sendVideo(sessionId, { cookie: null, headers: { authorization: `Bearer ${HUB}` } }))
        .status,
    ).toBe(401);
    expect(
      (await sendVideo(sessionId, { cookie: "ftl_staff=anything; sb-access-token=x" })).status,
    ).toBe(401);
    expect((await rowFor(sessionId)).videoMime).toBeNull();
  });

  it("refuses cross-origin requests even with a valid cookie", async () => {
    const { sessionId } = await photo();
    const res = await sendVideo(sessionId, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("stores the video for the session's photo; a retry is the same video", async () => {
    const { sessionId, token } = await photo();
    const first = await sendVideo(sessionId, { type: "video/webm;codecs=vp9" });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await first.json());
    expect(body).not.toMatch(/objects|\.webm|[0-9a-f]{64}/);
    const again = await sendVideo(sessionId, { body: MP4, type: "video/mp4" });
    expect(again.status).toBe(200);
    expect(await rowFor(sessionId)).toMatchObject({
      videoMime: "video/webm",
      videoBytes: WEBM.byteLength,
    });
    // The guest link is the one the kiosk already showed.
    expect((await guest(token, "image")).status).toBe(200);
  });

  it("only after the photo exists, and only from the kiosk that took it", async () => {
    expect((await sendVideo(uuid())).status).toBe(404);
    const { sessionId } = await photo();
    const other = await enroll("다른 부스");
    expect((await sendVideo(sessionId, { cookie: other })).status).toBe(404);
    expect((await rowFor(sessionId)).videoMime).toBeNull();
  });

  it("accepts only MP4 and WebM, with matching magic bytes", async () => {
    const { sessionId } = await photo();
    expect((await sendVideo(sessionId, { type: "video/quicktime" })).status).toBe(415);
    expect((await sendVideo(sessionId, { type: "image/jpeg", body: JPEG })).status).toBe(415);
    expect((await sendVideo(sessionId, { type: "video/mp4", body: WEBM })).status).toBe(400);
    expect((await sendVideo(sessionId, { body: JPEG })).status).toBe(400);
    expect((await sendVideo(sessionId, { body: new Uint8Array() })).status).toBe(400);
    expect((await sendVideo("not-a-uuid")).status).toBe(400);
    expect((await rowFor(sessionId)).videoMime).toBeNull();
  });

  it("413 above the size cap, by header and by actual size", async () => {
    const { sessionId } = await photo();
    const big = new Uint8Array(KIOSK_CONFIG.videoMaxBytes + 1);
    big.set(WEBM);
    expect((await sendVideo(sessionId, { body: big })).status).toBe(413);
    // No content-length to trust: the body is counted as it arrives.
    const lying = await sendVideo(sessionId, {
      body: new ReadableStream({
        start(c) {
          c.enqueue(big);
          c.close();
        },
      }),
    });
    expect(lying.status).toBe(413);
    expect((await rowFor(sessionId)).videoMime).toBeNull();
    // Exactly at the cap is accepted.
    const exact = new Uint8Array(KIOSK_CONFIG.videoMaxBytes);
    exact.set(WEBM);
    expect((await sendVideo(sessionId, { body: exact })).status).toBe(201);
  });

  it("409 for a deleted photo and for a phone photo", async () => {
    const { getPhotoService } = await import("@/lib/storage/server");
    const svc = getPhotoService();
    const { sessionId } = await photo();
    await svc.moderate((await rowFor(sessionId)).id, "delete", uuid());
    expect((await sendVideo(sessionId)).status).toBe(409);

    const kioskId = (await rowFor(sessionId)).kioskId;
    const phone = uuid();
    await svc.putMobile({ sessionId: phone, kioskId, data: JPEG, submissionsPaused: false });
    expect((await sendVideo(phone)).status).toBe(409);
    expect((await rowFor(phone)).videoMime).toBeNull();
  });
});

describe("GET /p/[token]/video (guest)", () => {
  it("no video: the same 404 as an unknown image, and the page shows no video button", async () => {
    const { token } = await photo();
    const missing = await guest(token, "video");
    const unknownVideo = await guest("A".repeat(32), "video");
    const unknownImage = await guest("A".repeat(32), "image");
    for (const res of [missing, unknownVideo]) {
      expect(res.status).toBe(unknownImage.status);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe(unknownImage.headers.get("cache-control"));
      expect(res.headers.get("content-type")).toBe(unknownImage.headers.get("content-type"));
    }
    expect(await missing.text()).toBe(await (await guest("B".repeat(32), "image")).text());
    const html = await page(token);
    expect(html).toContain("사진 저장하기");
    expect(html).not.toContain("영상 저장");
    expect(html).not.toContain("/video");
  });

  it("serves the bytes with type, length, ranges and the image route's cache policy", async () => {
    const { sessionId, token } = await photo();
    await sendVideo(sessionId, { body: MP4, type: "video/mp4" });
    const res = await guest(token, "video");
    const img = await guest(token, "image");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(MP4.byteLength));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe(img.headers.get("cache-control"));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename=".+\.mp4"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4);
    const download = await guest(token, "video", {}, "?download=1");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);

    const html = await page(token);
    expect(html).toContain("영상 저장");
    expect(html).toContain(`/p/${token}/video`);
    expect(html).not.toMatch(/objects\/|\.video\.|supabase|\.data|[0-9a-f]{64}/);
    // The photo stays the one primary action.
    expect(html.match(/btn-primary/g)).toHaveLength(1);
  });

  it("byte ranges: 206 with Content-Range (iOS), 416 outside the file, HEAD without a body", async () => {
    const { sessionId, token } = await photo();
    await sendVideo(sessionId, { body: MP4, type: "video/mp4" });
    const size = MP4.byteLength;

    const probe = await guest(token, "video", { headers: { range: "bytes=0-1" } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
    expect(probe.headers.get("content-length")).toBe("2");
    expect(new Uint8Array(await probe.arrayBuffer())).toEqual(MP4.subarray(0, 2));

    const tail = await guest(token, "video", { headers: { range: "bytes=4-" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes 4-${size - 1}/${size}`);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(MP4.subarray(4));

    const suffix = await guest(token, "video", { headers: { range: "bytes=-3" } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(MP4.subarray(size - 3));

    const outside = await guest(token, "video", { headers: { range: `bytes=${size}-` } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe(`bytes */${size}`);

    const head = await guest(token, "video", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("expired and deleted links: the same 404, and the file is gone from disk", async () => {
    const { sessionId, token } = await photo();
    await sendVideo(sessionId);
    const row = await rowFor(sessionId);
    expect((await objectFiles()).some((f) => f === `${row.id}.video.webm`)).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 73 * 3_600_000 });
    expect((await guest(token, "video")).status).toBe(404);
    vi.useRealTimers();
    expect((await guest(token, "video")).status).toBe(200);

    const { getPhotoService } = await import("@/lib/storage/server");
    await getPhotoService().moderate(row.id, "delete", uuid());
    const gone = await guest(token, "video");
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe("Not found");
    expect((await objectFiles()).some((f) => f.startsWith(row.id))).toBe(false);
  });

  it("never logs the token", async () => {
    const log = vi.mocked(console.log);
    log.mockClear();
    const { sessionId, token } = await photo();
    await sendVideo(sessionId);
    await guest(token, "video");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 73 * 3_600_000 });
    await guest(token, "video");
    vi.useRealTimers();
    const lines = [...log.mock.calls, ...vi.mocked(console.warn).mock.calls].flat().join("\n");
    expect(lines).toContain("guest_video_unavailable");
    expect(lines).not.toContain(token);
  });
});

describe("POST /api/hub/photos/video (cloud side of the hub copy)", () => {
  const hubPhoto = async (sessionId = uuid()) => {
    const { POST } = await import("@/app/api/hub/photos/route");
    const res = await POST(
      new Request(`${ORIGIN}/api/hub/photos`, {
        method: "POST",
        body: JPEG,
        headers: {
          authorization: `Bearer ${HUB}`,
          "content-type": "image/jpeg",
          "x-session-id": sessionId,
          "x-frame-id": "starlight-strip",
        },
      }),
    );
    return { sessionId, token: ((await res.json()) as { token: string }).token };
  };
  const hubVideo = async (
    sessionId: string,
    opts: { headers?: Record<string, string>; body?: BodyInit; type?: string } = {},
  ) => {
    const { POST } = await import("@/app/api/hub/photos/video/route");
    return POST(
      new Request(`${ORIGIN}/api/hub/photos/video`, {
        method: "POST",
        body: opts.body ?? WEBM,
        headers: {
          authorization: `Bearer ${HUB}`,
          "content-type": opts.type ?? "video/webm",
          "x-session-id": sessionId,
          ...opts.headers,
        },
      }),
    );
  };

  it("reads only the bearer secret: a kiosk cookie is not enough", async () => {
    const { sessionId } = await hubPhoto();
    expect((await hubVideo(sessionId, { headers: { authorization: "" } })).status).toBe(401);
    expect(
      (await hubVideo(sessionId, { headers: { authorization: "Bearer wrong", cookie: kiosk } }))
        .status,
    ).toBe(401);
    expect(
      (await hubVideo(sessionId, { headers: { authorization: "", cookie: kiosk } })).status,
    ).toBe(401);
    expect((await rowFor(sessionId)).videoMime).toBeNull();
  });

  it("stores the video without touching the guest token; a retry is 200", async () => {
    const { sessionId, token } = await hubPhoto();
    const hashBefore = (await rowFor(sessionId)).tokenHash;
    const first = await hubVideo(sessionId);
    expect(first.status).toBe(201);
    expect(JSON.stringify(await first.json())).not.toMatch(/token|url|objects/);
    expect((await hubVideo(sessionId)).status).toBe(200);
    expect((await rowFor(sessionId)).tokenHash).toBe(hashBefore);
    // The QR the guest already scanned still opens the photo, and now the video too.
    expect((await guest(token, "image")).status).toBe(200);
    const video = await guest(token, "video");
    expect(video.status).toBe(200);
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(WEBM);
  });

  it("only hub copies: a kiosk's own photo and unknown sessions are 404", async () => {
    const own = await photo();
    expect((await hubVideo(own.sessionId)).status).toBe(404);
    expect((await rowFor(own.sessionId)).videoMime).toBeNull();
    expect((await hubVideo(uuid())).status).toBe(404);
  });

  it("validates type, magic bytes and size like the kiosk route", async () => {
    const { sessionId } = await hubPhoto();
    expect((await hubVideo(sessionId, { type: "video/quicktime" })).status).toBe(415);
    expect((await hubVideo(sessionId, { body: JPEG })).status).toBe(400);
    expect((await hubVideo("nope")).status).toBe(400);
    const big = new Uint8Array(KIOSK_CONFIG.videoMaxBytes + 1);
    big.set(WEBM);
    expect((await hubVideo(sessionId, { body: big })).status).toBe(413);
    expect((await rowFor(sessionId)).videoMime).toBeNull();
  });

  it("a copy deleted on the cloud stays final: 410, and its video is gone", async () => {
    const { sessionId, token } = await hubPhoto();
    await hubVideo(sessionId);
    const { POST } = await import("@/app/api/hub/photos/delete/route");
    const res = await POST(
      new Request(`${ORIGIN}/api/hub/photos/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${HUB}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await guest(token, "video")).status).toBe(404);
    expect((await guest(token, "image")).status).toBe(404);
    const row = await rowFor(sessionId);
    expect((await objectFiles()).some((f) => f.startsWith(row.id))).toBe(false);
    expect((await hubVideo(sessionId)).status).toBe(410);
    expect((await objectFiles()).some((f) => f.startsWith(row.id))).toBe(false);
  });
});

describe("the media wall never learns about videos", () => {
  it("feed and wall image carry no video, URL or flag for a photo that has one", async () => {
    const { getBackend, getPhotoService } = await import("@/lib/storage/server");
    const { sessionId } = await photo();
    await sendVideo(sessionId);
    const row = await rowFor(sessionId);
    const svc = getPhotoService();
    await svc.setWallConsentForSession(sessionId, true, row.kioskId);
    expect((await svc.moderate(row.id, "approve", uuid())).ok).toBe(true);
    await getBackend().settings.update({ wallForce: "on" }, uuid());

    const { GET } = await import("@/app/api/wall/feed/route");
    const feed = await GET(new Request(`${ORIGIN}/api/wall/feed`, { headers: { cookie: kiosk } }));
    expect(feed.status).toBe(200);
    const text = await feed.text();
    expect(text).toContain(row.id);
    expect(text).not.toMatch(/video|webm|mp4/i);

    const { GET: image } = await import("@/app/api/wall/photos/[id]/image/route");
    const img = await image(
      new Request(`${ORIGIN}/api/wall/photos/${row.id}/image`, { headers: { cookie: kiosk } }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toMatch(/^image\//);
  });
});
