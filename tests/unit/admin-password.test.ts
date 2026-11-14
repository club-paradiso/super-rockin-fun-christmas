// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signKioskSession } from "@/lib/kiosk-auth/session";
import { signStaffSession } from "@/lib/staff-auth/pin";
import {
  ADMIN_COOKIE,
  SHARED_OPERATOR_ID,
  signAdminSession,
  verifyAdminSession,
} from "@/lib/staff-auth/shared";
import { uuid } from "../helpers/images";

/**
 * Shared administrator password (D84): the kiosk enrollment password opens /admin, through the
 * real route handlers and the local backend. One credential, separate sessions: a booth cookie is
 * never an administrator, an administrator cookie never enrolls or acts as a booth.
 */
const ORIGIN = "https://booth.example.org";
const SESSION_SECRET = "s".repeat(48);
const PASSWORD = "shared-enroll-password-for-tests";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-admin-pw-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: SESSION_SECRET,
    KIOSK_ENROLL_SECRET: PASSWORD,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const noParams = { params: Promise.resolve({}) };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

async function login(password: unknown, ip = "203.0.113.1", origin = ORIGIN) {
  const { POST } = await import("@/app/api/admin/auth/password/route");
  return POST(post("/api/admin/auth/password", { password }, { "x-forwarded-for": ip, origin }));
}
async function getSettings(cookie?: string) {
  const { GET } = await import("@/app/api/admin/settings/route");
  return GET(
    new Request(`${ORIGIN}/api/admin/settings`, { headers: cookie ? { cookie } : {} }),
    noParams,
  );
}

describe("session cookie (pure)", () => {
  const now = 1_800_000_000;
  const claims = { issuedAt: now, expiresAt: now + 3600 };

  it("verifies only with the same two secrets, before it expires", () => {
    const value = signAdminSession(SESSION_SECRET, PASSWORD, claims);
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, value, now + 10)).toEqual(claims);
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, value, now + 3600)).toBeNull();
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, value + "x", now + 10)).toBeNull();
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, null, now)).toBeNull();
    // The password itself is nowhere in the cookie.
    expect(value).not.toContain(PASSWORD);
  });

  it("rotating either secret ends every session", () => {
    const value = signAdminSession(SESSION_SECRET, PASSWORD, claims);
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD + "2", value, now + 10)).toBeNull();
    expect(verifyAdminSession("t".repeat(48), PASSWORD, value, now + 10)).toBeNull();
  });

  it("a kiosk or PIN cookie signed with the same server secret is not an administrator", () => {
    const kiosk = signKioskSession(SESSION_SECRET, {
      kioskId: uuid(),
      issuedAt: now,
      expiresAt: now + 3600,
    });
    const pin = signStaffSession(SESSION_SECRET, {
      userId: uuid(),
      issuedAt: now,
      expiresAt: now + 3600,
      pinSetAt: now * 1000,
    });
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, kiosk, now + 10)).toBeNull();
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, pin, now + 10)).toBeNull();
    // Same shape, signed with the plain server secret as key (what a kiosk cookie uses).
    const forged = kiosk.replace(/^v1\.[^.]+\./, "a1.");
    expect(verifyAdminSession(SESSION_SECRET, PASSWORD, forged, now + 10)).toBeNull();
  });
});

