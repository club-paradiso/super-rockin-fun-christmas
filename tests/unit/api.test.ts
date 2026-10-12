// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JPEG, JPEG_TRUNCATED, uuid } from "../helpers/images";

/**
 * Route handlers against the real local backend with kiosk auth ON — the same code paths a
 * Supabase deployment uses (only the backend differs).
 */
const ENROLL = "enroll-secret-for-tests-only";
const CRON = "c".repeat(40);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-api-"));
  Object.assign(process.env, {
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
    CRON_SECRET: CRON,
    PUBLIC_BASE_URL: "https://lights.example.org",
    PHOTO_LINK_TTL_HOURS: "72",
    PHOTO_RETENTION_DAYS: "30",
  });
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

const api = {
  photos: () => import("@/app/api/photos/route"),
  consent: () => import("@/app/api/photos/consent/route"),
  enroll: () => import("@/app/api/kiosk/enroll/route"),
  operator: () => import("@/app/api/operator/kiosks/route"),
  cron: () => import("@/app/api/cron/retention/route"),
  image: () => import("@/app/p/[token]/image/route"),
  page: () => import("@/app/p/[token]/page"),
};

async function enroll(label = "test kiosk") {
  const { POST } = await api.enroll();
  const res = await POST(
    new Request("https://lights.example.org/api/kiosk/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://lights.example.org" },
      body: JSON.stringify({ secret: ENROLL, label }),
    }),
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  const { kioskId } = (await res.json()) as { kioskId: string };
  return { res, setCookie, cookie: setCookie.split(";")[0]!, kioskId };
}

