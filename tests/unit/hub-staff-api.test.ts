// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JPEG, uuid } from "../helpers/images";

/**
 * Hub staff login (FTL_ROLE=hub) through the real route handlers and the local backend: first
 * staff via the console setup code, name + PIN login, PIN-only staff management, and the session
 * rules (PIN reset and deactivation end sessions; kiosk and staff cookies never substitute).
 */
const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-hub-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const json = (url: string, body: unknown, cookie?: string, origin = ORIGIN) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const noParams = { params: Promise.resolve({}) };
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

const routes = {
  setup: () => import("@/app/api/admin/auth/setup/route"),
  pin: () => import("@/app/api/admin/auth/pin/route"),
  otp: () => import("@/app/api/admin/auth/otp/route"),
  signout: () => import("@/app/api/admin/auth/signout/route"),
  staff: () => import("@/app/api/admin/staff/route"),
  staffOne: () => import("@/app/api/admin/staff/[userId]/route"),
  enroll: () => import("@/app/api/kiosk/enroll/route"),
  photos: () => import("@/app/api/photos/route"),
};

async function listStaff(cookie?: string) {
  const { GET } = await routes.staff();
  return GET(
    new Request(`${ORIGIN}/api/admin/staff`, { headers: cookie ? { cookie } : {} }),
    noParams,
  );
}
async function login(userId: string, pin: string) {
  const { POST } = await routes.pin();
  return POST(json("/api/admin/auth/pin", { userId, pin }));
}

let adminCookie = "";
let adminId = "";
let helperId = "";