describe("POST /api/admin/auth/password", () => {
  it("refuses everyone before login", async () => {
    expect((await getSettings()).status).toBe(401);
  });

  it("wrong, empty or oversized passwords fail the same way and set no cookie", async () => {
    for (const bad of ["nope", PASSWORD + " ", PASSWORD.toUpperCase()]) {
      const res = await login(bad, "203.0.113.2");
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).not.toContain(PASSWORD);
    }
    expect((await login("", "203.0.113.3")).status).toBe(400);
    expect((await login(12345, "203.0.113.3")).status).toBe(400);
    expect((await login("x".repeat(600), "203.0.113.3")).status).toBe(400);
  });

  it("cross-site and non-JSON requests are refused before the password is looked at", async () => {
    expect((await login(PASSWORD, "203.0.113.4", "https://evil.example")).status).toBe(403);
    const { POST } = await import("@/app/api/admin/auth/password/route");
    const form = await POST(
      new Request(`${ORIGIN}/api/admin/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({ password: PASSWORD }),
      }),
    );
    expect(form.status).toBe(415);
  });

  it("the kiosk enrollment password opens an HttpOnly administrator session", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(/^ftl_admin=a1\./);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toMatch(/Max-Age=43200/); // 12 hours
    expect(header).not.toContain(PASSWORD);
    expect(await res.text()).not.toContain(PASSWORD);
    const admin = cookieOf(res, ADMIN_COOKIE);

    const ok = await getSettings(admin);
    expect(ok.status).toBe(200);
  });

  it("acts as the shared operator: audited under its own id, not a staff member's", async () => {
    const admin = cookieOf(await login(PASSWORD), ADMIN_COOKIE);
    const { POST } = await import("@/app/api/admin/settings/route");
    const res = await POST(
      post("/api/admin/settings", { pauseWall: true }, { cookie: admin }),
      noParams,
    );
    expect(res.status).toBe(200);
    const { getBackend } = await import("@/lib/storage/server");
    const backend = getBackend();
    expect((await backend.settings.get()).updatedBy).toBe(SHARED_OPERATOR_ID);
    const [last] = await backend.audit.list({ subjectType: "settings", limit: 1 });
    expect(last).toMatchObject({
      actorType: "staff",
      actorId: SHARED_OPERATOR_ID,
      action: "update_settings",
    });
    // It is not a row in the staff list, so nobody can deactivate or impersonate it there.
    expect(await backend.staff.get(SHARED_OPERATOR_ID)).toBeNull();
    const { listAudit } = await import("@/lib/ops/admin");
    expect((await listAudit({ subjectType: "settings", limit: 1 }))[0]!.actorLabel).toBe(
      "공용 관리자",
    );
    await POST(post("/api/admin/settings", { pauseWall: false }, { cookie: admin }), noParams);
  });

  it("wall pace (D89): saved, audited, strict, and kept when the background changes", async () => {
    const admin = cookieOf(await login(PASSWORD), ADMIN_COOKIE);
    const { POST } = await import("@/app/api/admin/settings/route");
    const { getBackend } = await import("@/lib/storage/server");
    const { wallFeed } = await import("@/lib/wall/server");
    const send = (body: unknown) =>
      POST(post("/api/admin/settings", body, { cookie: admin }), noParams);

    expect((await wallFeed()).pace).toEqual({ visibleMs: 14_000, halfLifeMs: 0 });
    expect((await send({ wallPace: { showSeconds: 30, halfLifeMinutes: 60 } })).status).toBe(200);
    expect((await getBackend().settings.get()).wallLook).toMatchObject({
      showSeconds: 30,
      halfLifeMinutes: 60,
    });
    expect((await wallFeed()).pace).toEqual({ visibleMs: 30_000, halfLifeMs: 3_600_000 });
    // The anonymous audience is paced the same way.
    expect((await wallFeed([], 5, "public")).pace).toEqual({
      visibleMs: 30_000,
      halfLifeMs: 3_600_000,
    });
    const [last] = await getBackend().audit.list({ subjectType: "settings", limit: 1 });
    expect(last).toMatchObject({ actorId: SHARED_OPERATOR_ID, action: "update_settings" });

    // Saving a background (a form that knows nothing about the pace) keeps the pace.
    const look = { theme: "bethlehem", rotate: false, rotateMinutes: 15, rotation: [] };
    expect((await send({ wallLook: look })).status).toBe(200);
    expect((await getBackend().settings.get()).wallLook).toMatchObject({
      theme: "bethlehem",
      showSeconds: 30,
      halfLifeMinutes: 60,
    });
    // And saving the pace keeps the background.
    expect((await send({ wallPace: { showSeconds: 8, halfLifeMinutes: 0 } })).status).toBe(200);
    expect((await getBackend().settings.get()).wallLook).toMatchObject({
      theme: "bethlehem",
      showSeconds: 8,
      halfLifeMinutes: 0,
    });

    for (const bad of [
      { showSeconds: 4, halfLifeMinutes: 0 },
      { showSeconds: 121, halfLifeMinutes: 0 },
      { showSeconds: 14.5, halfLifeMinutes: 0 },
      { showSeconds: "14", halfLifeMinutes: 0 },
      { showSeconds: 14, halfLifeMinutes: -1 },
      { showSeconds: 14, halfLifeMinutes: 1441 },
      { showSeconds: 14 },
      null,
    ])
      expect((await send({ wallPace: bad })).status).toBe(400);
    expect((await getBackend().settings.get()).wallLook).toMatchObject({ showSeconds: 8 });

    const { defaultWallLook } = await import("@/config/wall-themes");
    await send({ wallLook: look });
    await getBackend().settings.update({ wallLook: defaultWallLook() }, SHARED_OPERATOR_ID);
  });

  it("mutations still need the same origin (CSRF) with a valid session", async () => {
    const admin = cookieOf(await login(PASSWORD), ADMIN_COOKIE);
    const { POST } = await import("@/app/api/admin/settings/route");
    const res = await POST(
      post(
        "/api/admin/settings",
        { pauseWall: true },
        { cookie: admin, origin: "https://evil.example" },
      ),
      noParams,
    );
    expect(res.status).toBe(403);
  });
});

describe("one credential, separate sessions", () => {
  it("a booth enrolled with the same password is not an administrator", async () => {
    const { POST: enroll } = await import("@/app/api/kiosk/enroll/route");
    const res = await enroll(
      post(
        "/api/kiosk/enroll",
        { secret: PASSWORD, label: "부스" },
        { "x-forwarded-for": "203.0.113.20" },
      ),
    );
    expect(res.status).toBe(201);
    const kiosk = cookieOf(res, "ftl_kiosk");
    expect(kiosk).toMatch(/^ftl_kiosk=/);
    // The enrollment answer never carries an administrator cookie.
    expect(cookieOf(res, ADMIN_COOKIE)).toBe("");
    expect((await getSettings(kiosk)).status).toBe(401);
    // Not even when the kiosk cookie's value is presented under the administrator cookie's name.
    expect((await getSettings(kiosk.replace("ftl_kiosk=", "ftl_admin="))).status).toBe(401);
  });

  it("an administrator session is not a booth: it cannot upload, answer consent or heartbeat", async () => {
    const res = await login(PASSWORD);
    const admin = cookieOf(res, ADMIN_COOKIE);
    // Logging in never enrolls this browser as a kiosk.
    expect(cookieOf(res, "ftl_kiosk")).toBe("");
    const { POST: heartbeat } = await import("@/app/api/kiosk/heartbeat/route");
    expect(
      (await heartbeat(post("/api/kiosk/heartbeat", { queueDepth: 0 }, { cookie: admin }))).status,
    ).toBe(401);
    const { POST: consent } = await import("@/app/api/photos/consent/route");
    expect(
      (
        await consent(
          post("/api/photos/consent", { sessionId: uuid(), consent: true }, { cookie: admin }),
        )
      ).status,
    ).toBe(401);
    // Nor when the administrator cookie's value is presented as a kiosk cookie.
    const asKiosk = admin.replace("ftl_admin=", "ftl_kiosk=");
    expect(
      (await heartbeat(post("/api/kiosk/heartbeat", { queueDepth: 0 }, { cookie: asKiosk })))
        .status,
    ).toBe(401);
  });

  it("sign-out clears the cookie; the cleared browser is refused", async () => {
    const admin = cookieOf(await login(PASSWORD), ADMIN_COOKIE);
    const { POST } = await import("@/app/api/admin/auth/signout/route");
    const res = await POST(post("/api/admin/auth/signout", {}, { cookie: admin }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login");
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("ftl_admin="))!;
    expect(cleared).toMatch(/^ftl_admin=;.*Max-Age=0/);
    expect((await getSettings(cookieOf(res, ADMIN_COOKIE))).status).toBe(401);
  });
});

describe("guessing limits", () => {
  it("locks one address out after 8 wrong passwords, without locking anyone else", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 8; i++) expect((await login(`guess-${i}`, ip)).status).toBe(401);
    expect((await login("guess-9", ip)).status).toBe(429);
    // Even the right password waits out the lock from that address...
    expect((await login(PASSWORD, ip)).status).toBe(429);
    // ...but the real operator, elsewhere, is not locked out by someone else's guessing.
    expect((await login(PASSWORD, "198.51.100.78")).status).toBe(200);
  });
});

describe("secret rotation and configuration", () => {
  it("a session opened before the password changed is refused afterwards", async () => {
    const admin = cookieOf(await login(PASSWORD, "203.0.113.40"), ADMIN_COOKIE);
    expect((await getSettings(admin)).status).toBe(200);
    const { resetServerConfigForTests } = await import("@/lib/server/env");
    process.env.KIOSK_ENROLL_SECRET = "a-new-enroll-password-2026";
    resetServerConfigForTests();
    expect((await getSettings(admin)).status).toBe(401);
    expect((await login(PASSWORD, "203.0.113.41")).status).toBe(401);
    expect((await login("a-new-enroll-password-2026", "203.0.113.41")).status).toBe(200);
    process.env.KIOSK_ENROLL_SECRET = PASSWORD;
    resetServerConfigForTests();
  });

  it("a password shorter than 12 characters never opens /admin (it still enrolls booths)", async () => {
    const { parseServerConfig } = await import("@/lib/server/env");
    const base = {
      FTL_ROLE: "hub",
      PHOTO_STORE: "local",
      KIOSK_SESSION_SECRET: SESSION_SECRET,
    };
    const short = parseServerConfig({ ...base, KIOSK_ENROLL_SECRET: "short-pass" });
    expect(short.sharedAdmin).toBeNull();
    expect(short.sharedAdminProblem).toBe("password_too_short");
    expect(short.kioskAuth).toMatchObject({ enrollSecret: "short-pass" });
    const none = parseServerConfig(base);
    expect(none.sharedAdmin).toBeNull();
    expect(none.sharedAdminProblem).toBe("no_password");
    const ok = parseServerConfig({ ...base, KIOSK_ENROLL_SECRET: PASSWORD });
    expect(ok.sharedAdmin).toEqual({ sessionHours: 12 });
    expect(ok.sharedAdminProblem).toBeNull();
    // There is no separate administrator password to configure.
    expect(
      parseServerConfig({ ...base, KIOSK_ENROLL_SECRET: PASSWORD, ADMIN_PASSWORD: "ignored" })
        .sharedAdmin,
    ).toEqual({ sessionHours: 12 });

    const { resetServerConfigForTests } = await import("@/lib/server/env");
    process.env.KIOSK_ENROLL_SECRET = "short-pass";
    resetServerConfigForTests();
    expect((await login("short-pass", "203.0.113.50")).status).toBe(404);
    process.env.KIOSK_ENROLL_SECRET = PASSWORD;
    resetServerConfigForTests();
  });
});