function upload(
  cookie: string | null,
  body: BodyInit = JPEG,
  headers: Record<string, string> = {},
  sessionId = uuid(),
) {
  return api.photos().then(({ POST }) =>
    POST(
      new Request("https://lights.example.org/api/photos", {
        method: "POST",
        body,
        headers: {
          "content-type": "image/jpeg",
          "x-session-id": sessionId,
          "x-frame-id": "starlight-strip",
          origin: "https://lights.example.org",
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
      }),
    ),
  );
}

const image = async (token: string, query = "") => {
  const { GET } = await api.image();
  return GET(new Request(`https://lights.example.org/p/${token}/image${query}`), {
    params: Promise.resolve({ token }),
  });
};

describe("kiosk enrollment and upload auth", () => {
  it("rejects uploads from a browser that is not enrolled", async () => {
    expect((await upload(null)).status).toBe(401);
    expect((await upload("ftl_kiosk=v1.forged.1.2.sig")).status).toBe(401);
  });

  it("rejects a wrong enrollment secret", async () => {
    const { POST } = await api.enroll();
    const res = await POST(
      new Request("https://lights.example.org/api/kiosk/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "guess", label: "x" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("issues an HttpOnly, SameSite=Lax, Secure session cookie and accepts its uploads", async () => {
    const { res, setCookie, cookie } = await enroll();
    expect(res.status).toBe(201);
    expect(setCookie).toMatch(/^ftl_kiosk=v1\./);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/Max-Age=\d+/);
    expect((await upload(cookie)).status).toBe(201);
  });

  it("revoked kiosks are rejected immediately", async () => {
    const { cookie, kioskId } = await enroll("lost tablet");
    const { POST, GET } = await api.operator();
    const auth = { authorization: `Bearer ${ENROLL}`, "content-type": "application/json" };
    expect((await GET(new Request("https://x/api/operator/kiosks"))).status).toBe(401);
    const revoke = await POST(
      new Request("https://x/api/operator/kiosks", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ action: "revoke", kioskId }),
      }),
    );
    expect(revoke.status).toBe(200);
    expect((await upload(cookie)).status).toBe(401);
  });

  it("refuses cross-origin requests even with a valid cookie (CSRF)", async () => {
    const { cookie } = await enroll();
    expect((await upload(cookie, JPEG, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("upload validation", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = (await enroll()).cookie;
  });

  it("rejects wrong MIME, bad session, unknown frame, invalid JPEG, empty body", async () => {
    expect((await upload(cookie, JPEG, { "content-type": "text/plain" })).status).toBe(415);
    expect((await upload(cookie, JPEG, { "content-type": "image/gif" })).status).toBe(415);
    expect((await upload(cookie, JPEG, { "x-session-id": "1" })).status).toBe(400);
    expect((await upload(cookie, JPEG, { "x-session-id": "" })).status).toBe(400);
    expect((await upload(cookie, JPEG, { "x-frame-id": "nope" })).status).toBe(400);
    expect((await upload(cookie, JPEG_TRUNCATED)).status).toBe(400);
    expect((await upload(cookie, new Uint8Array([0x89, 0x50]))).status).toBe(400);
    expect(await upload(cookie, new Uint8Array()).then((r) => r.status)).toBe(400);
  });

  it("rejects oversized bodies, by header and by actual size", async () => {
    expect(
      (await upload(cookie, JPEG, { "content-length": String(10 * 1024 * 1024) })).status,
    ).toBe(413);
    const big = new Uint8Array(4 * 1024 * 1024 + 10);
    big.set([0xff, 0xd8, 0xff]);
    expect((await upload(cookie, big)).status).toBe(413);
  });

  it("returns a public https URL and never a storage path", async () => {
    const res = await upload(cookie);
    const text = await res.text();
    const body = JSON.parse(text) as { url: string; token: string };
    expect(body.url).toBe(`https://lights.example.org/p/${body.token}`);
    expect(text).not.toMatch(/objects\/|\.jpg|object_?path|token_?hash/i);
  });

  it("a retried session is one record with a fresh working token", async () => {
    const sessionId = uuid();
    const first = (await (await upload(cookie, JPEG, {}, sessionId)).json()) as { token: string };
    const retry = await upload(cookie, JPEG, {}, sessionId);
    expect(retry.status).toBe(200);
    const second = (await retry.json()) as { token: string; duplicate: boolean };
    expect(second.duplicate).toBe(true);
    expect((await image(second.token)).status).toBe(200);
    expect((await image(first.token)).status).toBe(404);
  });
});

describe("guest delivery", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = (await enroll()).cookie;
  });
  const freshToken = async () => ((await (await upload(cookie)).json()) as { token: string }).token;

  it("valid token: image bytes, private headers, page without storage internals", async () => {
    const token = await freshToken();
    const res = await image(token, "?download=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);

    const { default: Page } = await api.page();
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(html).toContain("사진 저장하기");
    expect(html).toContain(`/p/${token}/image`);
    expect(html).not.toMatch(/objects\/|supabase|\.data|[0-9a-f]{64}/);
  });

  it("unknown, expired and deleted all look identical (404)", async () => {
    const { default: Page } = await api.page();
    const unknown = "A".repeat(32);
    expect((await image(unknown)).status).toBe(404);
    await expect(Page({ params: Promise.resolve({ token: unknown }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );

    const token = await freshToken();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 73 * 3_600_000 });
    expect((await image(token)).status).toBe(404);
    await expect(Page({ params: Promise.resolve({ token }) })).rejects.toThrow(/404/);
    vi.useRealTimers();

    // Deleted by retention cleanup.
    const doomed = await freshToken();
    const { GET } = await api.cron();
    expect((await GET(new Request("https://x/api/cron/retention"))).status).toBe(401);
    expect(
      (
        await GET(
          new Request("https://x/api/cron/retention", {
            headers: { authorization: "Bearer nope" },
          }),
        )
      ).status,
    ).toBe(401);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * 86_400_000 });
    const run = await GET(
      new Request("https://x/api/cron/retention", { headers: { authorization: `Bearer ${CRON}` } }),
    );
    expect(run.status).toBe(200);
    expect(((await run.json()) as { deleted: number }).deleted).toBeGreaterThan(0);
    const again = await GET(
      new Request("https://x/api/cron/retention", { headers: { authorization: `Bearer ${CRON}` } }),
    );
    expect(((await again.json()) as { deleted: number }).deleted).toBe(0);
    vi.useRealTimers();
    expect((await image(doomed)).status).toBe(404);
  });
});

describe("wall consent", () => {
  it("YES → PENDING, NO keeps the download, never auto-approved, kiosk auth required", async () => {
    const { cookie } = await enroll();
    const { token } = (await (await upload(cookie)).json()) as { token: string };
    const { POST } = await api.consent();
    const send = (consent: boolean, c: string | null = cookie) =>
      POST(
        new Request("https://lights.example.org/api/photos/consent", {
          method: "POST",
          headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
          body: JSON.stringify({ token, consent }),
        }),
      );
    expect((await send(true, null)).status).toBe(401);
    expect(await (await send(true)).json()).toEqual({
      wallConsent: true,
      moderationStatus: "PENDING",
    });
    expect(await (await send(false)).json()).toEqual({
      wallConsent: false,
      moderationStatus: "NONE",
    });
    expect((await image(token)).status).toBe(200);
  });
});

