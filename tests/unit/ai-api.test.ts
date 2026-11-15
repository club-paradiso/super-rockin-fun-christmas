// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uuid } from "../helpers/images";

/**
 * The automatic check (D95) through the real route handlers and the local backend, with kiosk and
 * staff auth on: consent → queue → verdict → wall feed and wall image, and every way that chain
 * must NOT lead to the wall. The provider is the built-in mock; its answer is switched per test.
 */
const ORIGIN = "https://booth.example.org";
const PASSWORD = "shared-enroll-password-for-tests";
const CRON = "c".repeat(40);
let dir: string;
let photo: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-ai-api-"));
  Object.assign(process.env, {
    // The hub: one process, local files, PIN staff login next to the shared password.
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: PASSWORD,
    CRON_SECRET: CRON,
    PUBLIC_BASE_URL: ORIGIN,
    AI_MODERATION_PROVIDER: "mock",
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

/** Make the provider answer differently from here on (a new service with the new setting). */
async function provider(behaviour: "safe" | "unsafe" | "unsure" | "fail" | "slow" | null) {
  if (behaviour) {
    process.env.AI_MODERATION_PROVIDER = "mock";
    process.env.AI_MODERATION_MOCK = behaviour;
  } else delete process.env.AI_MODERATION_PROVIDER;
  const { resetServerConfigForTests } = await import("@/lib/server/env");
  const { resetAiReviewForTests, settleAiReviewForTests } = await import("@/lib/moderation/server");
  await settleAiReviewForTests();
  resetServerConfigForTests();
  resetAiReviewForTests();
}
const settle = async () => (await import("@/lib/moderation/server")).settleAiReviewForTests();

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
async function settings(body: Record<string, unknown>, cookie = staff) {
  const { POST } = await import("@/app/api/admin/settings/route");
  return POST(json("/api/admin/settings", body, cookie), noParams);
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
async function consent(kiosk: string, sessionId: string, body: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/photos/consent/route");
  const res = await POST(json("/api/photos/consent", { sessionId, consent: true, ...body }, kiosk));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function review(kiosk: string | null, sessionId: string) {
  const { GET } = await import("@/app/api/photos/review/route");
  const res = await GET(
    new Request(`${ORIGIN}/api/photos/review?sessionId=${sessionId}`, {
      headers: kiosk ? { cookie: kiosk } : {},
    }),
  );
  return { status: res.status, body: (await res.json()) as { review?: string } };
}
async function feed(cookie?: string) {
  const { GET } = await import("@/app/api/wall/feed/route");
  const res = await GET(
    new Request(`${ORIGIN}/api/wall/feed`, {
      headers: { "x-forwarded-for": uuid(), ...(cookie ? { cookie } : {}) },
    }),
  );
  return (await res.json()) as { mode: string; photos: { id: string }[] };
}
async function wallImage(id: string, cookie?: string) {
  const { GET } = await import("@/app/api/wall/photos/[id]/image/route");
  return GET(
    new Request(`${ORIGIN}/api/wall/photos/${id}/image`, {
      headers: { "x-forwarded-for": uuid(), ...(cookie ? { cookie } : {}) },
    }),
    { params: Promise.resolve({ id }) },
  );
}
async function moderate(id: string, action: string, cookie = staff) {
  const { POST } = await import("@/app/api/admin/photos/[id]/moderate/route");
  return POST(
    json(
      `/api/admin/photos/${id}/moderate`,
      { action, ...(action === "delete" ? { confirm: "DELETE" } : {}) },
      cookie,
    ),
    { params: Promise.resolve({ id }) },
  );
}
const row = async (id: string) =>
  (await (await import("@/lib/storage/server")).getPhotoService().getById(id))!;

let kiosk: string;
let wall: string;
beforeAll(async () => {
  kiosk = await enroll("booth");
  wall = await enroll("wall display");
  staff = await staffLogin();
});
beforeEach(async () => {
  await provider("safe");
  await settings({
    moderationMode: "auto",
    pauseWall: false,
    showHoldingScreen: false,
    pauseSubmissions: false,
  });
});

describe("switching the mode", () => {
  it("is a staff action: no session, a booth cookie or another origin cannot do it", async () => {
    await settings({ moderationMode: "manual" });
    const { POST } = await import("@/app/api/admin/settings/route");
    expect((await settings({ moderationMode: "auto" }, "")).status).toBe(401);
    expect((await settings({ moderationMode: "auto" }, kiosk)).status).toBe(401);
    const crossSite = await POST(
      json("/api/admin/settings", { moderationMode: "auto" }, staff, {
        origin: "https://evil.example",
      }),
      noParams,
    );
    expect(crossSite.status).toBe(403);
    const { getBackend } = await import("@/lib/storage/server");
    expect((await getBackend().settings.get()).moderationMode).toBe("manual");
  });

  it("accepts only manual or auto, and is audited", async () => {
    for (const bad of ["off", "unmoderated", "", null, true, 1])
      expect((await settings({ moderationMode: bad })).status, String(bad)).toBe(400);
    expect((await settings({ moderationMode: "manual" })).status).toBe(200);
    expect((await settings({ moderationMode: "auto" })).status).toBe(200);
    const { getBackend } = await import("@/lib/storage/server");
    const [last] = await getBackend().audit.list({ subjectType: "settings", limit: 1 });
    expect(last).toMatchObject({ action: "update_settings", actorType: "staff" });
    expect(last!.fromState).toContain('"moderation_mode":"manual"');
    expect(last!.toState).toContain('"moderation_mode":"auto"');
  });

  it("auto is refused while no provider is configured, so the switch cannot promise a check", async () => {
    await settings({ moderationMode: "manual" });
    await provider(null);
    const res = await settings({ moderationMode: "auto" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ai_not_configured" });
    // Manual is always available.
    expect((await settings({ moderationMode: "manual" })).status).toBe(200);
  });

  it("the booth learns from its heartbeat whether a check is running", async () => {
    const { POST } = await import("@/app/api/kiosk/heartbeat/route");
    const beat = async () =>
      (await (await POST(json("/api/kiosk/heartbeat", { queueDepth: 0 }, kiosk))).json()) as {
        aiReview: boolean;
      };
    expect((await beat()).aiReview).toBe(true);
    await settings({ moderationMode: "manual" });
    expect((await beat()).aiReview).toBe(false);
    await settings({ moderationMode: "auto" });
    await provider(null);
    expect((await beat()).aiReview).toBe(false);
  });
});

describe("consent → automatic check → wall", () => {
  it("a yes in auto mode: checked, approved, on the feed and served as an image", async () => {
    const p = await shoot(kiosk);
    // Before any answer the photo is nowhere near the wall.
    expect((await wallImage(p.id, wall)).status).toBe(404);
    expect((await review(kiosk, p.sessionId)).body.review).toBe("none");

    const answer = await consent(kiosk, p.sessionId);
    expect(answer).toMatchObject({
      status: 200,
      body: { moderationStatus: "PENDING", review: "ai" },
    });
    await settle();

    expect(await row(p.id)).toMatchObject({ moderationStatus: "APPROVED", ai: { status: "SAFE" } });
    expect((await review(kiosk, p.sessionId)).body.review).toBe("approved");
    expect((await feed(wall)).photos.map((x) => x.id)).toContain(p.id);
    const image = await wallImage(p.id, wall);
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    // Venue consent only: the anonymous audience still gets nothing (D86 is unchanged).
    expect((await feed()).photos).toEqual([]);
    expect((await wallImage(p.id)).status).toBe(404);
  });

  it("every yes in auto mode is checked: the booth sends no flag and shows no notice (D96)", async () => {
    const p = await shoot(kiosk);
    // Exactly what the booth sends: a session and an answer.
    expect((await consent(kiosk, p.sessionId)).body).toMatchObject({
      moderationStatus: "PENDING",
      review: "ai",
    });
    await settle();
    expect(await row(p.id)).toMatchObject({ moderationStatus: "APPROVED", ai: { status: "SAFE" } });
  });

  it("in manual mode nothing is sent: a person approves", async () => {
    await settings({ moderationMode: "manual" });
    const p = await shoot(kiosk);
    expect((await consent(kiosk, p.sessionId)).body.review).toBe("staff");
    await settle();
    expect((await row(p.id)).moderationStatus).toBe("PENDING");
    expect((await wallImage(p.id, wall)).status).toBe(404);
    expect((await moderate(p.id, "approve")).status).toBe(200);
    expect((await wallImage(p.id, wall)).status).toBe(200);
  });

  it("no answer and a no are never queued", async () => {
    const p = await shoot(kiosk);
    const { POST } = await import("@/app/api/photos/consent/route");
    const res = await POST(
      json("/api/photos/consent", { sessionId: p.sessionId, consent: false }, kiosk),
    );
    expect(await res.json()).toMatchObject({ moderationStatus: "NONE", review: "staff" });
    await settle();
    expect((await row(p.id)).ai).toBeUndefined();
  });

  it.each([
    ["unsafe", "UNSAFE"],
    ["unsure", "UNCERTAIN"],
  ] as const)(
    "a photo the AI calls %s stays off the feed and off the image route",
    async (behaviour, status) => {
      await provider(behaviour);
      const p = await shoot(kiosk);
      expect((await consent(kiosk, p.sessionId)).body.review).toBe("ai");
      await settle();
      expect(await row(p.id)).toMatchObject({ moderationStatus: "PENDING", ai: { status } });
      expect((await feed(wall)).photos.map((x) => x.id)).not.toContain(p.id);
      expect((await wallImage(p.id, wall)).status).toBe(404);
      // The guest is told a person will look. Never what the AI thought.
      expect(await review(kiosk, p.sessionId)).toEqual({ status: 200, body: { review: "staff" } });
    },
  );

  it("provider down: the photo waits, the booth keeps working, a person can approve", async () => {
    await provider("fail");
    const p = await shoot(kiosk);
    expect((await consent(kiosk, p.sessionId)).status).toBe(200);
    await settle();
    expect(await row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "QUEUED" },
    });
    expect((await review(kiosk, p.sessionId)).body.review).toBe("checking");
    expect((await wallImage(p.id, wall)).status).toBe(404);
    // The next guest is not held up by the first one's review.
    const next = await shoot(kiosk);
    expect((await consent(kiosk, next.sessionId)).status).toBe(200);
    await settle();
    expect((await moderate(p.id, "approve")).status).toBe(200);
    expect(await row(p.id)).toMatchObject({
      moderationStatus: "APPROVED",
      ai: { status: "SKIPPED" },
    });
    expect((await wallImage(p.id, wall)).status).toBe(200);
  });
});

describe("the wall never shows more than the rules allow", () => {
  it("emergency blackout: an AI-approved photo leaves the feed and the image route at once", async () => {
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    await settle();
    expect((await wallImage(p.id, wall)).status).toBe(200);

    for (const [key, mode] of [
      ["pauseWall", "paused"],
      ["showHoldingScreen", "holding"],
    ] as const) {
      await settings({ [key]: true });
      expect(await feed(wall)).toMatchObject({ mode, photos: [] });
      expect((await wallImage(p.id, wall)).status).toBe(404);
      // Photos approved by the AI during the blackout stay off the wall as well.
      const during = await shoot(kiosk);
      await consent(kiosk, during.sessionId);
      await settle();
      expect((await row(during.id)).moderationStatus).toBe("APPROVED");
      expect((await wallImage(during.id, wall)).status).toBe(404);
      await settings({ [key]: false });
      expect((await wallImage(p.id, wall)).status).toBe(200);
    }
  });

  it("paused submissions: no new yes is taken, so nothing new reaches the AI", async () => {
    await settings({ pauseSubmissions: true });
    const p = await shoot(kiosk);
    expect((await consent(kiosk, p.sessionId)).status).toBe(409);
    await settle();
    expect(await row(p.id)).toMatchObject({ moderationStatus: "NONE", wallConsent: false });
    expect((await row(p.id)).ai).toBeUndefined();
  });

  it("staff hide or delete an AI-approved photo: gone from the wall, and it stays gone", async () => {
    const hidden = await shoot(kiosk);
    const deleted = await shoot(kiosk);
    for (const p of [hidden, deleted]) await consent(kiosk, p.sessionId);
    await settle();
    expect((await moderate(hidden.id, "hide")).status).toBe(200);
    expect((await moderate(deleted.id, "delete")).status).toBe(200);
    const { getAiReview } = await import("@/lib/moderation/server");
    await getAiReview().processDue(10);
    await getAiReview().processOne(hidden.id);
    const ids = (await feed(wall)).photos.map((x) => x.id);
    for (const p of [hidden, deleted]) {
      expect(ids).not.toContain(p.id);
      expect((await wallImage(p.id, wall)).status).toBe(404);
    }
    expect((await row(hidden.id)).moderationStatus).toBe("HIDDEN");
    expect((await row(deleted.id)).moderationStatus).toBe("DELETED");
    expect((await review(kiosk, deleted.sessionId)).status).toBe(404);
  });

  it("nothing about the AI reaches the wall or the guest", async () => {
    await provider("unsafe");
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    await settle();
    await moderate(p.id, "approve");
    const text = JSON.stringify(await feed(wall));
    expect(text).toContain(p.id);
    expect(Object.keys((await feed(wall)).photos[0]!).sort()).toEqual([
      "createdAt",
      "frameId",
      "id",
    ]);
    expect(text).not.toMatch(/"ai|UNSAFE|SKIPPED|gesture|provider|model|objectPath|token/i);
  });
});

describe("who may ask what", () => {
  it("review status: only the booth that took the photo, one word, nothing else", async () => {
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    await settle();
    expect((await review(null, p.sessionId)).status).toBe(401);
    expect((await review("ftl_kiosk=v1.forged.1.2.sig", p.sessionId)).status).toBe(401);
    // Another enrolled device and a staff cookie are not this booth.
    expect((await review(wall, p.sessionId)).status).toBe(404);
    expect((await review(staff, p.sessionId)).status).toBe(401);
    expect((await review(kiosk, uuid())).status).toBe(404);
    expect((await review(kiosk, "not-a-uuid")).status).toBe(400);
    expect(await review(kiosk, p.sessionId)).toEqual({ status: 200, body: { review: "approved" } });
  });

  it("the queue endpoint needs the cron secret", async () => {
    const { GET, POST } = await import("@/app/api/cron/ai-review/route");
    const call = (auth?: string) =>
      new Request(`${ORIGIN}/api/cron/ai-review`, {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
      });
    expect((await POST(call())).status).toBe(401);
    expect((await POST(call("Bearer wrong"))).status).toBe(401);
    expect((await POST(call(`Bearer ${PASSWORD}`))).status).toBe(401);
    expect(
      (await GET(new Request(`${ORIGIN}/api/cron/ai-review`, { headers: { cookie: staff } })))
        .status,
    ).toBe(401);

    await provider("fail");
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    await settle();
    await provider("safe");
    // Still queued for its retry; the endpoint works through what is due and says how many.
    const { getPhotoService } = await import("@/lib/storage/server");
    expect((await getPhotoService().getById(p.id))!.ai!.status).toBe("QUEUED");
    const res = await POST(call(`Bearer ${CRON}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: expect.any(Number) });
  });

  it("a booth cannot moderate, and nobody can post a verdict from outside", async () => {
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    expect((await moderate(p.id, "approve", kiosk)).status).toBe(401);
    expect((await moderate(p.id, "approve", "")).status).toBe(401);
    // There is no route that takes a verdict: the only writers are the server's own service.
    const { readdir } = await import("node:fs/promises");
    const api = await readdir(path.resolve(import.meta.dirname, "../../app/api"), {
      recursive: true,
    });
    const aiRoutes = api
      .filter((f) => /ai|review|moderat/i.test(f) && f.endsWith("route.ts"))
      .sort();
    expect(aiRoutes).toEqual([
      "admin/photos/[id]/moderate/route.ts",
      "cron/ai-review/route.ts",
      "photos/review/route.ts",
    ]);
  });

  it("the staff overview reports the mode, the provider and today's count", async () => {
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    await settle();
    const { GET } = await import("@/app/api/admin/overview/route");
    const res = await GET(
      new Request(`${ORIGIN}/api/admin/overview`, { headers: { cookie: staff } }),
      noParams,
    );
    const { ai } = (await res.json()) as {
      ai: Record<string, unknown> & { usage: { requests: number } };
    };
    expect(ai).toMatchObject({
      configured: true,
      mode: "auto",
      active: true,
      provider: "mock",
      problem: null,
    });
    expect(ai.usage.requests).toBeGreaterThan(0);
    expect(JSON.stringify(ai)).not.toMatch(/key|secret/i);
    expect((await GET(new Request(`${ORIGIN}/api/admin/overview`), noParams)).status).toBe(401);
  });

  it("the overview still opens when the AI status cannot be read (code deployed before its migration)", async () => {
    const { getBackend } = await import("@/lib/storage/server");
    const backend = getBackend();
    const real = backend.aiReviews.status;
    backend.aiReviews.status = async () => {
      throw new Error("function public.ftl_ai_status(date) does not exist");
    };
    try {
      const { GET } = await import("@/app/api/admin/overview/route");
      const res = await GET(
        new Request(`${ORIGIN}/api/admin/overview`, { headers: { cookie: staff } }),
        noParams,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ai: Record<string, unknown>;
        settings: Record<string, unknown>;
        pendingCount: number;
      };
      // Everything staff need in an emergency is still there; the AI card says it is unavailable.
      expect(body.settings).toHaveProperty("pauseWall");
      expect(body.pendingCount).toEqual(expect.any(Number));
      expect(body.ai).toMatchObject({ configured: false, active: false, mode: "manual" });
      expect(body.ai.problem).toMatch(/migration/);
    } finally {
      backend.aiReviews.status = real;
    }
  });

  it("with no provider configured, ordinary requests do not touch the review queue", async () => {
    await provider(null);
    const { getBackend } = await import("@/lib/storage/server");
    const backend = getBackend();
    const real = backend.aiReviews.claim;
    let claims = 0;
    backend.aiReviews.claim = async (...args) => {
      claims++;
      return real(...args);
    };
    try {
      await feed(wall);
      const { POST } = await import("@/app/api/kiosk/heartbeat/route");
      await POST(json("/api/kiosk/heartbeat", { queueDepth: 0 }, kiosk));
      await settle();
      expect(claims).toBe(0);
    } finally {
      backend.aiReviews.claim = real;
    }
  });
});

describe("every shot is checked on its own (D97)", () => {
  it("a strip of four costs four requests and is approved when all four are safe", async () => {
    const { getAiReview } = await import("@/lib/moderation/server");
    const before = (await getAiReview().status()).usage.requests;
    const p = await shoot(kiosk);
    await consent(kiosk, p.sessionId);
    await settle();
    expect(await row(p.id)).toMatchObject({ moderationStatus: "APPROVED", ai: { status: "SAFE" } });
    expect((await getAiReview().status()).usage.requests - before).toBe(4);
  });

  it("a photo in a retired frame cannot be cut up: nothing is sent and a person decides", async () => {
    const { getAiReview } = await import("@/lib/moderation/server");
    const before = (await getAiReview().status()).usage.requests;
    const p = await shoot(kiosk, "starlight-strip");
    await consent(kiosk, p.sessionId);
    await settle();
    expect(await row(p.id)).toMatchObject({
      moderationStatus: "PENDING",
      ai: { status: "FAILED", reason: "unsupported_image" },
    });
    expect((await getAiReview().status()).usage.requests).toBe(before);
    expect((await feed(wall)).photos.map((x) => x.id)).not.toContain(p.id);
  });
});
