// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phone photos (D66) go through the AI review too (2026-11-25, a user decision): the same queue
 * and the same single approval path as booth photos. Clearly fine → APPROVED at once; anything
 * else stays PENDING for a person. The hub, local files, the built-in mock provider.
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-ai-mobile-tests";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-ai-mobile-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "p".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
    PUBLIC_BASE_URL: ORIGIN,
    AI_MODERATION_PROVIDER: "mock",
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function useProvider(behaviour: "safe" | "unsafe") {
  process.env.AI_MODERATION_PROVIDER = "mock";
  process.env.AI_MODERATION_MOCK = behaviour;
  const { resetServerConfigForTests } = await import("@/lib/server/env");
  const { resetAiReviewForTests, settleAiReviewForTests } = await import("@/lib/moderation/server");
  await settleAiReviewForTests();
  resetServerConfigForTests();
  resetAiReviewForTests();
}
const settle = async () => (await import("@/lib/moderation/server")).settleAiReviewForTests();

async function enroll() {
  const { POST } = await import("@/app/api/kiosk/enroll/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/kiosk/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ secret: ENROLL, label: "ai mobile booth" }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function qr(cookie: string) {
  const { POST } = await import("@/app/api/mobile/sessions/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/mobile/sessions`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
    }),
  );
  const body = (await res.json()) as { url: string; sessionId: string };
  return { token: decodeURIComponent(body.url.split("/m/")[1]!), sessionId: body.sessionId };
}

let ip = 0;
async function upload(token: string) {
  // A synthetic picture (flat colour). No photograph of a person is used anywhere in the tests.
  const jpeg = new Uint8Array(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#4a8" } })
      .jpeg()
      .toBuffer(),
  );
  const { POST } = await import("@/app/api/mobile/upload/route");
  return POST(
    new Request(`${ORIGIN}/api/mobile/upload`, {
      method: "POST",
      body: jpeg as unknown as BodyInit,
      headers: {
        origin: ORIGIN,
        "content-type": "image/jpeg",
        "x-upload-token": token,
        "x-wall-consent": "yes",
        "x-forwarded-for": `198.51.100.${++ip}`,
      },
    }),
  );
}

async function row(sessionId: string) {
  const { getBackend } = await import("@/lib/storage/server");
  return getBackend().photos.findBySessionId(sessionId);
}

describe("phone photos and the AI review", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await enroll();
    // Off by default (2026-11-27): staff turn 「내 사진으로 참여하기」 on before any QR.
    const { getBackend } = await import("@/lib/storage/server");
    await getBackend().settings.update({ mobileUpload: true }, crypto.randomUUID());
  });

  it("the event starts in AI review: a clearly fine phone photo goes up without a person", async () => {
    await useProvider("safe");
    const { getBackend } = await import("@/lib/storage/server");
    expect((await getBackend().settings.get()).moderationMode).toBe("auto");
    const { token, sessionId } = await qr(cookie);
    expect((await upload(token)).status).toBe(201);
    await settle();
    const r = (await row(sessionId))!;
    expect(r.frameId).toBe("phone-photo");
    expect(r.moderationStatus).toBe("APPROVED");
    expect(r.ai?.status).toBe("SAFE");
  });

  it("anything the AI does not find clearly fine waits for a person", async () => {
    await useProvider("unsafe");
    const { token, sessionId } = await qr(cookie);
    expect((await upload(token)).status).toBe(201);
    await settle();
    expect((await row(sessionId))?.moderationStatus).toBe("PENDING");
  });

  it("in manual mode a phone photo waits for a person, as before", async () => {
    await useProvider("safe");
    const { getBackend } = await import("@/lib/storage/server");
    await getBackend().settings.update(
      { moderationMode: "manual" },
      "00000000-0000-0000-0000-000000000001",
    );
    const { token, sessionId } = await qr(cookie);
    expect((await upload(token)).status).toBe(201);
    await settle();
    const r = (await row(sessionId))!;
    expect(r.moderationStatus).toBe("PENDING");
    expect(r.ai?.status ?? "NONE").toBe("NONE");
  });
});