describe("first staff member on a fresh hub", () => {
  it("staff APIs refuse everyone before setup", async () => {
    expect((await listStaff()).status).toBe(401);
  });

  it("needs the console setup code, a name and an acceptable PIN; works once", async () => {
    const { ensureSetupCode } = await import("@/lib/staff-auth/setup");
    const code = (await ensureSetupCode())!;
    expect(code).toMatch(/^[2-9A-Z]{8}$/);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(code.slice(0, 4)));
    const { POST } = await routes.setup();

    const wrongCode = await POST(
      json("/api/admin/auth/setup", { code: "AAAA-AAAA", displayName: "책임자", pin: "482913" }),
    );
    expect(wrongCode.status).toBe(403);
    const weak = await POST(
      json("/api/admin/auth/setup", { code, displayName: "책임자", pin: "123456" }),
    );
    expect(weak.status).toBe(400);
    const crossSite = await POST(
      json(
        "/api/admin/auth/setup",
        { code, displayName: "책임자", pin: "482913" },
        undefined,
        "https://evil.example",
      ),
    );
    expect(crossSite.status).toBe(403);

    const ok = await POST(
      json("/api/admin/auth/setup", {
        code: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`,
        displayName: "책임자",
        pin: "482913",
      }),
    );
    expect(ok.status).toBe(201);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^ftl_staff=s1\./);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Secure/); // plain HTTP on the venue LAN (D42)
    adminCookie = cookieOf(ok);

    const again = await POST(
      json("/api/admin/auth/setup", { code, displayName: "누군가", pin: "482913" }),
    );
    expect(again.status).toBe(403);
    expect(await ensureSetupCode()).toBeNull();
  });

  it("the new session works and the staff list never carries PIN hashes", async () => {
    const res = await listStaff(adminCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("scrypt");
    const { staff } = JSON.parse(text) as { staff: { userId: string; email: string }[] };
    expect(staff).toHaveLength(1);
    expect(staff[0]!.email).toBe("");
    adminId = staff[0]!.userId;
  });
});

describe("PIN login", () => {
  it("wrong PIN → 401, right PIN → session cookie", async () => {
    expect((await login(adminId, "000001")).status).toBe(401);
    expect((await login(uuid(), "482913")).status).toBe(401);
    const ok = await login(adminId, "482913");
    expect(ok.status).toBe(200);
    expect((await listStaff(cookieOf(ok))).status).toBe(200);
  });

  it("email-code login does not exist on the hub", async () => {
    const { POST } = await routes.otp();
    expect((await POST(json("/api/admin/auth/otp", { email: "a@b.org" }))).status).toBe(503);
  });

  it("sign-out clears the cookie", async () => {
    const { POST } = await routes.signout();
    const res = await POST(json("/api/admin/auth/signout", {}, adminCookie));
    expect(res.status).toBe(303);
    // Both kinds of staff session are cleared: the shared administrator one and the PIN one.
    expect(res.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^ftl_admin=;.*Max-Age=0/),
      expect.stringMatching(/^ftl_staff=;.*Max-Age=0/),
    ]);
  });
});

describe("staff management on the hub", () => {
  it("adds staff with a name and PIN only; refuses weak PINs", async () => {
    const { POST } = await routes.staff();
    const weak = await POST(
      json("/api/admin/staff", { displayName: "도우미", pin: "111111" }, adminCookie),
      noParams,
    );
    expect(weak.status).toBe(400);
    const res = await POST(
      json("/api/admin/staff", { displayName: "도우미", pin: "715203" }, adminCookie),
      noParams,
    );
    expect(res.status).toBe(201);
    const { member } = (await res.json()) as { member: { userId: string; email: string } };
    expect(member.email).toBe("");
    helperId = member.userId;
    expect((await login(helperId, "715203")).status).toBe(200);
  });

  it("a PIN reset ends the old session at once", async () => {
    const helper = cookieOf(await login(helperId, "715203"));
    expect((await listStaff(helper)).status).toBe(200);
    const { POST } = await routes.staffOne();
    const reset = await POST(json(`/api/admin/staff/${helperId}`, { pin: "604918" }, adminCookie), {
      params: Promise.resolve({ userId: helperId }),
    });
    expect(reset.status).toBe(200);
    expect((await listStaff(helper)).status).toBe(401);
    expect((await login(helperId, "715203")).status).toBe(401);
    expect((await login(helperId, "604918")).status).toBe(200);
  });

  it("deactivation ends the session; an inactive person cannot log in", async () => {
    const helper = cookieOf(await login(helperId, "604918"));
    const { POST } = await routes.staffOne();
    const res = await POST(json(`/api/admin/staff/${helperId}`, { active: false }, adminCookie), {
      params: Promise.resolve({ userId: helperId }),
    });
    expect(res.status).toBe(200);
    expect((await listStaff(helper)).status).toBe(403);
    expect((await login(helperId, "604918")).status).toBe(401);
  });

  it("PIN changes and staff additions are audited without the PIN", async () => {
    const { getBackend } = await import("@/lib/storage/server");
    const events = await getBackend().audit.list({ subjectType: "staff", limit: 50 });
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["add_staff", "set_staff_pin", "deactivate_staff"]),
    );
    const text = JSON.stringify(events);
    for (const pin of ["482913", "715203", "604918", "scrypt"]) expect(text).not.toContain(pin);
  });
});

describe("guessing and cross-use", () => {
  it("rate-limits PIN guesses per person", async () => {
    const target = adminId;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await login(target, `90817${i}`)).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.at(-1)).toBe(429);
  });

  it("a kiosk cookie is not a staff session, and a staff cookie cannot upload", async () => {
    const { POST: enroll } = await routes.enroll();
    const res = await enroll(json("/api/kiosk/enroll", { secret: ENROLL, label: "부스" }));
    const kioskCookie = cookieOf(res);
    expect(kioskCookie).toMatch(/^ftl_kiosk=/);
    expect((await listStaff(kioskCookie)).status).toBe(401);

    const { POST: upload } = await routes.photos();
    const up = await upload(
      new Request(`${ORIGIN}/api/photos`, {
        method: "POST",
        body: JPEG,
        headers: {
          "content-type": "image/jpeg",
          "x-session-id": uuid(),
          "x-frame-id": "starlight-strip",
          origin: ORIGIN,
          cookie: adminCookie,
        },
      }),
    );
    expect(up.status).toBe(401);
  });
});