describe("Phase 3 kiosk APIs on the local backend", () => {
  it("one-time code enrollment works once; heartbeat reports state; pause blocks only wall consent", async () => {
    const { getBackend } = await import("@/lib/storage/server");
    const { generateEnrollmentCode, hashEnrollmentCode, normalizeEnrollmentCode } =
      await import("@/lib/ops/enrollment-code");
    const backend = getBackend();
    const staffId = uuid();
    const code = generateEnrollmentCode();
    await backend.enrollmentCodes.create({
      id: uuid(),
      codeHash: hashEnrollmentCode(normalizeEnrollmentCode(code)!),
      label: "로컬 키오스크",
      createdBy: staffId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { POST: enrollPost } = await api.enroll();
    const enrollReq = () =>
      enrollPost(
        new Request("https://lights.example.org/api/kiosk/enroll", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://lights.example.org" },
          body: JSON.stringify({ code: code.toLowerCase() }),
        }),
      );
    const first = await enrollReq();
    expect(first.status).toBe(201);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    expect((await enrollReq()).status).toBe(401);

    const { POST: heartbeat } = await import("@/app/api/kiosk/heartbeat/route");
    const beat = await heartbeat(
      new Request("https://lights.example.org/api/kiosk/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ queueDepth: 4, camera: "error" }),
      }),
    );
    expect(await beat.json()).toEqual({ wallSubmissions: "open" });
    const kiosk = (await backend.kiosks.list()).find((k) => k.label === "로컬 키오스크")!;
    expect(kiosk).toMatchObject({ queueDepth: 4, cameraState: "error", enrolledVia: "code" });

    await backend.settings.update({ pauseSubmissions: true }, staffId);
    const up = await upload(cookie);
    const { token, wallSubmissions } = (await up.json()) as {
      token: string;
      wallSubmissions: string;
    };
    expect(wallSubmissions).toBe("paused");
    const { POST: consent } = await api.consent();
    const send = (c: boolean) =>
      consent(
        new Request("https://lights.example.org/api/photos/consent", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ token, consent: c }),
        }),
      );
    expect((await send(true)).status).toBe(409);
    expect((await send(false)).status).toBe(200);
    expect((await image(token)).status).toBe(200);
    await backend.settings.update({ pauseSubmissions: false }, staffId);
  });

  it("staff APIs are unavailable without Supabase Auth, and never fall open", async () => {
    const { GET } = await import("@/app/api/admin/overview/route");
    const res = await GET(new Request("https://lights.example.org/api/admin/overview"), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(503);
  });
});

