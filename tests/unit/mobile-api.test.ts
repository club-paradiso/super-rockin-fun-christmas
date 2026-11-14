// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_FRAME_ID } from "@/config/mobile";

/**
 * "내 사진으로 참여하기" (D66) through the real route handlers: booth asks for a QR, the phone
 * page opens, the phone uploads, the booth sees it arrive. Local backend, kiosk auth ON, real
 * sharp re-encoding (EXIF/GPS removal and orientation are checked on actual JPEG bytes).
 */
const ORIGIN = "https://lights.example.org";
const ENROLL = "enroll-secret-for-mobile-tests";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-mobile-"));
  Object.assign(process.env, {
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "m".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
    PUBLIC_BASE_URL: ORIGIN,
  });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const routes = {
  enroll: () => import("@/app/api/kiosk/enroll/route"),
  session: () => import("@/app/api/mobile/sessions/route"),
  status: () => import("@/app/api/mobile/sessions/status/route"),
  upload: () => import("@/app/api/mobile/upload/route"),
  page: () => import("@/app/m/[token]/page"),
  storage: () => import("@/lib/storage/server"),
};

async function enroll(label: string) {
  const { POST } = await routes.enroll();
  const res = await POST(
    new Request(`${ORIGIN}/api/kiosk/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ secret: ENROLL, label }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function newQr(cookie: string | null) {
  const { POST } = await routes.session();
  return POST(
    new Request(`${ORIGIN}/api/mobile/sessions`, {
      method: "POST",
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    }),
  );
}

async function status(cookie: string, sessionId: string) {
  const { POST } = await routes.status();
  const res = await POST(
    new Request(`${ORIGIN}/api/mobile/sessions/status`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }),
  );
  return ((await res.json()) as { status: string }).status;
}

let ip = 0;
async function upload(
  token: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
  fromIp = `203.0.113.${++ip}`,
) {
  const { POST } = await routes.upload();
  return POST(
    new Request(`${ORIGIN}/api/mobile/upload`, {
      method: "POST",
      body: body as unknown as BodyInit,
      headers: {
        origin: ORIGIN,
        "content-type": "image/jpeg",
        "x-upload-token": token,
        "x-wall-consent": "yes",
        "x-forwarded-for": fromIp,
        ...headers,
      },
    }),
  );
}

const tokenOf = (url: string) => decodeURIComponent(url.split("/m/")[1]!);

/** A real phone-like JPEG: EXIF with a camera make, GPS position, and "turn 90°" orientation. */
async function phoneJpeg(width = 800, height = 600): Promise<Uint8Array> {
  const out = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 160 } },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "TestPhone", Model: "Secret Model 9" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 30/1 0/1" },
    })
    .toBuffer();
  return new Uint8Array(out);
}

describe("phone upload (D66)", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await enroll("mobile booth");
  });

  it("only an enrolled booth can ask for a QR; the QR is a phone page on the public address", async () => {
    expect((await newQr(null)).status).toBe(401);
    const res = await newQr(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; sessionId: string; via: string };
    expect(body.url.startsWith(`${ORIGIN}/m/u1.`)).toBe(true);
    expect(body.via).toBe("cloud");
    expect(await status(cookie, body.sessionId)).toBe("waiting");
  });

  it("phone → stored as a PENDING phone photo, EXIF and GPS removed, turned upright", async () => {
    const { url, sessionId } = (await (await newQr(cookie)).json()) as {
      url: string;
      sessionId: string;
    };
    const original = await phoneJpeg();
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    expect(Buffer.from(original).includes(Buffer.from("TestPhone"))).toBe(true);

    const res = await upload(tokenOf(url), original);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "received", review: "pending" });
    expect(await status(cookie, sessionId)).toBe("received");

    const { getBackend } = await routes.storage();
    const row = (await getBackend().photos.findBySessionId(sessionId))!;
    expect(row).toMatchObject({
      frameId: MOBILE_FRAME_ID,
      moderationStatus: "PENDING",
      wallConsent: true,
    });
    const stored = (await getBackend().objects.get(row.objectPath))!;
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation ?? 1).toBe(1);
    // Orientation 6 = the camera was turned: the stored photo is upright (portrait).
    expect([meta.width, meta.height]).toEqual([600, 800]);
    expect(Buffer.from(stored).includes(Buffer.from("TestPhone"))).toBe(false);
  });

  it("one photo per QR: the same QR again returns the same photo (200), never a second one", async () => {
    const { url, sessionId } = (await (await newQr(cookie)).json()) as {
      url: string;
      sessionId: string;
    };
    expect((await upload(tokenOf(url), await phoneJpeg())).status).toBe(201);
    expect((await upload(tokenOf(url), await phoneJpeg(900, 700))).status).toBe(200);
    const { getBackend } = await routes.storage();
    const rows = (await getBackend().photos.list({ limit: 500 })).filter(
      (r) => r.sessionId === sessionId,
    );
    expect(rows).toHaveLength(1);
  });

  // D86: a phone photo is public-wall material only when the page showed that line AND staff have
  // the public wall on when it arrives.
  it("records the public scope only with the header and only while the public wall is on", async () => {
    const { getBackend } = await routes.storage();
    const backend = getBackend();
    const staffId = crypto.randomUUID();
    const sent = async (headers: Record<string, string>) => {
      const { url, sessionId } = (await (await newQr(cookie)).json()) as {
        url: string;
        sessionId: string;
      };
      expect((await upload(tokenOf(url), await phoneJpeg(), headers)).status).toBe(201);
      return (await backend.photos.findBySessionId(sessionId))!;
    };
    // Switch off: the header alone records nothing.
    expect(await sent({ "x-wall-scope": "public" })).toMatchObject({
      wallConsent: true,
      wallPublic: false,
    });
    await backend.settings.update({ wallPublic: true }, staffId);
    expect(await sent({ "x-wall-scope": "public" })).toMatchObject({
      wallConsent: true,
      wallPublic: true,
      moderationStatus: "PENDING", // still reviewed by a person, like any other photo
    });
    expect((await sent({})).wallPublic).toBe(false);
    expect((await sent({ "x-wall-scope": "everyone" })).wallPublic).toBe(false);
    await backend.settings.update({ wallPublic: false }, staffId);
  });

  it("refuses: no consent, forged/expired QR, wrong type, not an image, too small, other site", async () => {
    const { url } = (await (await newQr(cookie)).json()) as { url: string };
    const token = tokenOf(url);
    const jpeg = await phoneJpeg();
    expect((await upload(token, jpeg, { "x-wall-consent": "no" })).status).toBe(400);
    expect((await upload(`${token}x`, jpeg)).status).toBe(410);
    expect((await upload("u1.nope", jpeg)).status).toBe(410);
    expect((await upload(token, jpeg, { "content-type": "image/gif" })).status).toBe(415);
    const garbage = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
    const res = await upload(token, garbage);
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([
      400,
      "unreadable",
    ]);
    const tiny = await phoneJpeg(100, 80);
    const small = await upload(token, tiny);
    expect([small.status, ((await small.json()) as { error: string }).error]).toEqual([
      400,
      "too_small",
    ]);
    expect((await upload(token, jpeg, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("PNG is accepted and stored as our own JPEG", async () => {
    const { url, sessionId } = (await (await newQr(cookie)).json()) as {
      url: string;
      sessionId: string;
    };
    const png = new Uint8Array(
      await sharp({ create: { width: 500, height: 500, channels: 4, background: "#ffcc00" } })
        .png()
        .toBuffer(),
    );
    expect((await upload(tokenOf(url), png, { "content-type": "image/png" })).status).toBe(201);
    const { getBackend } = await routes.storage();
    const row = (await getBackend().photos.findBySessionId(sessionId))!;
    expect(row.mime).toBe("image/jpeg");
    expect((await sharp((await getBackend().objects.get(row.objectPath))!).metadata()).format).toBe(
      "jpeg",
    );
  });

  // D89: the guest puts their photos in a booth frame on the phone; the stored photo keeps the
  // frame's id and its saved size, so the wall hangs it like that booth frame.
  it("a framed picture keeps its frame id and full size; a wrong shape or unknown frame is refused", async () => {
    const plain = async (width: number, height: number) =>
      new Uint8Array(
        await sharp({ create: { width, height, channels: 3, background: "#7a440e" } })
          .jpeg({ quality: 80 })
          .toBuffer(),
      );
    const qr = async () =>
      (await (await newQr(cookie)).json()) as { url: string; sessionId: string };
    const { getBackend } = await routes.storage();

    const letter = await qr();
    const res = await upload(tokenOf(letter.url), await plain(1200, 3600), {
      "x-frame-id": "shalom-letter",
    });
    expect(res.status).toBe(201);
    const row = (await getBackend().photos.findBySessionId(letter.sessionId))!;
    expect(row).toMatchObject({ frameId: "phone-shalom-letter", moderationStatus: "PENDING" });
    const meta = await sharp((await getBackend().objects.get(row.objectPath))!).metadata();
    // Not shrunk to the plain-photo bound (2048): the strip keeps the booth's saved size.
    expect([meta.width, meta.height]).toEqual([1200, 3600]);

    const refused = async (frame: string, width: number, height: number) => {
      const { url, sessionId } = await qr();
      const r = await upload(tokenOf(url), await plain(width, height), { "x-frame-id": frame });
      expect(await getBackend().photos.findBySessionId(sessionId)).toBeNull();
      return [r.status, ((await r.json()) as { error: string }).error];
    };
    // A photo that is not the frame's shape would hang in the wrong box.
    expect(await refused("shalom-letter", 1200, 900)).toEqual([400, "frame"]);
    // Only current booth frames: not a retired one, not the plain id, not a made-up one.
    expect(await refused("six-lights", 1200, 3600)).toEqual([400, "frame"]);
    expect(await refused("photo", 1200, 900)).toEqual([400, "frame"]);
    expect(await refused("nope", 1200, 900)).toEqual([400, "frame"]);
  });

  it("a QR can be retried only a few times (rate limit per QR)", async () => {
    const { url } = (await (await newQr(cookie)).json()) as { url: string };
    const bad = new Uint8Array([0xff, 0xd8, 0xff, 1, 0xff, 0xd9]);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await upload(tokenOf(url), bad)).status);
    expect(codes.slice(0, 6).every((c) => c === 400)).toBe(true);
    expect(codes.slice(6)).toEqual([429, 429]);
  });

  it("the phone page: valid QR opens the uploader; forged or used-and-deleted shows one closed page", async () => {
    const { default: Page } = await routes.page();
    const { url, sessionId } = (await (await newQr(cookie)).json()) as {
      url: string;
      sessionId: string;
    };
    const token = tokenOf(url);
    const open = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(open).toContain("내 사진으로 참여하기");
    expect(open).toContain("사진 고르기");
    const forged = renderToStaticMarkup(
      await Page({ params: Promise.resolve({ token: `${token}x` }) }),
    );
    expect(forged).toContain("이 QR은 더 이상 쓸 수 없어요");
    const broken = renderToStaticMarkup(
      await Page({ params: Promise.resolve({ token: "u1.%E0%A4%A" }) }),
    );
    expect(broken).toContain("이 QR은 더 이상 쓸 수 없어요");

    await upload(token, await phoneJpeg());
    const sent = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(sent).toContain("사진을 받았어요");

    const { getPhotoService, getBackend } = await routes.storage();
    const row = (await getBackend().photos.findBySessionId(sessionId))!;
    await getPhotoService().moderate(row.id, "delete", crypto.randomUUID());
    const deleted = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(deleted).toContain("이 QR은 더 이상 쓸 수 없어요");
    expect((await upload(token, await phoneJpeg())).status).toBe(409);
  });

  it("PAUSE SUBMISSIONS: no new QR, and a QR already shown cannot add a new photo", async () => {
    const { url } = (await (await newQr(cookie)).json()) as { url: string };
    const { getBackend } = await routes.storage();
    const staff = crypto.randomUUID();
    await getBackend().settings.update({ pauseSubmissions: true }, staff);
    try {
      expect((await newQr(cookie)).status).toBe(409);
      const res = await upload(tokenOf(url), await phoneJpeg());
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([
        409,
        "paused",
      ]);
    } finally {
      await getBackend().settings.update({ pauseSubmissions: false }, staff);
    }
  });
});