describe("media wall API on the local backend", () => {
  const wall = {
    feed: () => import("@/app/api/wall/feed/route"),
    image: () => import("@/app/api/wall/photos/[id]/image/route"),
  };
  const getFeed = async (cookie: string | null) => {
    const { GET } = await wall.feed();
    return GET(
      new Request("https://lights.example.org/api/wall/feed", {
        headers: cookie ? { cookie } : {},
      }),
    );
  };
  const getImage = async (cookie: string | null, id: string) => {
    const { GET } = await wall.image();
    return GET(
      new Request(`https://lights.example.org/api/wall/photos/${id}/image`, {
        headers: cookie ? { cookie } : {},
      }),
      { params: Promise.resolve({ id }) },
    );
  };

  it("a display enrolled with next=wall lands on /wall and sees only approved, consented photos", async () => {
    const { getBackend, getPhotoService } = await import("@/lib/storage/server");
    const { generateEnrollmentCode, hashEnrollmentCode, normalizeEnrollmentCode } =
      await import("@/lib/ops/enrollment-code");
    const backend = getBackend();
    const svc = getPhotoService();
    const staffId = uuid();

    const code = generateEnrollmentCode();
    await backend.enrollmentCodes.create({
      id: uuid(),
      codeHash: hashEnrollmentCode(normalizeEnrollmentCode(code)!),
      label: "미디어월",
      createdBy: staffId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { POST: enrollPost } = await api.enroll();
    const enrolled = await enrollPost(
      new Request("https://lights.example.org/api/kiosk/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://lights.example.org",
          // Own client IP: earlier tests in this file used up the default one's enroll budget.
          "x-forwarded-for": "10.9.0.1",
        },
        body: new URLSearchParams({ code, next: "wall" }),
      }),
    );
    expect(enrolled.status).toBe(303);
    expect(enrolled.headers.get("location")).toBe("/wall");
    const display = enrolled.headers.get("set-cookie")!.split(";")[0]!;

    expect((await getFeed(null)).status).toBe(401);
    expect((await getFeed("ftl_kiosk=v1.forged")).status).toBe(401);

    // Two guests say YES, one says NO; staff approves one YES.
    const kioskRes = await enrollPost(
      new Request("https://lights.example.org/api/kiosk/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://lights.example.org",
          "x-forwarded-for": "10.9.0.2",
        },
        body: JSON.stringify({ secret: ENROLL, label: "wall test kiosk" }),
      }),
    );
    expect(kioskRes.status).toBe(201);
    const kiosk = kioskRes.headers.get("set-cookie")!.split(";")[0]!;
    const { POST: consent } = await api.consent();
    const shoot = async (yes: boolean) => {
      const sessionId = uuid();
      const { token } = (await (await upload(kiosk, JPEG, {}, sessionId)).json()) as {
        token: string;
      };
      await consent(
        new Request("https://lights.example.org/api/photos/consent", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: kiosk },
          body: JSON.stringify({ token, consent: yes }),
        }),
      );
      return (await backend.photos.findBySessionId(sessionId))!.id;
    };
    const approved = await shoot(true);
    const pending = await shoot(true);
    const declined = await shoot(false);
    expect((await svc.moderate(approved, "approve", staffId)).ok).toBe(true);

    const res = await getFeed(display);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text) as { mode: string; photos: { id: string }[] };
    expect(body.mode).toBe("live");
    const ids = body.photos.map((p) => p.id);
    expect(ids).toContain(approved);
    expect(ids).not.toContain(pending);
    expect(ids).not.toContain(declined);
    expect(text).not.toMatch(/objectPath|object_path|tokenHash|kioskId|photos\//);

    const img = await getImage(display, approved);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toBe("private, no-store");
    expect((await getImage(display, pending)).status).toBe(404);
    expect((await getImage(display, declined)).status).toBe(404);
    expect((await getImage(display, "not-a-uuid")).status).toBe(404);
    expect((await getImage(null, approved)).status).toBe(401);

    // Hidden after the last poll: refused at once, gone from the next poll.
    await svc.moderate(approved, "hide", staffId);
    expect((await getImage(display, approved)).status).toBe(404);
    expect(
      ((await (await getFeed(display)).json()) as { photos: { id: string }[] }).photos.map(
        (p) => p.id,
      ),
    ).not.toContain(approved);
    await svc.moderate(approved, "unhide", staffId);

    // Emergency switches send no photos at all, and images are refused.
    await backend.settings.update({ pauseWall: true }, staffId);
    expect(await (await getFeed(display)).json()).toMatchObject({
      mode: "paused",
      photos: [],
      showNow: [],
    });
    expect((await getImage(display, approved)).status).toBe(404);
    await backend.settings.update({ showHoldingScreen: true }, staffId);
    expect(await (await getFeed(display)).json()).toMatchObject({
      mode: "holding",
      photos: [],
      showNow: [],
    });
    await backend.settings.update({ pauseWall: false, showHoldingScreen: false }, staffId);
    expect((await getImage(display, approved)).status).toBe(200);

    // Revoking the display cuts it off on its next request.
    const displayRow = (await backend.kiosks.list()).find((k) => k.label === "미디어월")!;
    await backend.kiosks.update(displayRow.id, { revoke: true }, staffId);
    expect((await getFeed(display)).status).toBe(401);
    expect((await getImage(display, approved)).status).toBe(401);
  });

  it("enrollment errors keep the wall destination; anything else never redirects off-site", async () => {
    const { POST: enrollPost } = await api.enroll();
    const send = (fields: Record<string, string>, ip: string) =>
      enrollPost(
        new Request("https://lights.example.org/api/kiosk/enroll", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://lights.example.org",
            "x-forwarded-for": ip,
          },
          body: new URLSearchParams(fields),
        }),
      );
    const bad = await send({ code: "ZZZZ-ZZZZ", next: "wall" }, "10.9.0.3");
    expect(bad.headers.get("location")).toBe("/kiosk/enroll?error=401&next=wall");
    const evil = await send(
      { secret: ENROLL, label: "x", next: "https://evil.example" },
      "10.9.0.4",
    );
    expect(evil.headers.get("location")).toBe("/kiosk");
  });
});
